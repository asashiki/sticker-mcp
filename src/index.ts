import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { StickerStorage } from "./storage.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { z } from "zod";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");

const storage = new StickerStorage(DATA_DIR);

// We will run a local HTTP server to serve images and bypass the 1MB tool limit
const HTTP_PORT = 34567;
const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}`;

const server = new McpServer({
  name: "sticker-mcp",
  version: "1.0.0"
});

const resourceUri = "ui://sticker-admin/mcp-app.html";

// Serve the bundled UI HTML
registerAppResource(
  server,
  "Sticker Admin UI",
  resourceUri,
  { description: "Manage stickers via UI" },
  async () => {
    const uiPath = path.join(__dirname, "..", "dist", "mcp-app.html");
    const content = await fs.readFile(uiPath, "utf-8");
    return {
      contents: [
        {
          uri: resourceUri,
          mimeType: "text/html",
          text: content
        }
      ]
    };
  }
);

// Register Tool: send_sticker
server.tool("send_sticker",
  "Send a sticker to express emotion. E.g. 'happy', 'sad'.",
  {
    emotion: z.string().describe("The emotion or scene tag")
  },
  async ({ emotion }) => {
    const sticker = await storage.getStickerByEmotion(emotion);
    if (!sticker) {
      return {
        content: [{ type: "text", text: `No sticker found for emotion: ${emotion}` }]
      };
    }
    
    // Instead of returning base64 which hits the 1MB limit, 
    // we return a markdown link pointing to our local HTTP server.
    const filename = path.basename(sticker.filepath);
    return {
      content: [
        {
          type: "text",
          text: `![${sticker.name}](${HTTP_URL}/images/${filename})`
        }
      ]
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

// We still need the internal tool to interact with the UI, which uses registerAppTool
registerAppTool(
  server,
  "_admin_manage_stickers",
  {
    title: "Manage Stickers",
    description: "Internal UI to add or delete stickers.",
    inputSchema: {
      action: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      emotions: z.array(z.string()).optional(),
      base64Data: z.string().optional(),
      mimeType: z.string().optional()
    },
    _meta: { ui: { resourceUri } },
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

    return { content: [{ type: "text", text: "Unknown action" }] };
  }
);

async function startHttpServer() {
  return new Promise<void>((resolve) => {
    const httpServer = http.createServer(async (req, res) => {
      if (req.url?.startsWith('/images/')) {
        const filename = req.url.replace('/images/', '');
        // Prevent path traversal
        const safePath = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, '');
        const filepath = path.join(DATA_DIR, 'images', safePath);
        
        try {
          const data = await fs.readFile(filepath);
          const ext = path.extname(filepath).toLowerCase();
          const mimeType = ext === '.png' ? 'image/png' :
                           ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                           ext === '.gif' ? 'image/gif' : 'application/octet-stream';
          res.writeHead(200, { 
            'Content-Type': mimeType,
            'Access-Control-Allow-Origin': '*'
          });
          res.end(data);
        } catch (e) {
          res.writeHead(404);
          res.end('Not found');
        }
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    
    httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
      console.error(`HTTP server listening on ${HTTP_URL}`);
      resolve();
    });
  });
}

async function main() {
  await storage.init();
  await startHttpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sticker MCP server running on stdio");
}

main().catch(console.error);
