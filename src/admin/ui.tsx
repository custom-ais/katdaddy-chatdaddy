import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, Clock, Info, Loader2, Play, X, XCircle } from 'lucide-react';
import type { Appointment, ToastMessage } from './DashboardContext';
import { attentionReason } from './DashboardContext';

export const inputClass = 'w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-slate-800 bg-white focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none disabled:bg-slate-50 disabled:text-slate-500';
export const primaryButton = 'inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-extrabold text-sm rounded-xl shadow-md shadow-orange-500/20 transition-all active:scale-95 disabled:opacity-50';
export const secondaryButton = 'inline-flex items-center justify-center gap-2 px-4 py-2.5 border border-slate-300 bg-white text-slate-700 font-bold text-sm rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-50';
export const subtleButton = 'inline-flex items-center justify-center gap-1.5 px-3 py-2 text-slate-600 font-bold text-sm rounded-xl hover:bg-slate-100 transition-colors disabled:opacity-50';

export function Field({ label, hint, children, className = '' }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-xs font-bold text-slate-700 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400 mt-1 leading-snug">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, detail, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; detail?: React.ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-3 py-2 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" className="mt-0.5 size-4 accent-orange-500 shrink-0" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="block text-sm font-bold text-slate-800">{label}</span>{detail && <span className="block text-xs text-slate-500 mt-0.5 leading-snug">{detail}</span>}</span>
    </label>
  );
}

export function Section({ icon, title, description, children, action }: { icon?: React.ReactNode; title: string; description?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="bg-white rounded-3xl border border-slate-200/90 shadow-sm p-5 sm:p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-3 border-b border-slate-100">
        <div className="flex items-start gap-2.5">
          {icon && <div className="p-2 rounded-xl bg-orange-50 text-orange-600 border border-orange-200 shrink-0">{icon}</div>}
          <div><h3 className="font-extrabold text-slate-900 text-base">{title}</h3>{description && <p className="text-xs text-slate-500 font-medium mt-0.5 max-w-2xl">{description}</p>}</div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Banner({ tone = 'dark', eyebrow, title, children, actions }: { tone?: 'dark'; eyebrow?: React.ReactNode; title: string; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 rounded-3xl p-6 sm:p-7 text-white shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div>
        {eyebrow && <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-500/20 text-orange-300 border border-orange-500/30 text-xs font-extrabold mb-2">{eyebrow}</div>}
        <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">{title}</h2>
        {children && <div className="text-slate-300 text-sm max-w-2xl mt-1 leading-relaxed">{children}</div>}
      </div>
      {actions && <div className="flex items-center gap-3 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Modal({ title, subtitle, badge, onClose, children, footer, wide }: { title: string; subtitle?: React.ReactNode; badge?: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-start sm:items-center justify-center p-4 sm:p-6 animate-in" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`bg-white rounded-3xl shadow-2xl border border-slate-200 w-full ${wide ? 'max-w-3xl' : 'max-w-2xl'} overflow-hidden my-8`}>
        <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {badge}
            <div className="min-w-0"><h3 className="font-extrabold text-slate-900 text-lg truncate">{title}</h3>{subtitle && <p className="text-xs text-slate-500 font-medium">{subtitle}</p>}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600 p-2 rounded-full hover:bg-slate-200/50"><X size={20} /></button>
        </div>
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto">{children}</div>
        {footer && <div className="bg-slate-50 px-6 py-4 border-t border-slate-200 flex items-center justify-between gap-3 flex-wrap">{footer}</div>}
      </div>
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <div role="alert" className="text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3 flex gap-2"><AlertCircle size={18} className="shrink-0" />{children}</div>;
}

/** Green = completed, amber = scheduled, red = needs the office, blue = in progress. */
export function StatusBadge({ appt, compact = false }: { appt: Appointment; compact?: boolean }) {
  const size = compact ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs';
  const base = `inline-flex items-center gap-1.5 ${size} font-black rounded-full border shrink-0`;
  if (appt.status === 'completed') return <span className={`${base} bg-emerald-50 text-emerald-800 border-emerald-300`}><CheckCircle size={compact ? 11 : 13} className="text-emerald-600" />Completed</span>;
  if (appt.status === 'action_needed') {
    return (
      <span className={`${base} bg-rose-50 text-rose-800 border-rose-300`} title={attentionReason(appt) || undefined}>
        <AlertTriangle size={compact ? 11 : 13} className="text-rose-600" />Action needed
      </span>
    );
  }
  if (appt.status === 'cancelled') return <span className={`${base} bg-slate-100 text-slate-600 border-slate-300`}><XCircle size={compact ? 11 : 13} />Cancelled</span>;
  if (appt.status === 'failed') return <span className={`${base} bg-slate-100 text-slate-500 border-slate-200`}><XCircle size={compact ? 11 : 13} />Not booked</span>;
  if (appt.status === 'confirming') return <span className={`${base} bg-sky-50 text-sky-800 border-sky-300`}><Loader2 size={compact ? 11 : 13} className="animate-spin" />Confirming</span>;
  if (appt.status === 'in_progress') return <span className={`${base} bg-sky-50 text-sky-800 border-sky-300`}><Play size={compact ? 10 : 12} className="fill-sky-600 text-sky-600" />In progress</span>;
  return <span className={`${base} bg-amber-50 text-amber-900 border-amber-300`}><Clock size={compact ? 11 : 13} className="text-amber-700" />Scheduled</span>;
}

export function ToastContainer({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  const icon = { success: <CheckCircle size={20} className="text-emerald-500" />, error: <AlertCircle size={20} className="text-rose-500" />, warning: <AlertTriangle size={20} className="text-amber-500" />, info: <Info size={20} className="text-blue-500" /> };
  const border = { success: 'border-emerald-200', error: 'border-rose-200', warning: 'border-amber-200', info: 'border-blue-200' };
  return (
    <div className="fixed bottom-[calc(1.25rem+var(--save-dock-space,0px))] right-5 z-[60] flex flex-col gap-2.5 max-w-md w-full pointer-events-none px-4 sm:px-0" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`pointer-events-auto p-4 rounded-2xl border bg-white shadow-xl shadow-slate-900/10 flex items-start gap-3 animate-in ${border[t.type]}`}>
          <div className="mt-0.5 shrink-0">{icon[t.type]}</div>
          <div className="flex-1 min-w-0"><h4 className="font-extrabold text-sm text-slate-800">{t.title}</h4>{t.description && <p className="text-xs text-slate-600 mt-0.5 leading-relaxed font-medium">{t.description}</p>}</div>
          <button onClick={() => onDismiss(t.id)} className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100" aria-label="Dismiss"><X size={16} /></button>
        </div>
      ))}
    </div>
  );
}
