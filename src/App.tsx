import React, { Suspense, lazy } from 'react';
import { CustomerPage } from './customer/BookingBot';

// The office dashboard (and its charts) loads only on /admin, so the customer chat stays light.
const AdminRoot = lazy(() => import('./admin/AdminRoot').then((m) => ({ default: m.AdminRoot })));

export default function App() {
  if (!location.pathname.startsWith('/admin')) return <CustomerPage />;
  return <Suspense fallback={<div className="min-h-dvh bg-slate-100" />}><AdminRoot /></Suspense>;
}
