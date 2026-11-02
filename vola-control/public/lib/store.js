// What the page currently knows, and the polling that keeps it fresh.
// It asks the server how the bots are doing every `pollSeconds` (30 by default), a bit faster while
// something is building, and not at all while this tab is hidden.

import { get } from './api.js';

export const state = {
  session: null,
  overview: null, // the last good answer
  error: null, // set when the last request failed
  loading: true,
  updatedAt: 0,
  fastUntil: 0,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error(err);
    }
  }
}

export async function loadSession() {
  state.session = await get('/api/session');
  return state.session;
}

let inflight = null;
let timer = null;
let running = false;

const anyBusy = () => Boolean(state.overview && state.overview.bots.some((b) => b.deployment && b.deployment.inFlight));
const isFast = () => Date.now() < state.fastUntil || anyBusy();

export function refresh({ force = false, maxAge } = {}) {
  if (inflight && !force) return inflight;
  const query = force ? '?force=1' : maxAge !== undefined ? `?maxAge=${maxAge}` : '';
  const request = get(`/api/overview${query}`)
    .then((data) => {
      state.overview = data;
      state.error = null;
      state.updatedAt = Date.now();
    })
    .catch((err) => {
      state.error = err;
    })
    .finally(() => {
      state.loading = false;
      if (inflight === request) inflight = null;
      emit();
      schedule();
    });
  inflight = request;
  return request;
}

function nextDelay() {
  const base = ((state.overview && state.overview.pollSeconds) || 30) * 1000;
  if (state.error && !state.overview) return 10_000;
  if (state.overview && state.overview.stale) {
    const wait = ((state.overview.error && state.overview.error.retryAfter) || 0) * 1000;
    return Math.max(15_000, wait);
  }
  return isFast() ? 4000 : base;
}

function schedule() {
  clearTimeout(timer);
  if (!running) return;
  timer = setTimeout(tick, nextDelay());
}

function tick() {
  if (document.hidden) {
    schedule();
    return;
  }
  refresh(isFast() ? { maxAge: 3 } : {});
}

/** Poll faster for a while, for example right after the person pressed Restart. */
export function boost(seconds = 150) {
  state.fastUntil = Date.now() + seconds * 1000;
  schedule();
}

export function start() {
  if (running) return;
  running = true;
  document.addEventListener('visibilitychange', onVisible);
  refresh();
}

export function stop() {
  running = false;
  clearTimeout(timer);
  document.removeEventListener('visibilitychange', onVisible);
}

function onVisible() {
  if (document.hidden || !running) return;
  const base = ((state.overview && state.overview.pollSeconds) || 30) * 1000;
  if (Date.now() - state.updatedAt > base) refresh();
}

export function resetOverview() {
  state.overview = null;
  state.error = null;
  state.loading = true;
  state.updatedAt = 0;
}

export const findBot = (id) => (state.overview ? state.overview.bots.find((b) => b.id === id) || null : null);
