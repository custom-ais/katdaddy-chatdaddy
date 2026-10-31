import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { Crosshair, Pencil, Plus, Minus, Trash2, Undo2, X, Check } from 'lucide-react';
import { distanceMiles } from '../../shared/coverage.mjs';
import { secondaryButton, subtleButton } from './ui';

type Point = { lat: number; lng: number };
type Mode = '' | 'base' | 'include' | 'exclude' | 'edit';
const point = (p: L.LatLng): Point => ({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) });
const icon = (color: string, large = false) => L.divIcon({ className: '', html: `<span style="display:block;width:${large ? 22 : 14}px;height:${large ? 22 : 14}px;background:${color};border:3px solid white;border-radius:50%;box-shadow:0 1px 5px #0007"></span>`, iconSize: large ? [22, 22] : [14, 14], iconAnchor: large ? [11, 11] : [7, 7] });

export function useServiceAreaEditor(map: React.RefObject<L.Map | null>, config: any, onChange: (key: string, value: any) => void, resolvedBase: any) {
  const [mode, setMode] = useState<Mode>(''), [draft, setDraft] = useState<Point[]>([]);
  const layer = useRef<L.LayerGroup | null>(null), draftLayer = useRef<L.LayerGroup | null>(null);
  const latest = useRef({ config, onChange, mode }); latest.current = { config, onChange, mode };
  const centered = useRef('');
  useEffect(() => {
    const m = map.current; if (!m) return;
    layer.current = L.layerGroup().addTo(m); draftLayer.current = L.layerGroup().addTo(m);
    const click = (event: L.LeafletMouseEvent) => {
      const current = latest.current;
      if (current.mode === 'base') { current.onChange('baseLocation', point(event.latlng)); current.onChange('baseAddress', ''); setMode(''); }
      else if (current.mode === 'include' || current.mode === 'exclude') setDraft((old) => old.length < 60 ? [...old, point(event.latlng)] : old);
    };
    m.on('click', click);
    return () => { m.off('click', click); layer.current?.remove(); draftLayer.current?.remove(); };
  }, [map]);
  useEffect(() => {
    const m = map.current, group = layer.current; if (!m || !group) return;
    group.clearLayers();
    const base = config.baseLocation || resolvedBase;
    if (base) {
      const p: L.LatLngTuple = [base.lat, base.lng];
      L.marker(p, { draggable: true, icon: icon('#0f172a', true), zIndexOffset: 1000 }).bindTooltip('Base location — drag to move').on('dragend', (event) => { latest.current.onChange('baseLocation', point(event.target.getLatLng())); latest.current.onChange('baseAddress', ''); }).addTo(group);
      if (config.serviceAreaMode === 'radius') {
        const outer = L.circle(p, { radius: config.travelAreaMiles * 1609.344, color: '#d97706', fillColor: '#f59e0b', fillOpacity: 0.1, weight: 2 }).addTo(group);
        L.circle(p, { radius: config.serviceAreaMiles * 1609.344, color: '#059669', fillColor: '#10b981', fillOpacity: 0.15, weight: 2 }).addTo(group);
        for (const [key, color] of [['serviceAreaMiles', '#059669'], ['travelAreaMiles', '#d97706']]) {
          const miles = config[key], handle: L.LatLngTuple = [base.lat, base.lng + miles / (69 * Math.cos(base.lat * Math.PI / 180))];
          L.marker(handle, { draggable: true, icon: icon(color) }).bindTooltip(key === 'serviceAreaMiles' ? 'Drag standard radius' : 'Drag outer radius').on('dragend', (event) => {
            const next = Math.max(1, Math.min(150, Math.round(distanceMiles(base, point(event.target.getLatLng())))));
            const current = latest.current;
            current.onChange(key, key === 'travelAreaMiles' ? Math.max(next, current.config.serviceAreaMiles) : next);
            if (key === 'serviceAreaMiles' && next > current.config.travelAreaMiles) current.onChange('travelAreaMiles', next);
          }).addTo(group);
        }
        const key = JSON.stringify([p, config.serviceAreaMiles, config.travelAreaMiles, 'radius']);
        if (centered.current !== key) { m.fitBounds(outer.getBounds(), { padding: [24, 24] }); centered.current = key; }
      } else {
        const key = JSON.stringify(p);
        if (centered.current !== key) { m.setView(p, Math.max(9, m.getZoom())); centered.current = key; }
      }
    }
    for (const area of config.customServiceAreas || []) {
      const color = area.kind === 'exclude' ? '#dc2626' : '#059669';
      L.polygon(area.points.map((p: Point) => [p.lat, p.lng] as L.LatLngTuple), { color, fillOpacity: 0.2, weight: 3 }).bindTooltip(area.kind === 'exclude' ? 'Excluded service area' : 'Included standard service area').addTo(group);
      if (mode === 'edit') area.points.forEach((p: Point, i: number) => {
        L.marker([p.lat, p.lng], { draggable: true, icon: icon(color) }).bindTooltip('Drag boundary point').on('dragend', (event) => {
          const next = point(event.target.getLatLng());
          latest.current.onChange('customServiceAreas', latest.current.config.customServiceAreas.map((a: any) => a.id === area.id ? { ...a, points: a.points.map((v: Point, index: number) => index === i ? next : v) } : a));
        }).addTo(group);
      });
    }
  }, [map, config.baseLocation, resolvedBase, config.serviceAreaMode, config.serviceAreaMiles, config.travelAreaMiles, config.customServiceAreas, mode]);
  useEffect(() => {
    const group = draftLayer.current; if (!group) return; group.clearLayers();
    const points = draft.map((p) => [p.lat, p.lng] as L.LatLngTuple), color = mode === 'exclude' ? '#dc2626' : '#059669';
    if (points.length > 1) L.polyline(points, { color, dashArray: '5 5', weight: 3 }).addTo(group);
    for (const p of points) L.circleMarker(p, { radius: 5, color, fillOpacity: 1 }).addTo(group);
  }, [draft, mode]);
  const begin = (next: Mode) => { setDraft([]); setMode(mode === next ? '' : next); };
  const finish = () => {
    if (draft.length < 3) return;
    onChange('customServiceAreas', [...(config.customServiceAreas || []), { id: crypto.randomUUID(), kind: mode, points: draft }]); setDraft([]); setMode('');
  };
  const drawing = mode === 'include' || mode === 'exclude';
  return <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
    <div className="flex flex-wrap gap-2"><button type="button" className={secondaryButton} aria-pressed={mode === 'base'} onClick={() => begin('base')}><Crosshair size={15} />Set base on map</button><button type="button" className={secondaryButton} disabled={(config.customServiceAreas || []).length >= 12} aria-pressed={mode === 'include'} onClick={() => begin('include')}><Plus size={15} />Draw included area</button><button type="button" className={secondaryButton} disabled={(config.customServiceAreas || []).length >= 12} aria-pressed={mode === 'exclude'} onClick={() => begin('exclude')}><Minus size={15} />Draw excluded area</button><button type="button" className={secondaryButton} disabled={!config.customServiceAreas?.length} aria-pressed={mode === 'edit'} onClick={() => begin('edit')}><Pencil size={15} />Edit boundaries</button></div>
    <p role="status" className="text-xs text-slate-600">{mode === 'base' ? 'Click the map to place the base. You can then drag the pin to refine it.' : drawing ? `Click the map to add boundary points (${draft.length}/60). Use at least three points, then finish the shape.` : mode === 'edit' ? 'Drag the boundary handles to reshape the included or excluded areas.' : 'In radius mode, drag the green or amber handles to resize coverage. Included areas receive standard service; excluded areas always take priority.'}</p>
    {drawing && <div className="flex flex-wrap gap-2"><button type="button" className={secondaryButton} disabled={draft.length < 3} onClick={finish}><Check size={15} />Finish shape</button><button type="button" className={subtleButton} disabled={!draft.length} onClick={() => setDraft((p) => p.slice(0, -1))}><Undo2 size={15} />Undo point</button><button type="button" className={subtleButton} onClick={() => { setDraft([]); setMode(''); }}><X size={15} />Cancel drawing</button></div>}
    {(config.customServiceAreas || []).map((area: any, i: number) => <div key={area.id} className="flex justify-between items-center text-xs"><span className={area.kind === 'exclude' ? 'text-red-700 font-bold' : 'text-emerald-700 font-bold'}>{area.kind === 'exclude' ? 'Excluded' : 'Included'} area {i + 1} · {area.points.length} points</span><button type="button" className={subtleButton} aria-label={`Remove ${area.kind} area ${i + 1}`} onClick={() => onChange('customServiceAreas', config.customServiceAreas.filter((a: any) => a.id !== area.id))}><Trash2 size={14} />Remove</button></div>)}
  </div>;
}
