<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
  <img alt="sticker-mcp — expressive stickers in AI chat" src=".github/assets/banner-light.svg" width="100%">
</picture>

[![CI](https://github.com/asashiki/sticker-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/asashiki/sticker-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-e96ba8.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-8b8bef)
![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20Streamable%20HTTP-3a3340)

**English** · [简体中文](README.zh-CN.md)

</div>

# sticker-mcp

An MCP server that lets AI send expressive stickers (表情包) directly into the chat, rendered inline via MCP Apps. Comes with a standalone web admin page for managing the sticker library, and tools that let the AI add new stickers for you.

## Features

- **Inline sticker rendering** — `send_sticker` renders the image in the conversation via a `ui://` MCP Apps widget (works on claude.ai and ChatGPT web).
- **AI judgement built in** — tool descriptions teach the AI to check the library (`list_available_stickers`) and pick a sticker matching the conversation's mood, proactively.
- **AI can grow the library** — `add_sticker` lets the AI save an image when the host provides an actual image URL or `data:image/...;base64,...` URI, with name + emotion tags. On local stdio there is also `add_sticker_by_path`.
- **Standalone admin page** — `/admin` is a plain web page (no MCP host needed): drag & drop / paste upload, batch add, tag editing, search, delete. Optionally protected by `ADMIN_TOKEN`.
- **Simple storage** — JSON + image files on disk. No database.

## Tools

| Tool | Purpose |
|---|---|
| `send_sticker` | Pick a sticker by emotion/scene `query` (or exact `stickerId`) and render it in chat. Random pick among multiple matches. On no match, returns the catalog so the AI can retry. |
| `list_available_stickers` | Catalog of `{id, name, tags}` — the AI calls this once per conversation to know what moods it can express. |
| `add_sticker` | Download an image from an http(s) URL or save a `data:image/...` URI as a sticker with name + tags. |
| `add_sticker_by_path` | (stdio/local only) Add a sticker from a local file path. |

## Transports & endpoints

- **Local stdio**: `node dist/stdio.js` (or `npm run dev:stdio`).
- **Remote Streamable HTTP**: `node dist/server.js`, MCP endpoint at `MCP_HTTP_PATH` (default `/mcp/sticker`, `/mcp` kept as alias).
- HTTP server also serves: `/images/:filename` (sticker images for the widget), `/admin` (management page), `/api/stickers` (REST for the admin page), `/healthz`.

## Quick start (local)

```bash
npm install
npm run build
npm start            # Streamable HTTP on :3000
# or stdio for Claude Desktop:
npm run start:stdio
```

### Claude Desktop (stdio)

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

## Remote deployment (claude.ai / ChatGPT web)

1. Copy `.env.example` to `.env` and set at least `PUBLIC_BASE_URL` (public HTTPS origin) — the widget loads sticker images from `PUBLIC_BASE_URL/images/*`, and that origin is written into the widget CSP. Without it, images are inlined as base64 (fine locally, brittle in hosted iframes).
2. `docker compose up -d` (or run `node dist/server.js` behind your reverse proxy).
3. Reverse-proxy `https://your-domain/mcp/sticker` to the container's `:3000` (same path), plus `/images/*`, `/admin`, `/api/*`.
4. In claude.ai -> Settings -> Connectors -> add custom connector with URL `https://your-domain/mcp/sticker`. If `MCP_AUTH_PASSWORD` is set, the connector will use OAuth dynamic client registration and show the password authorization page.

> Hosts cache `ui://` resources by URI. If you modify the widget, bump the version suffix in `src/widget/sticker-view-html.ts` (`mcp-app-v2.html` → `v3` ...).

## Configuration

See `.env.example`. Summary:

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_BASE_URL` | _(empty)_ | Public HTTPS origin; enables URL-based images + CSP. Required for web AI clients. |
| `PORT` | `3000` | HTTP port. |
| `MCP_HTTP_PATH` | `/mcp/sticker` | Streamable HTTP MCP route. |
| `ALLOWED_ORIGINS` | PUBLIC_BASE_URL origin | CORS allowlist, comma separated. |
| `MCP_AUTH_PASSWORD` | _(empty)_ | Optional password gate for remote connectors. Leave empty to disable auth. |
| `DATA_DIR` | `./data` | stickers.json + images/. |
| `ADMIN_TOKEN` | _(empty)_ | If set, `/admin` + `/api/*` require it (Bearer header or `?token=`). |

## OAuth password auth

Set `MCP_AUTH_PASSWORD` to enable a minimal OAuth Authorization Code flow for remote connectors. The server exposes OAuth discovery and dynamic client registration, so clients that support automatic registration can connect without a manually configured Client ID. During connection, enter the configured password on the authorization page.

## Development

```bash
npm run dev          # HTTP server with reload
npm run typecheck
npm run build        # server (tsup) + widget (IIFE) + admin assets
```

Code layout: `src/mcp.ts` (tool/resource registration) · `src/server.ts` (HTTP transport + REST + static) · `src/stdio.ts` (local transport) · `src/storage.ts` (JSON + sharp) · `src/widget/` (MCP Apps widget) · `src/admin/` (standalone admin page).

## License

MIT
