import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createStickerServer } from "./mcp.js";
import { StickerStorage } from "./storage.js";

const config = loadConfig();
const storage = new StickerStorage(config.dataDir);

async function main() {
  await storage.init();
  const server = createStickerServer(config, storage, { allowLocalFileAccess: true });
  await server.connect(new StdioServerTransport());
  console.error("sticker-mcp running on stdio");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
