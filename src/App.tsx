import React, { Suspense, lazy } from 'react';
import { CustomerPage } from './customer/BookingBot';

// The office dashboard (and its charts) loads only on /admin, so the customer chat stays light.
const AdminRoot = lazy(() => import('./admin/AdminRoot').then((m) => ({ default: m.AdminRoot })));
// The page behind the after-hours email's Yes / No buttons (no login; a signed link).
const RespondPage = lazy(() => import('./respond/RespondPage').then((m) => ({ default: m.RespondPage })));

export default function App() {
  if (location.pathname === '/respond') return <Suspense fallback={<div className="min-h-dvh bg-[#eef2f7]" />}><RespondPage /></Suspense>;
  if (!location.pathname.startsWith('/admin')) return <CustomerPage />;
  return <Suspense fallback={<div className="min-h-dvh bg-slate-100" />}><AdminRoot /></Suspense>;
}
