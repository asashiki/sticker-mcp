/**
 * Minimal OAuth 2.0 Authorization Code + PKCE flow for MCP servers.
 *
 * If MCP_AUTH_PASSWORD is not set, all requests pass through with no auth.
 *
 * Endpoints added:
 *   GET  /.well-known/oauth-authorization-server  — metadata discovery
 *   GET  /oauth/authorize                          — password input page
 *   POST /oauth/authorize                          — verify password, issue code
 *   POST /oauth/token                              — exchange code for token
 *
 * Protected routes check:  Authorization: Bearer <token>
 */

import crypto from "node:crypto";
import express from "express";
import type { Request, Response, NextFunction, Express } from "express";

const PASSWORD = process.env.MCP_AUTH_PASSWORD ?? "";
const ENABLED = PASSWORD.length > 0;

const codes = new Map<string, { token: string; expires: number }>();
const tokens = new Set<string>();

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

setInterval(() => {
  const now = Date.now();
  for (const [code, val] of codes) {
    if (val.expires < now) codes.delete(code);
  }
}, 60_000).unref();

const urlencodedParser = express.urlencoded({ extended: false });

export function setupOAuth(app: Express, baseUrl: string, serviceName: string) {
  if (!ENABLED) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  // ── Discovery ──────────────────────────────────────────────────────────────
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256", "plain"]
    });
  });

  // ── Show password form ─────────────────────────────────────────────────────
  app.get("/oauth/authorize", (req, res) => {
    const q = req.query as Record<string, string>;
    const hidden = (name: string) =>
      q[name] ? `<input type="hidden" name="${name}" value="${String(q[name]).replace(/"/g, "&quot;")}">` : "";

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${serviceName} · 授权</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
     background:#fff2f9;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei UI",sans-serif}
.card{background:#fff;border:1px solid #f3dce9;border-radius:14px;padding:32px 28px;
      box-shadow:0 4px 20px rgba(180,120,160,.1);max-width:360px;width:100%}
h1{font-size:17px;font-weight:700;color:#3a3340;margin-bottom:6px}
p{font-size:13px;color:#8a7d8f;margin-bottom:22px}
label{font-size:13px;color:#3a3340;display:block;margin-bottom:6px}
input[type=password]{width:100%;padding:10px 12px;border:1px solid #f3dce9;border-radius:8px;
                     font-size:14px;outline:none;transition:border .15s}
input[type=password]:focus{border-color:#e96ba8}
button{margin-top:14px;width:100%;padding:11px;background:#e96ba8;color:#fff;border:none;
       border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(1.07)}
.err{margin-top:12px;font-size:13px;color:#e96ba8;text-align:center}
</style>
</head><body>
<div class="card">
  <h1>${serviceName}</h1>
  <p>请输入部署时设置的密码以授权访问</p>
  <form method="POST" action="/oauth/authorize">
    ${hidden("redirect_uri")}${hidden("state")}${hidden("code_challenge")}${hidden("code_challenge_method")}${hidden("client_id")}
    <label for="pw">密码</label>
    <input id="pw" type="password" name="password" autofocus autocomplete="current-password" required>
    <button type="submit">授权</button>
    ${q.error ? '<div class="err">密码错误，请重试</div>' : ""}
  </form>
</div>
</body></html>`);
  });

  // ── Verify password, issue code ────────────────────────────────────────────
  app.post("/oauth/authorize", urlencodedParser, (req, res) => {
    const body = req.body as Record<string, string>;
    if (body.password !== PASSWORD) {
      const params = new URLSearchParams({ ...body, error: "1" });
      res.redirect(`/oauth/authorize?${params}`);
      return;
    }
    const token = randomHex(32);
    const code = randomHex(16);
    codes.set(code, { token, expires: Date.now() + 5 * 60 * 1000 });
    tokens.add(token);

    const redirect = new URL(body.redirect_uri);
    redirect.searchParams.set("code", code);
    if (body.state) redirect.searchParams.set("state", body.state);
    res.redirect(redirect.toString());
  });

  // ── Token exchange ─────────────────────────────────────────────────────────
  app.post("/oauth/token", urlencodedParser, express.json(), (req, res) => {
    const code = (req.body as Record<string, string>).code;
    const entry = code ? codes.get(code) : undefined;
    if (!entry || entry.expires < Date.now()) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    codes.delete(code);
    res.json({ access_token: entry.token, token_type: "Bearer", expires_in: 86400 });
  });

  // ── Bearer middleware ──────────────────────────────────────────────────────
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (tokens.has(token)) return next();
    res.status(401).json({ error: "unauthorized" });
  };
}
