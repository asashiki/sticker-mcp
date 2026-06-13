import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { setupOAuth } from "./oauth.js";
import { createStickerServer } from "./mcp.js";
import { StickerStorage } from "./storage.js";

const config = loadConfig();
const storage = new StickerStorage(config.dataDir);
const mcpPaths = Array.from(new Set([config.mcpHttpPath, "/mcp"]));

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif"
};

function adminAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.adminToken) {
    next();
    return;
  }
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const queryToken = typeof req.query.token === "string" ? req.query.token : null;
  if (bearer === config.adminToken || queryToken === config.adminToken) {
    next();
    return;
  }
  res.status(401).json({ error: "Admin token required" });
}

async function main() {
  await storage.init();

  const app = express();
  app.set("trust proxy", true);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      }
    })
  );
  app.use(express.json({ limit: "12mb" }));

  const bearerAuth = setupOAuth(app, config.publicBaseUrl, "sticker-mcp");

  // --- sticker images (referenced by widget structuredContent.imageUrl) ---
  app.get("/images/:filename", async (req, res) => {
    const safe = path.basename(String(req.params.filename));
    const filepath = path.join(config.dataDir, "images", safe);
    try {
      const data = await fs.readFile(filepath);
      res.setHeader("Content-Type", MIME_BY_EXT[path.extname(safe).toLowerCase()] ?? "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(data);
    } catch {
      res.status(404).send("Not found");
    }
  });

  // --- standalone admin page ---
  const here = path.dirname(fileURLToPath(import.meta.url));
  app.get(["/admin", "/admin/"], adminAuth, async (_req, res) => {
    // dist/server.js sits next to dist/admin/admin.html; in dev it's src/admin/admin.html.
    for (const candidate of [path.join(here, "admin/admin.html"), path.join(here, "../src/admin/admin.html")]) {
      try {
        const htmlContent = await fs.readFile(candidate, "utf-8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(htmlContent);
        return;
      } catch {
        // try next candidate
      }
    }
    res.status(404).send("Admin page not built.");
  });

  // --- REST API for the admin page ---
  app.get("/api/stickers", adminAuth, async (_req, res) => {
    const stickers = await storage.withThumbs(await storage.getAllStickers());
    res.json(
      stickers.map((s) => ({
        id: s.id,
        name: s.name,
        emotions: s.emotions,
        addedAt: s.addedAt ?? null,
        thumb: s.thumb,
        imageUrl: `images/${storage.publicFilename(s)}`
      }))
    );
  });

  app.post("/api/stickers", adminAuth, async (req, res) => {
    const { name, emotions, base64Data, mimeType } = req.body ?? {};
    if (typeof name !== "string" || !Array.isArray(emotions) || typeof base64Data !== "string" || typeof mimeType !== "string") {
      res.status(400).json({ error: "name, emotions[], base64Data, mimeType are required" });
      return;
    }
    try {
      const sticker = await storage.addStickerFromBase64(name.trim(), emotions, base64Data, mimeType);
      res.status(201).json({ id: sticker.id });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "add failed" });
    }
  });

  app.patch("/api/stickers/:id", adminAuth, async (req, res) => {
    const { name, emotions } = req.body ?? {};
    const sticker = await storage.updateSticker(String(req.params.id), {
      name: typeof name === "string" ? name.trim() : undefined,
      emotions: Array.isArray(emotions) ? emotions : undefined
    });
    if (!sticker) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ success: true });
  });

  app.delete("/api/stickers/:id", adminAuth, async (req, res) => {
    const success = await storage.deleteSticker(String(req.params.id));
    res.status(success ? 200 : 404).json({ success });
  });

  app.get("/healthz", async (_req, res) => {
    const stickers = await storage.getAllStickers();
    res.json({
      ok: true,
      service: "sticker-mcp",
      transport: "streamable-http",
      stickers: stickers.length,
      publicBaseUrl: config.publicBaseUrl,
      mcpEndpoint: `${config.publicBaseUrl ?? `http://127.0.0.1:${config.port}`}${config.mcpHttpPath}`,
      adminProtected: Boolean(config.adminToken)
    });
  });

  // --- Streamable HTTP MCP endpoint (stateless: fresh server per request) ---
  app.all(mcpPaths, bearerAuth, async (req, res) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }

    const server = createStickerServer(config, storage, { allowLocalFileAccess: false });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : "Internal server error" },
          id: null
        });
      }
    } finally {
      void transport.close();
      void server.close();
    }
  });

  const httpServer = app.listen(config.port, "0.0.0.0", () => {
    console.log(`sticker-mcp listening on :${config.port}`);
    console.log(`MCP endpoint: ${config.mcpHttpPath} | admin: /admin | images: /images/*`);
    if (!config.publicBaseUrl) {
      console.warn("PUBLIC_BASE_URL is not set — stickers will be inlined as base64 (fine locally, set it for web AI clients).");
    }
  });
  httpServer.keepAliveTimeout = 70_000;
  httpServer.headersTimeout = 75_000;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
