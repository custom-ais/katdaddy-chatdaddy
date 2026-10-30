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

// ---- address suggestions -------------------------------------------------------------
const PLACE = {
  formattedAddress: "15420 W Bell Rd, Surprise, AZ 85374, USA",
  location: { latitude: 33.6386, longitude: -112.3889 },
  addressComponents: [
    { longText: "15420", shortText: "15420", types: ["street_number"] },
    { longText: "West Bell Road", shortText: "W Bell Rd", types: ["route"] },
    { longText: "Surprise", shortText: "Surprise", types: ["locality", "political"] },
    { longText: "Arizona", shortText: "AZ", types: ["administrative_area_level_1", "political"] },
    { longText: "85374", shortText: "85374", types: ["postal_code"] },
  ],
};

test("suggestions ask Google for West Valley street addresses with the session token", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return reply({ suggestions: [{ placePrediction: { placeId: "ChIJabc12345", text: { text: "15420 W Bell Rd, Surprise, AZ, USA" }, structuredFormat: { mainText: { text: "15420 W Bell Rd" }, secondaryText: { text: "Surprise, AZ, USA" } } } }, { queryPrediction: { text: { text: "bell rd" } } }] });
  };
  const geo = createGeo({ cache: memoryCache(), googleKey: "test-key", fetchImpl });
  assert.equal(geo.suggestions, true);
  const list = await geo.suggestAddresses("15420 w bell", "0b7f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
  assert.deepEqual(list, [{ id: "ChIJabc12345", main: "15420 W Bell Rd", secondary: "Surprise, AZ, USA" }]);
  assert.equal(sent.url, "https://places.googleapis.com/v1/places:autocomplete");
  assert.equal(sent.init.headers["X-Goog-Api-Key"], "test-key");
  assert.equal(sent.body.sessionToken, "0b7f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
  assert.deepEqual(sent.body.includedPrimaryTypes, ["street_address", "premise", "subpremise"]);
  assert.equal(sent.body.locationBias.circle.radius, 50000);
});

test("a chosen suggestion becomes street, city and ZIP, and booking won't look it up again", async () => {
  const urls = [];
  const cache = memoryCache();
  const geo = createGeo({ cache, googleKey: "test-key", fetchImpl: async (url, init) => (urls.push([url, init.headers["X-Goog-FieldMask"]]), reply(PLACE)) });
  const a = await geo.addressFor("ChIJabc12345", "0b7f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
  assert.deepEqual(a, { street: "15420 W Bell Rd", city: "Surprise", state: "AZ", zip: "85374", formatted: "15420 W Bell Rd, Surprise, AZ 85374, USA", precise: true });
  assert.deepEqual(urls[0], ["https://places.googleapis.com/v1/places/ChIJabc12345?sessionToken=0b7f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "addressComponents,formattedAddress,location"]);
  const g = await geo.geocode("15420 W Bell Rd, Surprise, AZ 85374");
  assert.equal(g.lat, 33.6386);
  assert.equal(urls.length, 1, "the contact step's lookup comes from the cache");
});

test("a street with no house number is marked imprecise; no key means no suggestions", async () => {
  const road = { ...PLACE, addressComponents: PLACE.addressComponents.filter((c) => !c.types.includes("street_number")) };
  const geo = createGeo({ cache: memoryCache(), googleKey: "test-key", fetchImpl: async () => reply(road) });
  assert.equal((await geo.addressFor("ChIJroad12345", "")).precise, false);
  const none = createGeo({ cache: memoryCache(), googleKey: "", fetchImpl: async () => { throw new Error("should not call"); } });
  assert.equal(none.suggestions, false);
  assert.deepEqual(await none.suggestAddresses("15420 w bell", "0b7f6a3e-1c2d"), []);
});

test("a refused Places request is reported for the dashboard", async () => {
  const cache = memoryCache();
  const geo = createGeo({ cache, googleKey: "test-key", clock: () => 99, fetchImpl: async () => reply({ error: { status: "PERMISSION_DENIED", message: "Places API (New) has not been used in project 123" } }, 403) });
  await assert.rejects(geo.suggestAddresses("15420 w bell", "0b7f6a3e-1c2d"), /Google address suggestions failed: PERMISSION_DENIED/);
  assert.match((await geo.lastIssue()).message, /Places API \(New\) has not been used/);
});
