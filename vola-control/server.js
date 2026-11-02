#!/usr/bin/env node
'use strict';

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) {
  console.error(`\n  VOLA Control needs Node.js 18 or newer (you have ${process.versions.node}).`);
  console.error('  Download the current LTS version from https://nodejs.org and try again.\n');
  process.exit(1);
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pkg = require('./package.json');
const { loadConfig, isConfigured, writeEnv } = require('./lib/config');
const { createAuth, hashPassword } = require('./lib/auth');
const { createRailway } = require('./lib/railway');
const { createBots } = require('./lib/bots');
const { createActivity } = require('./lib/activity');
const { createDemo } = require('./lib/demo');
const { testConnection } = require('./lib/connect');
const { HttpError, describeError } = require('./lib/errors');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_BODY = 512 * 1024;
const MIN_PASSWORD = 8;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

// `transport` lets tests (and nothing else) replace the real network call to Railway.
function createApp(initialConfig, { env = process.env, argv = process.argv.slice(2), transport } = {}) {
  let cfg = initialConfig;
  const activity = createActivity({ dir: cfg.dataDir });
  const auth = createAuth();
  let runtime = null;
  let demo = null;

  // ------------------------------------------------------------------ runtime (Railway client + bots)

  function buildRuntime() {
    if (demo) {
      demo.stop();
      demo = null;
    }
    if (cfg.demo) {
      demo = createDemo({ speed: cfg.demoSpeed });
      const railway = createRailway({ token: demo.TOKEN, mode: 'project', transport: demo.transport });
      runtime = {
        railway,
        service: createBots({ railway, ...demo.ids, pollSeconds: cfg.pollSeconds, activity }),
      };
    } else if (isConfigured(cfg)) {
      const railway = createRailway({ token: cfg.token, mode: cfg.tokenMode, url: cfg.apiUrl, transport });
      runtime = {
        railway,
        service: createBots({
          railway,
          projectId: cfg.projectId,
          environmentId: cfg.environmentId,
          pollSeconds: cfg.pollSeconds,
          activity,
        }),
      };
    } else {
      runtime = null;
    }
  }
  buildRuntime();

  function reloadConfig() {
    cfg = loadConfig({ argv, env, envPath: cfg.envPath });
    buildRuntime();
  }

  const locks = () => ({
    connection: Boolean(env.RAILWAY_PROJECT_TOKEN || env.RAILWAY_API_TOKEN),
    password: Boolean(env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD_HASH),
  });

  const authConfig = () => ({
    passwordHash: cfg.passwordHash,
    password: cfg.password || (cfg.demo && !cfg.passwordHash ? 'demo' : ''),
  });

  const needRuntime = () => {
    if (!runtime) throw new HttpError(409, 'The dashboard is not set up yet.');
    return runtime.service;
  };

  // ------------------------------------------------------------------ request helpers

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const isSecure = (req) => cfg.cookieSecure || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function hostAllowed(req) {
    const raw = String(req.headers.host || '').toLowerCase();
    const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
    if (cfg.allowedHosts.length) return cfg.allowedHosts.includes(host);
    if (!LOOPBACK_NAMES.has(cfg.host)) return true; // a deployed copy: the platform decides the host name
    // Local only: refuse other host names so a malicious web page cannot reach us via DNS rebinding.
    return LOOPBACK_NAMES.has(host) || host.endsWith('.localhost');
  }

  function guardWrite(req) {
    if (req.headers['x-requested-with'] !== 'vola') throw new HttpError(403, 'Blocked: this request did not come from the dashboard.');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Blocked: cross-site request.');
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
      } catch {
        ok = false;
      }
      if (!ok) throw new HttpError(403, 'Blocked: unexpected origin.');
    }
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (Number(req.headers['content-length']) > MAX_BODY) {
        reject(new HttpError(413, 'That request is too large.'));
        return;
      }
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          tooBig = true;
          chunks.length = 0;
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return reject(new HttpError(413, 'That request is too large.'));
        if (!size) return resolve({});
        if (!/application\/json/i.test(String(req.headers['content-type'] || ''))) {
          return reject(new HttpError(415, 'Send JSON.'));
        }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          return resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
        } catch {
          return reject(new HttpError(400, 'That request was not valid JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  function setSecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }

  function sendJson(res, status, body, cookies = []) {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (cookies.length) headers['Set-Cookie'] = cookies;
    res.writeHead(status, headers);
    res.end(payload);
  }

  function sendText(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  // ------------------------------------------------------------------ API handlers

  function sessionInfo(ctx) {
    const configured = isConfigured(cfg);
    const a = authConfig();
    return {
      authenticated: Boolean(auth.sessionFrom(ctx.req)),
      configured,
      needsSetup: !configured,
      demo: cfg.demo,
      demoHint: cfg.demo && !cfg.password && !cfg.passwordHash ? 'demo' : undefined,
      hasPassword: Boolean(a.password || a.passwordHash),
      version: pkg.version,
    };
  }

  async function login(ctx) {
    const a = authConfig();
    if (!a.password && !a.passwordHash) throw new HttpError(503, 'The dashboard is not set up yet.');
    const result = auth.login(ctx.ip, ctx.body.password, a);
    if (!result.ok) {
      await sleep(350);
      activity.add({
        actor: ctx.ip,
        action: 'login',
        ok: false,
        message: result.locked ? 'Locked out after too many wrong passwords' : 'Wrong password',
      });
      if (result.locked) {
        throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil(result.retryAfter / 60)} minute(s).`, {
          retryAfter: result.retryAfter,
        });
      }
      throw new HttpError(401, 'That password is not right.');
    }
    ctx.cookies.push(auth.cookie(result.sid, { secure: isSecure(ctx.req) }));
    activity.add({ actor: ctx.ip, action: 'login', ok: true, message: 'Signed in' });
    return { ok: true };
  }

  function logout(ctx) {
    const s = auth.sessionFrom(ctx.req);
    if (s) auth.destroy(s.sid);
    ctx.cookies.push(auth.clearCookie({ secure: isSecure(ctx.req) }));
    return { ok: true };
  }

  // -- first-time setup (only from this computer, only until it is set up)

  function requireSetup(ctx) {
    if (isConfigured(cfg)) throw new HttpError(403, 'The dashboard is already set up.');
    if (!LOOPBACK_ADDRS.has(ctx.req.socket.remoteAddress)) {
      throw new HttpError(403, 'First-time setup can only be done on the computer that runs the dashboard.');
    }
  }

  function setupInfo() {
    const configured = isConfigured(cfg);
    return {
      needsSetup: !configured,
      defaults: configured ? {} : { projectId: cfg.projectId, environmentId: cfg.environmentId },
      locked: locks(),
    };
  }

  async function setupTest(ctx) {
    const { token, projectId, environmentId } = ctx.body;
    return testConnection({ token, projectId, environmentId, apiUrl: cfg.apiUrl, transport });
  }

  function checkNewPassword(pw) {
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) {
      throw new HttpError(400, `Choose a password with at least ${MIN_PASSWORD} characters.`);
    }
    if (pw.length > 200) throw new HttpError(400, 'That password is too long.');
    return pw;
  }

  async function applyConnection({ token, projectId, environmentId }) {
    if (locks().connection) {
      throw new HttpError(409, 'The Railway token is set by an environment variable on this server. Change it there.');
    }
    const result = await testConnection({ token, projectId, environmentId, apiUrl: cfg.apiUrl, transport });
    if (!result.ok) {
      throw new HttpError(400, 'Railway did not accept those details. Read the steps below and try again.', { steps: result.steps });
    }
    const clean = String(token).trim();
    writeEnv(cfg.envPath, {
      RAILWAY_PROJECT_TOKEN: result.mode === 'project' ? clean : null,
      RAILWAY_API_TOKEN: result.mode === 'bearer' ? clean : null,
      RAILWAY_PROJECT_ID: result.projectId,
      RAILWAY_ENVIRONMENT_ID: result.environmentId,
    });
    return result;
  }

  async function setupSave(ctx) {
    const { token, password, projectId, environmentId } = ctx.body;
    if (locks().password) throw new HttpError(409, 'The dashboard password is set by an environment variable on this server.');
    checkNewPassword(password);
    const result = await applyConnection({ token, projectId, environmentId });
    writeEnv(cfg.envPath, { DASHBOARD_PASSWORD_HASH: hashPassword(password), DASHBOARD_PASSWORD: null });
    reloadConfig();
    ctx.cookies.push(auth.cookie(auth.create(ctx.ip), { secure: isSecure(ctx.req) }));
    activity.add({ actor: ctx.ip, action: 'setup', ok: true, message: `Connected to ${result.projectName}` });
    return { ok: true, projectName: result.projectName, services: result.services };
  }

  // -- settings of the dashboard itself

  async function connectionSave(ctx) {
    if (cfg.demo) throw new HttpError(409, 'This is demo mode. Start the dashboard normally to connect a real project.');
    const result = await applyConnection(ctx.body);
    reloadConfig();
    activity.add({ actor: ctx.ip, action: 'change-token', ok: true, message: `Connected to ${result.projectName}` });
    return { ok: true, projectName: result.projectName, services: result.services, steps: result.steps };
  }

  function passwordChange(ctx) {
    if (cfg.demo) throw new HttpError(409, 'The password cannot be changed in demo mode.');
    if (locks().password) throw new HttpError(409, 'The dashboard password is set by an environment variable on this server.');
    const { current, next } = ctx.body;
    if (!auth.passwordMatches(current, authConfig())) throw new HttpError(403, 'The current password is not right.');
    checkNewPassword(next);
    writeEnv(cfg.envPath, { DASHBOARD_PASSWORD_HASH: hashPassword(next), DASHBOARD_PASSWORD: null });
    reloadConfig();
    auth.destroyAllExcept(ctx.session.sid);
    activity.add({ actor: ctx.ip, action: 'change-password', ok: true, message: 'Dashboard password changed' });
    return { ok: true };
  }

  async function diagnostics() {
    const service = needRuntime();
    const steps = [];
    const started = Date.now();
    try {
      const ov = await service.getOverview({ force: true });
      steps.push({
        name: 'Railway answers',
        ok: !ov.stale,
        detail: ov.stale ? ov.error.message : `Answered in ${Date.now() - started} ms`,
      });
      steps.push({ name: 'Project', ok: true, detail: `${ov.project.name} / ${ov.environment.name}` });
      steps.push({
        name: 'Bots found',
        ok: ov.bots.length > 0,
        detail: ov.bots.length ? `${ov.bots.length}: ${ov.bots.map((b) => b.name).join(', ')}` : 'None in this environment',
      });
    } catch (err) {
      steps.push({ name: 'Railway answers', ok: false, detail: describeError(err).message });
    }
    return {
      steps,
      demo: cfg.demo,
      tokenType: cfg.demo ? 'demo' : runtime.railway.mode === 'project' ? 'project token' : 'account/workspace token',
      rate: runtime.railway.getRate(),
      requests: runtime.railway.getRequestCount(),
      version: pkg.version,
      locked: locks(),
      ids: service.getIds(),
    };
  }

  // -- bots

  // ?force=1 always asks Railway; ?maxAge=3 accepts an answer up to 3 seconds old (used while a bot is changing state).
  const overview = async (ctx) => {
    const q = ctx.url.searchParams;
    const opts = { force: q.get('force') === '1' };
    const maxAge = Number(q.get('maxAge'));
    if (q.has('maxAge') && Number.isFinite(maxAge) && maxAge >= 0) opts.maxAgeMs = Math.min(maxAge, 120) * 1000;
    const data = await needRuntime().getOverview(opts);
    return { ...data, demo: cfg.demo };
  };

  const actor = (ctx) => ctx.ip;

  const routes = [];
  const route = (method, pattern, fn, opts = {}) => routes.push({ method, pattern, fn, opts });

  route('GET', /^\/api\/session$/, sessionInfo, { auth: false });
  route('POST', /^\/api\/login$/, login, { auth: false });
  route('POST', /^\/api\/logout$/, logout, { auth: false });

  route('GET', /^\/api\/setup$/, setupInfo, { auth: false });
  route('POST', /^\/api\/setup\/test$/, setupTest, { auth: false, setup: true });
  route('POST', /^\/api\/setup\/save$/, setupSave, { auth: false, setup: true });

  route('GET', /^\/api\/overview$/, overview);
  route('GET', /^\/api\/activity$/, (ctx) => ({
    entries: activity.list(Math.min(200, Math.max(1, Number.parseInt(ctx.url.searchParams.get('limit'), 10) || 50))),
  }));
  route('GET', /^\/api\/diagnostics$/, diagnostics);
  route('POST', /^\/api\/connection$/, connectionSave);
  route('POST', /^\/api\/password$/, passwordChange);

  route('POST', /^\/api\/bulk$/, (ctx) => needRuntime().runBulk(ctx.body.action, ctx.body.ids, { actor: actor(ctx) }));
  route('POST', /^\/api\/bots\/([\w-]+)\/actions\/([\w-]+)$/, (ctx, id, action) =>
    needRuntime().runAction(id, action, { deploymentId: ctx.body.deploymentId, actor: actor(ctx) }),
  );
  route('GET', /^\/api\/bots\/([\w-]+)\/deployments$/, (ctx, id) =>
    needRuntime().listDeployments(id, { limit: ctx.url.searchParams.get('limit') }),
  );
  route('GET', /^\/api\/bots\/([\w-]+)\/logs$/, (ctx, id) => {
    const q = ctx.url.searchParams;
    return needRuntime().getLogs(id, {
      kind: q.get('kind') === 'build' ? 'build' : 'deploy',
      deploymentId: q.get('deploymentId') || undefined,
      limit: q.get('limit'),
    });
  });

  route('GET', /^\/api\/bots\/([\w-]+)\/variables$/, (ctx, id) =>
    needRuntime().listVariables(id, { rendered: ctx.url.searchParams.get('rendered') === '1' }),
  );
  route('POST', /^\/api\/bots\/([\w-]+)\/variables\/reveal$/, (ctx, id) =>
    needRuntime().revealVariables(id, { names: ctx.body.names, rendered: ctx.body.rendered === true, actor: actor(ctx) }),
  );
  route('PUT', /^\/api\/bots\/([\w-]+)\/variables$/, (ctx, id) =>
    needRuntime().setVariable(id, {
      name: ctx.body.name,
      value: ctx.body.value,
      redeploy: ctx.body.redeploy !== false,
      actor: actor(ctx),
    }),
  );
  route('POST', /^\/api\/bots\/([\w-]+)\/variables\/delete$/, (ctx, id) =>
    needRuntime().deleteVariable(id, { name: ctx.body.name, redeploy: ctx.body.redeploy !== false, actor: actor(ctx) }),
  );
  route('POST', /^\/api\/bots\/([\w-]+)\/variables\/import$/, (ctx, id) =>
    needRuntime().importVariables(id, { text: ctx.body.text, redeploy: ctx.body.redeploy !== false, actor: actor(ctx) }),
  );

  route('GET', /^\/api\/bots\/([\w-]+)\/settings$/, (ctx, id) => needRuntime().getSettings(id));
  route('PATCH', /^\/api\/bots\/([\w-]+)\/settings$/, (ctx, id) =>
    needRuntime().updateSettings(id, { changes: ctx.body.changes, redeploy: ctx.body.redeploy === true, actor: actor(ctx) }),
  );
  route('POST', /^\/api\/bots\/([\w-]+)\/rename$/, (ctx, id) =>
    needRuntime().renameBot(id, { name: ctx.body.name, actor: actor(ctx) }),
  );

  // ------------------------------------------------------------------ dispatch

  async function handleApi(req, res, url) {
    const ctx = { req, res, url, ip: clientIp(req), body: {}, cookies: [], session: null };
    const found = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!found) throw new HttpError(404, 'Not found.');

    if (req.method !== 'GET' && req.method !== 'HEAD') guardWrite(req);
    if (found.opts.auth !== false) {
      ctx.session = auth.sessionFrom(req);
      if (!ctx.session) throw new HttpError(401, 'Please sign in.');
    }
    if (found.opts.setup) requireSetup(ctx);
    if (req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readJson(req);

    const params = found.pattern.exec(url.pathname).slice(1);
    const result = await found.fn(ctx, ...params);
    sendJson(res, 200, result === undefined ? { ok: true } : result, ctx.cookies);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Bad path.');
    }
    if (rel === '/') rel = '/index.html';
    if (rel.split('/').some((seg) => seg.startsWith('.'))) throw new HttpError(404, 'Not found.');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    const type = MIME[path.extname(file).toLowerCase()];
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) throw new HttpError(404, 'Not found.');
    fs.readFile(file, (err, data) => {
      if (err) return sendText(res, 404, 'Not found.');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': data.length });
      return res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  async function handler(req, res) {
    const isApi = String(req.url).startsWith('/api/');
    try {
      setSecurityHeaders(res);
      if (!hostAllowed(req)) {
        sendText(res, 421, 'This address is not allowed. Open the dashboard at http://localhost instead.');
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      if (isApi) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      const d = describeError(err);
      if (d.kind === 'internal') console.error(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      if (isApi) {
        const { status, ...error } = d;
        sendJson(res, status, { error });
      } else {
        sendText(res, d.status, d.message);
      }
    }
  }

  function close() {
    if (demo) demo.stop();
  }

  return { handler, close, getConfig: () => cfg };
}

// ---------------------------------------------------------------------------------------

function openBrowser(url) {
  try {
    const opts = { stdio: 'ignore', detached: true };
    let child;
    if (process.platform === 'win32') child = spawn('cmd', ['/c', 'start', '', url], opts);
    else if (process.platform === 'darwin') child = spawn('open', [url], opts);
    else child = spawn('xdg-open', [url], opts);
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the person can open the link by hand */
  }
}

function main() {
  const cfg = loadConfig();
  const app = createApp(cfg);
  const server = http.createServer(app.handler);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${cfg.port} is already in use. Is VOLA Control already running in another window?`);
      console.error('  Close that one, or add PORT=3001 to the .env file and start again.\n');
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  server.listen(cfg.port, cfg.host, () => {
    const shown = LOOPBACK_NAMES.has(cfg.host) || cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
    const url = `http://${shown}:${server.address().port}`;
    const mode = cfg.demo ? 'DEMO (pretend bots, nothing real is touched)' : isConfigured(app.getConfig()) ? 'LIVE' : 'FIRST-TIME SETUP';
    console.log('');
    console.log(`  VOLA Control ${pkg.version}`);
    console.log(`  Mode:  ${mode}`);
    console.log(`  Open:  ${url}`);
    console.log('');
    console.log('  Leave this window open while you use the dashboard. Press Ctrl+C to stop it.');
    console.log('');
    if (cfg.openBrowser) openBrowser(url);
  });

  const shutdown = () => {
    app.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err) => console.error('Unhandled error:', err));
}

if (require.main === module) main();

module.exports = { createApp };
