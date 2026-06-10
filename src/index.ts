import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { StickerStorage } from "./storage.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { z } from "zod";
import sharp from "sharp";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");

const storage = new StickerStorage(DATA_DIR);

const server = new McpServer({
  name: "sticker-mcp",
  version: "1.0.0"
});

// Removed complex Admin UI resource

const INLINE_UI_HTML = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; padding: 0; display: flex; justify-content: center; align-items: center; background: transparent; overflow: hidden; }
    img { max-width: 100%; max-height: 100vh; object-fit: contain; }
  </style>
</head>
<body>
  <img id="sticker" src="" style="display: none;" />
  <div id="error" style="color: white; font-family: sans-serif; display: none;"></div>
  <script type="module">
    import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps@0.1.0/dist/app.js";
    const app = new App();
    app.ontoolinput = async (params) => {
      const emotion = params.arguments.emotion;
      try {
        const result = await app.callTool({
          name: "_admin_manage_stickers",
          arguments: { action: "get_by_emotion", emotion }
        });
        const content = JSON.parse(result.content[0].text);
        if (content.base64Data) {
          document.getElementById('sticker').src = \`data:\${content.mimeType};base64,\${content.base64Data}\`;
          document.getElementById('sticker').style.display = 'block';
        } else {
          document.getElementById('error').textContent = 'Sticker not found';
          document.getElementById('error').style.display = 'block';
        }
      } catch (e) {
        document.getElementById('error').textContent = e.message;
        document.getElementById('error').style.display = 'block';
      }
    };
  </script>
</body>
</html>`;

const inlineUiUri = "ui://sticker-view/index.html";

registerAppResource(
  server,
  "Sticker Inline View",
  inlineUiUri,
  { description: "View sticker inline" },
  async () => {
    return {
      contents: [{ uri: inlineUiUri, mimeType: "text/html;profile=mcp-app", text: INLINE_UI_HTML }]
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
    _meta: { ui: { resourceUri: inlineUiUri } },
  },
  async ({ emotion }) => {
    return {
      content: [{ type: "text", text: `[System]: Displaying sticker for '${emotion}' in the UI.` }]
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
    emotion: z.string().optional()
  },
  async (params) => {
    const action = params.action;
    
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

// Local HTTP server to serve images
let HTTP_PORT = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT) : 0;
async function startHttpServer() {
  return new Promise<void>((resolve, reject) => {
    const httpServer = http.createServer(async (req, res) => {
      // Handle CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.url?.startsWith('/images/')) {
        const filename = req.url.replace('/images/', '');
        const safePath = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, '');
        const filepath = path.join(DATA_DIR, 'images', safePath);
        
        try {
          const data = await fs.readFile(filepath);
          const ext = path.extname(filepath).toLowerCase();
          const mimeType = ext === '.png' ? 'image/png' :
                           ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                           ext === '.gif' ? 'image/gif' :
                           ext === '.webp' ? 'image/webp' : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mimeType });
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
    
    httpServer.on('error', (err: any) => {
      console.error('HTTP Server error:', err);
      if (err.code === 'EADDRINUSE') {
        // If it's in use (which shouldn't happen with port 0, but just in case)
        resolve();
      } else {
        reject(err);
      }
    });

    httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (addr && typeof addr === 'object') {
        HTTP_PORT = addr.port;
      }
      console.error(`HTTP static server listening on port ${HTTP_PORT}`);
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
