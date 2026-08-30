interface StickerData {
  imageUrl: string;
  name?: string;
  mimeType?: string;
}

declare global {
  interface Window {
    openai?: {
      toolOutput?: unknown;
      [key: string]: unknown;
    };
  }
}

type RpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

let rendered = false;
let nextRequestId = 1;
const pendingRequests = new Map<number, {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}>();

function coerce(data: unknown): StickerData | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (typeof value.imageUrl !== "string") return null;
  return {
    imageUrl: value.imageUrl,
    name: typeof value.name === "string" ? value.name : "",
    mimeType: typeof value.mimeType === "string" ? value.mimeType : "image/png"
  };
}

function render(data: StickerData, bridge: "mcp-app" | "chatgpt-compat") {
  rendered = true;
  const root = document.getElementById("root");
  if (!root) return;
  root.replaceChildren();
  root.dataset.bridge = bridge;

  const wrap = document.createElement("div");
  wrap.className = "sticker";
  const image = document.createElement("img");
  image.src = data.imageUrl;
  image.alt = data.name || "sticker";
  image.draggable = false;
  image.addEventListener("load", reportSize, { once: true });
  image.addEventListener("error", () => {
    const error = document.createElement("div");
    error.className = "err";
    error.textContent = "表情图加载失败";
    wrap.replaceChildren(error);
    reportSize();
  });
  wrap.appendChild(image);
  root.appendChild(wrap);
}

function renderToolResult(
  params: { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> },
  bridge: "mcp-app" | "chatgpt-compat"
) {
  let data = coerce(params?.structuredContent);
  if (!data && Array.isArray(params?.content)) {
    for (const block of params.content) {
      if (block.type !== "text" || !block.text) continue;
      try {
        data = coerce(JSON.parse(block.text));
        if (data) break;
      } catch {
        // Human-readable tool text is not expected to be JSON.
      }
    }
  }
  if (data) render(data, bridge);
}

function postMessage(message: Record<string, unknown>) {
  if (window.parent === window) return;
  window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
}

function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = nextRequestId++;
  postMessage({ id, method, params });
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    window.setTimeout(() => {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);
      reject(new Error(`${method} timed out`));
    }, 5000);
  });
}

function reportSize() {
  const root = document.getElementById("root");
  if (!root) return;
  const rect = root.getBoundingClientRect();
  postMessage({
    method: "ui/notifications/size-changed",
    params: { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
  });
}

function installMcpAppsBridge() {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data as RpcMessage;
    if (!message || message.jsonrpc !== "2.0") return;

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") {
      renderToolResult(
        (message.params ?? {}) as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> },
        "mcp-app"
      );
      return;
    }
    if (message.method === "ui/notifications/host-context-changed") {
      const context = (message.params ?? {}) as { locale?: unknown };
      if (typeof context.locale === "string") document.documentElement.lang = context.locale;
    }
  }, { passive: true });

  void request("ui/initialize", {
    appInfo: { name: "sticker-mcp", version: "1.2.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26"
  }).then((result) => {
    const host = result as { hostContext?: { locale?: unknown } } | undefined;
    if (typeof host?.hostContext?.locale === "string") document.documentElement.lang = host.hostContext.locale;
    postMessage({ method: "ui/notifications/initialized", params: {} });
  }).catch((error) => {
    console.debug("[sticker-mcp] MCP Apps initialization unavailable:", error);
  });

  const root = document.getElementById("root");
  if (root && typeof ResizeObserver !== "undefined") new ResizeObserver(reportSize).observe(root);
}

function installChatGptCompatibility() {
  const apply = () => {
    const data = coerce(window.openai?.toolOutput);
    if (data) render(data, "chatgpt-compat");
  };
  apply();
  window.addEventListener("openai:set_globals", apply as EventListener);
}

function boot() {
  // MCP Apps is the portable path. window.openai remains a feature-detected
  // compatibility path for ChatGPT hosts that have not moved to ui/* yet.
  installMcpAppsBridge();
  installChatGptCompatibility();
  window.setTimeout(() => {
    if (rendered) return;
    const root = document.getElementById("root");
    if (root) root.innerHTML = '<div class="err">等待宿主发送表情数据；若持续显示，请检查组件资源缓存。</div>';
    reportSize();
  }, 4000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
