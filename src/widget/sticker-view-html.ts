import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Bump the version suffix whenever the widget changes — hosts cache ui:// resources by URI. */
export const STICKER_VIEW_URI = "ui://sticker-mcp/view-v8.html";
export const STICKER_VIEW_MIME = "text/html;profile=mcp-app";

const CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: transparent;
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC",
                      "Hiragino Sans", "Microsoft YaHei UI", "Noto Sans SC", sans-serif; }
  #root { padding: 4px 0; }
  .sticker { display: inline-block; }
  .sticker img {
    display: block; width: auto; height: auto; max-width: min(200px, 100vw); max-height: 200px;
    border-radius: 14px; user-select: none; -webkit-user-drag: none;
    animation: pop .32s cubic-bezier(.21, 1.25, .5, 1) both;
  }
  @keyframes pop {
    from { transform: scale(.72); opacity: 0; }
    to   { transform: scale(1);   opacity: 1; }
  }
  .err { color: #b8aabb; font-size: 13px; padding: 6px 2px; }
  @media (prefers-reduced-motion: reduce) { .sticker img { animation: none; } }
`;

let cachedJs: string | null = null;

function widgetJs(): string {
  if (cachedJs !== null) return cachedJs;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const jsPath = [
      resolve(here, "widget/sticker-view-widget.global.js"),
      resolve(process.cwd(), "dist/widget/sticker-view-widget.global.js")
    ].find((candidate) => {
      try { readFileSync(candidate); return true; } catch { return false; }
    });
    if (!jsPath) throw new Error("Widget bundle is missing");
    cachedJs = readFileSync(jsPath, "utf8");
  } catch {
    cachedJs = `document.getElementById("root").innerHTML='<div class="err">表情组件未构建（npm run build）</div>';`;
  }
  return cachedJs;
}

export function stickerViewHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style></head>
<body><div id="root"></div><script>${widgetJs()}</script></body></html>`;
}
