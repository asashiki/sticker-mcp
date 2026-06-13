<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
  <img alt="sticker-mcp — 让 AI 在对话里发表情包" src=".github/assets/banner-light.svg" width="100%">
</picture>

[![CI](https://github.com/asashiki/sticker-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/asashiki/sticker-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-e96ba8.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-8b8bef)
![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20Streamable%20HTTP-3a3340)

[English](README.md) · **简体中文**

</div>

# sticker-mcp

一个让 AI 在聊天里直接发表情包的 MCP 服务：表情图通过 MCP Apps 的 `ui://` widget 内联渲染在对话中（claude.ai 和 ChatGPT 网页端都支持），自带一个独立的网页管理后台，AI 还能帮你往表情库里加新图。

## 功能亮点

- **对话内渲染** — `send_sticker` 调用后，表情图直接出现在聊天气泡里，带轻巧的弹入动画。
- **AI 自己会判断** — 工具描述教会 AI：先用 `list_available_stickers` 看一眼库里有什么，再根据对话气氛主动挑合适的标签发图（报喜、安慰、打招呼、庆祝……）；匹配不到时会把整个表情目录返回给 AI 让它自己换词重试。
- **AI 帮你加表情** — 你发一张图的链接说"把这张加成表情包"，AI 就会调 `add_sticker_by_url`（支持 https 链接和 data URI），起好名字、打好情绪标签存进库里。本地 stdio 模式下还有 `add_sticker_by_path` 直接读本地文件。
- **独立管理页** — `/admin` 是一个纯网页（不依赖任何 MCP 客户端）：拖拽/粘贴批量上传、缩略图预览、改名改标签、搜索、删除，浅色/深色主题切换，可用 `ADMIN_TOKEN` 加口令保护。
- **存储极简** — JSON + 图片文件落盘，零数据库。

## 工具一览

| 工具 | 用途 |
|---|---|
| `send_sticker` | 按情绪/场景词 `query`（或精确 `stickerId`）选图并渲染到对话。多个匹配时随机挑一张；匹配不到返回完整目录供 AI 重试。 |
| `list_available_stickers` | 返回 `{id, name, tags}` 目录，AI 每段对话开头看一次就知道能表达哪些情绪。 |
| `add_sticker_by_url` | 下载图片（https 或 `data:image/...`）存为新表情，带名称和 1-8 个标签。 |
| `add_sticker_by_path` | （仅本地 stdio）从本地文件路径加表情。 |
| `_admin_manage_stickers` | 管理 widget 的内部接口。 |

## 传输与端点

- **本地 stdio**：`node dist/stdio.js`（开发用 `npm run dev:stdio`）。
- **远程 Streamable HTTP**：`node dist/server.js`，MCP 端点在 `MCP_HTTP_PATH`（默认 `/mcp/sticker`，同时保留 `/mcp` 别名方便本机测试）。
- HTTP 服务还提供：`/images/:filename`（widget 加载表情图）、`/admin`（管理页）、`/api/stickers`（管理页 REST 接口）、`/healthz`（健康检查）。

## 快速开始（本地）

```bash
npm install
npm run build
npm start            # Streamable HTTP，监听 :3000
# 或 Claude Desktop 用 stdio：
npm run start:stdio
```

### Claude Desktop（stdio）配置

```json
{
  "mcpServers": {
    "sticker": {
      "command": "node",
      "args": ["path/to/sticker-mcp/dist/stdio.js"]
    }
  }
}
```

## 远程部署（连接 claude.ai / ChatGPT 网页端）

1. 复制 `.env.example` 为 `.env`，至少设置 `PUBLIC_BASE_URL`（公网 HTTPS 域名）——widget 从 `PUBLIC_BASE_URL/images/*` 加载表情图，该域名会写进 widget 的 CSP 白名单。不设置时图片会以 base64 内联（本地没问题，托管 iframe 里不稳）。
2. `docker compose up -d`（或把 `node dist/server.js` 挂在你的反代后面）。
3. 反向代理 `https://你的域名/mcp/sticker` 到容器 `:3000` 同路径，另外把 `/images/*`、`/admin`、`/api/*` 也一起转发。
4. claude.ai → 设置 → 连接器 → 添加自定义连接器，URL 填 `https://你的域名/mcp/sticker`。如果设置了 `MCP_AUTH_PASSWORD`，连接器会走 OAuth 动态客户端注册，并弹出密码授权页。

> 宿主按 URI 缓存 `ui://` 资源。改过 widget 后记得升级 `src/widget/sticker-view-html.ts` 里的版本号（`mcp-app-v2.html` → `v3` ……），否则客户端拿到的还是旧版。

## 配置项

完整见 `.env.example`，摘要：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `PUBLIC_BASE_URL` | _(空)_ | 公网 HTTPS 域名；启用 URL 图片 + CSP。连网页版 AI 必填。 |
| `PORT` | `3000` | HTTP 端口。 |
| `MCP_HTTP_PATH` | `/mcp/sticker` | Streamable HTTP MCP 路由。 |
| `ALLOWED_ORIGINS` | PUBLIC_BASE_URL 的 origin | CORS 白名单，逗号分隔。 |
| `MCP_AUTH_PASSWORD` | _(空)_ | 可选的远程连接器密码门禁。留空则关闭授权。 |
| `DATA_DIR` | `./data` | stickers.json 和 images/ 的位置。 |
| `ADMIN_TOKEN` | _(空)_ | 设置后 `/admin` 和 `/api/*` 需要口令（Bearer 头或 `?token=`）。 |

## OAuth 密码授权

设置 `MCP_AUTH_PASSWORD` 后，服务会启用一个最小 OAuth Authorization Code 流程，并暴露 OAuth discovery 与动态客户端注册端点。支持自动注册的客户端不需要手动填写 Client ID；连接时在授权页输入配置的密码即可。

## 开发

```bash
npm run dev          # HTTP 服务热重载
npm run typecheck
npm run build        # 服务端 (tsup) + widget (IIFE) + 管理页资源
```

代码结构：`src/mcp.ts`（工具/资源注册）· `src/server.ts`（HTTP 传输 + REST + 静态文件）· `src/stdio.ts`（本地传输）· `src/storage.ts`（JSON + sharp 缩略图）· `src/widget/`（MCP Apps widget）· `src/admin/`（独立管理页）。

## 许可

MIT
