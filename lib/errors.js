'use strict';

/** An error that maps straight to an HTTP status and a message that is safe to show. */
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

/**
 * Turn any error into { status, kind, message } that is safe to show in the browser.
 * Railway problems use 5xx/429 (never 401) so the browser doesn't think its own login expired.
 */
function describeError(err) {
  if (err instanceof HttpError) {
    return { status: err.status, kind: 'request', message: err.message, ...err.extra };
  }
  if (err && err.name === 'RailwayError') {
    switch (err.kind) {
      case 'auth':
        return {
          status: 502,
          kind: 'railway_auth',
          message: `Railway refused the token (${err.message}). Open Settings, then Connection, and paste a fresh token.`,
        };
      case 'rate': {
        const wait = err.retryAfter || 30;
        return {
          status: 429,
          kind: 'railway_rate',
          retryAfter: wait,
          message: `Railway says "slow down" (rate limit). Try again in about ${wait} seconds.`,
        };
      }
      case 'network':
        return { status: 504, kind: 'railway_network', message: err.message };
      default:
        return { status: 502, kind: 'railway', message: err.message };
    }
  }
  return { status: 500, kind: 'internal', message: 'Something went wrong inside the dashboard.' };
}

module.exports = { HttpError, describeError };
