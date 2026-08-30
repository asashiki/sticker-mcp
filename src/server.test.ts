import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AppConfig } from "./config.js";
import { createStickerHttpApp } from "./server.js";
import { STICKER_VIEW_MIME, STICKER_VIEW_URI } from "./widget/sticker-view-html.js";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function config(dataDir: string): AppConfig {
  return {
    port: 0,
    publicBaseUrl: "https://sticker.example",
    inlineImages: false,
    dataDir,
    mcpHttpPath: "/mcp/sticker",
    allowedOrigins: [],
    allowedHosts: ["127.0.0.1"],
    adminToken: "admin-secret",
    authPassword: "",
    authTokenSecret: "",
    oauthScope: "tools:read tools:write",
    allowLegacyResourceOmission: false
  };
}

test("one endpoint serves MCP 2026 and legacy clients with portable widget metadata", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sticker-mcp-test-"));
  const runtime = await createStickerHttpApp(config(dataDir));
  const server = http.createServer(runtime.app);
  const baseUrl = await listen(server);
  const modern = new Client(
    { name: "sticker-modern-test", version: "0.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  try {
    await modern.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/sticker`)));
    assert.equal(modern.getNegotiatedProtocolVersion(), "2026-07-28");
    const tools = await modern.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "add_sticker",
      "create_sticker_upload",
      "list_available_stickers",
      "send_sticker"
    ]);
    const send = tools.tools.find((tool) => tool.name === "send_sticker");
    assert.ok(send?.outputSchema);
    assert.deepEqual((send?._meta as Record<string, unknown>).ui, { resourceUri: STICKER_VIEW_URI });
    assert.equal((send?._meta as Record<string, unknown>)["openai/outputTemplate"], STICKER_VIEW_URI);

    const resources = await modern.listResources();
    const widget = resources.resources.find((resource) => resource.uri === STICKER_VIEW_URI);
    assert.ok(widget);
    assert.equal(widget.mimeType, STICKER_VIEW_MIME);
    assert.equal((widget._meta as Record<string, unknown>)["openai/widgetDomain"], undefined);
    const read = await modern.readResource({ uri: STICKER_VIEW_URI });
    const html = (read.contents[0] as { text?: string }).text ?? "";
    assert.match(html, /ui\/initialize/);
    assert.match(html, /ui\/notifications\/initialized/);
    assert.ok(Buffer.byteLength(html, "utf8") < 20_000);

    const legacy = new Client({ name: "sticker-legacy-test", version: "0.0.0" });
    try {
      await legacy.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      assert.notEqual(legacy.getNegotiatedProtocolVersion(), "2026-07-28");
      assert.ok((await legacy.listTools()).tools.some((tool) => tool.name === "send_sticker"));
    } finally {
      await legacy.close();
    }

    const querySecret = await fetch(`${baseUrl}/api/stickers?token=admin-secret`);
    assert.equal(querySecret.status, 401);
    const authorized = await fetch(`${baseUrl}/api/stickers`, {
      headers: { authorization: "Bearer admin-secret" }
    });
    assert.equal(authorized.status, 200);
  } finally {
    await modern.close();
    await runtime.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("HTTP boundary rejects an unexpected Host header", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sticker-mcp-host-test-"));
  const runtime = await createStickerHttpApp(config(dataDir));
  const server = http.createServer(runtime.app);
  const baseUrl = await listen(server);
  try {
    const status = await new Promise<number>((resolveStatus, reject) => {
      const request = http.request(`${baseUrl}/mcp/sticker`, {
        method: "POST",
        headers: { Host: "evil.example", "Content-Type": "application/json" }
      }, (response) => {
        response.resume();
        response.on("end", () => resolveStatus(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    });
    assert.equal(status, 403);
  } finally {
    await runtime.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
