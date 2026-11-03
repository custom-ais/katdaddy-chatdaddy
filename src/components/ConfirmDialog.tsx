// Branded confirmation dialogs in place of the browser's confirm() ("site.app says…").
// askConfirm() renders its own dialog on <body> and resolves true (confirm) or false (cancel, Escape, backdrop).

import React, { useEffect, useId, useRef } from 'react';
import { createRoot } from 'react-dom/client';

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get a red button, and focus starts on Cancel. */
  danger?: boolean;
  /** 'chat' shows BOB; 'admin' is the dashboard style. */
  brand?: 'chat' | 'admin';
};

export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (value: boolean) => {
      root.unmount();
      host.remove();
      previous?.focus?.();
      resolve(value);
    };
    root.render(<ConfirmDialog {...options} onDone={done} />);
  });
}

function ConfirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, brand = 'admin', onDone }: ConfirmOptions & { onDone: (value: boolean) => void }) {
  const ok = useRef<HTMLButtonElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId(), messageId = useId();
  useEffect(() => {
    (danger ? cancel : ok).current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [danger, onDone]);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 backdrop-blur-[2px] p-4 animate-in" onClick={(e) => { if (e.target === e.currentTarget) onDone(false); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={message ? messageId : undefined} className="w-full max-w-sm rounded-3xl bg-white shadow-2xl border border-slate-200 p-6 text-left">
        {brand === 'chat' && <img src="/bob-avatar.png" alt="" width={56} height={56} className="size-14 rounded-full border border-sky-100 bg-white mb-3" />}
        <h2 id={titleId} className="font-extrabold text-slate-900 text-lg leading-snug">{title}</h2>
        {message && <p id={messageId} className="mt-1.5 text-sm text-slate-600 leading-relaxed">{message}</p>}
        <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button ref={cancel} type="button" onClick={() => onDone(false)} className="px-4 py-2.5 rounded-xl font-extrabold text-sm bg-slate-100 text-slate-700 hover:bg-slate-200">{cancelLabel}</button>
          <button ref={ok} type="button" onClick={() => onDone(true)} className={`px-4 py-2.5 rounded-xl font-extrabold text-sm text-white ${danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-orange-500 hover:bg-orange-600'}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
