import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicUrl, readBytesLimited } from "./url-policy.js";

test("public image policy rejects private and cloud-metadata targets", async () => {
  await assert.rejects(fetchPublicUrl("http://127.0.0.1/private"), /private or special-use image host/);
  await assert.rejects(fetchPublicUrl("http://169.254.169.254/latest/meta-data"), /private or special-use image host/);
  await assert.rejects(fetchPublicUrl("file:///etc/passwd"), /non-HTTP image URL/);
});

test("image response limit applies while streaming without Content-Length", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    }
  }));
  await assert.rejects(readBytesLimited(response, 10), /exceeds/);
  assert.deepEqual([...await readBytesLimited(new Response(new Uint8Array([1, 2, 3])), 10)], [1, 2, 3]);
});
