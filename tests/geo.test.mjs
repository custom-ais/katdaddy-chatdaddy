import test from "node:test";
import assert from "node:assert/strict";
import { createGeo } from "../server/geo.mjs";

const memoryCache = () => {
  const m = new Map();
  return { m, kvGet: async (k) => m.get(k) ?? null, kvSet: async (k, v) => void m.set(k, v) };
};
const census = { result: { addressMatches: [{ coordinates: { x: -112.58, y: 33.37 }, matchedAddress: "100 W TEST ST, BUCKEYE, AZ, 85326", addressComponents: { city: "BUCKEYE", state: "AZ", zip: "85326" } }] } };
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const htmlPage = (status) => ({ ok: false, status, json: async () => { throw new SyntaxError("Unexpected token <"); } });

test("a refused Google key falls back to the Census lookup", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url).host);
    return /googleapis/.test(url) ? reply({ status: "REQUEST_DENIED", error_message: "API keys with referer restrictions cannot be used with this API." }) : reply(census);
  };
  const cache = memoryCache();
  const geo = createGeo({ cache, googleKey: "test-key", fetchImpl });
  const g = await geo.geocode("100 W Test St, Buckeye, AZ 85326");
  assert.equal(g.provider, "census");
  assert.equal(g.zip, "85326");
  assert.deepEqual(calls, ["maps.googleapis.com", "geocoding.geo.census.gov"]);
  assert.equal(await geo.lastIssue(), null, "a fallback that worked is not an outage");
  await geo.geocode("100 W Test St, Buckeye, AZ 85326");
  assert.equal(calls.length, 2, "the answer is cached");
});

test("Google finding nothing is a real answer, not a reason to ask Census", async () => {
  const calls = [];
  const geo = createGeo({ cache: memoryCache(), googleKey: "test-key", fetchImpl: async (url) => (calls.push(url), reply({ status: "ZERO_RESULTS", results: [] })) });
  assert.equal(await geo.geocode("1 Nowhere Rd, Buckeye, AZ 85326"), null);
  assert.equal(calls.length, 1);
});

test("when every lookup fails: a GEO_UNAVAILABLE error, and the reason is kept for the dashboard", async () => {
  const fetchImpl = async (url) => {
    if (/googleapis/.test(url)) throw new TypeError("fetch failed");
    return htmlPage(502);
  };
  const cache = memoryCache();
  const geo = createGeo({ cache, googleKey: "test-key", fetchImpl, clock: () => 1234 });
  await assert.rejects(geo.geocode("100 W Test St, Buckeye, AZ 85326"), (e) => e.code === "GEO_UNAVAILABLE" && /Google address lookup did not respond/.test(e.message) && /Census address lookup returned 502/.test(e.message));
  const issue = await geo.lastIssue();
  assert.equal(issue.at, 1234);
  assert.match(issue.message, /Census address lookup returned 502/);
  assert.equal(cache.m.has("geo:100 w test st buckeye az 85326"), false, "a failed lookup is not cached as 'not found'");
});

test("without a Google key, a Census error page is an outage, not 'address not found'", async () => {
  const geo = createGeo({ cache: memoryCache(), googleKey: "", fetchImpl: async () => reply({ errors: ["Service unavailable"] }, 503) });
  await assert.rejects(geo.geocode("100 W Test St, Buckeye, AZ 85326"), { code: "GEO_UNAVAILABLE" });
});
