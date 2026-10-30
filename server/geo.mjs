// Geocoding + drive times.
// With GOOGLE_MAPS_API_KEY: Google Geocoding API + Routes API (real road drive times).
// Without it: US Census geocoder (free) + a straight-line estimate. The estimate is
// fine for testing but too rough to enforce the 20-minute rule in production.

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

export function createGeo({ cache, googleKey = process.env.GOOGLE_MAPS_API_KEY || "", fetchImpl = fetch } = {}) {
  const component = (cs, type, short = false) => {
    const hit = (cs || []).find((c) => c.types?.includes(type));
    return hit ? (short ? hit.short_name : hit.long_name) : "";
  };

  async function geocodeGoogle(address) {
    const params = new URLSearchParams({ address, components: "country:US", key: googleKey });
    const json = await (await fetchImpl(`https://maps.googleapis.com/maps/api/geocode/json?${params}`)).json();
    if (json.status === "ZERO_RESULTS") return null;
    if (json.status !== "OK") throw new Error(`Geocoding failed: ${json.status}`);
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
    const json = await (await fetchImpl(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params}`)).json();
    const m = json?.result?.addressMatches?.[0];
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
    const result = googleKey ? await geocodeGoogle(address) : await geocodeCensus(address);
    await cache.kvSet(key, result || { miss: true }, result ? GEOCODE_TTL : 6 * 3600);
    return result;
  }

  async function matrix(origin, destinations) {
    const wp = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
    const response = await fetchImpl("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleKey,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
      },
      body: JSON.stringify({ origins: [wp(origin)], destinations: destinations.map(wp), travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE" }),
    });
    const json = await response.json();
    if (!response.ok || !Array.isArray(json)) throw new Error(`Route matrix failed: ${json?.error?.message || response.status}`);
    // Proto3 JSON omits zero values, so a missing index means 0.
    return json.map((el) => ({
      d: el.destinationIndex ?? 0,
      minutes: el.condition === "ROUTE_EXISTS" && el.duration ? Math.round(Number(String(el.duration).replace("s", "")) / 60) : null,
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

  return { geocode, driveMinutes, provider: googleKey ? "google" : "estimate" };
}
