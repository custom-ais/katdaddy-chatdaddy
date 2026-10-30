import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.mjs";

// ChatDaddy's Vercel project already has ADMIN_PASSWORD and NEXT_PUBLIC_APP_URL.
test("ADMIN_PASSWORD from Vercel signs in without a setup step", async (t) => {
  const h = await harness(t, { env: { ADMIN_PASSWORD: "chatdaddy-office-password" } });
  const status = await h.call("/api/admin/status");
  assert.equal(status.data.setupRequired, false);
  assert.equal((await h.call("/api/admin/setup", { method: "POST", body: { setupToken: "test-only-setup-token", password: "x".repeat(20) } })).status, 409);
  assert.equal((await h.call("/api/admin/login", { method: "POST", body: { password: "wrong-password-here" } })).status, 401);
  const ok = await h.call("/api/admin/login", { method: "POST", body: { password: "chatdaddy-office-password" } });
  assert.equal(ok.status, 200);
  const cookie = ok.cookie;
  assert.equal((await h.call("/api/admin/data", { cookie })).status, 200);
  // Changing the password stores a new one that replaces the env password.
  const changed = await h.call("/api/admin/password", { method: "POST", cookie, body: { currentPassword: "chatdaddy-office-password", newPassword: "a-brand-new-password-123" } });
  assert.equal(changed.status, 200);
  assert.equal((await h.call("/api/admin/login", { method: "POST", body: { password: "chatdaddy-office-password" } })).status, 401);
  assert.equal((await h.call("/api/admin/login", { method: "POST", body: { password: "a-brand-new-password-123" } })).status, 200);
});

test("Jobber's ChatDaddy redirect path is accepted and requests from other sites are refused", async (t) => {
  const h = await harness(t, { env: { NEXT_PUBLIC_APP_URL: "https://katdaddy-bookingbot.vercel.app" } });
  const cb = await h.call("/api/jobber/oauth/callback?state=nope&code=abc");
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get("location"), /\/admin\?jobber=failed/);
  const own = await h.call("/api/session", { method: "POST", body: {} });
  assert.equal(own.status, 201);
  const app = await h.call("/api/session", { method: "POST", body: {}, headers: { Origin: "https://katdaddy-bookingbot.vercel.app" } });
  assert.equal(app.status, 201);
  const other = await h.call("/api/session", { method: "POST", body: {}, headers: { Origin: "https://evil.example" } });
  assert.equal(other.status, 403);
});

test("a failed database start is retried instead of sticking", async () => {
  const { createStore } = await import("../server/store.mjs");
  let calls = 0;
  const db = { kind: "fake", tx: (fn) => fn(db), close: async () => {}, query: async () => { if (++calls === 1) throw new Error("Database: relation does not exist"); return []; } };
  const store = createStore(db);
  await assert.rejects(store.init(), /does not exist/);
  await store.init();
});
