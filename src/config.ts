import path from "node:path";

export interface AppConfig {
  port: number;
  /** Public HTTPS base URL, e.g. https://mcp.asashiki.com — required for remote (web AI) deployments. */
  publicBaseUrl: string | null;
  dataDir: string;
  mcpHttpPath: string;
  allowedOrigins: string[];
  /** Optional bearer token protecting /admin page and /api/* REST endpoints. Empty = open. */
  adminToken: string | null;
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

export function loadConfig(): AppConfig {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const normalizedPort = Number.isFinite(port) ? port : 3000;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || null;
  const defaultOrigins = publicBaseUrl ? [new URL(publicBaseUrl).origin] : [];

  return {
    port: normalizedPort,
    publicBaseUrl,
    dataDir: process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), "data"),
    mcpHttpPath: normalizePath(process.env.MCP_HTTP_PATH, "/mcp/sticker"),
    allowedOrigins: parseList(process.env.ALLOWED_ORIGINS, defaultOrigins),
    adminToken: process.env.ADMIN_TOKEN?.trim() || null
  };
}

/** Origins the widget iframe is allowed to load images from (CSP). */
export function imageOrigins(config: AppConfig): string[] {
  return config.publicBaseUrl ? [new URL(config.publicBaseUrl).origin] : [];
}
