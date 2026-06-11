import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import type { AppConfig } from "./config.js";
import { imageOrigins } from "./config.js";
import type { Sticker, StickerStorage } from "./storage.js";
import { STICKER_VIEW_MIME, STICKER_VIEW_URI, stickerViewHtml } from "./widget/sticker-view-html.js";

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

function cspMeta(config: AppConfig) {
  const origins = imageOrigins(config);
  return {
    ui: { csp: { resourceDomains: origins, connectDomains: origins } },
    "openai/widgetCSP": { resource_domains: origins, connect_domains: origins }
  };
}

export interface StickerPayload {
  id: string;
  name: string;
  emotions: string[];
  /** Public HTTPS URL when PUBLIC_BASE_URL is set, otherwise a base64 data URI. */
  imageUrl: string;
  mimeType: string;
  matchedQuery: string;
}

async function toPayload(
  config: AppConfig,
  storage: StickerStorage,
  sticker: Sticker,
  matchedQuery: string
): Promise<StickerPayload> {
  let imageUrl: string;
  let mimeType = sticker.mimeType;
  if (config.publicBaseUrl) {
    imageUrl = `${config.publicBaseUrl}/images/${storage.publicFilename(sticker)}`;
  } else {
    const inline = await storage.readForInline(sticker);
    mimeType = inline.mimeType;
    imageUrl = `data:${mimeType};base64,${inline.buffer.toString("base64")}`;
  }
  return { id: sticker.id, name: sticker.name, emotions: sticker.emotions, imageUrl, mimeType, matchedQuery };
}

async function catalogText(storage: StickerStorage): Promise<string> {
  const stickers = await storage.getAllStickers();
  if (stickers.length === 0) {
    return "Sticker library is empty. You can add stickers with add_sticker_by_url, or the user can open the admin page.";
  }
  const catalog = stickers.map((s) => ({ id: s.id, name: s.name, tags: s.emotions }));
  return JSON.stringify(catalog, null, 2);
}

async function detectMime(buffer: Buffer, fallback: string): Promise<string> {
  try {
    const meta = await sharp(buffer).metadata();
    const map: Record<string, string> = {
      png: "image/png",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      avif: "image/avif"
    };
    const detected = meta.format ? map[meta.format] : undefined;
    if (detected) return detected;
  } catch {
    // fall through to header-based fallback
  }
  return fallback;
}

export interface CreateServerOptions {
  /** Tools that read the server's local filesystem are only safe on local stdio transport. */
  allowLocalFileAccess?: boolean;
}

export function createStickerServer(
  config: AppConfig,
  storage: StickerStorage,
  options: CreateServerOptions = {}
): McpServer {
  const server = new McpServer({ name: "sticker-mcp", version: "1.1.0" });
  const csp = cspMeta(config);

  server.registerResource(
    "sticker-view",
    STICKER_VIEW_URI,
    {
      title: "Sticker View",
      description: "Inline sticker rendering for chat.",
      mimeType: STICKER_VIEW_MIME,
      _meta: csp
    },
    async () => ({
      contents: [
        { uri: STICKER_VIEW_URI, mimeType: STICKER_VIEW_MIME, text: stickerViewHtml(), _meta: csp }
      ]
    })
  );

  server.registerTool(
    "send_sticker",
    {
      title: "Send Sticker",
      description:
        "Send an expressive sticker (meme/表情包) that renders as an image in the chat. " +
        "Use this proactively whenever a sticker would make the reply more fun or expressive — " +
        "reacting to good/bad news, greeting, teasing, celebrating, comforting. " +
        "Pick `query` based on the conversation's mood (an emotion or scene word such as 开心 / 委屈 / 干杯 / good night). " +
        "If you have not seen the library yet in this conversation, call list_available_stickers first and choose a tag from it. " +
        "If several stickers match, a random one is chosen — you can pass stickerId to force an exact sticker.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(60)
          .describe("Emotion/scene tag or sticker name to match, e.g. '开心', 'sad', '猫猫疑惑'."),
        stickerId: z.string().optional().describe("Exact sticker id from list_available_stickers; overrides query matching.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      _meta: {
        ui: { resourceUri: STICKER_VIEW_URI },
        "openai/outputTemplate": STICKER_VIEW_URI
      }
    },
    async ({ query, stickerId }) => {
      let sticker: Sticker | null = null;
      if (stickerId) {
        sticker = await storage.getById(stickerId);
        if (!sticker) {
          return {
            content: [{ type: "text", text: `No sticker with id '${stickerId}'. Current library:\n${await catalogText(storage)}` }],
            isError: true
          };
        }
      } else {
        const { picked } = await storage.findByQuery(query);
        sticker = picked;
        if (!sticker) {
          return {
            content: [
              {
                type: "text",
                text:
                  `No sticker matched '${query}'. Pick a tag from the current library and retry:\n` +
                  (await catalogText(storage))
              }
            ],
            isError: true
          };
        }
      }

      const payload = await toPayload(config, storage, sticker, query);
      return {
        content: [
          {
            type: "text",
            text: `Sent sticker '${sticker.name}' (tags: ${sticker.emotions.join(", ")}). It is now visible in the chat — no need to describe or re-send it.`
          }
        ],
        structuredContent: payload as unknown as Record<string, unknown>,
        _meta: { ui: { resourceUri: STICKER_VIEW_URI } }
      };
    }
  );

  server.registerTool(
    "list_available_stickers",
    {
      title: "List Available Stickers",
      description:
        "List every sticker in the library with its id, name and emotion/scene tags. " +
        "Call this once early in a conversation (or when send_sticker reports no match) so you know which moods you can express; " +
        "afterwards you can call send_sticker directly.",
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => ({
      content: [{ type: "text", text: await catalogText(storage) }]
    })
  );

  server.registerTool(
    "add_sticker_by_url",
    {
      title: "Add Sticker From URL",
      description:
        "Download an image from an https:// URL (or accept a data: URI) and save it as a new sticker. " +
        "Use this when the user shares an image link and asks to add it as a sticker (帮我把这张图加成表情包). " +
        "Ask the user (or infer from the image) a short name plus 1-5 emotion/scene tags describing when to use it. " +
        "Supported formats: png / jpeg / gif / webp / avif, max 8MB.",
      inputSchema: {
        name: z.string().min(1).max(60).describe("Short display name, e.g. '猫猫震惊'."),
        emotions: z
          .array(z.string().min(1).max(30))
          .min(1)
          .max(8)
          .describe("Emotion/scene tags describing when to send it, e.g. ['震惊', '吃惊', 'surprised']."),
        url: z.string().min(8).describe("https:// image URL, or a data:image/...;base64,... URI.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ name, emotions, url }) => {
      try {
        let buffer: Buffer;
        let mimeType: string;

        if (url.startsWith("data:image/")) {
          const match = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url);
          if (!match || !match[1] || !match[2]) throw new Error("Malformed data URI.");
          mimeType = match[1];
          buffer = Buffer.from(match[2], "base64");
        } else {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            throw new Error("Only http(s) or data:image URLs are supported.");
          }
          const res = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
          if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
          const declared = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
          const bytes = Buffer.from(await res.arrayBuffer());
          if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("Image exceeds the 8MB limit.");
          buffer = bytes;
          mimeType = declared;
        }

        mimeType = await detectMime(buffer, mimeType);
        if (!ALLOWED_MIME.includes(mimeType)) {
          throw new Error(`Unsupported image type '${mimeType}'. Allowed: ${ALLOWED_MIME.join(", ")}`);
        }
        if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error("Image exceeds the 8MB limit.");

        const sticker = await storage.addSticker(name, emotions, buffer, mimeType);
        return {
          content: [
            {
              type: "text",
              text: `Added sticker '${sticker.name}' (id ${sticker.id}, tags: ${sticker.emotions.join(", ")}). You can send it right away with send_sticker.`
            }
          ]
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Failed to add sticker: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true
        };
      }
    }
  );

  if (options.allowLocalFileAccess) {
    server.registerTool(
      "add_sticker_by_path",
      {
        title: "Add Sticker From Local Path",
        description:
          "Add a new sticker from an image file on this computer (local/stdio mode only). " +
          "Use when the user gives a local file path. Supported: png / jpeg / gif / webp / avif, max 8MB.",
        inputSchema: {
          name: z.string().min(1).max(60).describe("Short display name."),
          emotions: z.array(z.string().min(1).max(30)).min(1).max(8).describe("Emotion/scene tags."),
          filePath: z.string().describe("Absolute path to the image file.")
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      async ({ name, emotions, filePath }) => {
        try {
          const absolutePath = path.resolve(filePath);
          const buffer = await fs.readFile(absolutePath);
          if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error("Image exceeds the 8MB limit.");
          const ext = path.extname(absolutePath).toLowerCase();
          const fallback =
            ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
            ext === ".gif" ? "image/gif" :
            ext === ".webp" ? "image/webp" :
            ext === ".avif" ? "image/avif" : "image/png";
          const mimeType = await detectMime(buffer, fallback);
          if (!ALLOWED_MIME.includes(mimeType)) throw new Error(`Unsupported image type '${mimeType}'.`);
          const sticker = await storage.addSticker(name, emotions, buffer, mimeType);
          return {
            content: [{ type: "text", text: `Added sticker '${sticker.name}' (id ${sticker.id}).` }]
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `Failed: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true
          };
        }
      }
    );
  }

  // Internal tool used by the in-host admin widget (hidden-ish: underscore prefix).
  server.registerTool(
    "_admin_manage_stickers",
    {
      title: "Sticker Admin (internal)",
      description: "Internal endpoint for the sticker admin widget. Not intended for direct AI use.",
      inputSchema: {
        action: z.enum(["list", "add", "update", "delete"]),
        id: z.string().optional(),
        name: z.string().optional(),
        emotions: z.array(z.string()).optional(),
        base64Data: z.string().optional(),
        mimeType: z.string().optional()
      }
    },
    async (params) => {
      if (params.action === "list") {
        const stickers = await storage.withThumbs(await storage.getAllStickers());
        const safe = stickers.map(({ filepath: _fp, ...rest }) => rest);
        return { content: [{ type: "text", text: JSON.stringify(safe) }] };
      }
      if (params.action === "add") {
        if (!params.name || !params.emotions || !params.base64Data || !params.mimeType) {
          return { content: [{ type: "text", text: "Missing fields for add." }], isError: true };
        }
        const sticker = await storage.addStickerFromBase64(params.name, params.emotions, params.base64Data, params.mimeType);
        return { content: [{ type: "text", text: JSON.stringify({ id: sticker.id }) }] };
      }
      if (params.action === "update") {
        if (!params.id) return { content: [{ type: "text", text: "Missing id." }], isError: true };
        const sticker = await storage.updateSticker(params.id, { name: params.name, emotions: params.emotions });
        return { content: [{ type: "text", text: JSON.stringify({ success: Boolean(sticker) }) }] };
      }
      if (params.action === "delete") {
        if (!params.id) return { content: [{ type: "text", text: "Missing id." }], isError: true };
        const success = await storage.deleteSticker(params.id);
        return { content: [{ type: "text", text: JSON.stringify({ success }) }] };
      }
      return { content: [{ type: "text", text: "Unknown action" }], isError: true };
    }
  );

  return server;
}
