import React, { useEffect, useState } from 'react';
import { KeyRound, Mail, Save, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { Field, Section, inputClass, primaryButton, secondaryButton } from './ui';

export function IntegrationSettings() {
  const { data, refresh } = useDashboard();
  const [state, setState] = useState<any>(null), [values, setValues] = useState<Record<string, string>>({});
  const [remove, setRemove] = useState<string[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  useEffect(() => { let active = true; api('/api/admin/integration-settings').then((r) => { if (active) setState(r); }).catch((e) => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      setState(await api('/api/admin/integration-settings', { method: 'PATCH', body: { values: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())), remove } }));
      setValues({}); setRemove([]); await refresh(); setMessage('Saved securely. New requests use these settings.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setMessage(''); setError('');
    try { await api('/api/admin/email/verify', { method: 'POST', body: {} }); setMessage('Email sign-in succeeded. No message was sent.'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Section icon={<KeyRound size={18} />} title="Connections and API keys" description="Saved credentials are encrypted on the server and never displayed here. A blank field keeps its current value.">
    <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950"><ShieldCheck className="inline mr-2" size={17} />Only signed-in administrators can manage these connections.</div>
    {state && !state.writable && <p className="text-sm text-amber-800">Encrypted storage needs a BOB_SECRET_KEY in Vercel first. Existing Vercel credentials continue to work.</p>}
    {state?.issue && <p className="text-sm text-rose-700">{state.issue}</p>}
    {['AI', 'Jobber', 'Maps', 'Email', 'HighLevel'].map((group) => <fieldset key={group} disabled={busy || !state?.writable} className="rounded-2xl border border-slate-200 p-4 space-y-3">
      <legend className="px-2 text-sm font-extrabold text-slate-800">{group}</legend>
      {group === 'Email' && <p className="text-xs text-slate-500">Use the West Valley mailbox and its email app password. Gmail uses smtp.gmail.com, port 465. Customer confirmations and reports come from westvalley@dryerventsquad.com.</p>}
      {group === 'HighLevel' && <p className="text-xs text-slate-500">Customer texts stay paused until enabled in booking settings. On-call requests need a working sender and the phone-ready setting.</p>}
      <div className="grid sm:grid-cols-2 gap-4">{state?.fields.filter((f: any) => f.group === group).map((f: any) => <Field key={f.key} label={f.label} hint={f.configured ? `Configured in ${f.source === 'dashboard' ? 'this dashboard' : 'Vercel'}` : 'Not configured'}>
        <input className={inputClass} type={/KEY|SECRET|TOKEN|PASSWORD/.test(f.key) ? 'password' : 'text'} autoComplete="new-password" spellCheck={false} value={values[f.key] || ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} placeholder={f.configured ? 'Leave blank to keep saved value' : 'Enter value'} />
        {f.source === 'dashboard' && <label className="mt-1 flex items-center gap-2 text-xs font-normal"><input type="checkbox" checked={remove.includes(f.key)} onChange={(e) => setRemove((r) => e.target.checked ? [...r, f.key] : r.filter((k) => k !== f.key))} />Remove dashboard override</label>}
      </Field>)}</div>
    </fieldset>)}
    <div className="flex flex-wrap gap-3"><button className={primaryButton} onClick={() => void save()} disabled={busy || !state?.writable || (!Object.values(values).some((v) => v.trim()) && !remove.length)}><Save size={15} />Save connections</button><button className={secondaryButton} disabled={busy || !data.integrations?.email?.configured} onClick={() => void verify()}><Mail size={15} />Check email connection</button></div>
    <p className="text-xs text-slate-500">Daily report: 5:10 p.m. Arizona time · To westvalley@dryerventsquad.com · CC seth@custom-ais.com. {data.integrations?.dailyReport?.configured ? 'Email credentials and schedule secret are present.' : 'Email credentials and the schedule secret still need setup.'}</p>
    {data.integrations?.dailyReport?.issue && <p className="text-sm text-amber-800">{data.integrations.dailyReport.issue.message}</p>}
    {message && <p className="text-sm text-emerald-700" role="status">{message}</p>}{error && <p className="text-sm text-rose-700" role="alert">{error}</p>}
  </Section>;
}
