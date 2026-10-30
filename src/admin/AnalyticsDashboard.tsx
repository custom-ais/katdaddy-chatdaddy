import React, { useMemo } from 'react';
import { AlertTriangle, Bot, Calendar, DollarSign, Gauge, MapPin, Target, Timer, TrendingUp, Users } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useDashboard, azDate, azDay, azHour, dollars } from './DashboardContext';
import { Banner } from './ui';

const COLORS = ['#f97316', '#3b82f6', '#8b5cf6', '#10b981', '#ef4444', '#06b6d4', '#64748b'];
const DAY = 86_400_000;
const tooltipStyle = { borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 4px 12px rgba(15,23,42,0.06)', fontSize: 12 };

function Kpi({ label, icon, tone, value, detail, foot, footValue }: { label: string; icon: React.ReactNode; tone: string; value: React.ReactNode; detail: React.ReactNode; foot: string; footValue: React.ReactNode }) {
  return (
    <div className="bg-white p-5 rounded-3xl border border-slate-200/90 shadow-xs space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-500">{label}</span>
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${tone}`}>{icon}</div>
      </div>
      <div>
        <p className="text-3xl font-black text-slate-900 tracking-tight">{value}</p>
        <p className="text-xs font-semibold text-slate-500 mt-1">{detail}</p>
      </div>
      <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-semibold"><span>{foot}</span><span className="font-extrabold text-slate-900">{footValue}</span></div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="h-full flex items-center justify-center text-sm text-slate-400 font-medium text-center px-6">{children}</div>;
}

export function AnalyticsDashboard({ onNavigateToAppointments }: { onNavigateToAppointments: () => void }) {
  const { data, activeAppointments } = useDashboard();
  const now = Date.now();
  const booked = useMemo(() => activeAppointments.filter((a) => a.status !== 'cancelled'), [activeAppointments]);

  const stats = useMemo(() => {
    const revenue = booked.reduce((n, a) => n + a.price, 0);
    const completed = booked.filter((a) => a.status === 'completed').length;
    const upcoming = booked.filter((a) => Date.parse(a.scheduledAt) > now && a.status !== 'completed').length;
    const online = booked.filter((a) => a.source === 'ai_bot').length;
    const readings = booked.filter((a) => a.airflowReadings?.beforeCfm && a.airflowReadings?.afterCfm);
    const gain = readings.length ? Math.round(readings.reduce((n, a) => n + ((a.airflowReadings!.afterCfm! - a.airflowReadings!.beforeCfm!) / a.airflowReadings!.beforeCfm!) * 100, 0) / readings.length) : null;
    const needsOffice = activeAppointments.filter((a) => a.status === 'action_needed').length;
    const notBooked = data.appointments.filter((a) => a.status === 'failed').length;
    return { revenue, avg: booked.length ? revenue / booked.length : 0, completed, upcoming, online, readings: readings.length, gain, needsOffice, notBooked };
  }, [booked, activeAppointments, data.appointments, now]);

  // Revenue by day, a week back and a week ahead, in Arizona time.
  const trend = useMemo(() => {
    const days: { key: string; day: string; revenue: number; bookings: number }[] = [];
    for (let i = -7; i <= 7; i++) days.push({ key: azDate(now + i * DAY), day: azDay(now + i * DAY), revenue: 0, bookings: 0 });
    const byKey = new Map(days.map((d) => [d.key, d]));
    for (const a of booked) {
      const d = byKey.get(azDate(a.scheduledAt));
      if (d) { d.revenue += a.price; d.bookings += 1; }
    }
    return days;
  }, [booked, now]);

  const packages = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of booked) counts.set(a.package, (counts.get(a.package) || 0) + 1);
    return [...counts.entries()].map(([name, value]) => ({ name, value })).sort((x, y) => y.value - x.value);
  }, [booked]);

  const hours = useMemo(() => {
    const counts = new Map<number, number>();
    for (const a of booked) { const h = azHour(a.scheduledAt); counts.set(h, (counts.get(h) || 0) + 1); }
    const label = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
    return [...counts.entries()].sort((x, y) => x[0] - y[0]).map(([h, count]) => ({ hour: label(h), count }));
  }, [booked]);

  const cities = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of booked) { const c = a.city || 'Unknown'; counts.set(c, (counts.get(c) || 0) + 1); }
    return [...counts.entries()].map(([city, bookings]) => ({ city, bookings })).sort((x, y) => y.bookings - x.bookings).slice(0, 8);
  }, [booked]);

  const zones = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of booked) if (a.territory?.zone) { const k = `Zone ${a.territory.zone}${a.territory.micro ? ` · ${a.territory.micro}` : ''}`; counts.set(k, (counts.get(k) || 0) + 1); }
    return [...counts.entries()].sort((x, y) => y[1] - x[1]);
  }, [booked]);

  const today = azDate(now);
  const target = (data.config.dailyRevenueTargetCents || 0) / 100;
  const todayByTech = data.technicians.map((t) => ({ t, total: booked.filter((a) => a.technicianId === t.id && azDate(a.scheduledAt) === today).reduce((n, a) => n + a.price, 0) }));
  const topTwo = cities.slice(0, 2), topShare = booked.length ? Math.round((topTwo.reduce((n, c) => n + c.bookings, 0) / booked.length) * 100) : 0;
  const repairs = booked.filter((a) => a.route === 'assessment' || a.route === 'bundle');
  const bundleShare = repairs.length ? Math.round((repairs.filter((a) => a.route === 'bundle').length / repairs.length) * 100) : null;

  return (
    <div className="space-y-6 animate-in">
      <Banner eyebrow={<><TrendingUp size={14} />From your bookings</>} title="Scheduling analytics"
        actions={<>
          <div className="bg-white/10 px-4 py-3 rounded-2xl border border-white/10 text-center">
            <span className="text-[11px] font-bold text-slate-300 block">Times held right now</span>
            <span className="text-xl font-black text-orange-400 flex items-center justify-center gap-1.5 mt-0.5"><Timer size={16} />{data.heldLocksCount}</span>
          </div>
          <button onClick={onNavigateToAppointments} className="px-5 py-3 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-extrabold text-sm rounded-2xl shadow-lg shadow-orange-500/30 active:scale-95 whitespace-nowrap">View appointments</button>
        </>}>
        Every number here is counted from appointments in BOB. Nothing is estimated — a blank means there's no data yet.
      </Banner>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label="Booked revenue" icon={<DollarSign size={18} />} tone="bg-orange-50 text-orange-600" value={dollars(stats.revenue)}
          detail={`${booked.length} visit${booked.length === 1 ? '' : 's'}, cancellations excluded`} foot="Average ticket" footValue={booked.length ? dollars(stats.avg) : '—'} />
        <Kpi label="Booked online by BOB" icon={<Bot size={18} />} tone="bg-blue-50 text-blue-600" value={stats.online}
          detail={data.conversations ? `${Math.round((stats.online / data.conversations) * 100)}% of ${data.conversations} chats booked` : 'No chats yet'} foot="Couldn't be booked" footValue={stats.notBooked} />
        <Kpi label="Appointments" icon={<Calendar size={18} />} tone="bg-violet-50 text-violet-600" value={booked.length}
          detail={<><b className="text-slate-900">{stats.completed}</b> completed, <b className="text-orange-600">{stats.upcoming}</b> upcoming</>} foot="Need the office" footValue={<span className={stats.needsOffice ? 'text-rose-600' : ''}>{stats.needsOffice}</span>} />
        <Kpi label="Average airflow gain" icon={<Gauge size={18} />} tone="bg-emerald-50 text-emerald-600" value={stats.gain === null ? '—' : `${stats.gain >= 0 ? '+' : ''}${stats.gain}%`}
          detail={stats.readings ? 'Before and after readings from technicians' : 'Appears once techs enter CFM readings'} foot="Visits measured" footValue={stats.readings} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white p-5 sm:p-6 rounded-3xl border border-slate-200/90 shadow-xs space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div><h3 className="font-extrabold text-slate-900 text-base tracking-tight">Booked revenue by day</h3><p className="text-xs text-slate-500 font-medium">Last 7 days and the next 7, Arizona time</p></div>
            <span className="text-xs font-bold bg-slate-100 text-slate-700 px-3 py-1 rounded-full whitespace-nowrap">15 days</span>
          </div>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs><linearGradient id="rev" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f97316" stopOpacity={0.35} /><stop offset="95%" stopColor="#f97316" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} interval={2} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => [n === 'revenue' ? dollars(Number(v)) : v, n === 'revenue' ? 'Booked' : 'Visits']} />
                <Area type="monotone" dataKey="revenue" stroke="#f97316" strokeWidth={3} fill="url(#rev)" name="revenue" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white p-5 sm:p-6 rounded-3xl border border-slate-200/90 shadow-xs space-y-4">
          <div><h3 className="font-extrabold text-slate-900 text-base tracking-tight">Services booked</h3><p className="text-xs text-slate-500 font-medium">What customers chose</p></div>
          <div className="h-56 w-full">
            {packages.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={packages} cx="50%" cy="50%" innerRadius={55} outerRadius={82} paddingAngle={3} dataKey="value">{packages.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => [`${v} visit${v === 1 ? '' : 's'}`, n]} />
                </PieChart>
              </ResponsiveContainer>
            ) : <Empty>No visits booked yet.</Empty>}
          </div>
          <div className="space-y-1.5 pt-1 border-t border-slate-100 max-h-36 overflow-y-auto">
            {packages.map((p, i) => (
              <div key={p.name} className="flex items-center justify-between text-xs font-semibold gap-2">
                <span className="flex items-center gap-2 min-w-0"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} /><span className="text-slate-700 truncate">{p.name}</span></span>
                <span className="font-black text-slate-900">{p.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-5 sm:p-6 rounded-3xl border border-slate-200/90 shadow-xs space-y-4">
          <div><h3 className="font-extrabold text-slate-900 text-base tracking-tight">Arrival times booked</h3><p className="text-xs text-slate-500 font-medium">Start of the arrival window, Arizona time</p></div>
          <div className="h-60 w-full">
            {hours.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hours} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="hour" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [`${v} visit${v === 1 ? '' : 's'}`, 'Booked']} />
                  <Bar dataKey="count" fill="#f97316" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <Empty>Booked times appear here.</Empty>}
          </div>
        </div>

        <div className="bg-white p-5 sm:p-6 rounded-3xl border border-slate-200/90 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div><h3 className="font-extrabold text-slate-900 text-base tracking-tight">Visits by city</h3><p className="text-xs text-slate-500 font-medium">Where the work is</p></div>
            <span className="text-xs font-bold text-slate-500 flex items-center gap-1"><MapPin size={13} className="text-orange-500" />West Valley</span>
          </div>
          <div className="h-60 w-full">
            {cities.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={cities} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <YAxis dataKey="city" type="category" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} width={90} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [`${v} visit${v === 1 ? '' : 's'}`, 'Booked']} />
                  <Bar dataKey="bookings" fill="#3b82f6" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <Empty>Cities appear once visits are booked.</Empty>}
          </div>
        </div>
      </div>

      <div className="bg-white p-6 rounded-3xl border border-slate-200/90 shadow-xs space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-orange-100 text-orange-600"><Users size={18} /></div>
          <div><h3 className="font-extrabold text-slate-900 text-base">Today and the route</h3><p className="text-xs text-slate-500">Counted from today's schedule and the territory map</p></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-2xl bg-orange-50/70 border border-orange-100 space-y-2">
            <div className="flex items-center gap-2 text-orange-900 font-extrabold text-xs"><Target size={14} className="text-orange-600" />Daily target{target ? ` · ${dollars(target)} per tech` : ''}</div>
            {todayByTech.map(({ t, total }) => (
              <div key={t.id}>
                <div className="flex justify-between text-xs font-semibold text-slate-700"><span>{t.name}</span><span>{dollars(total)}</span></div>
                {target > 0 && <div className="h-1.5 rounded-full bg-white overflow-hidden mt-1"><div className={`h-full ${total >= target ? 'bg-emerald-500' : 'bg-orange-500'}`} style={{ width: `${Math.min(100, (total / target) * 100)}%` }} /></div>}
              </div>
            ))}
          </div>
          <div className="p-4 rounded-2xl bg-blue-50/70 border border-blue-100 space-y-2">
            <div className="flex items-center gap-2 text-blue-900 font-extrabold text-xs"><MapPin size={14} className="text-blue-600" />Route clustering</div>
            {booked.length ? (
              <p className="text-xs text-slate-700 leading-relaxed font-medium">
                {topTwo.map((c) => c.city).join(' and ')} account for <b>{topShare}%</b> of visits.{zones[0] && <> Busiest zone: <b>{zones[0][0]}</b> ({zones[0][1]}).</>} BOB offers times next to booked jobs first{data.config.routeScoring ? ' and ranks them by route fit' : ''}.
              </p>
            ) : <p className="text-xs text-slate-500">Shows the busiest cities and zones once visits are booked.</p>}
          </div>
          <div className="p-4 rounded-2xl bg-emerald-50/70 border border-emerald-100 space-y-2">
            <div className="flex items-center gap-2 text-emerald-900 font-extrabold text-xs"><AlertTriangle size={14} className="text-emerald-700" />Repairs and follow-up</div>
            <p className="text-xs text-slate-700 leading-relaxed font-medium">
              {bundleShare === null ? 'No repair visits yet.' : <>Of {repairs.length} repair visit{repairs.length === 1 ? '' : 's'}, <b>{bundleShare}%</b> added a cleaning with the assessment at 50% off.</>}{' '}
              {stats.needsOffice ? <><b className="text-rose-700">{stats.needsOffice}</b> booking{stats.needsOffice === 1 ? ' needs' : 's need'} a Jobber check.</> : 'Nothing is waiting on a Jobber check.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
