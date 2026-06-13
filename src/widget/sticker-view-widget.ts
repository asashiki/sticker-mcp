import { App } from "@modelcontextprotocol/ext-apps";

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

function tryChatGpt() {
  if (!window.openai) return;
  const apply = () => {
    const data = coerce(window.openai?.toolOutput);
    if (data) render(data, "chatgpt");
  };
  apply();
  window.addEventListener("openai:set_globals", apply as EventListener);
}

async function tryMcpApps() {
  try {
    const app = new App({ name: "sticker-mcp", version: "1.1.0" });
    /* Register before connect() — host may send toolresult during/right after handshake */
    app.ontoolresult = (params: { structuredContent?: unknown }) => {
      const data = coerce(params?.structuredContent);
      if (data) render(data, "claude");
    };
    await app.connect();
  } catch (e) {
    console.debug("[sticker] MCP Apps connect skipped:", e);
  }
}

function boot() {
  /* Run both bridges in parallel — rendered flag prevents double-render */
  tryChatGpt();
  void tryMcpApps();
  setTimeout(() => showError("等待表情数据..."), 4000)