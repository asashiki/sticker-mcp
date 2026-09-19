import { connectWidget } from "./host-bridge.js";

interface StickerData {
  imageUrl: string;
  name?: string;
  mimeType?: string;
}

declare global {
  interface Window {
    openai?: {
      toolOutput?: unknown;
      [k: string]: unknown;
    };
  }
}

function coerce(data: unknown): StickerData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.imageUrl !== "string") return null;
  return {
    imageUrl: d.imageUrl,
    name: typeof d.name === "string" ? d.name : "",
    mimeType: typeof d.mimeType === "string" ? d.mimeType : "image/png"
  };
}

let rendered = false;
let cleanupCurrent = () => {};

function render(data: StickerData, platform: "chatgpt" | "claude") {
  rendered = true;
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";
  root.className = `platform-${platform}`;

  const wrap = document.createElement("div");
  wrap.className = "sticker";

  const img = document.createElement("img");
  img.src = data.imageUrl;
  img.alt = data.name || "sticker";
  img.draggable = false;
  img.addEventListener("error", () => {
    wrap.innerHTML = `<div class="err">表情图加载失败</div>`;
  });

  wrap.appendChild(img);
  root.appendChild(wrap);
}

function showError(msg: string) {
  if (rendered) return;
  const root = document.getElementById("root");
  if (root) root.innerHTML = `<div class="err">${msg}</div>`;
}

function boot() {
  connectWidget("sticker-mcp", coerce, render, () => cleanupCurrent());
  setTimeout(() => showError("等待工具数据…"), 4000);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
