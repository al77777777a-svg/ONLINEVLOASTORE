'use strict';

const DEFAULT_URL = 'https://backboard.railway.com/graphql/v2';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * kind: 'auth'    Railway rejected the token or it may not touch this resource
 *       'rate'    HTTP 429, too many requests
 *       'graphql' Railway answered with a GraphQL error
 *       'network' could not reach Railway at all
 *       'http'    some other bad HTTP status
 */
class RailwayError extends Error {
  constructor(message, { kind = 'graphql', status, retryAfter, operation } = {}) {
    super(message);
    this.name = 'RailwayError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.operation = operation;
  }
}

const AUTH_RE =
  /not authori[sz]ed|unauthori[sz]ed|forbidden|invalid (api )?token|token (is )?(invalid|expired|not found)|project token not found|access denied/i;

function operationOf(document) {
  const m = /^\s*(query|mutation)\s+([A-Za-z_]\w*)/.exec(document);
  return m ? { type: m[1], name: m[2] } : { type: 'query', name: undefined };
}

/** Railway documents X-RateLimit-Reset loosely, so accept epoch seconds, epoch ms, seconds-from-now or a date. */
function parseReset(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n > 1e12) return new Date(n).toISOString();
    if (n > 1e9) return new Date(n * 1000).toISOString();
    return new Date(Date.now() + n * 1000).toISOString();
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function fetchTransport(url) {
  return async function transport({ body, headers, signal }) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON, handled by the caller */
    }
    return { status: res.status, headers: res.headers, json, text };
  };
}

/**
 * Minimal Railway GraphQL client.
 * mode 'project' sends the token as `Project-Access-Token`, mode 'bearer' as `Authorization: Bearer`.
 * The token is only ever placed in request headers. It is never logged or put in an error message.
 */
function createRailway({ token, mode = 'project', url = DEFAULT_URL, transport, timeoutMs = 20000 }) {
  const send = transport || fetchTransport(url);
  const stats = { requests: 0, rate: null };

  function buildHeaders() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'vola-control/1.0',
    };
    if (mode === 'bearer') h.Authorization = `Bearer ${token}`;
    else h['Project-Access-Token'] = token;
    return h;
  }

  function readRate(h) {
    if (!h || typeof h.get !== 'function') return;
    const limitRaw = h.get('x-ratelimit-limit');
    const remainingRaw = h.get('x-ratelimit-remaining');
    if (limitRaw == null || remainingRaw == null) return;
    const limit = Number(limitRaw);
    const remaining = Number(remainingRaw);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return;
    stats.rate = { limit, remaining, resetAt: parseReset(h.get('x-ratelimit-reset')), at: Date.now() };
  }

  async function sendOnce(document, variables, op) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await send({
        body: { query: document, variables, operationName: op.name },
        headers: buildHeaders(),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      const why = (err && err.cause && err.cause.code) || (err && err.message) || 'unknown error';
      throw new RailwayError(aborted ? 'Railway did not answer in time.' : `Could not reach Railway (${why}).`, {
        kind: 'network',
        operation: op.name,
      });
    } finally {
      clearTimeout(timer);
    }

    stats.requests += 1;
    readRate(res.headers);

    if (res.status === 429) {
      const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      throw new RailwayError('Railway rate limit reached.', {
        kind: 'rate',
        status: 429,
        retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30,
        operation: op.name,
      });
    }

    const json = res.json;
    if (json && Array.isArray(json.errors) && json.errors.length) {
      const message = json.errors
        .map((e) => String((e && e.message) || 'Unknown error'))
        .join('; ')
        .slice(0, 400);
      const kind = res.status === 401 || res.status === 403 || AUTH_RE.test(message) ? 'auth' : 'graphql';
      throw new RailwayError(message, { kind, status: res.status, operation: op.name });
    }

    if (res.status === 401 || res.status === 403) {
      throw new RailwayError('Railway refused the token.', { kind: 'auth', status: res.status, operation: op.name });
    }
    if (res.status < 200 || res.status >= 300 || !json || typeof json !== 'object') {
      throw new RailwayError(`Railway answered with an unexpected response (HTTP ${res.status}).`, {
        kind: 'http',
        status: res.status,
        operation: op.name,
      });
    }
    return json.data;
  }

  /** Run one query or mutation and return its `data`. Queries are retried once on hiccups; mutations are not. */
  async function request(document, variables = {}) {
    const op = operationOf(document);
    const isMutation = op.type === 'mutation';
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await sendOnce(document, variables, op);
      } catch (err) {
        const retryable =
          attempt < 2 &&
          err instanceof RailwayError &&
          ((err.kind === 'rate' && err.retryAfter <= 8) ||
            (!isMutation && (err.kind === 'network' || (err.kind === 'http' && err.status >= 502))));
        if (!retryable) throw err;
        await sleep(err.kind === 'rate' ? err.retryAfter * 1000 : 400);
      }
    }
  }

  return {
    request,
    mode,
    getRate: () => stats.rate,
    getRequestCount: () => stats.requests,
  };
}

module.exports = { createRailway, RailwayError, DEFAULT_URL, operationOf };
