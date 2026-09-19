/** Rendering-only MCP Apps bridge. Host notifications must not remount media. */
export function connectWidget<T>(name: string, coerce: (value: unknown) => T | null,
  render: (data: T, platform: "chatgpt" | "claude") => void, cleanup: () => void) {
  let disposed = false, standard = false, ready = false, signature = "", lastHeight = -1, frame = 0;
  const win = window as Window & { openai?: Record<string, any> };
  const post = (message: object) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const size = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed) return;
      const height = Math.ceil(document.getElementById("root")?.getBoundingClientRect().height ?? 0);
      if (height <= 0 || height === lastHeight) return;
      if (ready) { lastHeight = height; post({ method: "ui/notifications/size-changed", params: { height } }); }
      else if (typeof win.openai?.notifyIntrinsicHeight === "function") {
        lastHeight = height; win.openai.notifyIntrinsicHeight(height);
      }
    });
  };
  const context = (ctx: any) => {
    if (ctx?.theme === "light" || ctx?.theme === "dark") {
      document.documentElement.dataset.theme = ctx.theme;
      document.documentElement.style.colorScheme = ctx.theme;
    }
    size();
  };
  const parse = (value: unknown): T | null => {
    if (typeof value === "string") { try { return coerce(JSON.parse(value)); } catch { return null; } }
    return coerce(value);
  };
  const accept = (value: unknown, source: "standard" | "legacy") => {
    if (disposed || (source === "legacy" && standard)) return;
    const data = parse(value);
    if (!data) return;
    if (source === "standard") standard = true;
    const next = JSON.stringify(data);
    if (signature === next) return;
    signature = next;
    cleanup();
    render(data, win.openai ? "chatgpt" : "claude");
    size();
  };
  const result = (params: any) => {
    if (params?.isError) return;
    if (parse(params?.structuredContent)) { accept(params.structuredContent, "standard"); return; }
    for (const block of params?.content ?? []) {
      if (block.type === "text" && parse(block.text)) { accept(block.text, "standard"); break; }
    }
  };
  const globals = (event?: Event) => {
    const values = (event as CustomEvent | undefined)?.detail?.globals ?? win.openai;
    context(values);
    accept(values?.toolOutput ?? win.openai?.toolOutput, "legacy");
  };
  const observer = new ResizeObserver(size);
  const root = document.getElementById("root");
  if (root) observer.observe(root);
  const dispose = () => {
    if (disposed) return;
    disposed = true; cleanup(); observer.disconnect(); cancelAnimationFrame(frame);
    window.removeEventListener("openai:set_globals", globals);
    window.removeEventListener("message", message);
  };
  const message = (event: MessageEvent) => {
    if (disposed || event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
    const m = event.data;
    if (m.id === "widget-init" && m.result) {
      ready = true; lastHeight = -1; context(m.result.hostContext);
      post({ method: "ui/notifications/initialized", params: {} }); size();
    } else if (m.method === "ui/notifications/tool-result") result(m.params);
    else if (m.method === "ui/notifications/host-context-changed") context(m.params);
    else if (m.method === "ui/resource-teardown") {
      dispose(); if (m.id !== undefined) post({ id: m.id, result: {} });
    }
  };
  window.addEventListener("message", message);
  window.addEventListener("openai:set_globals", globals);
  window.addEventListener("pagehide", dispose, { once: true });
  globals();
  post({ id: "widget-init", method: "ui/initialize", params: {
    protocolVersion: "2026-01-26", appInfo: { name, version: "1.0.0" }, appCapabilities: {}
  } });
}
