import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { StickerStorage } from "./storage.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { z } from "zod";
import sharp from "sharp";
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");

const storage = new StickerStorage(DATA_DIR);

const server = new McpServer({
  name: "sticker-mcp",
  version: "1.0.0"
});

// We use the Vite-built single-file HTML which has the SDK bundled, avoiding CSP issues.
const resourceUri = "ui://sticker-view/mcp-app.html";

registerAppResource(
  server,
  "Sticker UI",
  resourceUri,
  { description: "View sticker inline" },
  async () => {
    const uiPath = path.join(__dirname, "..", "dist", "mcp-app.html");
    const content = await fs.readFile(uiPath, "utf-8");
    return {
      contents: [{ uri: resourceUri, mimeType: "text/html;profile=mcp-app", text: content }]
    };
  }
);

registerAppTool(
  server,
  "send_sticker",
  {
    title: "Send Sticker",
    description: "Send a sticker to express emotion. E.g. 'happy', 'sad'.",
    inputSchema: {
      emotion: z.string().describe("The emotion or scene tag")
    },
    _meta: { ui: { resourceUri } },
  },
  async ({ emotion }) => {
    return {
      content: [{ type: "text", text: `[System]: Displaying sticker for '${emotion}' in the UI.` }]
    };
  }
);

// Regular Tool: list_available_stickers
server.tool("list_available_stickers",
  "Get a list of all available stickers and their associated emotions. Use this to find an appropriate sticker before calling send_sticker.",
  {},
  async () => {
    const stickers = await storage.getAllStickers();
    const catalog = stickers.map(s => ({ name: s.name, emotions: s.emotions }));
    return {
      content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }]
    };
  }
);

// Regular Tool: Add sticker by local path
server.tool("add_sticker_by_path",
  "Add a new sticker from a local file path. Use this when the user asks to add an image as a sticker and provides a file path.",
  {
    name: z.string().describe("Name of the sticker"),
    emotions: z.array(z.string()).describe("List of emotions or tags"),
    filePath: z.string().describe("Absolute file path to the image on the user's computer")
  },
  async ({ name, emotions, filePath }) => {
    try {
      // Resolve path
      const absolutePath = path.resolve(filePath);
      const data = await fs.readFile(absolutePath);
      const base64Data = data.toString("base64");
      
      // Determine mimetype
      const ext = path.extname(absolutePath).toLowerCase();
      const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
                       ext === ".gif" ? "image/gif" : 
                       ext === ".webp" ? "image/webp" : "image/png";

      const sticker = await storage.addSticker(name, emotions, base64Data, mimeType);
      return {
        content: [{ type: "text", text: `Successfully added sticker '${name}' with id ${sticker.id}` }]
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Failed to read file or add sticker: ${e.message}` }],
        isError: true
      };
    }
  }
);

// Internal tool for the inline UI to fetch sticker data
server.tool(
  "_admin_manage_stickers",
  "Internal tool to fetch sticker data",
  {
    action: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    emotions: z.array(z.string()).optional(),
    base64Data: z.string().optional(),
    mimeType: z.string().optional(),
    emotion: z.string().optional()
  },
  async (params) => {
    const action = params.action;
    
    if (action === "list") {
      const stickers = await storage.getAllStickers();
      return { content: [{ type: "text", text: JSON.stringify(stickers) }] };
    }
    
    if (action === "add") {
      const sticker = await storage.addSticker(
        params.name as string, 
        params.emotions as string[], 
        params.base64Data as string, 
        params.mimeType as string
      );
      return { content: [{ type: "text", text: JSON.stringify(sticker) }] };
    }
    
    if (action === "delete") {
      const success = await storage.deleteSticker(params.id as string);
      return { content: [{ type: "text", text: JSON.stringify({ success }) }] };
    }

    if (action === "get_by_emotion") {
      const sticker = await storage.getStickerByEmotion(params.emotion as string);
      if (!sticker) return { content: [{ type: "text", text: "{}" }] };
      
      let buffer = await fs.readFile(sticker.filepath);
      let mimeType = sticker.mimeType;
      
      const SIZE_LIMIT = 700 * 1024;
      if (buffer.length > SIZE_LIMIT) {
        try {
          const isGif = mimeType === 'image/gif';
          buffer = await sharp(buffer, { animated: isGif })
            .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 75 })
            .toBuffer();
          mimeType = 'image/webp';
        } catch (e) {
          console.error("Compression failed", e);
        }
      }

      return { content: [{ type: "text", text: JSON.stringify({ ...sticker, base64Data: buffer.toString("base64"), mimeType }) }] };
    }

    return { content: [{ type: "text", text: "Unknown action" }] };
  }
);

// Local HTTP server to serve images, Admin UI, and SSE
let HTTP_PORT = process.env.PORT ? parseInt(process.env.PORT) : (process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT) : 0);
let sseTransport: StreamableHTTPServerTransport | null = null;

async function startHttpServer() {
  return new Promise<void>((resolve, reject) => {
    const app = express();
    app.use(cors());

    // Serve Images
    app.get('/images/:filename', async (req, res) => {
      const filename = req.params.filename;
      const safePath = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, '');
      const filepath = path.join(DATA_DIR, 'images', safePath);
      
      try {
        const data = await fs.readFile(filepath);
        const ext = path.extname(filepath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' :
                         ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                         ext === '.gif' ? 'image/gif' :
                         ext === '.webp' ? 'image/webp' : 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);
        res.send(data);
      } catch (e) {
        res.status(404).send('Not found');
      }
    });

    // Serve Admin UI (dist/mcp-app.html) at /admin
    app.get('/admin', async (req, res) => {
      try {
        const uiPath = path.join(__dirname, "..", "dist", "mcp-app.html");
        const content = await fs.readFile(uiPath, "utf-8");
        res.setHeader('Content-Type', 'text/html');
        res.send(content);
      } catch (e) {
        res.status(404).send('Admin UI not built. Run npm run build.');
      }
    });

    // SSE endpoint
    app.get('/mcp', async (req, res) => {
      console.error("New SSE connection established");
      sseTransport = new StreamableHTTPServerTransport({ endpoint: '/mcp/message' });
      await server.connect(sseTransport);
      await sseTransport.handleSse(req, res);
    });

    // Message endpoint
    app.post('/mcp/message', express.json(), async (req, res) => {
      if (sseTransport) {
        await sseTransport.handlePostMessage(req, res);
      } else {
        res.status(400).send("No active transport");
      }
    });

    const httpServer = app.listen(HTTP_PORT, '0.0.0.0', () => {
      const addr = httpServer.address();
      if (addr && typeof addr === 'object') {
        HTTP_PORT = addr.port;
      }
      console.error(`HTTP server listening on port ${HTTP_PORT}`);
      resolve();
    });

    httpServer.on('error', (err: any) => {
      console.error('HTTP Server error:', err);
      reject(err);
    });
  });
}

async function main() {
  await storage.init();
  await startHttpServer();
  
  if (process.env.TRANSPORT === "sse") {
    console.error(`Sticker MCP server running on SSE. Connect via http://127.0.0.1:${HTTP_PORT}/mcp`);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Sticker MCP server running on stdio");
  }
}

main().catch(console.error);
