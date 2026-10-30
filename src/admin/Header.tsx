import React from 'react';
import { BarChart3, Bot, Calendar, Inbox, LogOut, Plus, RefreshCw, Settings, Wind } from 'lucide-react';
import { useDashboard } from './DashboardContext';

export type Tab = 'appointments' | 'inbox' | 'analytics' | 'bot' | 'settings';

export function Header({ tab, onTab, onNew, onSignOut }: { tab: Tab; onTab: (t: Tab) => void; onNew: () => void; onSignOut: () => void }) {
  const { data, loading, refresh } = useDashboard();
  const active = data.appointments.filter((a) => ['confirmed', 'in_progress', 'action_needed'].includes(a.status)).length;
  const inbox = data.approvals.filter((a) => a.status === 'pending').length + data.requests.filter((r) => r.status !== 'resolved').length;
  const jobberOk = data.config.scheduleSource !== 'Jobber' || data.integrations?.jobber?.connected;
  const tabs: [Tab, string, React.ReactElement, number?][] = [
    ['appointments', 'Appointments', <Calendar size={16} />, active],
    ['inbox', 'Inbox', <Inbox size={16} />, inbox],
    ['analytics', 'Analytics', <BarChart3 size={16} />],
    ['bot', 'Booking Bot', <Bot size={16} />],
    ['settings', 'Settings', <Settings size={16} />],
  ];
  return (
    <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-slate-200 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-3 h-16 sm:h-20">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="bg-gradient-to-br from-orange-500 to-amber-600 p-2.5 rounded-2xl shadow-md shadow-orange-500/20 text-white"><Wind size={22} className="stroke-[2.5]" /></div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-slate-900 text-lg sm:text-xl tracking-tight leading-none">Dryer Vent Squad</span>
                <span className="hidden sm:inline-flex text-[11px] font-bold px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200">West Valley</span>
              </div>
              <p className="text-xs font-semibold text-slate-500 mt-0.5 flex items-center gap-1.5">
                <span>Dispatch &amp; scheduling</span>
                <span className={`w-1.5 h-1.5 rounded-full ${jobberOk ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                <span className="hidden md:inline text-slate-400 font-normal">{data.config.scheduleSource === 'Jobber' ? (jobberOk ? 'Jobber connected' : 'Jobber not connected') : 'BOB schedule'}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void refresh()} className="p-2.5 rounded-xl text-slate-500 hover:bg-slate-100" aria-label="Refresh" title="Refresh"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
            <button onClick={onNew} className="flex items-center gap-2 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-extrabold text-xs sm:text-sm px-3.5 sm:px-4 py-2.5 rounded-xl shadow-md shadow-orange-500/20 active:scale-95">
              <Plus size={16} strokeWidth={2.5} /><span className="hidden sm:inline">Office booking</span>
            </button>
            <button onClick={onSignOut} className="p-2.5 rounded-xl text-slate-500 hover:bg-slate-100" aria-label="Sign out" title="Sign out"><LogOut size={18} /></button>
          </div>
        </div>
        <nav className="flex items-center gap-1 overflow-x-auto pb-3 -mt-1 scrollbar-none" aria-label="Dashboard sections">
          <div className="flex items-center bg-slate-100/90 p-1.5 rounded-2xl border border-slate-200/80 shadow-inner">
            {tabs.map(([id, label, icon, count]) => (
              <button key={id} onClick={() => onTab(id)} aria-current={tab === id ? 'page' : undefined}
                className={`flex items-center gap-2 px-3 sm:px-3.5 py-2 rounded-xl text-xs sm:text-sm font-extrabold whitespace-nowrap transition-all ${tab === id ? 'bg-white text-slate-900 shadow-sm border border-slate-200/60' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'}`}>
                {React.cloneElement(icon, { className: tab === id ? 'text-orange-500' : 'text-slate-400' } as any)}
                <span>{label}</span>
                {!!count && <span className={`px-1.5 py-0.5 text-[11px] font-bold rounded-full ${id === 'inbox' ? 'bg-rose-500 text-white' : tab === id ? 'bg-orange-100 text-orange-700' : 'bg-slate-200 text-slate-600'}`}>{count}</span>}
              </button>
            ))}
          </div>
        </nav>
      </div>
    </header>
  );
}
