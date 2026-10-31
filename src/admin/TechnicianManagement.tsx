import React from 'react';
import { ArrowRightLeft, Award, Calendar, CheckCircle, Gauge, Link2, MapPin, Phone, Target } from 'lucide-react';
import { useDashboard, azDate, azDay, azTime, dollars, initials, isLinked, type Technician } from './DashboardContext';
import { Banner, StatusBadge } from './ui';

const STATUS: Record<Technician['status'], [string, string]> = {
  on_job: ['On a job', 'bg-blue-50 text-blue-700 border-blue-200'],
  on_route: ['On the way', 'bg-amber-50 text-amber-700 border-amber-200'],
  available: ['Available', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
  off_duty: ['Off duty', 'bg-slate-100 text-slate-600 border-slate-200'],
};

export function TechnicianManagement({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, activeAppointments: appointments, mutate, showToast } = useDashboard();
  const today = azDate(Date.now());
  const weekAgo = Date.now() - 7 * 86_400_000;
  const target = (data.config.dailyRevenueTargetCents || 0) / 100;

  const setStatus = async (id: string, status: Technician['status']) => {
    try {
      await mutate('/api/admin/technicians', { technicians: data.technicians.map((t) => (t.id === id ? { ...t, status } : t)) }, 'POST', 'Status updated');
    } catch (e) { showToast({ type: 'error', title: "Couldn't update", description: (e as Error).message }); }
  };
  const reassign = async (apptId: string, technicianId: string) => {
    const a = appointments.find((x) => x.id === apptId);
    if (!a) return;
    try {
      await mutate(`/api/admin/appointments/${encodeURIComponent(apptId)}`, { revision: a.revision, technicianId }, 'PATCH', 'Technician reassigned');
    } catch (e) { showToast({ type: 'error', title: "Couldn't reassign", description: (e as Error).message }); }
  };
  const upcoming = appointments.filter((a) => ['confirmed', 'in_progress', 'action_needed'].includes(a.status) && Date.parse(a.scheduledAt) > Date.now() - 12 * 3_600_000).sort((x, y) => Date.parse(x.scheduledAt) - Date.parse(y.scheduledAt));

  return (
    <div className="space-y-6 animate-in">
      <Banner eyebrow={<><Award size={14} />Field staff</>} title="Technicians and job assignment">
        Today's work, measured airflow results, and the daily revenue target from the scheduling workbook. Visits that live in Jobber are reassigned in Jobber.
      </Banner>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {data.technicians.map((tech) => {
          const mine = appointments.filter((a) => a.technicianId === tech.id && a.status !== 'cancelled');
          const todays = mine.filter((a) => azDate(a.scheduledAt) === today);
          const revenueToday = todays.reduce((n, a) => n + a.price, 0);
          const week = mine.filter((a) => a.status === 'completed' && Date.parse(a.scheduledAt) >= weekAgo).length;
          const readings = mine.filter((a) => a.status === 'completed' && a.airflowReadings?.beforeCfm && a.airflowReadings?.afterCfm);
          const gain = readings.length ? Math.round(readings.reduce((n, a) => n + ((a.airflowReadings!.afterCfm! - a.airflowReadings!.beforeCfm!) / a.airflowReadings!.beforeCfm!) * 100, 0) / readings.length) : null;
          const onSite = mine.find((a) => a.status === 'in_progress');
          const takesOnline = data.config.activeTechnicianIds.includes(tech.id);
          return (
            <div key={tech.id} className="bg-white rounded-3xl border border-slate-200/90 shadow-sm p-6 space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-white text-xl font-black shadow-md shrink-0" style={{ backgroundColor: tech.color }}>{initials(tech.name)}</div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap"><h3 className="text-xl font-black text-slate-900 tracking-tight">{tech.name}</h3>{tech.vehicle && <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200">{tech.vehicle}</span>}</div>
                    {tech.zone && <p className="text-xs font-semibold text-slate-500 mt-0.5 flex items-center gap-1.5"><MapPin size={13} className="text-orange-500" />{tech.zone}</p>}
                    {tech.phone && <p className="text-xs font-medium text-slate-600 mt-0.5 flex items-center gap-1.5"><Phone size={13} className="text-slate-400" /><a href={`tel:${tech.phone}`} className="hover:text-orange-600 font-semibold">{tech.phone}</a></p>}
                    <p className="text-[11px] font-semibold mt-1 flex items-center gap-1.5 text-slate-500"><Link2 size={12} />{tech.jobberUserId ? 'Linked to Jobber user' : 'Not linked to Jobber'} · {takesOnline ? 'Takes online bookings' : 'No online bookings'}</p>
                  </div>
                </div>
                <div className="space-y-2 text-right">
                  <span className={`block rounded-xl px-3 py-1.5 text-xs font-extrabold ${tech.availability?.state === 'available' ? 'bg-emerald-50 text-emerald-700' : tech.availability?.state === 'busy' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{({ available: 'Available now', busy: 'Busy now', off_duty: 'Off duty', unknown: 'Availability unknown' })[tech.availability?.state || 'unknown']}</span>
                  <select aria-label={`${tech.name} duty setting`} value={tech.status === 'off_duty' ? 'off_duty' : 'available'} onChange={(e) => setStatus(tech.id, e.target.value as Technician['status'])} className="rounded-lg border border-slate-200 px-2 py-1 text-xs"><option value="available">Use live calendar</option><option value="off_duty">Mark off duty</option></select>
                </div>
              </div>
              <p className="text-xs text-slate-500">{tech.availability?.reason || 'Checking calendar availability…'}{tech.availability?.until ? ` Until ${azTime(tech.availability.until)}.` : ''}{tech.availability && ` Checked ${azTime(tech.availability.checkedAt)} · ${tech.availability.source}`}</p>
              {tech.bio && <p className="text-xs text-slate-600 leading-relaxed font-medium bg-slate-50 p-3 rounded-xl border border-slate-100">{tech.bio}</p>}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200/80 text-center"><span className="text-[10px] font-bold text-slate-400 block">Jobs today</span><span className="text-lg font-black text-slate-900 block">{todays.length}</span></div>
                <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200/80 text-center"><span className="text-[10px] font-bold text-slate-400 block">Booked today</span><span className="text-lg font-black text-emerald-600 block">{dollars(revenueToday)}</span></div>
                <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200/80 text-center"><span className="text-[10px] font-bold text-slate-400 block">Avg airflow gain</span><span className="text-lg font-black text-orange-600 flex items-center justify-center gap-0.5"><Gauge size={14} />{gain === null ? '—' : `${gain >= 0 ? '+' : ''}${gain}%`}</span></div>
                <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200/80 text-center"><span className="text-[10px] font-bold text-slate-400 block">Done, 7 days</span><span className="text-lg font-black text-slate-900 block">{week}</span></div>
              </div>
              {target > 0 && (
                <div>
                  <div className="flex justify-between text-[11px] font-bold text-slate-500 mb-1"><span className="flex items-center gap-1"><Target size={12} />Daily target</span><span>{dollars(revenueToday)} of {dollars(target)}</span></div>
                  <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full ${revenueToday >= target ? 'bg-emerald-500' : 'bg-orange-500'}`} style={{ width: `${Math.min(100, (revenueToday / target) * 100)}%` }} /></div>
                </div>
              )}
              {onSite ? (
                <div className="bg-blue-50/80 border border-blue-200 p-3.5 rounded-2xl flex items-center justify-between gap-3">
                  <div><span className="text-[10px] font-black text-blue-700 block">On site now</span><span className="text-xs font-black text-blue-900 block">{onSite.customerName} · {onSite.address}, {onSite.city}</span></div>
                  <button onClick={() => onOpen(onSite.id)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl">Open</button>
                </div>
              ) : (
                <div className="bg-emerald-50/70 border border-emerald-200 p-3 rounded-2xl flex items-center gap-2 text-xs font-semibold text-emerald-800"><CheckCircle size={15} className="text-emerald-600" />No visit in progress</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="bg-white rounded-3xl border border-slate-200/90 shadow-sm p-6 space-y-4">
        <div className="pb-3 border-b border-slate-100">
          <h3 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2"><ArrowRightLeft size={18} className="text-orange-500" />Assign upcoming jobs</h3>
          <p className="text-xs text-slate-500 font-medium">BOB checks the drive-time and schedule rules before moving a job. Jobs in Jobber are reassigned in Jobber.</p>
        </div>
        {!upcoming.length && <p className="text-sm text-slate-500">No upcoming jobs.</p>}
        <div className="divide-y divide-slate-100">
          {upcoming.map((a) => (
            <div key={a.id} className="py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 px-2">
              <button className="space-y-1 text-left" onClick={() => onOpen(a.id)}>
                <div className="flex items-center gap-2.5 flex-wrap"><span className="font-extrabold text-sm text-slate-900">{a.customerName}</span><StatusBadge appt={a} compact /><span className="text-xs font-extrabold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-md border border-orange-200">{dollars(a.price)}</span><span className="text-xs font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded-md">{a.package}</span></div>
                <div className="flex items-center gap-3 text-xs text-slate-500 font-medium"><span className="flex items-center gap-1"><Calendar size={12} />{azDay(a.scheduledAt)} {azTime(a.scheduledAt)}</span><span className="flex items-center gap-1"><MapPin size={12} />{a.address}, {a.city}</span></div>
              </button>
              <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-2xl border border-slate-200 self-start md:self-auto" title={isLinked(a) ? 'Reassign this visit in Jobber' : undefined}>
                {data.technicians.map((t) => (
                  <button key={t.id} disabled={isLinked(a) || a.technicianId === t.id} onClick={() => reassign(a.id, t.id)} className={`px-3 py-1.5 rounded-xl text-xs font-extrabold ${a.technicianId === t.id ? 'bg-white text-slate-900 shadow-xs border border-slate-200' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/50 disabled:hover:bg-transparent disabled:opacity-50'}`}>
                    {t.name.split(' ')[0]}{a.technicianId === t.id && <span className="ml-1 text-orange-500">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
