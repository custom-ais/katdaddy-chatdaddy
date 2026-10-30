import React, { useMemo, useState } from 'react';
import { AlertTriangle, Bot, Calendar, CalendarDays, Check, CheckCircle, ChevronRight, Clock, ExternalLink, Filter, Gauge, LayoutList, MapPin, Phone, Play, Search, User, Users, X } from 'lucide-react';
import { useDashboard, azDate, azDay, azTime, dollars, initials, attentionReason, type Appointment } from './DashboardContext';
import { StatusBadge } from './ui';
import { AppointmentDetailModal } from './AppointmentDetailModal';
import { TechnicianManagement } from './TechnicianManagement';

type StatusFilter = 'all' | 'active' | 'scheduled' | 'action_needed' | 'in_progress' | 'completed' | 'cancelled';

export function AppointmentManager() {
  const { data, activeAppointments: appointments, mutate, showToast } = useDashboard();
  const technicians = data.technicians;
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [techFilter, setTechFilter] = useState('all');
  const [view, setView] = useState<'list' | 'timeline' | 'technicians'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [day, setDay] = useState(azDate(Date.now()));
  const today = azDate(Date.now());

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim(), digits = search.replace(/\D/g, '');
    return appointments
      .filter((a) => {
        const text = `${a.customerName} ${a.technicianName} ${a.address} ${a.city} ${a.zip} ${a.id} ${a.package} ${a.jobber?.jobNumber || ''}`.toLowerCase();
        const matches = !q || text.includes(q) || (digits.length >= 3 && a.phone.replace(/\D/g, '').includes(digits));
        const status =
          statusFilter === 'all' ? true
          : statusFilter === 'active' ? ['confirmed', 'in_progress', 'action_needed', 'confirming'].includes(a.status)
          : statusFilter === 'scheduled' ? a.status === 'confirmed'
          : a.status === statusFilter;
        return matches && status && (techFilter === 'all' || a.technicianId === techFilter);
      })
      .sort((x, y) => (statusFilter === 'completed' || statusFilter === 'cancelled' ? Date.parse(y.scheduledAt) - Date.parse(x.scheduledAt) : Date.parse(x.scheduledAt) - Date.parse(y.scheduledAt)));
  }, [appointments, search, statusFilter, techFilter]);

  const counts = useMemo(() => ({
    all: appointments.length,
    active: appointments.filter((a) => ['confirmed', 'in_progress', 'action_needed', 'confirming'].includes(a.status)).length,
    scheduled: appointments.filter((a) => a.status === 'confirmed').length,
    action_needed: appointments.filter((a) => a.status === 'action_needed').length,
    in_progress: appointments.filter((a) => a.status === 'in_progress').length,
    completed: appointments.filter((a) => a.status === 'completed').length,
    cancelled: appointments.filter((a) => a.status === 'cancelled').length,
    today: appointments.filter((a) => a.status !== 'cancelled' && azDate(a.scheduledAt) === today).length,
  }), [appointments, today]);

  const quickStatus = async (a: Appointment, status: Appointment['status']) => {
    try {
      await mutate(`/api/admin/appointments/${encodeURIComponent(a.id)}`, { revision: a.revision, status }, 'PATCH', status === 'completed' ? 'Marked completed' : 'Marked in progress');
    } catch (e) {
      showToast({ type: 'error', title: "Couldn't update", description: (e as Error).message });
    }
  };
  const selected = selectedId ? appointments.find((a) => a.id === selectedId) || null : null;
  const Stat = ({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: React.ReactNode }) => (
    <div className="bg-white p-4 sm:p-5 rounded-2xl border border-slate-200/90 shadow-xs flex items-center justify-between">
      <div><p className="text-xs font-bold text-slate-500">{label}</p><p className={`text-2xl font-black mt-1 ${tone}`}>{value}</p></div>
      <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center">{icon}</div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5 sm:gap-4">
        <Stat label="Today's jobs" value={counts.today} tone="text-slate-900" icon={<Calendar size={20} className="text-orange-600" />} />
        <Stat label="In progress" value={counts.in_progress} tone="text-sky-600" icon={<Play size={20} className="text-sky-600 fill-sky-500" />} />
        <Stat label="Scheduled ahead" value={counts.scheduled} tone="text-amber-600" icon={<Clock size={20} className="text-amber-600" />} />
        <Stat label="Needs attention" value={counts.action_needed} tone={counts.action_needed ? 'text-rose-600' : 'text-slate-900'} icon={<AlertTriangle size={20} className="text-rose-600" />} />
      </div>

      <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/90 shadow-xs space-y-3.5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="relative flex-1">
            <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input type="search" placeholder="Search by customer, phone, technician, address, or Jobber job…" value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-800 placeholder-slate-400 focus:bg-white focus:border-orange-500 focus:ring-2 focus:ring-orange-500/10 outline-none" />
            {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 rounded-md" aria-label="Clear search"><X size={14} /></button>}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 px-3 py-2 rounded-xl">
              <User size={14} className="text-slate-400" />
              <select aria-label="Technician" value={techFilter} onChange={(e) => setTechFilter(e.target.value)} className="bg-transparent text-xs font-extrabold text-slate-700 outline-none cursor-pointer">
                <option value="all">All techs</option>
                {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200">
              {([['list', 'List', <LayoutList size={15} />], ['timeline', 'Day board', <CalendarDays size={15} />], ['technicians', 'Tech staff', <Users size={15} />]] as const).map(([id, label, icon]) => (
                <button key={id} onClick={() => setView(id)} aria-pressed={view === id} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold ${view === id ? (id === 'technicians' ? 'bg-orange-500 text-white shadow-xs' : 'bg-white text-slate-900 shadow-xs') : 'text-slate-500 hover:text-slate-800'}`}>
                  {icon}<span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        {view !== 'technicians' && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1 pt-1 scrollbar-none border-t border-slate-100">
            <Filter size={12} className="text-slate-400 shrink-0" />
            {([
              ['active', 'Active', 'bg-orange-500'], ['scheduled', 'Scheduled', 'bg-amber-500'], ['action_needed', 'Action needed', 'bg-rose-500'],
              ['in_progress', 'In progress', 'bg-sky-500'], ['completed', 'Completed', 'bg-emerald-500'], ['cancelled', 'Cancelled', 'bg-slate-400'], ['all', 'All', 'bg-slate-300'],
            ] as [StatusFilter, string, string][]).map(([id, label, dot]) => (
              <button key={id} onClick={() => setStatusFilter(id)} aria-pressed={statusFilter === id} className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-extrabold whitespace-nowrap ${statusFilter === id ? 'bg-slate-900 text-white' : 'bg-slate-100 hover:bg-slate-200/70 text-slate-700'}`}>
                <span className={`w-2 h-2 rounded-full ${dot}`} />{label}
                <span className={`px-1.5 rounded-md text-[10px] ${statusFilter === id ? 'bg-white/20' : 'bg-slate-200'}`}>{counts[id]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {view === 'technicians' ? (
        <TechnicianManagement onOpen={setSelectedId} />
      ) : view === 'list' ? (
        <div className="space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-3xl p-12 text-center border border-slate-200">
              <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-3 text-slate-400"><Search size={24} /></div>
              <h3 className="font-extrabold text-slate-800 text-lg">{appointments.length ? 'No matching appointments' : 'No appointments yet'}</h3>
              <p className="text-sm text-slate-500 max-w-sm mx-auto mt-1 mb-5">{appointments.length ? 'Try a different search or filter.' : 'Visits booked through BOB — online or from the office — show up here with their Jobber job.'}</p>
              {appointments.length > 0 && <button onClick={() => { setSearch(''); setStatusFilter('all'); setTechFilter('all'); }} className="px-4 py-2 text-xs font-extrabold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl">Reset filters</button>}
            </div>
          ) : (
            filtered.map((a) => {
              const tech = technicians.find((t) => t.id === a.technicianId);
              const isToday = azDate(a.scheduledAt) === today;
              const reason = attentionReason(a);
              return (
                <div key={a.id} className={`bg-white rounded-2xl border shadow-xs hover:shadow-md transition-all p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 group ${reason ? 'border-rose-200' : 'border-slate-200/90 hover:border-orange-200'}`}>
                  <div className="flex items-start gap-4 min-w-0">
                    <div className="w-16 sm:w-20 text-center py-2 px-1 rounded-xl bg-slate-50 border border-slate-200 shrink-0">
                      <span className="block text-[11px] font-bold text-orange-600">{isToday ? 'Today' : azDay(a.scheduledAt)}</span>
                      <span className="block text-sm sm:text-base font-black text-slate-900 leading-tight">{azTime(a.scheduledAt)}</span>
                      <span className="block text-[10px] text-slate-400 font-semibold mt-0.5">{a.durationMins}m</span>
                    </div>
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button onClick={() => setSelectedId(a.id)} className="font-black text-base sm:text-lg text-slate-900 group-hover:text-orange-600 text-left">{a.customerName}</button>
                        <StatusBadge appt={a} />
                        <span className="text-xs font-mono font-bold text-slate-400">{a.id}</span>
                        {a.source === 'ai_bot' && <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200"><Bot size={11} />Booked by BOB</span>}
                        {a.jobber?.jobNumber && (a.jobber.webUri
                          ? <a href={a.jobber.webUri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">Jobber #{a.jobber.jobNumber}<ExternalLink size={10} /></a>
                          : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Jobber #{a.jobber.jobNumber}</span>)}
                        {a.approval && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200">Approved by {a.approval.by}</span>}
                        {a.overflow && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">5 PM overflow</span>}
                      </div>
                      {reason && <p className="text-xs font-bold text-rose-700 flex items-center gap-1.5"><AlertTriangle size={13} />{reason}</p>}
                      <div className="flex items-center gap-3 text-xs text-slate-600 flex-wrap font-medium">
                        <span className="flex items-center gap-1"><Phone size={13} className="text-slate-400" /><a href={`tel:${a.phone}`} className="hover:text-orange-600 hover:underline">{a.phone}</a></span>
                        <span className="flex items-center gap-1"><MapPin size={13} className="text-slate-400" />{a.address}, {a.city} {a.zip}</span>
                      </div>
                      <div className="flex items-center gap-2 pt-1 flex-wrap">
                        <span className="text-xs font-extrabold text-slate-800 bg-slate-100 px-2.5 py-0.5 rounded-md">{a.package}</span>
                        <span className="text-xs font-black text-orange-600 bg-orange-50 px-2 py-0.5 rounded-md border border-orange-100">{dollars(a.price)}</span>
                        {a.airflowReadings?.beforeCfm != null && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 bg-slate-50 px-2 py-0.5 rounded-md border border-slate-200">
                            <Gauge size={12} className="text-orange-500" />
                            {a.airflowReadings.afterCfm != null ? <span>{a.airflowReadings.beforeCfm} → <strong className="text-emerald-600">{a.airflowReadings.afterCfm} CFM</strong></span> : <span>{a.airflowReadings.beforeCfm} CFM before</span>}
                          </span>
                        )}
                        {a.notes && <span className="text-xs text-slate-500 truncate max-w-xs font-medium italic">“{a.notes}”</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between md:justify-end gap-3 pt-3 md:pt-0 border-t md:border-t-0 border-slate-100 shrink-0">
                    <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-xl">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black text-white" style={{ backgroundColor: tech?.color || '#f97316' }}>{initials(a.technicianName)}</div>
                      <div className="leading-none"><span className="block text-xs font-extrabold text-slate-800">{a.technicianName}</span><span className="text-[10px] text-slate-400 font-semibold">{a.territory?.city || tech?.zone || 'West Valley'}</span></div>
                    </div>
                    <div className="flex items-center gap-1">
                      {a.status === 'confirmed' && <button onClick={() => quickStatus(a, 'in_progress')} title="Mark tech on site" aria-label="Mark in progress" className="p-2 rounded-xl text-blue-600 hover:bg-blue-50 border border-blue-200"><Play size={16} className="fill-blue-500" /></button>}
                      {a.status === 'in_progress' && <button onClick={() => quickStatus(a, 'completed')} title="Mark completed" aria-label="Mark completed" className="p-2 rounded-xl text-emerald-600 hover:bg-emerald-50 border border-emerald-200"><Check size={16} /></button>}
                      <button onClick={() => setSelectedId(a.id)} className="flex items-center gap-1 text-xs font-extrabold text-slate-700 hover:text-orange-600 bg-slate-100 hover:bg-orange-50 px-3 py-2 rounded-xl">Details<ChevronRight size={14} /></button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="bg-white rounded-3xl border border-slate-200/90 shadow-xs p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h3 className="font-extrabold text-slate-900 text-base flex items-center gap-2"><CalendarDays size={18} className="text-orange-500" />Day board · {azDay(`${day}T12:00:00-07:00`)}</h3>
            <div className="flex items-center gap-2">
              <button className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 hover:bg-slate-200" onClick={() => setDay(azDate(Date.parse(`${day}T12:00:00-07:00`) - 86_400_000))}>Previous</button>
              <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1 text-xs font-bold" aria-label="Day" />
              <button className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 hover:bg-slate-200" onClick={() => setDay(azDate(Date.parse(`${day}T12:00:00-07:00`) + 86_400_000))}>Next</button>
            </div>
          </div>
          <p className="text-xs text-slate-500">BOB bookings only. Jobs booked directly in Jobber are on the Jobber calendar (BOB still schedules around them).</p>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {technicians.map((tech) => {
              const jobs = filtered.filter((a) => a.technicianId === tech.id && a.status !== 'cancelled' && azDate(a.scheduledAt) === day).sort((x, y) => Date.parse(x.scheduledAt) - Date.parse(y.scheduledAt));
              const revenue = jobs.reduce((n, a) => n + a.price, 0), target = (data.config.dailyRevenueTargetCents || 0) / 100;
              return (
                <div key={tech.id} className="bg-slate-50/80 rounded-2xl p-4 border border-slate-200/80 space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full text-white text-xs font-black flex items-center justify-center" style={{ backgroundColor: tech.color }}>{initials(tech.name)}</div>
                      <div><span className="font-extrabold text-xs text-slate-900 block leading-tight">{tech.name}</span><span className="text-[10px] text-slate-500 font-medium">{jobs.length} jobs · {dollars(revenue)}{target ? ` of ${dollars(target)}` : ''}</span></div>
                    </div>
                  </div>
                  {target > 0 && <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden" aria-label={`Revenue target ${Math.round((revenue / target) * 100)}%`}><div className="h-full bg-orange-500" style={{ width: `${Math.min(100, (revenue / target) * 100)}%` }} /></div>}
                  <div className="space-y-2.5">
                    {jobs.length === 0 ? <div className="p-4 text-center text-xs text-slate-400 font-medium border border-dashed border-slate-200 rounded-xl">No BOB bookings</div> : jobs.map((a) => (
                      <button key={a.id} onClick={() => setSelectedId(a.id)} className="w-full text-left bg-white p-3 rounded-xl border border-slate-200 hover:border-orange-300 space-y-1.5">
                        <div className="flex items-center justify-between"><span className="text-xs font-black text-orange-600">{azTime(a.scheduledAt)}</span><StatusBadge appt={a} compact /></div>
                        <p className="font-extrabold text-xs text-slate-900 leading-tight">{a.customerName}</p>
                        <p className="text-[11px] text-slate-500 truncate flex items-center gap-1"><MapPin size={10} className="text-slate-400" />{a.city} ({a.zip}){a.territory?.micro ? ` · ${a.territory.micro}` : ''}</p>
                        <div className="flex items-center justify-between text-[10px] font-bold text-slate-600 pt-1 border-t border-slate-100"><span className="truncate">{a.package}</span><span className="text-orange-600 font-black">{dollars(a.price)}</span></div>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selected && <AppointmentDetailModal appointment={selected} onClose={() => setSelectedId(null)} />}
      {counts.completed > 0 && statusFilter === 'active' && view === 'list' && (
        <p className="text-center text-xs text-slate-400"><CheckCircle size={12} className="inline mr-1" />{counts.completed} completed visits are under “Completed”.</p>
      )}
    </div>
  );
}
