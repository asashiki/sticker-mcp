import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource } from "@modelcontextprotocol/ext-apps/server/index.js";
import { StickerStorage } from "./storage.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { z } from "zod";

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
  resourceUri,
  async () => {
    const uiPath = path.join(__dirname, "..", "dist", "mcp-app.html");
    const content = await fs.readFile(uiPath, "utf-8");
    return content;
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
    const base64 = await storage.getStickerBase64(sticker);
    return {
      content: [
        {
          type: "image",
          data: base64,
          mimeType: sticker.mimeType
        }
      ]
    };
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
      type: "object",
      properties: {
        action: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        emotions: { type: "array", items: { type: "string" } },
        base64Data: { type: "string" },
        mimeType: { type: "string" }
      },
      required: ["action"]
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

async function main() {
  await storage.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sticker MCP server running on stdio");
}

main().catch(console.error);
