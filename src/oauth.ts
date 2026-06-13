/**
 * Minimal OAuth 2.0 Authorization Code flow for MCP servers.
 *
 * If MCP_AUTH_PASSWORD is not set, all requests pass through with no auth.
 *
 * Endpoints added:
 *   GET  /.well-known/oauth-authorization-server  - metadata discovery
 *   GET  /.well-known/oauth-protected-resource     - protected resource metadata
 *   POST /oauth/register                           - dynamic client registration
 *   GET  /oauth/authorize                          - password input page
 *   POST /oauth/authorize                          - verify password, issue code
 *   POST /oauth/token                              - exchange code for token
 *
 * Protected routes check: Authorization: Bearer <token>
 */

import crypto from "node:crypto";
import express from "express";
import type { Request, Response, NextFunction, Express } from "express";

const PASSWORD = process.env.MCP_AUTH_PASSWORD ?? "";
const ENABLED = PASSWORD.length > 0;
const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

const codes = new Map<string, { token: string; expires: number }>();
const clients = new Map<string, { redirectUris: string[]; clientName?: string; issuedAt: number }>();

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

function serviceSlug(serviceName: string) {
  return serviceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mcp";
}

function signPayload(payload: string) {
  return crypto.createHmac("sha256", PASSWORD).update(payload).digest("base64url");
}

function issueAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + ACCESS_TOKEN_TTL_SECONDS }), "utf8").toString("base64url");
  return `mcp.${payload}.${signPayload(payload)}`;
}

function verifyAccessToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "mcp") return false;
  const payloadPart = parts[1];
  const signaturePart = parts[2];
  if (!payloadPart || !signaturePart) return false;
  const expected = Buffer.from(signPayload(payloadPart), "base64url");
  const actual = Buffer.from(signaturePart, "base64url");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [code, val] of codes) {
    if (val.expires < now) codes.delete(code);
  }
}, 60_000).unref();

const urlencodedParser = express.urlencoded({ extended: false });

export function setupOAuth(app: Express, baseUrl: string | null, serviceName: string) {
  if (!ENABLED) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  if (!baseUrl) {
    throw new Error("PUBLIC_BASE_URL is required when MCP_AUTH_PASSWORD is set.");
  }

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: []
    });
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"]
    });
  });

  app.post("/oauth/register", express.json({ limit: "256kb" }), (req, res) => {
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string" && uri.length > 0)
      : [];
    if (redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" });
      return;
    }

    const clientId = `${serviceSlug(serviceName)}-${randomHex(16)}`;
    const issuedAt = Math.floor(Date.now() / 1000);
    clients.set(clientId, {
      redirectUris,
      clientName: typeof body.client_name === "string" ? body.client_name : undefined,
      issuedAt
    });

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_secret_expires_at: 0,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: typeof body.client_name === "string" ? body.client_name : serviceName
    });
  });

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

  app.post("/oauth/authorize", urlencodedParser, (req, res) => {
    const body = req.body as Record<string, string>;
    if (body.password !== PASSWORD) {
      const params = new URLSearchParams({ ...body, error: "1" });
      res.redirect(`/oauth/authorize?${params}`);
      return;
    }
    if (!body.redirect_uri) {
      res.status(400).json({ error: "invalid_request", error_description: "redirect_uri is required" });
      return;
    }
    if (body.client_id) {
      const client = clients.get(body.client_id);
      if (client && !client.redirectUris.includes(body.redirect_uri)) {
        res.status(400).json({ error: "invalid_request", error_description: "redirect_uri is not registered" });
        return;
      }
    }

    const code = randomHex(16);
    codes.set(code, { token: issueAccessToken(), expires: Date.now() + 5 * 60 * 1000 });

    const redirect = new URL(body.redirect_uri);
    redirect.searchParams.set("code", code);
    if (body.state) redirect.searchParams.set("state", body.state);
    res.redirect(redirect.toString());
  });

  app.post("/oauth/token", urlencodedParser, express.json(), (req, res) => {
    const code = (req.body as Record<string, string>).code;
    if (!code) {
      res.status(400).json({ error: "invalid_request", error_description: "code is required" });
      return;
    }
    const entry = codes.get(code);
    if (!entry || entry.expires < Date.now()) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    codes.delete(code);
    res.json({ access_token: entry.token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS });
  });

  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (verifyAccessToken(token)) return next();
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    res.status(401).json({ error: "unauthorized" });
  };
}
