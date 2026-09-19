import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { createStickerServer } from "./mcp.js";
import { StickerStorage } from "./storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("plain MCP client can discover and consume portable results", async () => {
 const config=loadConfig();
 const dir=await mkdtemp(join(tmpdir(),"sticker-compat-"));
 const storage=new StickerStorage(dir);await storage.init();
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=","base64");
 const sticker=await storage.addSticker("Happy",["happy"],png,"image/png");
 const server=createStickerServer(config,storage);
 const client=new Client({name:"plain-client",version:"1"},{capabilities:{}});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(a);await client.connect(b);
  const tools=await client.listTools();assert.ok(tools.tools.length);
  const resources=await client.listResources();const widget=resources.resources[0]!;
  const read=await client.readResource({uri:widget.uri});
  const resource=read.contents[0]!;
  assert.equal(resource.mimeType,"text/html;profile=mcp-app");
  assert.equal(resource._meta?.["openai/widgetDomain"],undefined);
  const result=await client.callTool({name:"send_sticker",arguments:{query:"happy",stickerId:sticker.id}});
  assert.notEqual(result.isError,true);
  assert.ok((result.content as Array<{type:string}>).some(x=>x.type==="image"));
  const add=tools.tools.find(t=>t.name==="add_sticker")!;
  assert.equal(add.outputSchema,undefined,"add_sticker must not claim upload-slot output");
  assert.ok(tools.tools.find(t=>t.name==="create_sticker_upload")?.outputSchema);
  const upload=await client.callTool({name:"create_sticker_upload",arguments:{name:"Test",emotions:["happy"]}});
  assert.notEqual(upload.isError,true);
 } finally {
  await client.close();await server.close();
  await rm(dir,{recursive:true,force:true});
 }
});
