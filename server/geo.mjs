// Geocoding + drive times.
// With GOOGLE_MAPS_API_KEY: Google Geocoding API + Routes API (real road drive times).
// Without it: US Census geocoder (free) + a straight-line estimate. The estimate is
// fine for testing but too rough to enforce the 20-minute rule in production.
// If Google refuses or errors, the Census lookup is tried next. When every lookup fails the
// error has code GEO_UNAVAILABLE, and the reason is kept for the office dashboard.

const GEOCODE_TTL = 60 * 60 * 24 * 90;
const DRIVE_TTL = 60 * 60 * 24 * 30;

export function normalizeAddress(text) {
  return String(text || "").toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
}

export function haversineMiles(a, b) {
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** West Valley grid roads: ~1.3x detour at ~32 mph average. */
export const estimateDriveMinutes = (a, b) => Math.round((haversineMiles(a, b) * 1.3 * 60) / 32);

const pointKey = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
const LOOKUP_TIMEOUT_MS = 8000;
const ISSUE_KEY = "diag:geo";
// Address suggestions lean toward the West Valley (Places allows a 50 km bias circle).
const WEST_VALLEY = { latitude: 33.53, longitude: -112.38 };
const ADDRESS_TYPES = ["street_address", "premise", "subpremise"];

export function createGeo({ cache, googleKey = process.env.GOOGLE_MAPS_API_KEY || "", fetchImpl = fetch, clock = () => Date.now() } = {}) {
  /** GET a JSON API with a time limit; an error page or a hang becomes a plain Error. */
  async function getJson(url, label) {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`${label} did not respond (${error.name === "TimeoutError" ? "timed out" : error.message})`);
    }
    const json = await response.json().catch(() => null);
    if (!json) throw new Error(`${label} returned ${response.status} without a usable answer`);
    return { response, json };
  }

  const component = (cs, type, short = false) => {
    const hit = (cs || []).find((c) => c.types?.includes(type));
    return hit ? (short ? hit.short_name : hit.long_name) : "";
  };

  async function geocodeGoogle(address) {
    const params = new URLSearchParams({ address, components: "country:US", key: googleKey });
    const { json } = await getJson(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, "Google address lookup");
    if (json.status === "ZERO_RESULTS") return null;
    // e.g. REQUEST_DENIED when the Geocoding API isn't enabled or the key only allows websites.
    if (json.status !== "OK") throw new Error(`Google address lookup refused: ${json.status}${json.error_message ? ` (${json.error_message})` : ""}`);
    const top = json.results[0], c = top.address_components;
    const number = component(c, "street_number");
    return {
      lat: top.geometry.location.lat,
      lng: top.geometry.location.lng,
      formatted: top.formatted_address,
      city: component(c, "locality") || component(c, "sublocality") || component(c, "neighborhood"),
      state: component(c, "administrative_area_level_1", true),
      zip: component(c, "postal_code"),
      neighborhood: component(c, "neighborhood"),
      precise: Boolean(number) && !top.partial_match,
      provider: "google",
    };
  }

  async function geocodeCensus(address) {
    const params = new URLSearchParams({ address, benchmark: "Public_AR_Current", format: "json" });
    const { response, json } = await getJson(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params}`, "Census address lookup");
    if (!response.ok || !json.result) throw new Error(`Census address lookup returned ${response.status}${json.errors ? ` (${[].concat(json.errors).join("; ")})` : ""}`);
    const m = json.result.addressMatches?.[0];
    if (!m) return null;
    return {
      lat: m.coordinates.y,
      lng: m.coordinates.x,
      formatted: m.matchedAddress,
      city: String(m.addressComponents?.city || "").replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()),
      state: m.addressComponents?.state || "",
      zip: m.addressComponents?.zip || "",
      precise: true,
      provider: "census",
    };
  }

  async function geocode(address) {
    const norm = normalizeAddress(address);
    if (!norm) return null;
    const key = `geo:${norm}`;
    const cached = await cache.kvGet(key);
    if (cached) return cached.miss ? null : cached;
    const lookups = googleKey ? [geocodeGoogle, geocodeCensus] : [geocodeCensus];
    const problems = [];
    for (const lookup of lookups) {
      let result;
      try {
        result = await lookup(address);
      } catch (error) {
        problems.push(error.message);
        console.warn("[geo]", error.message);
        continue;
      }
      await cache.kvSet(key, result || { miss: true }, result ? GEOCODE_TTL : 6 * 3600);
      return result;
    }
    const message = problems.join(" Then: ");
    await cache.kvSet(ISSUE_KEY, { at: clock(), message }, 60 * 60 * 24 * 7).catch(() => {});
    const error = new Error(`Address lookup unavailable. ${message}`);
    error.code = "GEO_UNAVAILABLE";
    throw error;
  }

  // ---- address suggestions while the customer types (Google Places API (New)) ---------------
  // One session token per address entry: the typing requests and the final Place Details call
  // are billed together as one session.
  const placesError = async (response, json, label) => {
    const reason = json?.error ? `${json.error.status || response.status}${json.error.message ? ` (${json.error.message})` : ""}` : response.status;
    const message = `${label} failed: ${reason}`;
    await cache.kvSet(ISSUE_KEY, { at: clock(), message }, 60 * 60 * 24 * 7).catch(() => {});
    return new Error(message);
  };

  /** Up to 5 suggestions: [{ id, main, secondary }]. Empty without a Google key. */
  async function suggestAddresses(input, sessionToken) {
    if (!googleKey) return [];
    const response = await fetchImpl("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": googleKey },
      body: JSON.stringify({
        input, sessionToken, languageCode: "en", regionCode: "us", includedRegionCodes: ["us"],
        includedPrimaryTypes: ADDRESS_TYPES,
        locationBias: { circle: { center: WEST_VALLEY, radius: 50000 } },
      }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json) throw await placesError(response, json, "Google address suggestions");
    return (json.suggestions || []).map((x) => x.placePrediction).filter((p) => p?.placeId).slice(0, 5).map((p) => ({
      id: p.placeId,
      main: p.structuredFormat?.mainText?.text || p.text?.text || "",
      secondary: p.structuredFormat?.secondaryText?.text || "",
    }));
  }

  /** The chosen suggestion as street / city / ZIP. Also primes the geocode cache for booking. */
  async function addressFor(placeId, sessionToken) {
    if (!googleKey) return null;
    const qs = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : "";
    const response = await fetchImpl(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${qs}`, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      headers: { "X-Goog-Api-Key": googleKey, "X-Goog-FieldMask": "addressComponents,formattedAddress,location" },
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json) throw await placesError(response, json, "Google address details");
    const part = (type, short = false) => {
      const hit = (json.addressComponents || []).find((c) => c.types?.includes(type));
      return hit ? (short ? hit.shortText : hit.longText) || "" : "";
    };
    const number = part("street_number"), road = part("route", true), unit = part("subpremise");
    const street = [number, road].filter(Boolean).join(" ") + (unit ? ` #${unit}` : "");
    const out = {
      street,
      city: part("locality") || part("sublocality") || part("neighborhood"),
      state: part("administrative_area_level_1", true),
      zip: part("postal_code"),
      formatted: json.formattedAddress || "",
      precise: Boolean(number),
    };
    if (out.precise && out.city && out.zip && json.location) {
      const g = {
        lat: json.location.latitude, lng: json.location.longitude, formatted: out.formatted, city: out.city,
        state: out.state, zip: out.zip, neighborhood: part("neighborhood"), precise: true, provider: "google",
      };
      // The same key the contact step looks up, so booking doesn't geocode this address again.
      await cache.kvSet(`geo:${normalizeAddress(`${out.street}, ${out.city}, AZ ${out.zip}`)}`, g, GEOCODE_TTL).catch(() => {});
    }
    return out;
  }

  /** The last time every address lookup failed, for the dashboard (null if none this week). */
  const lastIssue = async () => (await cache.kvGet(ISSUE_KEY).catch(() => null)) || null;

  async function matrix(origin, destinations) {
    const wp = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
    const response = await fetchImpl("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
      method: "POST",
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleKey,
        "X-Goog-FieldMask": "originIndex,destinationIndex,status,duration,condition,distanceMeters",
      },
      body: JSON.stringify({ origins: [wp(origin)], destinations: destinations.map(wp), travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE" }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(json)) throw new Error(`Route matrix failed: ${json?.error?.message || response.status}`);
    // Proto3 JSON omits zero values, so a missing index means 0.
    return json.map((el) => ({
      d: el.destinationIndex ?? 0,
      minutes: el.condition === "ROUTE_EXISTS" && el.duration ? Math.round(Number(String(el.duration).replace("s", "")) / 60) : null,
      miles: el.condition === "ROUTE_EXISTS" && !el.status?.code && Number.isFinite(el.distanceMeters) ? el.distanceMeters / 1609.344 : null,
    }));
  }

  /** pairs: [{from, to}] -> minutes[] in the same order (null when unknown). */
  async function driveMinutes(pairs) {
    const out = new Array(pairs.length).fill(null);
    const missing = [];
    await Promise.all(
      pairs.map(async (p, i) => {
        if (!p.from || !p.to) return;
        if (pointKey(p.from) === pointKey(p.to)) return void (out[i] = 0);
        if (!googleKey) return void (out[i] = estimateDriveMinutes(p.from, p.to));
        const hit = await cache.kvGet(`drive:${pointKey(p.from)}>${pointKey(p.to)}`);
        if (hit) out[i] = hit.minutes;
        else missing.push(i);
      }),
    );
    const byOrigin = new Map();
    for (const i of missing) {
      const k = pointKey(pairs[i].from);
      if (!byOrigin.has(k)) byOrigin.set(k, []);
      byOrigin.get(k).push(i);
    }
    for (const indexes of byOrigin.values()) {
      for (let s = 0; s < indexes.length; s += 24) {
        const chunk = indexes.slice(s, s + 24);
        let elements = [];
        try {
          elements = await matrix(pairs[chunk[0]].from, chunk.map((i) => pairs[i].to));
        } catch (error) {
          console.warn("[geo] route matrix unavailable, using estimate:", error.message);
        }
        for (const [pos, i] of chunk.entries()) {
          const el = elements.find((e) => e.d === pos);
          out[i] = el?.minutes ?? estimateDriveMinutes(pairs[i].from, pairs[i].to);
          if (el?.minutes != null) {
            await cache.kvSet(`drive:${pointKey(pairs[i].from)}>${pointKey(pairs[i].to)}`, { minutes: el.minutes }, DRIVE_TTL);
          }
        }
      }
    }
    return out;
  }

  // Coverage uses measured road miles only. A routing outage must never silently become a radius.
  async function roadRoutes(pairs) {
    if (!googleKey) throw Object.assign(new Error("Driving-distance coverage requires Google Routes to be configured."), { code: "ROUTING_UNAVAILABLE" });
    const out = Array(pairs.length).fill(null), groups = new Map();
    for (let i = 0; i < pairs.length; i++) {
      const { from, to } = pairs[i];
      if (!from || !to) continue;
      if (pointKey(from) === pointKey(to)) { out[i] = { miles: 0, minutes: 0 }; continue; }
      const cached = await cache.kvGet(`road:${pointKey(from)}>${pointKey(to)}`);
      if (cached && Number.isFinite(cached.miles)) { out[i] = cached; continue; }
      const key = pointKey(from);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    for (const indexes of groups.values()) for (let start = 0; start < indexes.length; start += 24) {
      const chunk = indexes.slice(start, start + 24);
      let elements;
      try { elements = await matrix(pairs[chunk[0]].from, chunk.map((i) => pairs[i].to)); }
      catch (cause) { throw Object.assign(new Error("Road-distance lookup is unavailable. Please try again or ask the office to review the address."), { code: "ROUTING_UNAVAILABLE", cause }); }
      for (let pos = 0; pos < chunk.length; pos++) {
        const i = chunk[pos], el = elements.find((e) => e.d === pos);
        if (el?.miles == null) continue;
        out[i] = { miles: el.miles, minutes: el.minutes };
        await cache.kvSet(`road:${pointKey(pairs[i].from)}>${pointKey(pairs[i].to)}`, out[i], DRIVE_TTL);
      }
    }
    return out;
  }

  async function serviceAreaSamples(base, maximumMiles) {
    const key = `area-samples:${pointKey(base)}:${maximumMiles}`;
    const hit = await cache.kvGet(key);
    if (hit) return hit;
    const points = [];
    for (const fraction of [0.25, 0.55, 0.85]) for (let bearing = 0; bearing < 12; bearing++) {
      const angle = bearing * Math.PI / 6, miles = maximumMiles * fraction;
      points.push({ lat: base.lat + miles * Math.cos(angle) / 69, lng: base.lng + miles * Math.sin(angle) / (69 * Math.cos(base.lat * Math.PI / 180)) });
    }
    const routes = await roadRoutes(points.map((to) => ({ from: base, to })));
    const samples = points.map((point, i) => ({ ...point, ...(routes[i] || {}), reachable: Boolean(routes[i]) }));
    await cache.kvSet(key, samples, 86_400);
    return samples;
  }
  return { geocode, driveMinutes, roadRoutes, serviceAreaSamples, lastIssue, suggestAddresses, addressFor, suggestions: Boolean(googleKey), provider: googleKey ? "google" : "estimate" };
}
