// Only the public company login link, never a client-specific access token.
export function normalizeClientHubUrl(value) {
  if (value === '' || value == null) return '';
  if (typeof value !== 'string' || value.length > 300 || value !== value.trim() || /[\s\\%]/.test(value)) throw new Error('Use the public Jobber Client Hub share-login link.');
  const match = /^https:\/\/clienthub\.getjobber\.com\/client_hubs\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/login\/new(?:\?source=share_login)?$/i.exec(value);
  if (!match) throw new Error('Use the public Jobber Client Hub share-login link.');
  return `https://clienthub.getjobber.com/client_hubs/${match[1].toLowerCase()}/login/new?source=share_login`;
}
