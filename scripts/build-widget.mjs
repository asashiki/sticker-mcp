import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist/widget");

await build({
  entry: [resolve(root, "src/widget/sticker-view-widget.ts")],
  outDir,
  format: ["iife"],
  globalName: "StickerViewWidget",
  platform: "browser",
  target: "es2020",
  bundle: true,
  minify: true,
  sourcemap: false,
  clean: true,
  dts: false,
  splitting: false,
  outExtension: () => ({ js: ".global.js" })
});
