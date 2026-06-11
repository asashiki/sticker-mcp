/**
 * Backwards-compatible entry point.
 * TRANSPORT=http  -> Streamable HTTP server (src/server.ts)
 * anything else   -> stdio (src/stdio.ts)
 */
if (process.env.TRANSPORT === "http") {
  await import("./server.js");
} else {
  await import("./stdio.js");
}
