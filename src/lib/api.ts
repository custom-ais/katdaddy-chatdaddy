export class ApiError extends Error {
  constructor(public status: number, message: string, public code = '', public retryInSeconds = 0) {
    super(message);
  }
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function api<T = any>(path: string, {
  method = 'GET', body, token, signal,
}: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-BOB-Request': '1', ...(token ? { 'X-BOB-Session': token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: 'same-origin', signal,
    });
    let result: any;
    try { result = await response.json(); }
    catch { throw new ApiError(response.status, 'The server returned an unreadable response. Check the server and try again.'); }

    // This response guarantees that the operation never acquired its lease and
    // never ran. Uncertain provider/network failures must not automatically repeat
    // a text or booking. Only a request still waiting for its turn can be retried.
    if (response.status === 409 && result.code === 'CONVERSATION_PENDING' && attempt < 2) {
      await delay(Math.min(3, Math.max(1, result.retryInSeconds || 1)) * 1000, signal);
      continue;
    }
    if (!response.ok) throw new ApiError(response.status, result.error || 'The request could not be completed.', result.code || '', result.retryInSeconds || 0);
    return result;
  }
}

export function saveText(name: string, text: string, type = 'text/plain') {
  const a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type }));
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
