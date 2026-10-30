import test from "node:test";
import assert from "node:assert/strict";
import { cleanSecret, tokenKind, createLeadConnector } from "../server/leadconnector.mjs";

test("a pasted token loses stray spaces, quotes and a Bearer prefix", () => {
  assert.equal(cleanSecret("  pit-1234abcd-5678-90ef  \n"), "pit-1234abcd-5678-90ef");
  assert.equal(cleanSecret('"pit-1234abcd-5678-90ef"'), "pit-1234abcd-5678-90ef");
  assert.equal(cleanSecret("Bearer pit-1234abcd-5678-90ef"), "pit-1234abcd-5678-90ef");
  assert.equal(cleanSecret(undefined), "");
});

test("the kind of token is reported without the token", () => {
  assert.equal(tokenKind(""), "missing");
  assert.equal(tokenKind("pit-1234abcd-5678-90ef-aaaa-bbbbccccdddd"), "private-integration");
  assert.equal(tokenKind("eyJhbGciOiJIUzI1NiJ9.eyJsb2NhdGlvbl9pZCI6IngifQ.c2lnbmF0dXJl"), "jwt");
  assert.equal(tokenKind("3f1a9c0e7b2d4e6f"), "other");
});

test("the cleaned token is what gets sent", async () => {
  let auth;
  const lc = createLeadConnector({
    env: { LC_PRIVATE_TOKEN: ' "pit-1234abcd-5678-90ef" ', LC_LOCATION_ID: " loc123 " },
    fetchImpl: async (url, init) => { auth = init.headers.Authorization; return new Response(JSON.stringify({ contact: { id: "c1" } }), { status: 200 }); },
  });
  assert.equal(lc.tokenKind, "private-integration");
  assert.equal(lc.cfg.locationId, "loc123");
  assert.equal(await lc.upsertContact({ phone: "+16235550100" }), "c1");
  assert.equal(auth, "Bearer pit-1234abcd-5678-90ef");
});
