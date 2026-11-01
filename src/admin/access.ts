import { canViewTab, canViewSettings } from '../../shared/admin-permissions.mjs';
import type { AdminPrincipal } from './DashboardContext';
import type { Tab } from './Header';

export const ADMIN_TABS: Tab[] = ['appointments', 'inbox', 'analytics', 'activity', 'bot', 'settings', 'users'];
export function firstAllowedTab(principal: AdminPrincipal | undefined): Tab | null {
  return ADMIN_TABS.find(tab => canViewTab(principal, tab)) || null;
}
export function initialAdminTab(search: string, principal: AdminPrincipal | undefined): Tab | null {
  const params = new URLSearchParams(search);
  const requested = params.get('approval') ? 'inbox' : params.get('jobber') ? 'settings' : params.get('tab');
  // Preserve explicit forbidden destinations so the page can show Access denied.
  if (requested) return ADMIN_TABS.includes(requested as Tab) ? requested as Tab : null;
  return firstAllowedTab(principal);
}
export function firstAllowedSettings(principal: AdminPrincipal | undefined, pages: readonly (readonly [string, string])[]): string | null {
  return pages.find(([page]) => canViewSettings(principal, page))?.[0] || null;
}
export function changedConfig(previous: Record<string, any>, next: Record<string, any>): Record<string, any> {
  const changed: Record<string, any> = {};
  for (const key of Object.keys(next)) {
    if (key === 'version' || JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue;
    const value = next[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && previous[key] && typeof previous[key] === 'object' && !Array.isArray(previous[key])) {
      const nested = changedConfig(previous[key], value);
      if (Object.keys(nested).length) changed[key] = nested;
    } else changed[key] = value;
  }
  return changed;
}

export function invitationLocation(location: Pick<Location, 'search' | 'hash'>): { kind: 'invite' | 'bootstrap'; token: string } | null {
  const params = new URLSearchParams(location.search);
  const kind = params.has('bootstrap') ? 'bootstrap' : params.has('invite') ? 'invite' : null;
  if (!kind) return null;
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  return { kind, token };
}
