/**
 * Small self-hosted OAuth 2.1 authorization server for sticker-mcp.
 * Public clients only: Authorization Code + S256 PKCE and RFC 8707 resource
 * binding. Registrations/codes are in memory; signed access tokens survive a
 * process restart as long as MCP_AUTH_TOKEN_SECRET remains stable.
 */
import crypto from "node:crypto";
import express from "express";
import type { Request, Response, NextFunction, Express } from "express";

const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

type OAuthClient = { redirectUris: string[]; clientName: string; issuedAt: number };
type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
};
type AccessClaims = {
  iss: string;
  aud: string;
  client_id: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
};

export interface OAuthSetupOptions {
  baseUrl: string;
  resourceUrl: string;
  password: string;
  tokenSecret: string;
  serviceName: string;
  scope: string;
  allowLegacyResourceOmission: boolean;
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function serviceSlug(serviceName: string) {
  return serviceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mcp";
}

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validRedirectUri(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function normalizeResource(value: string): string | null {
  try {
    const url = new URL(value);
    if (!(url.protocol === "http:" || url.protocol === "https:")) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function protectedResourceMetadataPath(resourceUrl: string): string {
  const path = new URL(resourceUrl).pathname.replace(/\/$/, "");
  return `/.well-known/oauth-protected-resource${path === "" || path === "/" ? "" : path}`;
}

function safeEqualText(actual: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(actual).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  return safeEqualText(crypto.createHash("sha256").update(verifier).digest("base64url"), challenge);
}

function tokenKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(`sticker-mcp-access-token\0${secret}`).digest();
}

function signPayload(payload: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function issueAccessToken(
  options: OAuthSetupOptions,
  key: Buffer,
  clientId: string,
  resource: string,
  scope: string
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessClaims = {
    iss: options.baseUrl,
    aud: resource,
    client_id: clientId,
    scope,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    jti: randomToken(16)
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `mcp.${payload}.${signPayload(payload, key)}`;
}

function verifyAccessToken(token: string, options: OAuthSetupOptions, key: Buffer): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "mcp") return null;
  const payloadPart = parts[1];
  const signaturePart = parts[2];
  if (!payloadPart || !signaturePart || !safeEqualText(signaturePart, signPayload(payloadPart, key))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Partial<AccessClaims>;
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.iss !== options.baseUrl ||
      claims.aud !== options.resourceUrl ||
      typeof claims.client_id !== "string" ||
      typeof claims.scope !== "string" ||
      !options.scope.split(/\s+/).every((scope) => claims.scope?.split(/\s+/).includes(scope)) ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      claims.iat > now + 60 ||
      typeof claims.jti !== "string"
    ) return null;
    return claims as AccessClaims;
  } catch {
    return null;
  }
}

function authorizationPage(serviceName: string, fields: Record<string, string>, error?: string): string {
  const hidden = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`)
    .join("");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(serviceName)} · 授权</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:18px;background:#fff2f9;font-family:system-ui,-apple-system,"PingFang SC",sans-serif}
.card{background:#fff;border:1px solid #f3dce9;border-radius:14px;padding:32px 28px;box-shadow:0 4px 20px rgba(180,120,160,.1);max-width:390px;width:100%}h1{font-size:17px;color:#3a3340;margin-bottom:6px}p{font-size:13px;color:#8a7d8f;margin-bottom:18px;line-height:1.55}.scope{font:12px ui-monospace,monospace;color:#8b8bef;background:#e9e9fe;border-radius:7px;padding:8px;margin-bottom:18px;word-break:break-all}label{font-size:13px;color:#3a3340;display:block;margin-bottom:6px}input{width:100%;padding:10px 12px;border:1px solid #f3dce9;border-radius:8px;font-size:14px}button{margin-top:14px;width:100%;padding:11px;background:#e96ba8;color:#fff;border:0;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}.err{margin-bottom:12px;font-size:13px;color:#c43e62;background:#fff0f4;padding:9px;border-radius:8px}</style></head>
<body><div class="card"><h1>${htmlEscape(serviceName)}</h1><p>请输入部署时设置的密码，授权此客户端访问你的表情库。写入工具仍会由宿主按工具注解确认。</p>${error ? `<div class="err">${htmlEscape(error)}</div>` : ""}<div class="scope">resource: ${htmlEscape(fields.resource ?? "")}<br>scope: ${htmlEscape(fields.scope ?? "")}</div><form method="POST" action="/oauth/authorize">${hidden}<label for="pw">授权密码</label><input id="pw" type="password" name="password" autofocus autocomplete="current-password" required><button type="submit">授权连接</button></form></div></body></html>`;
}

function secureAuthorizationPageHeaders(res: Response) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

export function setupOAuth(app: Express, rawOptions: OAuthSetupOptions) {
  if (!rawOptions.password) return (_req: Request, _res: Response, next: NextFunction) => next();
  if (!rawOptions.tokenSecret) throw new Error("MCP_AUTH_TOKEN_SECRET or MCP_AUTH_PASSWORD is required when OAuth is enabled.");

  const options = {
    ...rawOptions,
    baseUrl: rawOptions.baseUrl.replace(/\/$/, ""),
    resourceUrl: rawOptions.resourceUrl.replace(/\/$/, "")
  };
  const canonicalResource = normalizeResource(options.resourceUrl);
  if (!canonicalResource || canonicalResource !== options.resourceUrl) {
    throw new Error("OAuth resourceUrl must be a canonical HTTP(S) URL without query or fragment.");
  }

  const clients = new Map<string, OAuthClient>();
  const codes = new Map<string, AuthorizationCode>();
  const failedAttempts = new Map<string, { count: number; resetAt: number }>();
  const key = tokenKey(options.tokenSecret);
  const metadataPath = protectedResourceMetadataPath(options.resourceUrl);
  const supportedScopes = [...new Set(options.scope.split(/\s+/).filter(Boolean))];
  if (supportedScopes.length === 0) throw new Error("MCP_OAUTH_SCOPE must not be empty.");

  const resolveResource = (raw: string | undefined): string | null => {
    if (!raw) return options.allowLegacyResourceOmission ? options.resourceUrl : null;
    return normalizeResource(raw) === canonicalResource ? options.resourceUrl : null;
  };
  const resolveScope = (raw: string | undefined): string | null => {
    const requested = [...new Set((raw?.trim() || options.scope).split(/\s+/).filter(Boolean))];
    // This compact server does not yet instantiate a different tool catalog per
    // request, so it must not mint a read-only token that can still reach write
    // tools. Issue only the complete configured scope set.
    return requested.length === supportedScopes.length && requested.every((scope) => supportedScopes.includes(scope))
      ? requested.join(" ")
      : null;
  };

  const protectedResourceMeta = {
    resource: options.resourceUrl,
    authorization_servers: [options.baseUrl],
    scopes_supported: supportedScopes,
    bearer_methods_supported: ["header"]
  };
  for (const path of new Set(["/.well-known/oauth-protected-resource", metadataPath])) {
    app.get(path, (_req, res) => res.json(protectedResourceMeta));
  }

  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json({
    issuer: options.baseUrl,
    authorization_endpoint: `${options.baseUrl}/oauth/authorize`,
    token_endpoint: `${options.baseUrl}/oauth/token`,
    registration_endpoint: `${options.baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: supportedScopes,
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
    client_id_metadata_document_supported: false
  }));

  app.post("/oauth/register", express.json({ limit: "64kb" }), (req, res) => {
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [];
    if (redirectUris.length === 0 || redirectUris.length > 16 || !redirectUris.every(validRedirectUri)) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "Use exact HTTPS redirect URIs, or HTTP only for localhost/loopback." });
      return;
    }
    const clientName = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 120) || options.serviceName : options.serviceName;
    const clientId = `${serviceSlug(options.serviceName)}-${randomToken(18)}`;
    const issuedAt = Math.floor(Date.now() / 1000);
    clients.set(clientId, { redirectUris, clientName, issuedAt });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_secret_expires_at: 0,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: clientName
    });
  });

  const validateAuthorization = (input: Record<string, unknown>) => {
    const responseType = asString(input.response_type);
    const clientId = asString(input.client_id);
    const redirectUri = asString(input.redirect_uri);
    const codeChallenge = asString(input.code_challenge);
    const method = asString(input.code_challenge_method) ?? "S256";
    const resource = resolveResource(asString(input.resource));
    const scope = resolveScope(asString(input.scope));
    if (responseType !== "code") return { error: "unsupported_response_type" } as const;
    if (!clientId || !redirectUri || !codeChallenge) return { error: "invalid_request" } as const;
    const client = clients.get(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) return { error: "invalid_client" } as const;
    if (method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) return { error: "invalid_request" } as const;
    if (!resource) return { error: asString(input.resource) ? "invalid_target" : "invalid_request" } as const;
    if (!scope) return { error: "invalid_scope" } as const;
    return { clientId, redirectUri, codeChallenge, resource, scope, state: asString(input.state) };
  };

  app.get("/oauth/authorize", (req, res) => {
    const validated = validateAuthorization(req.query as Record<string, unknown>);
    if ("error" in validated) return void res.status(400).json({ error: validated.error });
    secureAuthorizationPageHeaders(res);
    res.send(authorizationPage(options.serviceName, {
      response_type: "code",
      client_id: validated.clientId,
      redirect_uri: validated.redirectUri,
      code_challenge: validated.codeChallenge,
      code_challenge_method: "S256",
      resource: validated.resource,
      scope: validated.scope,
      ...(validated.state ? { state: validated.state } : {})
    }));
  });

  app.post("/oauth/authorize", express.urlencoded({ extended: false, limit: "32kb" }), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const validated = validateAuthorization(body);
    if ("error" in validated) return void res.status(400).json({ error: validated.error });
    const attemptKey = req.ip || "unknown";
    const attempt = failedAttempts.get(attemptKey);
    if (attempt && attempt.resetAt > Date.now() && attempt.count >= 10) {
      res.setHeader("Retry-After", String(Math.ceil((attempt.resetAt - Date.now()) / 1000)));
      return void res.status(429).send("Too many failed authorization attempts.");
    }
    if (!safeEqualText(asString(body.password) ?? "", options.password)) {
      const next = attempt && attempt.resetAt > Date.now()
        ? { count: attempt.count + 1, resetAt: attempt.resetAt }
        : { count: 1, resetAt: Date.now() + 10 * 60 * 1000 };
      failedAttempts.set(attemptKey, next);
      secureAuthorizationPageHeaders(res);
      res.status(403).send(authorizationPage(options.serviceName, {
        response_type: "code",
        client_id: validated.clientId,
        redirect_uri: validated.redirectUri,
        code_challenge: validated.codeChallenge,
        code_challenge_method: "S256",
        resource: validated.resource,
        scope: validated.scope,
        ...(validated.state ? { state: validated.state } : {})
      }, "密码错误，请重试。"));
      return;
    }
    failedAttempts.delete(attemptKey);
    const code = randomToken(24);
    codes.set(code, {
      clientId: validated.clientId,
      redirectUri: validated.redirectUri,
      codeChallenge: validated.codeChallenge,
      resource: validated.resource,
      scope: validated.scope,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS
    });
    const redirect = new URL(validated.redirectUri);
    redirect.searchParams.set("code", code);
    if (validated.state) redirect.searchParams.set("state", validated.state);
    redirect.searchParams.set("iss", options.baseUrl);
    res.redirect(redirect.toString());
  });

  app.post("/oauth/token", express.urlencoded({ extended: false, limit: "32kb" }), express.json({ limit: "32kb" }), (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (asString(body.grant_type) !== "authorization_code") return void res.status(400).json({ error: "unsupported_grant_type" });
    const code = asString(body.code);
    const clientId = asString(body.client_id);
    const redirectUri = asString(body.redirect_uri);
    const verifier = asString(body.code_verifier);
    if (!code || !clientId || !redirectUri || !verifier) return void res.status(400).json({ error: "invalid_request" });
    const record = codes.get(code);
    if (!record || record.expiresAt <= Date.now()) {
      if (record) codes.delete(code);
      return void res.status(400).json({ error: "invalid_grant" });
    }
    codes.delete(code);
    const resource = resolveResource(asString(body.resource));
    if (!resource || resource !== record.resource) {
      return void res.status(400).json({ error: asString(body.resource) ? "invalid_target" : "invalid_request" });
    }
    if (clientId !== record.clientId || redirectUri !== record.redirectUri || !verifyPkceS256(verifier, record.codeChallenge)) {
      return void res.status(400).json({ error: "invalid_grant" });
    }
    res.json({
      access_token: issueAccessToken(options, key, clientId, resource, record.scope),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: record.scope
    });
  });

  return (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const claims = verifyAccessToken(token, options, key);
    if (claims) {
      (req as Request & { auth?: AccessClaims }).auth = claims;
      next();
      return;
    }
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${options.baseUrl}${metadataPath}", scope="${options.scope}"`);
    res.status(401).json({ error: "unauthorized" });
  };
}
