'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_PATH = path.join(ROOT, '.env');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** Tiny .env parser: KEY=VALUE, optional quotes, # comments. */
function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function readEnvFile(file = DEFAULT_ENV_PATH) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function loadConfig({ argv = process.argv.slice(2), env = process.env, envPath = DEFAULT_ENV_PATH } = {}) {
  // Real environment variables win over the .env file.
  const merged = { ...readEnvFile(envPath), ...env };
  const projectToken = (merged.RAILWAY_PROJECT_TOKEN || '').trim();
  const accountToken = (merged.RAILWAY_API_TOKEN || '').trim();
  const port = Number.parseInt(merged.PORT, 10);
  const poll = Number.parseInt(merged.POLL_SECONDS, 10);

  return {
    root: ROOT,
    envPath,
    dataDir: path.resolve(merged.DATA_DIR || path.join(ROOT, 'data')),
    demo: argv.includes('--demo') || truthy(merged.DEMO),
    demoSpeed: Number(merged.DEMO_SPEED) > 0 ? Number(merged.DEMO_SPEED) : 1,
    host: (merged.BIND_HOST || '127.0.0.1').trim(),
    port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 3000,
    pollSeconds: Math.min(600, Math.max(10, Number.isFinite(poll) ? poll : 30)),
    token: projectToken || accountToken,
    tokenMode: projectToken ? 'project' : accountToken ? 'bearer' : null,
    projectId: (merged.RAILWAY_PROJECT_ID || '').trim(),
    environmentId: (merged.RAILWAY_ENVIRONMENT_ID || '').trim(),
    passwordHash: (merged.DASHBOARD_PASSWORD_HASH || '').trim(),
    password: merged.DASHBOARD_PASSWORD || '',
    apiUrl: (merged.RAILWAY_API_URL || '').trim() || 'https://backboard.railway.com/graphql/v2',
    trustProxy: truthy(merged.TRUST_PROXY),
    cookieSecure: truthy(merged.COOKIE_SECURE),
    allowedHosts: list(merged.ALLOWED_HOSTS),
    openBrowser: argv.includes('--open'),
  };
}

/** True when the dashboard has everything it needs to run for real (or is in demo mode). */
function isConfigured(cfg) {
  if (cfg.demo) return true;
  const hasPassword = Boolean(cfg.passwordHash || cfg.password);
  const hasToken = Boolean(cfg.token);
  const hasIds = cfg.tokenMode === 'project' || Boolean(cfg.projectId && cfg.environmentId);
  return hasPassword && hasToken && hasIds;
}

function formatValue(v) {
  const s = String(v);
  if (/[\r\n]/.test(s)) throw new Error('Values cannot contain line breaks.');
  if (s.includes('"')) throw new Error('Values cannot contain double quotes.');
  return /[\s#]/.test(s) ? `"${s}"` : s;
}

/** Update or add KEY=VALUE lines in the .env file. A null/undefined value removes the key. */
function writeEnv(envPath, updates) {
  let lines = [];
  try {
    lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const remaining = new Map(Object.entries(updates));
  const out = [];
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && remaining.has(m[1])) {
      const v = remaining.get(m[1]);
      remaining.delete(m[1]);
      if (v !== null && v !== undefined) out.push(`${m[1]}=${formatValue(v)}`);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of remaining) {
    if (v !== null && v !== undefined) out.push(`${k}=${formatValue(v)}`);
  }
  fs.writeFileSync(envPath, out.join('\n') + '\n', { mode: 0o600 });
}

module.exports = { loadConfig, isConfigured, writeEnv, parseEnv, readEnvFile, ROOT };
