import React, { useCallback, useEffect, useState } from 'react';
import { Bot, ExternalLink, Eye, EyeOff, Loader2, LockKeyhole, Wind } from 'lucide-react';
import { api } from '../lib/api';
import { DashboardProvider, useDashboard, type Snapshot } from './DashboardContext';
import { Header, type Tab } from './Header';
import { AppointmentManager } from './AppointmentManager';
import { AnalyticsDashboard } from './AnalyticsDashboard';
import { InboxPage } from './InboxPage';
import { ActivityLogPage } from './ActivityLogPage';
import { SettingsPage } from './SettingsPage';
import { NewAppointmentModal } from './NewAppointmentModal';
import { ErrorNote, Field, ToastContainer, inputClass, primaryButton, secondaryButton } from './ui';
import { BookingBot } from '../customer/BookingBot';
import { canViewTab } from '../../shared/admin-permissions.mjs';
import { ADMIN_TABS, initialAdminTab, invitationLocation } from './access';
import { UsersPage } from './UsersPage';
import { InvitationPage } from './InvitationPage';

const TABS: Tab[] = ADMIN_TABS;

function SignIn({ setupRequired, authMode, onSignedIn }: { setupRequired: boolean; authMode?: string; onSignedIn: () => void }) {
  const individual = authMode === 'named' || new URLSearchParams(location.search).get('account') === '1';
  const [setup, setSetup] = useState(setupRequired && !individual);
  const [email, setEmail] = useState(''), [notice, setNotice] = useState('');
  const [password, setPassword] = useState(''), [code, setCode] = useState(''), [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      if (setup) { await api('/api/admin/setup', { method: 'POST', body: { setupToken: code, password } }); setSetup(false); }
      const result = await api('/api/admin/login', { method: 'POST', body: { password, ...(individual ? { email } : {}) } });
      setPassword('');
      if (result.pendingCutover) { setNotice('Your account login is verified. Individual account access is awaiting the separately authorized cutover.'); return; }
      onSignedIn();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="min-h-dvh bg-slate-100 flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-white rounded-3xl border border-slate-200 shadow-xl p-7 space-y-5">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-br from-orange-500 to-amber-600 p-2.5 rounded-2xl text-white shadow-md shadow-orange-500/20"><Wind size={22} className="stroke-[2.5]" /></div>
          <div><p className="font-extrabold text-slate-900 leading-none">Dryer Vent Squad</p><p className="text-xs font-semibold text-slate-500 mt-1">Dispatch &amp; scheduling</p></div>
        </div>
        <div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">{setup ? 'Set up the dashboard' : 'Sign in'}</h1>
          <p className="text-sm text-slate-500 mt-1">{setup ? 'Enter the setup code saved as BOB_SETUP_TOKEN in Vercel, then choose the dashboard password.' : individual ? 'Use your individual account. Your Master Admin chooses which pages and actions you can access.' : 'Appointments, approvals, prices and booking rules.'}</p>
        </div>
        {setup && <Field label="Setup code"><input className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="one-time-code" /></Field>}
        {individual && <Field label="Account email"><input className={inputClass} type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></Field>}
        <Field label={setup ? 'New password (14+ characters)' : 'Password'}>
          <div className="relative">
            <input className={`${inputClass} pr-11`} type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={setup ? 14 : undefined} autoComplete={setup ? 'new-password' : 'current-password'} required autoFocus />
            <button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-700" aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          </div>
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
        {notice && <p role="status" className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900">{notice}</p>}
        <button className={`${primaryButton} w-full`} disabled={busy}><LockKeyhole size={16} />{busy ? 'Signing in…' : setup ? 'Create password and sign in' : 'Sign in'}</button>
        <a className="block text-center text-xs font-bold text-slate-500 hover:text-orange-600" href="/chat">Open the customer chat</a>
      </form>
    </div>
  );
}

function BotPreview() {
  const { data } = useDashboard();
  const c = data.config, i = data.integrations || {};
  const verificationRequired = i.verification?.provider === 'twilio' || c.requirePhoneVerification !== false;
  const verificationReady = !verificationRequired || (i.verification?.enabled !== false && Boolean(i.verification?.configured));
  const mapsReady = i.maps?.enabled !== false;
  const live = data.bookingEnabled === true;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 animate-in">
      <div className="min-w-0"><BookingBot preview /></div>
      <aside className="space-y-4">
        <div className="bg-white rounded-3xl border border-slate-200 p-5 space-y-3">
          <h3 className="font-extrabold text-slate-900 flex items-center gap-2"><Bot size={18} className="text-orange-500" />This is the live bot</h3>
          <p className="text-sm text-slate-600 leading-relaxed">It uses the same prices, rules and calendar customers see. {live ? 'Online booking is on, so a booking you finish here is real — use your own phone and cancel it in Jobber afterwards.' : 'Online booking is off right now, so it will offer a callback request instead of times.'}</p>
          <ul className="text-xs text-slate-600 space-y-1.5">
            <li><b>Smart chat:</b> {c.aiAssistant ? (i.assistant?.configured ? `on (${i.assistant.model})` : 'on, waiting for the selected provider’s API key') : 'off'}</li>
            <li><b>Verification:</b> {!verificationRequired ? 'not required by the saved policy' : verificationReady ? 'text or email required (Twilio)' : 'Twilio verification is not ready'}</li>
            <li><b>Address lookup:</b> {mapsReady ? (i.maps?.provider === 'google' ? 'Google Maps enabled' : 'Census lookup only; measured routes unavailable') : 'off — online booking is paused, including ZIP-based service areas'}</li>
            <li><b>Online approvals:</b> emergency same-day only. Other approval-only exceptions remain office-only.</li>
          </ul>
          <a className={`${secondaryButton} w-full`} href="/chat" target="_blank" rel="noreferrer">Open the customer page<ExternalLink size={14} /></a>
        </div>
      </aside>
    </div>
  );
}

export function adminTabFromSearch(search: string): Tab {
  const p = new URLSearchParams(search);
  if (p.get('approval')) return 'inbox';
  if (p.get('jobber')) return 'settings';
  const t = p.get('tab') as Tab;
  return TABS.includes(t) ? t : 'appointments';
}

function Dashboard({ onSignedOut, focusApproval }: { onSignedOut: () => void; focusApproval: string | null }) {
  const { data, can, toasts, dismissToast, showToast } = useDashboard();
  const initialTab = initialAdminTab(location.search, data.access);
  const [tab, setTab] = useState<Tab | null>(initialTab);
  const [settingsMounted, setSettingsMounted] = useState(initialTab === 'settings');
  useEffect(() => {
    const restore = () => {
      const next = initialAdminTab(location.search, data.access);
      setTab(next);
      if (next === 'settings') setSettingsMounted(true);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [data.access]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(location.search), j = p.get('jobber');
    if (j === 'connected') showToast({ type: 'success', title: 'Jobber connected', description: 'BOB now reads the live calendar.' });
    if (j === 'failed') showToast({ type: 'error', title: "Jobber didn't connect", description: 'Check the Jobber app keys and redirect address in Vercel, then try again.' });
    if (j) { p.delete('jobber'); p.set('tab', 'settings'); history.replaceState(null, '', `/admin?${p.toString()}`); }
  }, [showToast]);
  const choose = (t: Tab) => {
    if (t === tab || !canViewTab(data.access, t)) return;
    const url = new URL(location.href);
    url.searchParams.delete('approval'); url.searchParams.delete('jobber'); url.searchParams.set('tab', t);
    history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    setTab(t); if (t === 'settings') setSettingsMounted(true);
    window.scrollTo({ top: 0 });
  };
  const signOut = async () => { try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch {} onSignedOut(); };
  const allowed = !!tab && canViewTab(data.access, tab);
  const canBook = can('appointments.view') && can('appointments.manage') && can('finance.view');

  return (
    <div className="min-h-dvh bg-slate-100/80">
      <Header tab={tab} onTab={choose} onNew={() => { if (canBook) setCreating(true); }} onSignOut={signOut} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {!allowed && <div role="alert" className="rounded-2xl bg-white border border-slate-200 p-6"><h1 className="text-xl font-bold">Access unavailable</h1><p className="mt-2 text-sm text-slate-600">You do not have access to this page. Choose an available page above or ask your Master Admin to update your access.</p></div>}
        {allowed && tab === 'appointments' && <AppointmentManager />}
        {allowed && tab === 'inbox' && <InboxPage focusApproval={focusApproval} />}
        {allowed && tab === 'analytics' && <AnalyticsDashboard onNavigateToAppointments={() => choose('appointments')} />}
        {allowed && tab === 'activity' && <ActivityLogPage />}
        {allowed && tab === 'bot' && <BotPreview />}
        {allowed && tab === 'users' && <UsersPage />}
        {settingsMounted && canViewTab(data.access, 'settings') && <div hidden={tab !== 'settings'}><SettingsPage active={tab === 'settings'} /></div>}
      </main>
      {creating && canBook && <NewAppointmentModal onClose={() => setCreating(false)} />}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export function AdminRoot() {
  const [invitation] = useState(() => invitationLocation(location));
  const [state, setState] = useState<{ phase: 'loading' | 'signin' | 'ready' | 'error'; setupRequired?: boolean; authMode?: string; data?: Snapshot; error?: string }>({ phase: 'loading' });
  const [focusApproval] = useState(() => new URLSearchParams(location.search).get('approval'));
  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const s = await api('/api/admin/status');
      if (!s.authenticated) return setState({ phase: 'signin', setupRequired: s.setupRequired, authMode: s.authMode });
      setState({ phase: 'ready', data: await api('/api/admin/data') });
    } catch (e) {
      setState({ phase: 'error', error: (e as Error).message });
    }
  }, []);
  useEffect(() => { if (!invitation) void load(); }, [load, invitation]);
  const signedOut = useCallback(() => { void load(); }, [load]);

  if (invitation) return <InvitationPage invitation={invitation} />;

  if (state.phase === 'loading') return <div className="min-h-dvh flex items-center justify-center bg-slate-100 text-slate-500"><Loader2 className="animate-spin" /></div>;
  if (state.phase === 'error') {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-slate-100 p-4">
        <div className="max-w-md w-full bg-white rounded-3xl border border-slate-200 p-6 space-y-4">
          <h1 className="text-xl font-black text-slate-900">The dashboard couldn't load</h1>
          <ErrorNote>{state.error}</ErrorNote>
          <button className={primaryButton} onClick={load}>Try again</button>
        </div>
      </div>
    );
  }
  if (state.phase === 'signin') return <SignIn setupRequired={!!state.setupRequired} authMode={state.authMode} onSignedIn={load} />;
  return (
    <DashboardProvider initial={state.data!} onSignedOut={signedOut}>
      <Dashboard onSignedOut={signedOut} focusApproval={focusApproval} />
    </DashboardProvider>
  );
}
