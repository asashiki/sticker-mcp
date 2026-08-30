import fs from "node:fs/promises";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import cors from "cors";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  createMcpHandler,
  validateHostHeader
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { loadConfig, type AppConfig } from "./config.js";
import { setupOAuth } from "./oauth.js";
import { createStickerServer } from "./mcp.js";
import { StickerStorage } from "./storage.js";
import { consumeStickerUploadSlot, getStickerUploadSlot } from "./upload-slots.js";
import { STICKER_VIEW_MIME, STICKER_VIEW_URI, stickerViewHtml } from "./widget/sticker-view-html.js";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif"
};

function safeTokenEqual(actual: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(actual).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function adminAuth(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.adminToken) return void next();
    const authorization = req.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (token && safeTokenEqual(token, config.adminToken)) return void next();
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "Admin token required" });
  };
}

function adminHtmlCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.join(here, "admin/admin.html"), path.join(here, "../src/admin/admin.html")];
}

export async function createStickerHttpApp(config: AppConfig) {
  const storage = new StickerStorage(config.dataDir);
  await storage.init();
  const app = express();
  const mcpPaths = Array.from(new Set([config.mcpHttpPath, "/mcp"]));
  const canonicalMcpResource = `${config.publicBaseUrl}${config.mcpHttpPath}`;
  const requireAdmin = adminAuth(config);

  app.disable("x-powered-by");
  // Compose exposes one reverse-proxy hop. Do not trust arbitrary forwarded
  // chains because the OAuth rate limiter keys failed attempts by req.ip.
  app.set("trust proxy", 1);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    }
  }));

  // One-time capability URL used by an MCP host to upload raw attachment bytes.
  // It must run before the JSON parser.
  app.put(
    ["/api/stickers/upload/:token", "/api/sticker-upload/:token"],
    express.raw({ type: "*/*", limit: "8mb" }),
    async (req, res) => {
      const token = String(req.params.token);
      const slot = getStickerUploadSlot(token);
      if (!slot) return void res.status(404).json({ error: "Upload URL is invalid or expired" });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const mimeType = (String(req.headers["content-type"] ?? "").split(";")[0] ?? "").trim() || "image/png";
      try {
        const sticker = await storage.addSticker(slot.name, slot.emotions, body, mimeType);
        consumeStickerUploadSlot(token);
        const imageUrl = `/images/${storage.publicFilename(sticker)}`;
        console.log(`[sticker_upload] added id=${sticker.id} name="${sticker.name}" bytes=${body.length} mime=${sticker.mimeType}`);
        res.status(201).json({
          id: sticker.id,
          name: sticker.name,
          emotions: sticker.emotions,
          imageUrl: `${config.publicBaseUrl}${imageUrl}`
        });
      } catch (error) {
        console.warn(`[sticker_upload] failed: ${error instanceof Error ? error.message : String(error)}`);
        res.status(400).json({ error: error instanceof Error ? error.message : "upload failed" });
      }
    }
  );

  app.use(express.json({ limit: "12mb" }));
  const bearerAuth = setupOAuth(app, {
    baseUrl: config.publicBaseUrl,
    resourceUrl: canonicalMcpResource,
    password: config.authPassword,
    tokenSecret: config.authTokenSecret,
    serviceName: process.env.MCP_AUTH_SERVICE_NAME?.trim() || "sticker-mcp",
    scope: config.oauthScope,
    allowLegacyResourceOmission: config.allowLegacyResourceOmission
  });

  app.get("/images/:filename", async (req, res) => {
    const safe = path.basename(String(req.params.filename));
    const filepath = path.join(config.dataDir, "images", safe);
    try {
      const data = await fs.readFile(filepath);
      res.setHeader("Content-Type", MIME_BY_EXT[path.extname(safe).toLowerCase()] ?? "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(data);
    } catch {
      res.status(404).send("Not found");
    }
  });

  // The HTML shell contains no sticker data and asks for ADMIN_TOKEN locally.
  // API requests carry the token in Authorization; query-string secrets are
  // deliberately unsupported.
  app.get(["/admin", "/admin/"], async (_req, res) => {
    for (const candidate of adminHtmlCandidates()) {
      try {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.send(await fs.readFile(candidate, "utf8"));
        return;
      } catch {
        // Try the development/build layout alternate.
      }
    }
    res.status(404).send("Admin page not built.");
  });

  app.get("/api/stickers", requireAdmin, async (_req, res) => {
    const stickers = await storage.withThumbs(await storage.getAllStickers());
    res.json(stickers.map((sticker) => ({
      id: sticker.id,
      name: sticker.name,
      emotions: sticker.emotions,
      addedAt: sticker.addedAt ?? null,
      thumb: sticker.thumb,
      imageUrl: `/images/${storage.publicFilename(sticker)}`
    })));
  });

  app.post("/api/stickers", requireAdmin, async (req, res) => {
    const { name, emotions, base64Data, mimeType } = req.body ?? {};
    if (typeof name !== "string" || !Array.isArray(emotions) || typeof base64Data !== "string" || typeof mimeType !== "string") {
      return void res.status(400).json({ error: "name, emotions[], base64Data, mimeType are required" });
    }
    try {
      const sticker = await storage.addStickerFromBase64(name.trim(), emotions, base64Data, mimeType);
      res.status(201).json({ id: sticker.id });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "add failed" });
    }
  });

  app.patch("/api/stickers/:id", requireAdmin, async (req, res) => {
    const { name, emotions } = req.body ?? {};
    const sticker = await storage.updateSticker(String(req.params.id), {
      name: typeof name === "string" ? name.trim() : undefined,
      emotions: Array.isArray(emotions) ? emotions : undefined
    });
    if (!sticker) return void res.status(404).json({ error: "not found" });
    res.json({ success: true });
  });

  app.delete("/api/stickers/:id", requireAdmin, async (req, res) => {
    const success = await storage.deleteSticker(String(req.params.id));
    res.status(success ? 200 : 404).json({ success });
  });

  app.get("/healthz", async (_req, res) => {
    const stickers = await storage.getAllStickers();
    res.json({
      ok: true,
      service: "sticker-mcp",
      version: "1.2.0",
      transport: "streamable-http",
      latestProtocolVersion: LATEST_PROTOCOL_VERSION,
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      stickers: stickers.length,
      mcpEndpoint: canonicalMcpResource,
      oauthEnabled: Boolean(config.authPassword),
      adminProtected: Boolean(config.adminToken)
    });
  });

  app.get("/diagnostics/mcp-app", (_req, res) => {
    const origins = [new URL(config.publicBaseUrl).origin];
    res.setHeader("Cache-Control", "no-store");
    res.json({
      widget: {
        uri: STICKER_VIEW_URI,
        mimeType: STICKER_VIEW_MIME,
        htmlBytes: Buffer.byteLength(stickerViewHtml(), "utf8"),
        dedicatedDomain: config.widgetDomain ?? null,
        sandbox: config.widgetDomain ? "dedicated-domain" : "host-default"
      },
      imageOrigins: origins,
      compatibility: {
        standard: "MCP Apps 2026-01-26 ui/* bridge",
        chatgpt: "window.openai is progressive fallback only"
      }
    });
  });

  const mcpHandler = createMcpHandler(() => createStickerServer(config, storage, { allowLocalFileAccess: false }), {
    legacy: "stateless",
    responseMode: "auto"
  });
  const nodeMcpHandler = toNodeHandler(mcpHandler);

  app.all(mcpPaths, bearerAuth, async (req, res) => {
    const host = validateHostHeader(req.headers.host, config.allowedHosts);
    if (!host.ok) return void res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: host.message }, id: null });
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
      return void res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Origin not allowed" }, id: null });
    }
    await nodeMcpHandler(req, res, req.body);
  });

  return { app, storage, close: () => mcpHandler.close() };
}

export async function main() {
  const config = loadConfig({ requirePublicBaseUrl: process.env.NODE_ENV === "production" });
  const runtime = await createStickerHttpApp(config);
  const httpServer = runtime.app.listen(config.port, "0.0.0.0", () => {
    console.log(`sticker-mcp listening on :${config.port} (${config.mcpHttpPath})`);
  });
  httpServer.keepAliveTimeout = 70_000;
  httpServer.headersTimeout = 75_000;
  httpServer.on("close", () => void runtime.close());
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
