import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { StickerStorage } from "./storage.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { z } from "zod";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");

const storage = new StickerStorage(DATA_DIR);

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

// Convert send_sticker to an App Tool so it opens the UI!
registerAppTool(
  server,
  "send_sticker",
  {
    title: "View Sticker",
    description: "Send a sticker to express emotion. E.g. 'happy', 'sad'.",
    inputSchema: {
      emotion: z.string().describe("The emotion or scene tag")
    },
    _meta: { ui: { resourceUri } },
  },
  async ({ emotion }) => {
    // We don't return the base64 to the AI anymore! We just tell the AI it worked.
    // The UI will intercept the tool call and display the sticker to the user!
    return {
      content: [
        {
          type: "text",
          text: `[System]: Successfully popped up the sticker UI for emotion '${emotion}'. The user is viewing the sticker now.`
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

async function main() {
  await storage.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sticker MCP server running on stdio");
}

main().catch(console.error);
