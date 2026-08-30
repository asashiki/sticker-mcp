import path from "node:path";

export interface AppConfig {
  port: number;
  /** Public HTTPS origin, e.g. https://sticker.example.com. */
  publicBaseUrl: string;
  /** Inline sticker bytes for stdio when PUBLIC_BASE_URL was not configured. */
  inlineImages: boolean;
  dataDir: string;
  mcpHttpPath: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  widgetDomain?: string;
  /** Optional bearer token protecting /admin page and /api/* REST endpoints. Empty = open. */
  adminToken: string | null;
  authPassword: string;
  authTokenSecret: string;
  oauthScope: string;
  allowLegacyResourceOmission: boolean;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function normalizePath(value: string | undefined, defaultValue: string): string {
  const p = value?.trim() || defaultValue;
  return p.startsWith("/") ? p : `/${p}`;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected true or false, received: ${value}`);
}

function optionalOrigin(value: string | undefined, name: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${name} must be a dedicated HTTPS origin without a path.`);
  }
  return url.origin;
}

export function loadConfig(options: { requirePublicBaseUrl?: boolean } = {}): AppConfig {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const normalizedPort = Number.isFinite(port) ? port : 3000;
  const configuredPublicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || "";
  let publicBaseUrl = configuredPublicBaseUrl;
  if (!publicBaseUrl) {
    if (options.requirePublicBaseUrl) {
      throw new Error("PUBLIC_BASE_URL is required for remote MCP Apps deployments.");
    }
    publicBaseUrl = `http://127.0.0.1:${normalizedPort}`;
  }
  const publicUrl = new URL(publicBaseUrl);
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") {
    throw new Error("PUBLIC_BASE_URL must be an origin without credentials, path, query, or fragment.");
  }
  if (
    options.requirePublicBaseUrl &&
    publicUrl.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname)
  ) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS outside localhost in production.");
  }
  const authPassword = process.env.MCP_AUTH_PASSWORD ?? "";

  return {
    port: normalizedPort,
    publicBaseUrl,
    inlineImages: configuredPublicBaseUrl === "",
    dataDir: process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), "data"),
    mcpHttpPath: normalizePath(process.env.MCP_HTTP_PATH, "/mcp/sticker"),
    allowedOrigins: parseList(process.env.ALLOWED_ORIGINS, [publicUrl.origin]),
    allowedHosts: parseList(process.env.ALLOWED_HOSTS, [publicUrl.hostname, "localhost", "127.0.0.1", "[::1]"]),
    widgetDomain: optionalOrigin(process.env.MCP_WIDGET_DOMAIN, "MCP_WIDGET_DOMAIN"),
    adminToken: process.env.ADMIN_TOKEN?.trim() || null,
    authPassword,
    authTokenSecret: process.env.MCP_AUTH_TOKEN_SECRET?.trim() || authPassword,
    oauthScope: process.env.MCP_OAUTH_SCOPE?.trim() || "tools:read tools:write",
    allowLegacyResourceOmission: parseBoolean(process.env.MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION, true)
  };
}

/** Origins the widget iframe is allowed to load images from (CSP). */
export function imageOrigins(config: AppConfig): string[] {
  return [new URL(config.publicBaseUrl).origin];
}
