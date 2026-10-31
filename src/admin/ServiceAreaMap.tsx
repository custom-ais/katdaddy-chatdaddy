import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Loader2, MapPin, Route } from 'lucide-react';
import { api } from '../lib/api';
import { Field, inputClass, secondaryButton, ErrorNote } from './ui';
import { useServiceAreaEditor } from './useServiceAreaEditor';
import { money, drivingAreaFor } from '../../shared/domain.mjs';

const colors: Record<string, string> = { in: '#059669', travel: '#d97706', out: '#64748b', unknown: '#94a3b8' };
const label: Record<string, string> = { in: 'Standard service area', travel: 'Travel charge applies', out: 'Outside service area', unknown: 'Route unavailable' };
const tooltip = (text: string) => { const node = document.createElement('span'); node.textContent = text; return node; };

export function ServiceAreaMap({ config, onChange }: { config: any; onChange: (key: string, value: any) => void }) {
  const container = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null), markers = useRef<L.LayerGroup | null>(null);
  const [result, setResult] = useState<any>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [address, setAddress] = useState(''), [check, setCheck] = useState<any>(null), [checking, setChecking] = useState(false);
  const fingerprint = JSON.stringify([config.baseAddress, config.baseLocation, config.travelAreaMiles, config.serviceAreaMode]);
  const [generatedFor, setGeneratedFor] = useState('');
  useEffect(() => {
    if (!container.current) return;
    const m = L.map(container.current, { scrollWheelZoom: false }).setView([33.5, -112.4], 9);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(m);
    markers.current = L.layerGroup().addTo(m); map.current = m;
    const resize = new ResizeObserver(() => m.invalidateSize()); resize.observe(container.current);
    return () => { resize.disconnect(); m.remove(); map.current = null; };
  }, []);
  useEffect(() => {
    if (!result || !map.current || !markers.current) return;
    markers.current.clearLayers();
    const points: L.LatLngTuple[] = [[result.base.lat, result.base.lng]];
    for (const point of config.serviceAreaMode === "radius" ? [] : result.points) {
      const area = drivingAreaFor(point.miles, config, "", point);
      points.push([point.lat, point.lng]);
      L.circleMarker([point.lat, point.lng], { radius: 6, color: colors[area] || colors.unknown, fillOpacity: 0.8, weight: 2 })
        .bindTooltip(tooltip(`${label[area]}${Number.isFinite(point.miles) ? ` · ${point.miles.toFixed(1)} driving miles` : ''}`)).addTo(markers.current);
    }
    if (check?.location) {
      const point: L.LatLngTuple = [check.location.lat, check.location.lng]; points.push(point);
      L.circleMarker(point, { radius: 11, color: colors[check.area] || '#334155', fillOpacity: 1, weight: 4 }).bindTooltip(tooltip(`Checked address · ${check.driveFromBaseMiles?.toFixed(1) || '?'} driving miles`)).addTo(markers.current);
    }
    map.current.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 12 });
  }, [result, check, config.serviceAreaMode, config.serviceAreaMiles, config.travelAreaMiles, config.customServiceAreas]);
  const editor = useServiceAreaEditor(map, config, onChange, result?.base);
  const generate = async () => {
    setBusy(true); setError(''); setCheck(null);
    try { const response = await api('/api/admin/service-area/map', { method: 'POST', body: { baseAddress: config.baseAddress, baseLocation: config.baseLocation, customServiceAreas: config.customServiceAreas, serviceAreaMode: config.serviceAreaMode, serviceAreaMiles: config.serviceAreaMiles, travelAreaMiles: config.travelAreaMiles } }); setResult(response); setGeneratedFor(fingerprint); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const checkAddress = async () => {
    setChecking(true); setCheck(null); setError('');
    try { setCheck(await api('/api/admin/geo/check', { method: 'POST', body: { address, config: { serviceAreaMode: config.serviceAreaMode === 'radius' ? 'radius' : 'driving_distance', baseAddress: config.baseAddress, baseLocation: config.baseLocation, customServiceAreas: config.customServiceAreas, serviceAreaMiles: config.serviceAreaMiles, travelAreaMiles: config.travelAreaMiles, travelZoneFeeCents: config.travelZoneFeeCents } } })); }
    catch (e) { setError((e as Error).message); } finally { setChecking(false); }
  };
  return <div className="space-y-4">
    <Field label="Truck's base address" hint={config.baseLocation ? `Selected map point: ${config.baseLocation.lat.toFixed(5)}, ${config.baseLocation.lng.toFixed(5)}. Drag the base pin to move it, or type an address.` : "Type an address or use Set base on map below."}><input className={inputClass} value={config.baseAddress} placeholder="Street, City, AZ ZIP" onChange={(e) => { onChange('baseAddress', e.target.value); onChange('baseLocation', null); }} /></Field>
    <div className="grid sm:grid-cols-3 gap-3">
      <Field label={config.serviceAreaMode === 'radius' ? 'Standard radius (miles)' : 'Standard area (driving miles)'}><input type="number" min="1" max="150" step="1" className={inputClass} value={config.serviceAreaMiles} onChange={(e) => { const n = Number(e.target.value); onChange("serviceAreaMiles", n); if (n > config.travelAreaMiles) onChange("travelAreaMiles", n); }} /></Field>
      <Field label={config.serviceAreaMode === 'radius' ? 'Outer travel radius (miles)' : 'Outer travel area (driving miles)'}><input type="number" min={config.serviceAreaMiles} max="150" step="1" className={inputClass} value={config.travelAreaMiles} onChange={(e) => onChange('travelAreaMiles', Number(e.target.value))} /></Field>
      <Field label="Outer-area travel charge ($)"><input type="number" min="0" max="500" step="1" className={inputClass} value={config.travelZoneFeeCents / 100} onChange={(e) => onChange('travelZoneFeeCents', Math.round(Number(e.target.value) * 100))} /></Field>
    </div>
    <div className="flex flex-wrap items-center gap-3"><button type="button" className={secondaryButton} onClick={generate} disabled={busy || (!config.baseAddress.trim() && !config.baseLocation)}>{busy ? <Loader2 size={16} className="animate-spin" /> : <Route size={16} />}{busy ? 'Updating map…' : config.serviceAreaMode === 'radius' ? 'Update radius map' : 'Update driving-distance map'}</button>{result && generatedFor !== fingerprint && <span className="text-xs font-bold text-amber-700">Settings changed. Update the map to match.</span>}</div>
    {error && <ErrorNote>{error}</ErrorNote>}
    <div className="grid sm:grid-cols-2 gap-4">
      <Field label={config.serviceAreaMode === 'radius' ? 'Adjust standard radius' : 'Adjust standard driving limit'} hint={`${config.serviceAreaMiles} miles`}><input aria-label="Standard area mileage slider" type="range" min="1" max="150" value={config.serviceAreaMiles} className="w-full accent-emerald-600" onChange={(e) => { const n = Number(e.target.value); onChange('serviceAreaMiles', n); if (n > config.travelAreaMiles) onChange('travelAreaMiles', n); }} /></Field>
      <Field label={config.serviceAreaMode === 'radius' ? 'Adjust outer radius' : 'Adjust outer driving limit'} hint={`${config.travelAreaMiles} miles`}><input aria-label="Outer area mileage slider" type="range" min={config.serviceAreaMiles} max="150" value={config.travelAreaMiles} className="w-full accent-amber-600" onChange={(e) => onChange('travelAreaMiles', Number(e.target.value))} /></Field>
    </div>
    {editor}
    <div ref={container} className="h-80 sm:h-96 w-full rounded-2xl border border-slate-200 overflow-hidden isolate z-0" role="region" aria-label="Driving-distance service area map" />
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs font-semibold text-slate-600">{['in', 'travel', 'out'].map((area) => <span key={area} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colors[area] }} />{label[area]}</span>)}</div>
    <p className="text-xs text-slate-500">{config.serviceAreaMode === 'radius' ? 'Green and amber circles show your standard and outer radii. Custom included or excluded areas override those circles.' : 'Map dots show sampled road-distance checks. Driving miles follow roads, so this mode does not use a circular boundary.'} Check a complete address for its coverage and travel charge. Click Save settings to apply your edits.</p>
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
      <div className="grid sm:grid-cols-[1fr_auto] items-end gap-3"><Field label="Check a service address"><input className={inputClass} value={address} placeholder="Street, City, AZ ZIP" onChange={(e) => { setAddress(e.target.value); setCheck(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (address.trim() && !checking) void checkAddress(); } }} /></Field><button type="button" className={secondaryButton} onClick={checkAddress} disabled={checking || !address.trim() || (!config.baseAddress.trim() && !config.baseLocation)}>{checking ? <Loader2 size={16} className="animate-spin" /> : <MapPin size={16} />}Check address</button></div>
      {check && <div role="status" className="rounded-xl bg-white border border-slate-200 p-3 text-sm"><strong>{check.reason === 'routing_unavailable' ? 'Driving distance could not be verified' : check.area === 'in' ? 'Inside the standard service area' : check.area === 'travel' ? 'Inside the outer travel area' : 'Outside the service area'}</strong>{Number.isFinite(check.driveFromBaseMiles) && <p className="mt-1 text-slate-600">{check.driveFromBaseMiles.toFixed(1)} {config.serviceAreaMode === 'radius' ? 'miles from base' : 'driving miles'}{check.driveFromBaseMin != null ? ` · ${check.driveFromBaseMin} min` : ''} · Travel charge {money(check.travelFeeCents || 0)}</p>}</div>}
    </div>
  </div>;
}
