// Talking to the dashboard server. Every change carries a header that only this page sends,
// which is how the server knows a request did not come from some other website.

export class ApiError extends Error {
  constructor({ status = 0, kind = 'http', message = 'Something went wrong.', retryAfter, steps }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.retryAfter = retryAfter;
    this.steps = steps;
  }
}

let onSignedOut = () => {};
export const setSignedOutHandler = (fn) => {
  onSignedOut = fn;
};

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'X-Requested-With': 'vola',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError({
      status: 0,
      kind: 'offline',
      message: 'The dashboard on your computer did not answer. Check that its window is still open, then try again.',
    });
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const e = (data && data.error) || {};
    if (res.status === 401 && path !== '/api/login' && path !== '/api/session') onSignedOut();
    throw new ApiError({
      status: res.status,
      kind: e.kind || 'http',
      message: e.message || `The dashboard returned an error (${res.status}).`,
      retryAfter: e.retryAfter,
      steps: e.steps,
    });
  }
  return data;
}

export const get = (path) => api('GET', path);
export const post = (path, body = {}) => api('POST', path, body);
export const put = (path, body = {}) => api('PUT', path, body);
export const patch = (path, body = {}) => api('PATCH', path, body);

export const botPath = (id, rest = '') => `/api/bots/${encodeURIComponent(id)}${rest}`;
