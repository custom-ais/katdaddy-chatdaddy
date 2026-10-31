export const validPoint = (p) => Boolean(p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180);
export function distanceMiles(a, b) {
  const rad = (v) => v * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function pointInArea(point, vertices) {
  if (!validPoint(point) || !Array.isArray(vertices) || vertices.length < 3) return false;
  const x = point.lng, y = point.lat;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i], b = vertices[j];
    const cross = (x - a.lng) * (b.lat - a.lat) - (y - a.lat) * (b.lng - a.lng);
    if (Math.abs(cross) < 1e-10 && x >= Math.min(a.lng, b.lng) && x <= Math.max(a.lng, b.lng) && y >= Math.min(a.lat, b.lat) && y <= Math.max(a.lat, b.lat)) return true;
    if ((a.lat > y) !== (b.lat > y) && x < (b.lng - a.lng) * (y - a.lat) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}
export function customCoverage(point, areas = []) {
  if (!validPoint(point)) return null;
  if (areas.some((area) => area.kind === 'exclude' && pointInArea(point, area.points))) return 'out';
  if (areas.some((area) => area.kind === 'include' && pointInArea(point, area.points))) return 'in';
  return null;
}
