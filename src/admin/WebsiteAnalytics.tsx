import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, ExternalLink, Eye, FileText, Globe, Loader2, MousePointerClick, Share2, Smartphone, UserPlus, Users } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { subtleButton } from './ui';

type Totals = { activeUsers: number; newUsers: number; sessions: number; pageViews: number; engagementRate: number; avgSessionSeconds: number };
export interface WebsiteReport {
  status: 'ok' | 'not_configured' | 'error';
  site: string; days: number; propertyId?: string; timeZone?: string; fetchedAt?: number; serviceAccount?: string;
  totals?: Totals; previous?: Totals;
  daily: { date: string; users: number; sessions: number; pageViews: number }[];
  pages: { path: string; views: number; users: number }[];
  channels: { name: string; sessions: number }[];
  devices: { name: string; users: number }[];
  missing: string[]; problems: string[];
  error?: { code: string; message: string };
}

const RANGES = [7, 28, 90];
const tooltipStyle = { borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 4px 12px rgba(15,23,42,0.06)', fontSize: 12 };
const count = (n: number) => Math.round(n || 0).toLocaleString();
const shortDate = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${iso}T00:00:00Z`));
const duration = (s: number) => { const m = Math.floor(s / 60), r = Math.round(s % 60); return m ? `${m}m ${r}s` : `${r}s`; };
const DEVICE: Record<string, string> = { desktop: 'Computer', mobile: 'Phone', tablet: 'Tablet', smarttv: 'TV' };

/** Percent change against the period before, or null when there's nothing to compare with. */
export function change(current: number, previous: number | undefined): number | null {
  if (!previous || !Number.isFinite(previous)) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function Change({ value, days }: { value: number | null; days: number }) {
  if (value === null) return <span className="text-slate-400">No earlier data to compare</span>;
  const up = value >= 0;
  return <span className={`inline-flex items-center gap-0.5 font-extrabold ${value === 0 ? 'text-slate-500' : up ? 'text-emerald-700' : 'text-rose-700'}`}>
    {value !== 0 && (up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />)}{up && value > 0 ? '+' : ''}{value}%<span className="font-semibold text-slate-500 ml-1">vs previous {days} days</span>
  </span>;
}

function Tile({ label, help, icon, value, delta, days }: { label: string; help: string; icon: React.ReactNode; value: number; delta: number | null; days: number }) {
  return (
    <div className="bg-white p-5 rounded-3xl border border-slate-200/90 shadow-xs space-y-2">
      <div className="flex items-center justify-between"><span className="text-xs font-bold text-slate-500">{label}</span><div className="w-9 h-9 rounded-xl flex items-center justify-center bg-sky-50 text-sky-600">{icon}</div></div>
      <p className="text-3xl font-black text-slate-900 tracking-tight">{count(value)}</p>
      <p className="text-xs text-slate-500 font-medium">{help}</p>
      <p className="pt-2 border-t border-slate-100 text-xs"><Change value={delta} days={days} /></p>
    </div>
  );
}

function Bars({ rows, empty }: { rows: { label: string; value: number; detail?: string }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-sm text-slate-400 font-medium py-6 text-center">{empty}</p>;
  return <ul className="space-y-2.5">{rows.map((r) => (
    <li key={r.label} className="text-xs">
      <div className="flex items-center justify-between gap-3 font-semibold"><span className="text-slate-700 truncate min-w-0" title={r.label}>{r.label}</span><span className="font-black text-slate-900 whitespace-nowrap">{count(r.value)}{r.detail && <span className="font-semibold text-slate-500"> {r.detail}</span>}</span></div>
      <div className="h-1.5 mt-1 rounded-full bg-slate-100 overflow-hidden"><div className="h-full rounded-full bg-sky-500" style={{ width: `${(r.value / max) * 100}%` }} /></div>
    </li>
  ))}</ul>;
}

function Card({ title, note, icon, children, className = '' }: { title: string; note?: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <div className={`bg-white p-5 sm:p-6 rounded-3xl border border-slate-200/90 shadow-xs space-y-4 ${className}`}>
    <div className="flex items-start gap-2">{icon && <span className="text-sky-600 mt-0.5">{icon}</span>}<div><h3 className="font-extrabold text-slate-900 text-base tracking-tight">{title}</h3>{note && <p className="text-xs text-slate-500 font-medium">{note}</p>}</div></div>
    {children}
  </div>;
}

function Setup({ report, canManage }: { report: WebsiteReport; canManage: boolean }) {
  return (
    <div className="bg-white p-5 sm:p-6 rounded-3xl border border-dashed border-slate-300 space-y-3 text-sm text-slate-700">
      <p className="font-extrabold text-slate-900">Google Analytics for {report.site} isn't connected yet.</p>
      {report.problems.map((p) => <p key={p} className="flex items-start gap-2 text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs font-semibold"><AlertTriangle size={14} className="shrink-0 mt-0.5" />{p}</p>)}
      {canManage ? (
        <ol className="list-decimal pl-5 space-y-1.5 text-xs leading-relaxed">
          <li>In <a className="font-bold text-sky-700 underline" href="https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com" target="_blank" rel="noreferrer">Google Cloud</a>, turn on the <b>Google Analytics Data API</b>.</li>
          <li>In Google Cloud → IAM &amp; Admin → <b>Service accounts</b>, create a service account (it needs no roles), then Keys → Add key → <b>JSON</b>.</li>
          <li>In <a className="font-bold text-sky-700 underline" href="https://analytics.google.com/" target="_blank" rel="noreferrer">Google Analytics</a> for {report.site}: Admin → <b>Property access management</b> → add the service account's email as a <b>Viewer</b>{report.serviceAccount ? <> (<code className="font-mono">{report.serviceAccount}</code>)</> : null}.</li>
          <li>Copy the numeric <b>Property ID</b> from Admin → Property details (not the G-… measurement ID).</li>
          <li>In Vercel → this project → Settings → Environment Variables, add <code className="font-mono">GA4_PROPERTY_ID</code> and <code className="font-mono">GA4_SERVICE_ACCOUNT_JSON</code> (paste the whole key file, marked Sensitive), then redeploy.{report.missing.length ? <> Missing now: <b>{report.missing.join(', ')}</b>.</> : null}</li>
        </ol>
      ) : <p className="text-xs text-slate-500">Ask your Master Admin to connect it. Website traffic will show here once it is.</p>}
      <p className="text-[11px] text-slate-400">The key stays on the server. The dashboard only reads reports; it can't change anything in Google Analytics.</p>
    </div>
  );
}

export function WebsiteAnalytics() {
  const { can } = useDashboard();
  const [days, setDays] = useState(28);
  const [report, setReport] = useState<WebsiteReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const latest = useRef(0);

  const load = useCallback(async (range: number) => {
    const id = ++latest.current;
    setLoading(true); setFailure('');
    try {
      const r = await api<WebsiteReport>(`/api/admin/website-analytics?days=${range}`);
      if (id === latest.current) setReport(r);
    } catch (e) {
      if (id === latest.current) setFailure((e as Error).message);
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(days); }, [days, load]);

  const site = report?.site || 'Custom-AIs.com';
  const ok = report?.status === 'ok' && report.totals ? report : null;
  const t = ok?.totals, p = ok?.previous;
  const gaLink = report?.propertyId ? `https://analytics.google.com/analytics/web/#/p${report.propertyId}/reports/intelligenthome` : 'https://analytics.google.com/';
  const updated = ok?.fetchedAt ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', hour: 'numeric', minute: '2-digit' }).format(new Date(ok.fetchedAt)) : '';

  return (
    <section className="space-y-4" aria-labelledby="website-traffic">
      <div className="bg-white p-5 sm:p-6 rounded-3xl border border-slate-200/90 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-2xl bg-sky-50 text-sky-600 border border-sky-100 shrink-0"><Globe size={20} /></div>
          <div>
            <h2 id="website-traffic" className="font-black text-slate-900 text-lg tracking-tight">Website traffic · {site}</h2>
            <p className="text-xs text-slate-500 font-medium">From Google Analytics: the last {days} days through yesterday{updated ? `, read at ${updated}` : ''}. Google updates these numbers every few hours.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex p-1 rounded-xl bg-slate-100" role="group" aria-label="Date range">
            {RANGES.map((r) => <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)} className={`px-3 py-1.5 rounded-lg text-xs font-extrabold ${days === r ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-900'}`}>{r} days</button>)}
          </div>
          {report?.status !== 'not_configured' && <a className={subtleButton} href={gaLink} target="_blank" rel="noreferrer">Open Google Analytics<ExternalLink size={14} /></a>}
        </div>
      </div>

      {loading && !report && !failure && <div className="bg-white p-8 rounded-3xl border border-slate-200/90 flex items-center justify-center gap-2 text-sm text-slate-500 font-semibold"><Loader2 size={16} className="animate-spin" />Loading website traffic…</div>}
      {(failure || report?.status === 'error') && (
        <div role="alert" className="bg-rose-50 border border-rose-200 p-4 sm:p-5 rounded-3xl text-sm text-rose-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="flex items-start gap-2 font-semibold"><AlertTriangle size={16} className="shrink-0 mt-0.5" />{failure || report?.error?.message || "Google Analytics didn't return the report."}</p>
          <button type="button" className="px-4 py-2 rounded-xl bg-white border border-rose-200 text-rose-800 font-bold text-xs whitespace-nowrap disabled:opacity-60" disabled={loading} onClick={() => void load(days)}>{loading ? 'Trying…' : 'Try again'}</button>
        </div>
      )}
      {!failure && report?.status === 'not_configured' && <Setup report={report} canManage={can('integrations.manage')} />}

      {!failure && ok && t && (
        <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Visitors" help="People who came to the site" icon={<Users size={18} />} value={t.activeUsers} delta={change(t.activeUsers, p?.activeUsers)} days={days} />
            <Tile label="New visitors" help="First time on the site" icon={<UserPlus size={18} />} value={t.newUsers} delta={change(t.newUsers, p?.newUsers)} days={days} />
            <Tile label="Visits" help="Sessions (one ends after 30 idle minutes)" icon={<MousePointerClick size={18} />} value={t.sessions} delta={change(t.sessions, p?.sessions)} days={days} />
            <Tile label="Page views" help="Pages opened, including repeats" icon={<Eye size={18} />} value={t.pageViews} delta={change(t.pageViews, p?.pageViews)} days={days} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Visitors per day" note={`Visitors and visits each day${ok.timeZone ? ` (${ok.timeZone.replace('_', ' ')} time)` : ''}`} className="lg:col-span-2">
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={ok.daily.map((d) => ({ ...d, day: shortDate(d.date) }))} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                    <defs><linearGradient id="ga-users" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3} /><stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} minTickGap={18} />
                    <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => [count(Number(v)), n === 'users' ? 'Visitors' : 'Visits']} />
                    <Area type="monotone" dataKey="sessions" stroke="#8b5cf6" strokeWidth={2} fill="none" name="sessions" />
                    <Area type="monotone" dataKey="users" stroke="#0ea5e9" strokeWidth={3} fill="url(#ga-users)" name="users" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="flex gap-4 text-xs font-semibold text-slate-600"><span className="flex items-center gap-1.5"><span className="w-3 h-1 rounded-full bg-sky-500" />Visitors</span><span className="flex items-center gap-1.5"><span className="w-3 h-1 rounded-full bg-violet-500" />Visits</span></div>
            </Card>
            <Card title="How visitors engage" icon={<Smartphone size={16} />}>
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-2xl bg-slate-50 p-3"><dt className="text-[11px] font-bold text-slate-500">Engaged</dt><dd className="text-lg font-black text-slate-900">{Math.round(t.engagementRate * 100)}%</dd></div>
                <div className="rounded-2xl bg-slate-50 p-3"><dt className="text-[11px] font-bold text-slate-500">Avg. visit</dt><dd className="text-lg font-black text-slate-900">{duration(t.avgSessionSeconds)}</dd></div>
                <div className="rounded-2xl bg-slate-50 p-3"><dt className="text-[11px] font-bold text-slate-500">Pages/visit</dt><dd className="text-lg font-black text-slate-900">{t.sessions ? (t.pageViews / t.sessions).toFixed(1) : '—'}</dd></div>
              </dl>
              <p className="text-[11px] text-slate-500 leading-snug">Engaged = visits that lasted over 10 seconds, viewed 2+ pages, or led to a key event.</p>
              <div className="pt-1 border-t border-slate-100"><p className="text-xs font-bold text-slate-600 mb-2">Visitors by device</p>
                <Bars rows={ok.devices.map((d) => ({ label: DEVICE[d.name.toLowerCase()] || d.name, value: d.users }))} empty="No device data yet." />
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Top pages" note="Most viewed pages on the site" icon={<FileText size={16} />}>
              <Bars rows={ok.pages.map((pg) => ({ label: pg.path, value: pg.views, detail: 'views' }))} empty="No page views in this period." />
            </Card>
            <Card title="Where visits come from" note="Google's channel for each visit" icon={<Share2 size={16} />}>
              <Bars rows={ok.channels.map((c) => ({ label: c.name, value: c.sessions, detail: 'visits' }))} empty="No visits in this period." />
            </Card>
          </div>
        </div>
      )}
    </section>
  );
}
