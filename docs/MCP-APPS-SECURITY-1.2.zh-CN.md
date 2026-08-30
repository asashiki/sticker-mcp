# sticker-mcp 1.2：MCP Apps 与公网安全升级

这次升级不改变现有表情数据格式，`data/stickers.json` 与 `data/images/` 可以原样复用。建议在独立端口或临时域名先跑新容器，再切换反向代理；不要直接覆盖正在使用的实例。

## 解决了什么

| 旧行为 | 1.2 行为 | 实际收益 |
|---|---|---|
| 基于 MCP SDK 1.x 的 2025 HTTP transport | SDK 2.x handler 同端点协商 2026 与旧版 | 新客户端能用新版协议，老连接器继续可用 |
| widget 打包完整 `ext-apps` 客户端 | 约 3 KB 的标准 `ui/*` bridge + OpenAI 兼容层 | 更少脚本、更快加载，也减少宿主实现差异 |
| 写死 `openai/widgetDomain` | 默认交给宿主 sandbox；专属域名改为显式可选 | 避免域名未部署、证书或 CSP 不一致导致空白组件 |
| 管理 Token 可放 `?token=` | 只接受 `Authorization: Bearer` | 不进入浏览历史、访问日志或 Referer |
| `fetch(..., redirect: follow)` | 每一跳重新校验协议、DNS 与私网地址 | 阻断跳转到 localhost、内网和云 metadata 的 SSRF |
| 完整 `arrayBuffer()` 后才检查大小 | 读取过程中执行 8 MB 上限 | 超大/无限响应不能持续占用内存 |
| OAuth code 近似一次性 Token 包装 | S256 PKCE + 精确 redirect + client/resource/scope 绑定 | 授权码截获、跨客户端兑换和 audience 混用更难发生 |
| 容器只设置普通用户 | 再加只读根文件系统、cap drop、no-new-privileges 与资源上限 | 缩小图片解析器或依赖漏洞的影响面 |

## MCP Apps 兼容策略

组件以 MCP Apps 标准消息作为主路径：

- `ui/initialize`
- `ui/notifications/initialized`
- `ui/notifications/tool-result`
- `ui/notifications/host-context-changed`
- `ui/notifications/size-changed`

ChatGPT 的 `window.openai.toolOutput` 仍保留，但仅在存在时读取。工具与资源同时发布标准 `ui` metadata 和 OpenAI 兼容 alias，因此经过 mcp-switch 代理时也能保留绑定关系。

资源 URI 已升级为 `ui://sticker-mcp/view-v8.html`。这是刻意的缓存失效机制：很多宿主按 URI 长时间缓存组件 HTML。

## 安全迁移

生产环境建议至少配置：

```dotenv
PUBLIC_BASE_URL=https://sticker.example.com
ALLOWED_HOSTS=sticker.example.com
ALLOWED_ORIGINS=https://sticker.example.com
MCP_AUTH_PASSWORD=<long password>
MCP_AUTH_TOKEN_SECRET=<stable random secret>
ADMIN_TOKEN=<different random secret>
```

`MCP_AUTH_TOKEN_SECRET` 应长期稳定并与授权密码分离。升级验证期间可保留
`MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION=true`；确认所有客户端都会发送 RFC 8707
`resource` 后改为 `false`。

## 蓝绿验证

1. 备份 `data/`。
2. 用另一个本机端口启动 1.2，不改变旧容器和旧反代。
3. 检查 `/healthz` 与 `/diagnostics/mcp-app`。
4. 在测试连接器中验证列工具、读取 `ui://sticker-mcp/view-v8.html`、发送表情与添加表情。
5. 确认 `/api/stickers?token=...` 返回 401，而管理页输入 Token 后正常。
6. 再切换反代；异常时把反代切回旧端口，数据格式无需回滚。

仓库内自动验证：

```bash
npm run typecheck
npm test
```
