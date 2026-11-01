export const sanitizeDiagnostic = value => String(value || '').replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/([?&](?:key|api_key|token|access_token|secret)=)[^&\s)]+/gi, '$1[redacted]').replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted]').replace(/\bpit-[A-Za-z0-9-]{8,}/g, '[redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1500);
// Passive diagnostics: these methods never call a provider. Revision is private
// server-side configuration identity and is never included in a snapshot.
export function createIntegrationStatus({ store, cache = store, provider, revision, configured = true, operations = ['default'], clock = Date.now, maxAgeMs = 15 * 60_000, legacyKey } = {}) {
  const names = [...new Set(operations)];
  const key = operation => `diag:v2:${provider}:${operation}`;
  const read = async operation => { try { return await cache?.kvGet(key(operation)) || null; } catch { return null; } };
  const publicIssue = issue => issue && Number.isFinite(issue.at) ? { at: issue.at, message: sanitizeDiagnostic(issue.message), operation: issue.operation || 'unknown', historical: true } : null;
  async function record(operation, status, message) {
    if (!configured || !names.includes(operation)) return;
    try {
      const previous = await read(operation), at = clock();
      const lastIssue = status === 'error' ? { at, message: sanitizeDiagnostic(message || 'Provider operation failed.'), operation } : previous?.lastIssue || null;
      const history = status === 'error' ? [lastIssue, ...(previous?.history || [])].slice(0, 10) : previous?.history || [];
      await cache?.kvSet(key(operation), { revision, status, checkedAt: at, lastSuccessAt: status === 'healthy' ? at : previous?.revision === revision ? previous.lastSuccessAt || null : null, lastIssue, history });
    } catch {} // Diagnostic storage must not break normal provider operations.
  }
  async function snapshot() {
    const detail = {}, history = [];
    for (const operation of names) {
      const saved = await read(operation), current = configured && saved?.revision === revision;
      const issue = publicIssue(saved?.lastIssue);
      const fresh = current && Number.isFinite(saved.checkedAt) && clock() >= saved.checkedAt && clock() - saved.checkedAt < maxAgeMs;
      const status = fresh && ['healthy', 'error'].includes(saved.status) ? saved.status : 'unknown';
      detail[operation] = { status, stale: Boolean(current && !fresh), checkedAt: current ? saved.checkedAt : null, lastSuccessAt: current ? saved.lastSuccessAt || null : null, activeIssue: status === 'error' && issue ? { ...issue, historical: false } : null, lastIssue: issue };
      history.push(...(saved?.history || (issue ? [issue] : [])).map(publicIssue).filter(Boolean));
    }
    if (legacyKey) {
      try { const old = publicIssue(await cache?.kvGet(legacyKey)); if (old) history.push(old); } catch {}
    }
    const values = Object.values(detail);
    history.sort((a, b) => b.at - a.at);
    const uniqueHistory = history.filter((x, i, all) => all.findIndex(y => y.at === x.at && y.message === x.message && y.operation === x.operation) === i).slice(0, 20);
    const activeIssues = values.map(x => x.activeIssue).filter(Boolean).sort((a, b) => b.at - a.at);
    const times = field => values.map(x => x[field]).filter(Number.isFinite);
    const checks = times('checkedAt'), successes = times('lastSuccessAt');
    return {
      configured, status: activeIssues.length ? 'error' : configured && values.length && values.every(x => x.status === 'healthy') ? 'healthy' : 'unknown',
      checkedAt: checks.length ? Math.max(...checks) : null, lastSuccessAt: successes.length ? Math.max(...successes) : null,
      activeIssue: activeIssues[0] || null, lastIssue: uniqueHistory[0] || null, history: uniqueHistory, operations: detail,
    };
  }
  return { recordSuccess: operation => record(operation, 'healthy'), recordFailure: (operation, message) => record(operation, 'error', message), snapshot };
}
