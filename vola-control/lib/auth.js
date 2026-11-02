'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'vc_sid';
const IDLE_MS = 12 * 60 * 60 * 1000; // log out after 12h of no use
const MAX_MS = 7 * 24 * 60 * 60 * 1000; // and never keep a session longer than 7 days
const FAIL_LIMIT = 6; // wrong passwords allowed...
const FAIL_WINDOW_MS = 15 * 60 * 1000; // ...per 15 minutes, per address

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Constant-time string comparison. */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha(a), sha(b));
}

function hashPassword(password) {
  const N = 16384;
  const r = 8;
  const p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyHash(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (!expected.length) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, { N: +N, r: +r, p: +p });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

function createAuth({ now = Date.now } = {}) {
  const sessions = new Map();
  const fails = new Map();

  const sweeper = setInterval(() => {
    const t = now();
    for (const [sid, s] of sessions) {
      if (t - s.lastSeen > IDLE_MS || t - s.createdAt > MAX_MS) sessions.delete(sid);
    }
    for (const [ip, f] of fails) {
      if (t - f.first > FAIL_WINDOW_MS && (!f.lockedUntil || f.lockedUntil < t)) fails.delete(ip);
    }
  }, 60 * 1000);
  sweeper.unref();

  function lockedFor(ip) {
    const f = fails.get(ip);
    if (!f || !f.lockedUntil) return 0;
    const left = f.lockedUntil - now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  function recordFail(ip) {
    const t = now();
    let f = fails.get(ip);
    if (!f || t - f.first > FAIL_WINDOW_MS) f = { count: 0, first: t, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= FAIL_LIMIT) f.lockedUntil = t + FAIL_WINDOW_MS;
    fails.set(ip, f);
  }

  function passwordMatches(password, cfg) {
    const pw = String(password ?? '');
    if (cfg.passwordHash) return verifyHash(pw, cfg.passwordHash);
    if (cfg.password) return safeEqual(pw, cfg.password);
    return false;
  }

  function create(ip) {
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { createdAt: now(), lastSeen: now(), ip });
    return sid;
  }

  function login(ip, password, cfg) {
    const wait = lockedFor(ip);
    if (wait) return { ok: false, locked: true, retryAfter: wait };
    if (!passwordMatches(password, cfg)) {
      recordFail(ip);
      const w = lockedFor(ip);
      return { ok: false, locked: w > 0, retryAfter: w };
    }
    fails.delete(ip);
    return { ok: true, sid: create(ip) };
  }

  function sessionFrom(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    const t = now();
    if (t - s.lastSeen > IDLE_MS || t - s.createdAt > MAX_MS) {
      sessions.delete(sid);
      return null;
    }
    s.lastSeen = t;
    return { sid, createdAt: s.createdAt, ip: s.ip };
  }

  function destroy(sid) {
    sessions.delete(sid);
  }

  function destroyAllExcept(keep) {
    for (const sid of [...sessions.keys()]) if (sid !== keep) sessions.delete(sid);
  }

  function destroyAll() {
    sessions.clear();
  }

  function cookie(sid, { secure = false } = {}) {
    return `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_MS / 1000}${secure ? '; Secure' : ''}`;
  }

  function clearCookie({ secure = false } = {}) {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  return {
    login,
    create,
    sessionFrom,
    destroy,
    destroyAll,
    destroyAllExcept,
    cookie,
    clearCookie,
    passwordMatches,
    lockedFor,
  };
}

module.exports = { createAuth, hashPassword, verifyHash, safeEqual, parseCookies, COOKIE_NAME };
