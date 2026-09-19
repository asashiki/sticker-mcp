import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Run the shipped bundle against a small instrumented DOM. Media decoding and
// layout still require a browser; these tests assert lifecycle and host traffic.
class Node {
  children: Node[] = [];
  listeners = new Map<string, Function[]>();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, any> = { setProperty: (k: string, v: string) => { this.style[k] = v; } };
  classes = new Set<string>();
  classList = {
    add: (k: string) => this.classes.add(k),
    remove: (k: string) => this.classes.delete(k),
    toggle: (k: string, on = !this.classes.has(k)) => on ? this.classes.add(k) : this.classes.delete(k)
  };
  className = "";
  textContent = "";
  src = "";
  value = "0";
  hidden = false;
  disabled = false;
  paused = true;
  duration = 240;
  currentTime = 0;
  height = 160;
  playError: Error | null = null;
  pauseCalls = 0;
  constructor(public tag: string) {}
  set innerHTML(_: string) { this.children = []; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  appendChild(node: Node) { this.append(node); return node; }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  setAttribute(k: string, v: string) { this.attributes.set(k, v); }
  removeAttribute(k: string) { this.attributes.delete(k); if (k === "src") this.src = ""; }
  addEventListener(k: string, fn: Function) { this.listeners.set(k, [...(this.listeners.get(k) ?? []), fn]); }
  removeEventListener(k: string, fn: Function) { this.listeners.set(k, (this.listeners.get(k) ?? []).filter(f => f !== fn)); }
  dispatch(k: string, event: unknown = {}) { for (const fn of this.listeners.get(k) ?? []) fn(event); }
  getBoundingClientRect() { return { width: 600, height: this.height, left: 0 }; }
  scrollIntoView() {}
  load() {}
  pause() { this.pauseCalls++; this.paused = true; this.dispatch("pause"); }
  play() {
    if (this.playError) return Promise.reject(this.playError);
    this.paused = false; this.dispatch("play"); this.dispatch("playing");
    return Promise.resolve();
  }
}

function fixture() {
  const root = new Node("root"), html = new Node("html"), win = new Node("window");
  const nodes: Node[] = [], messages: any[] = [], frames: Function[] = [], observers: Function[] = [];
  let timer = 0;
  const timers = new Map<number, Function>();
  const parent = { postMessage: (m: unknown) => messages.push(m) };
  const window = Object.assign(win, {
    parent, openai: {} as Record<string, unknown>,
    setTimeout: (fn: Function) => { timers.set(++timer, fn); return timer; },
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (fn: Function) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {}
  });
  const context = {
    window, document: { readyState: "complete", documentElement: html,
      getElementById: () => root,
      createElement: (tag: string) => { const n = new Node(tag); nodes.push(n); return n; } },
    console, exports: {}, AbortController, AbortSignal,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame,
    ResizeObserver: class { constructor(fn: Function) { observers.push(fn); } observe() {} disconnect() {} },
    fetch: async () => ({ ok: true, text: async () => "" })
  };
  vm.runInNewContext(readFileSync("dist/widget/sticker-view-widget.global.js", "utf8"), context);
  const send = (method: string, params: unknown, extra = {}) => win.dispatch("message", {
    source: parent, data: { jsonrpc: "2.0", method, params, ...extra }
  });
  return { root, html, win, window, nodes, messages, send, observers,
    flush: () => { for (const fn of frames.splice(0)) fn(); },
    audio: () => nodes.filter(n => n.tag === "audio").at(-1)!,
    globals: (globals: Record<string, unknown>) => {
      Object.assign(window.openai, globals);
      win.dispatch("openai:set_globals", { detail: { globals } });
    },
    initialize: async () => {
      const init = messages.find(m => m.method === "ui/initialize");
      win.dispatch("message", { source: parent, data: { jsonrpc: "2.0", id: init.id,
        result: { protocolVersion: "2026-01-26", hostContext: { theme: "light" } } } });
      await Promise.resolve();
    }
  };
}

const data = {"imageUrl": "https://media.example/a.png", "name": "Happy"};
const updated = {"imageUrl": "https://media.example/b.png", "name": "New"};

test("25 duplicate result/global notifications preserve the rendered nodes", async () => {
 const f = fixture(); f.globals({toolOutput: data});
 const first = f.root.children[0], count = f.nodes.length;
 for (let i=0;i<25;i++) {
   f.globals({toolOutput: JSON.stringify(data), theme: i%2 ? "light":"dark"});
   f.send("ui/notifications/tool-result", {content:[{type:"text",text:JSON.stringify(data)}]});
 }
 assert.equal(f.root.children[0], first);
 assert.equal(f.nodes.length,count);
});
test("new results update once; stale legacy data and unrelated windows cannot revert them", () => {
 const f=fixture(); f.globals({toolOutput:data}); const first=f.root.children[0];
 f.send("ui/notifications/tool-result",{structuredContent:updated});
 const second=f.root.children[0]; assert.notEqual(second,first);
 f.globals({toolOutput:data,theme:"dark"});
 f.win.dispatch("message",{source:{},data:{jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{structuredContent:data}}});
 assert.equal(f.root.children[0],second); assert.equal(f.html.dataset.theme,"dark");
});
test("height-only reporting converges after handshake",async()=>{
 const f=fixture(); f.globals({toolOutput:data}); f.flush();
 assert.equal(f.messages.filter(m=>m.method==="ui/notifications/size-changed").length,0);
 await f.initialize(); f.flush();
 for(let i=0;i<20;i++){ f.observers.forEach(fn=>fn()); f.flush(); }
 const sizes=f.messages.filter(m=>m.method==="ui/notifications/size-changed");
 assert.equal(sizes.length,1); assert.equal(sizes[0].params.width,undefined);
});
test("teardown responds and rejects subsequent data",()=>{
 const f=fixture();f.globals({toolOutput:data});const count=f.nodes.length;
 f.send("ui/resource-teardown",{},{id:"close"});
 f.globals({toolOutput:updated});f.send("ui/notifications/tool-result",{structuredContent:updated});
 assert.equal(f.nodes.length,count);assert.ok(f.messages.some(m=>m.id==="close"&&m.result));
});
