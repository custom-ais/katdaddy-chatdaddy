import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';

export type AppointmentStatus = 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'action_needed' | 'failed' | 'confirming';

export interface ToastMessage { id: string; type: 'success' | 'info' | 'warning' | 'error'; title: string; description: string }

export interface Appointment {
  id: string; customerName: string; email: string; phone: string; address: string; city: string; zip: string;
  package: string; packageId?: string; price: number; status: AppointmentStatus; scheduledAt: string; durationMins: number;
  technicianId: string; technicianName: string; notes?: string; urgency: 'normal' | 'elevated' | 'high'; source: 'ai_bot' | 'phone_dispatch';
  airflowReadings?: { beforeCfm: number | null; afterCfm: number | null }; createdAt: string; revision: number;
  lineItems?: { id?: string; name: string; cents: number }[]; route?: string; concerns?: string[]; property?: Record<string, any>;
  jobber?: { jobNumber?: number; webUri?: string; visitId?: string | null } | null; jobberState?: string; jobberError?: string;
  approval?: { id: string; by: string; at: number } | null; overflow?: boolean; sameDay?: boolean; phoneVerified?: boolean;
  notifications?: { sms?: string; email?: string; smsProvider?: string; emailProvider?: string }; reminder?: { at: number; sms: string; email: string } | null; territory?: { city: string; zone: number; micro: string; corridor: string } | null; smsConsent?: boolean;
}

export interface Technician {
  id: string; name: string; phone: string; status: 'available' | 'on_route' | 'on_job' | 'off_duty'; color: string; zone: string;
  jobberUserId: string; vehicle?: string; bio?: string;
}

export interface Snapshot {
  config: any; faqs: any[]; technicians: Technician[]; appointments: Appointment[]; requests: any[]; approvals: any[];
  heldLocksCount: number; conversations: number; notifications: any[]; integrations: any; westValleyZips: string[]; now: number;
  messages?: MessageLog[]; reminderRun?: any;
}

/** One text or email in the log (Twilio or LeadConnector). Inbound texts carry `from` and `preview`. */
export interface MessageLog {
  id: string; at: number; updated?: number; channel: 'sms' | 'email'; direction: 'out' | 'in'; provider: string; kind: string;
  ref?: string; to?: string; from?: string; status: string; error?: string; errorCode?: number | string | null; subject?: string; preview?: string;
}

interface Ctx {
  data: Snapshot;
  loading: boolean;
  refresh: () => Promise<void>;
  /** POST/PATCH that returns a fresh snapshot. Shows a toast on success; throws on error. */
  mutate: (path: string, body: any, method?: string, success?: string) => Promise<any>;
  toasts: ToastMessage[];
  showToast: (t: Omit<ToastMessage, 'id'>) => void;
  dismissToast: (id: string) => void;
  activeAppointments: Appointment[];
}

const DashboardContext = createContext<Ctx | null>(null);

export function DashboardProvider({ initial, onSignedOut, children }: { initial: Snapshot; onSignedOut: () => void; children: React.ReactNode }) {
  const [data, setData] = useState<Snapshot>(initial);
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const showToast = useCallback((t: Omit<ToastMessage, 'id'>) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((x) => [...x, { ...t, id }]);
    timers.current.push(window.setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 5000));
  }, []);
  const dismissToast = useCallback((id: string) => setToasts((x) => x.filter((y) => y.id !== id)), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api('/api/admin/data'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignedOut();
      else showToast({ type: 'error', title: "Couldn't refresh", description: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [onSignedOut, showToast]);

  // Live-ish: refresh every 15 seconds while the tab is visible.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const mutate = useCallback(async (path: string, body: any, method = 'POST', success = 'Saved') => {
    try {
      const r = await api(path, { method, body });
      if (r && r.config) setData(r);
      if (success) showToast({ type: 'success', title: success, description: '' });
      return r;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignedOut();
      throw e;
    }
  }, [onSignedOut, showToast]);

  const activeAppointments = useMemo(() => data.appointments.filter((a) => a.status !== 'failed'), [data.appointments]);

  return (
    <DashboardContext.Provider value={{ data, loading, refresh, mutate, toasts, showToast, dismissToast, activeAppointments }}>
      {children}
    </DashboardContext.Provider>
  );
}

export const useDashboard = () => {
  const c = useContext(DashboardContext);
  if (!c) throw new Error('useDashboard must be used inside DashboardProvider');
  return c;
};

// ---- shared helpers -----------------------------------------------------------------------

const TZ = 'America/Phoenix';
export const azDate = (iso: string | number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
export const azTime = (iso: string | number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
export const azDay = (iso: string | number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
export const azWeekday = (iso: string | number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date(iso));
export const azHour = (iso: string | number) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)));
export const dollars = (n: number) => `$${Math.round(n).toLocaleString()}`;
export const initials = (name: string) => String(name || '?').split(/\s+/).map((n) => n[0]).join('').slice(0, 2).toUpperCase();
export const isLinked = (a: Appointment) => Boolean(a.jobber?.jobNumber);

/** Why an appointment needs the office, in plain words. */
export function attentionReason(a: Appointment): string | null {
  if (a.status !== 'action_needed') return null;
  if (a.jobberState === 'uncertain') return "Jobber didn't answer — check whether the visit was created";
  if (a.jobberState === 'visit_failed' || a.jobberState === 'visit_uncertain') return 'Job created in Jobber, but its visit needs scheduling';
  return 'Marked for follow-up';
}
