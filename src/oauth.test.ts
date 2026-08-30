import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import express from "express";
import { setupOAuth } from "./oauth.js";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("OAuth binds authorization code to client, redirect, resource and S256 verifier", async () => {
  const app = express();
  const server = http.createServer(app);
  const baseUrl = await listen(server);
  const resourceUrl = `${baseUrl}/mcp/sticker`;
  const bearerAuth = setupOAuth(app, {
    baseUrl,
    resourceUrl,
    password: "correct horse battery staple",
    tokenSecret: "stable-test-signing-secret",
    serviceName: "sticker-mcp test",
    scope: "tools:read tools:write",
    allowLegacyResourceOmission: false
  });
  app.get("/protected", bearerAuth, (_req, res) => res.json({ ok: true }));

  try {
    const unsafe = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://remote.example/callback"] })
    });
    assert.equal(unsafe.status, 400);

    const redirectUri = "https://chat.example/callback";
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Test client" })
    });
    assert.equal(registration.status, 201);
    const client = await registration.json() as { client_id: string };

    const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const authorization = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: resourceUrl,
        scope: "tools:read tools:write",
        state: "state-123",
        password: "correct horse battery staple"
      }),
      redirect: "manual"
    });
    assert.equal(authorization.status, 302);
    const callback = new URL(authorization.headers.get("location") ?? "");
    assert.equal(callback.searchParams.get("state"), "state-123");
    assert.equal(callback.searchParams.get("iss"), baseUrl);
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: resourceUrl
      })
    });
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json() as { access_token: string };
    assert.match(token.access_token, /^mcp\./);
    const protectedResponse = await fetch(`${baseUrl}/protected`, {
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    assert.equal(protectedResponse.status, 200);

    const replay = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: resourceUrl
      })
    });
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), { error: "invalid_grant" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OAuth rejects missing resource and does not reflect a bad password", async () => {
  const app = express();
  const server = http.createServer(app);
  const baseUrl = await listen(server);
  const resourceUrl = `${baseUrl}/mcp/sticker`;
  setupOAuth(app, {
    baseUrl,
    resourceUrl,
    password: "secret",
    tokenSecret: "signing-secret",
    serviceName: "sticker",
    scope: "tools:read",
    allowLegacyResourceOmission: false
  });
  try {
    const redirectUri = "https://chat.example/callback";
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] })
    });
    const { client_id } = await registration.json() as { client_id: string };
    const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const missing = new URL(`${baseUrl}/oauth/authorize`);
    missing.search = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256"
    }).toString();
    assert.equal((await fetch(missing)).status, 400);

    const denied = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: resourceUrl,
        scope: "tools:read",
        password: "this must never leak"
      }),
      redirect: "manual"
    });
    assert.equal(denied.status, 403);
    assert.doesNotMatch(await denied.text(), /this must never leak/);
    assert.equal(denied.headers.get("location"), null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
