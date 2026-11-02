'use strict';

const D = require('./documents');
const { RailwayError } = require('./railway');
const { HttpError, describeError } = require('./errors');
const { parseEnv } = require('./config');

// ---------------------------------------------------------------------------------------
// Status handling
// ---------------------------------------------------------------------------------------

/** Railway deployment status -> [our state, label] */
const STATUS = {
  SUCCESS: ['online', 'Online'],
  BUILDING: ['building', 'Building'],
  INITIALIZING: ['deploying', 'Starting'],
  DEPLOYING: ['deploying', 'Starting'],
  QUEUED: ['queued', 'Waiting'],
  WAITING: ['queued', 'Waiting'],
  NEEDS_APPROVAL: ['approval', 'Needs approval'],
  CRASHED: ['crashed', 'Crashed'],
  FAILED: ['failed', 'Failed'],
  REMOVING: ['stopped', 'Stopping'],
  REMOVED: ['stopped', 'Stopped'],
  SLEEPING: ['sleeping', 'Asleep'],
  SKIPPED: ['skipped', 'Skipped'],
};

const IN_FLIGHT = new Set(['building', 'deploying', 'queued', 'approval']);
// Deployments in these raw states are cancelled; running ones are stopped.
const CANCELLABLE_RAW = new Set(['BUILDING', 'INITIALIZING', 'QUEUED', 'WAITING', 'NEEDS_APPROVAL']);

function commitInfo(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) if (typeof meta[k] === 'string' && meta[k]) return meta[k];
    return null;
  };
  const info = {
    message: pick('commitMessage', 'commit_message'),
    hash: pick('commitHash', 'commit_hash', 'commitSha'),
    author: pick('commitAuthor', 'commit_author'),
    branch: pick('branch'),
    reason: pick('reason'),
    image: pick('image'),
  };
  return Object.values(info).some(Boolean) ? info : null;
}

function normalizeDeployment(d) {
  if (!d) return null;
  const [mapped, mappedLabel] = STATUS[d.status] || ['unknown', d.status || 'Unknown'];
  const stopped = d.deploymentStopped === true;
  const state = stopped && !IN_FLIGHT.has(mapped) ? 'stopped' : mapped;
  const label = state === 'stopped' && mapped !== 'stopped' ? 'Stopped' : mappedLabel;
  return {
    id: d.id,
    rawStatus: d.status,
    state,
    label,
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
    since: d.statusUpdatedAt || d.updatedAt || d.createdAt || null,
    canRedeploy: Boolean(d.canRedeploy),
    canRollback: Boolean(d.canRollback),
    stopped,
    inFlight: IN_FLIGHT.has(state),
    url: d.url || d.staticUrl || null,
    commit: commitInfo(d.meta),
  };
}

function capabilities(state) {
  const running = state === 'online';
  const busy = IN_FLIGHT.has(state);
  return {
    start: !running && !busy,
    stop: running || busy || state === 'crashed',
    restart: running || state === 'crashed' || state === 'sleeping',
    redeploy: !busy,
    deployLatest: !busy,
  };
}

function normalizeBot(si, volumes) {
  const deployment = normalizeDeployment(si.latestDeployment);
  const state = deployment ? deployment.state : 'none';
  const label = deployment ? deployment.label : 'No deployment';
  const repo = si.source && si.source.repo ? si.source.repo : null;
  const image = si.source && si.source.image ? si.source.image : null;
  const domains = [
    ...((si.domains && si.domains.serviceDomains) || []),
    ...((si.domains && si.domains.customDomains) || []),
  ]
    .map((d) => d && d.domain)
    .filter(Boolean);

  return {
    id: si.serviceId,
    name: si.serviceName,
    state,
    label,
    since: deployment ? deployment.since : null,
    source: { type: repo ? 'github' : image ? 'docker' : 'none', repo, image },
    deployment,
    activeDeployments: (si.activeDeployments || []).map((d) => ({ id: d.id, rawStatus: d.status })),
    domains,
    startCommand: si.startCommand || null,
    restartPolicy: si.restartPolicyType || null,
    cronSchedule: si.cronSchedule || null,
    numReplicas: si.numReplicas ?? null,
    volumes: volumes || [],
    capabilities: capabilities(state),
  };
}

// ---------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------

// The same words the settings page uses, so an error names the box the person typed in.
const SETTING_NAMES = {
  startCommand: 'Start command',
  buildCommand: 'Build command',
  rootDirectory: 'Folder in the repository',
  healthcheckPath: 'Health check address',
  cronSchedule: 'Timetable',
  restartPolicyType: 'Restart rule',
  restartPolicyMaxRetries: 'Tries before giving up',
  healthcheckTimeout: 'Wait time in seconds',
  numReplicas: 'Copies running at the same time',
  sleepApplication: 'Pause the bot when nothing uses it',
};

const bad = (key, why) => new HttpError(400, `${SETTING_NAMES[key] || key} ${why}.`);

const textRule =
  (max) =>
  (v, key) => {
    if (v === null) return null;
    if (typeof v !== 'string') throw bad(key, 'must be text');
    const t = v.trim();
    if (t.length > max) throw bad(key, `is too long (max ${max} characters)`);
    return t === '' ? null : t;
  };

const intRule =
  (min, max, { nullable = false } = {}) =>
  (v, key) => {
    if (v === null && nullable) return null;
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (!Number.isInteger(n) || n < min || n > max) throw bad(key, `must be a whole number from ${min} to ${max}`);
    return n;
  };

const enumRule = (values) => (v, key) => {
  if (!values.includes(v)) throw bad(key, `must be one of ${values.join(', ')}`);
  return v;
};

const boolRule = (v, key) => {
  if (typeof v !== 'boolean') throw bad(key, 'must be true or false');
  return v;
};

const SETTINGS_RULES = {
  startCommand: textRule(4000),
  buildCommand: textRule(4000),
  rootDirectory: textRule(500),
  healthcheckPath: textRule(500),
  cronSchedule: textRule(100),
  restartPolicyType: enumRule(['ALWAYS', 'NEVER', 'ON_FAILURE']),
  restartPolicyMaxRetries: intRule(0, 10),
  healthcheckTimeout: intRule(1, 3600, { nullable: true }),
  numReplicas: intRule(1, 50),
  sleepApplication: boolRule,
};

function validateSettings(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new HttpError(400, 'Send the settings you want to change.');
  }
  const input = {};
  for (const key of Object.keys(changes)) {
    if (!Object.hasOwn(SETTINGS_RULES, key)) throw new HttpError(400, `"${key}" cannot be changed from here.`);
    input[key] = SETTINGS_RULES[key](changes[key], key);
  }
  if (!Object.keys(input).length) throw new HttpError(400, 'There is nothing to change.');
  return input;
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VAR_VALUE = 32768;

function checkVarName(name) {
  if (typeof name !== 'string' || !VAR_NAME.test(name) || name.length > 255) {
    throw new HttpError(400, 'Variable names can use letters, numbers and underscores, and cannot start with a number.');
  }
  return name;
}

function checkVarValue(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'The value must be text.');
  if (value.length > MAX_VAR_VALUE) throw new HttpError(400, 'That value is too long.');
  return value;
}

const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

function normalizeSeverity(raw, message) {
  const s = String(raw || '').toLowerCase();
  if (s === 'warning') return 'warn';
  if (['info', 'warn', 'error', 'debug'].includes(s)) return s;
  if (/\b(error|exception|fatal|unhandled)\b/i.test(message)) return 'error';
  return 'info';
}

const isReference = (value) => /\$\{\{[^}]+\}\}/.test(String(value ?? ''));
const variableKind = (name, value) => (isReference(value) ? 'reference' : name.startsWith('RAILWAY_') ? 'railway' : 'plain');
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// ---------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------

const ACTIONS = new Set(['start', 'stop', 'restart', 'redeploy', 'deploy-latest', 'cancel', 'remove', 'rollback']);
const BULK_ACTIONS = new Set(['start', 'stop', 'restart', 'redeploy']);
const VOLUME_TTL_MS = 10 * 60 * 1000;

/** Only "Railway said no" errors may fall back to another way of doing the same thing. */
const isFallbackable = (err) => err instanceof RailwayError && err.kind === 'graphql';

function createBots({ railway, projectId = '', environmentId = '', pollSeconds = 30, activity, now = Date.now }) {
  const ids = { projectId, environmentId };
  const pollMs = pollSeconds * 1000;
  let cache = { data: null, at: 0 };
  let inflight = null;
  let cooldownUntil = 0;
  let volumes = { map: new Map(), at: 0 };
  const busy = new Set();

  const invalidate = () => {
    cache.at = 0;
  };

  async function ensureIds() {
    if (ids.projectId && ids.environmentId) return;
    if (railway.mode !== 'project') {
      throw new HttpError(500, 'The project ID and environment ID are missing. Add them in Settings, then Connection.');
    }
    const data = await railway.request(D.ProjectToken, {});
    ids.projectId = data.projectToken.projectId;
    ids.environmentId = data.projectToken.environmentId;
  }

  async function getVolumes() {
    if (now() - volumes.at < VOLUME_TTL_MS) return volumes.map;
    volumes.at = now(); // also on failure, so a missing permission is not retried every poll
    try {
      const data = await railway.request(D.Volumes, { projectId: ids.projectId, environmentId: ids.environmentId });
      const map = new Map();
      for (const ie of (data.environment && data.environment.volumeInstances && data.environment.volumeInstances.edges) || []) {
        const vi = ie.node;
        if (!vi || !vi.serviceId) continue;
        const list = map.get(vi.serviceId) || [];
        list.push({
          name: (vi.volume && vi.volume.name) || 'volume',
          mountPath: vi.mountPath,
          usedMB: vi.currentSizeMB,
          sizeMB: vi.sizeMB,
          state: vi.state,
        });
        map.set(vi.serviceId, list);
      }
      volumes.map = map;
    } catch {
      /* volumes are a nice-to-have; keep whatever we had */
    }
    return volumes.map;
  }

  async function fetchOverview() {
    await ensureIds();
    const data = await railway.request(D.Overview, { projectId: ids.projectId, environmentId: ids.environmentId });
    if (!data || !data.environment) {
      throw new RailwayError('Railway did not return this environment. Check the environment ID.', { kind: 'graphql' });
    }
    const vols = await getVolumes();
    const edges = (data.environment.serviceInstances && data.environment.serviceInstances.edges) || [];
    const bots = edges
      .map((e) => e.node)
      .filter((si) => si && !si.deletedAt)
      .map((si) => normalizeBot(si, vols.get(si.serviceId)))
      .sort(byName);
    return {
      project: { id: ids.projectId, name: (data.project && data.project.name) || 'Railway project' },
      environment: { id: ids.environmentId, name: data.environment.name },
      bots,
      fetchedAt: new Date(now()).toISOString(),
      stale: false,
      error: null,
    };
  }

  const decorate = (data) => ({ ...data, rate: railway.getRate(), pollSeconds });

  async function getOverview({ force = false, maxAgeMs } = {}) {
    const limit = maxAgeMs ?? Math.max(2000, pollMs - 1000);
    if (!force && cache.data && now() - cache.at < limit) return decorate(cache.data);

    if (!force && cache.data && now() < cooldownUntil) {
      const wait = Math.ceil((cooldownUntil - now()) / 1000);
      return decorate({
        ...cache.data,
        stale: true,
        error: describeError(new RailwayError('rate limit', { kind: 'rate', retryAfter: wait })),
      });
    }

    if (force && inflight) {
      try {
        await inflight;
      } catch {
        /* we start our own below */
      }
    }
    if (!inflight) {
      inflight = fetchOverview()
        .then((data) => {
          cache = { data, at: now() };
          return data;
        })
        .finally(() => {
          inflight = null;
        });
    }
    try {
      return decorate(await inflight);
    } catch (err) {
      if (err instanceof RailwayError && err.kind === 'rate') cooldownUntil = now() + err.retryAfter * 1000;
      if (cache.data) return decorate({ ...cache.data, stale: true, error: describeError(err) });
      throw err;
    }
  }

  async function findBot(botId, opts = { maxAgeMs: 5000 }) {
    if (!/^[\w-]{1,64}$/.test(String(botId))) throw new HttpError(404, 'That bot was not found.');
    const ov = await getOverview(opts);
    const bot = ov.bots.find((b) => b.id === botId);
    if (!bot) throw new HttpError(404, 'That bot was not found in this environment.');
    return bot;
  }

  // -- Deployments ----------------------------------------------------------------------

  async function listDeploymentsFor(bot, limit = 20) {
    const data = await railway.request(D.Deployments, {
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      serviceId: bot.id,
      first: clampInt(limit, 1, 50, 20),
    });
    const active = new Set(bot.activeDeployments.map((d) => d.id));
    return ((data.deployments && data.deployments.edges) || []).map((e) => ({
      ...normalizeDeployment(e.node),
      isActive: active.has(e.node.id),
    }));
  }

  async function listDeployments(botId, { limit } = {}) {
    const bot = await findBot(botId);
    return { deployments: await listDeploymentsFor(bot, limit) };
  }

  async function ownedDeployment(bot, deploymentId) {
    if (!/^[\w-]{8,64}$/.test(String(deploymentId || ''))) throw new HttpError(400, 'Choose a deployment first.');
    const found = (await listDeploymentsFor(bot, 50)).find((d) => d.id === deploymentId);
    if (!found) throw new HttpError(404, 'That deployment does not belong to this bot (or is too old to manage here).');
    return found;
  }

  // -- Actions --------------------------------------------------------------------------

  async function firstThatWorks(attempts) {
    let firstErr = null;
    for (const [label, fn] of attempts) {
      try {
        await fn();
        return label;
      } catch (err) {
        if (!isFallbackable(err)) throw err;
        firstErr = firstErr || err;
      }
    }
    throw firstErr;
  }

  const redeployAttempts = (bot) => {
    const sid = { serviceId: bot.id, environmentId: ids.environmentId };
    const attempts = [['redeploy', () => railway.request(D.ServiceInstanceRedeploy, sid)]];
    if (bot.deployment) {
      attempts.push(['redeploy of the last deployment', () => railway.request(D.DeploymentRedeploy, { id: bot.deployment.id })]);
    }
    attempts.push(['deploy of the latest commit', () => railway.request(D.ServiceInstanceDeploy, sid)]);
    return attempts;
  };

  async function doAction(bot, action, deploymentId) {
    const sid = { serviceId: bot.id, environmentId: ids.environmentId };

    switch (action) {
      case 'restart': {
        const target = (bot.activeDeployments[0] && bot.activeDeployments[0].id) || (bot.deployment && bot.deployment.id);
        if (target) {
          try {
            await railway.request(D.DeploymentRestart, { id: target });
            return { method: 'restart', message: `${bot.name} is restarting.` };
          } catch (err) {
            if (!isFallbackable(err)) throw err;
          }
        }
        await firstThatWorks(redeployAttempts(bot));
        return {
          method: 'redeploy',
          message: `${bot.name} could not be restarted in place, so it is being redeployed instead.`,
        };
      }

      case 'redeploy':
        await firstThatWorks(redeployAttempts(bot));
        return { method: 'redeploy', message: `${bot.name} is being redeployed.` };

      case 'start':
        await firstThatWorks(redeployAttempts(bot));
        return { method: 'start', message: `${bot.name} is starting.` };

      case 'deploy-latest':
        await railway.request(D.ServiceInstanceDeploy, sid);
        return { method: 'deploy-latest', message: `Deploying the latest commit of ${bot.name}.` };

      case 'stop': {
        const targets = new Map();
        for (const d of bot.activeDeployments) targets.set(d.id, d.rawStatus);
        if (bot.deployment && bot.deployment.inFlight) targets.set(bot.deployment.id, bot.deployment.rawStatus);
        if (!targets.size && bot.deployment) targets.set(bot.deployment.id, bot.deployment.rawStatus);
        if (!targets.size) throw new HttpError(409, 'There is nothing running to stop.');
        let done = 0;
        const failures = [];
        for (const [id, raw] of targets) {
          try {
            await railway.request(CANCELLABLE_RAW.has(raw) ? D.DeploymentCancel : D.DeploymentStop, { id });
            done += 1;
          } catch (err) {
            if (!isFallbackable(err)) throw err;
            failures.push(err);
          }
        }
        if (!done) throw failures[0];
        return { method: 'stop', message: `${bot.name} is being stopped.` };
      }

      case 'cancel': {
        const dep = await ownedDeployment(bot, deploymentId);
        if (!dep.inFlight) throw new HttpError(409, 'Only a deployment that is still building can be cancelled.');
        await railway.request(D.DeploymentCancel, { id: dep.id });
        return { method: 'cancel', message: 'The deployment was cancelled.' };
      }

      case 'remove': {
        const dep = await ownedDeployment(bot, deploymentId);
        await railway.request(D.DeploymentRemove, { id: dep.id });
        return { method: 'remove', message: 'The deployment was removed.' };
      }

      case 'rollback': {
        const dep = await ownedDeployment(bot, deploymentId);
        if (!dep.canRollback) throw new HttpError(409, 'Railway says this deployment cannot be rolled back to.');
        await railway.request(D.DeploymentRollback, { id: dep.id });
        return { method: 'rollback', message: `Rolling ${bot.name} back to that deployment.` };
      }

      default:
        throw new HttpError(400, 'Unknown action.');
    }
  }

  async function runAction(botId, action, { deploymentId, actor } = {}) {
    if (!ACTIONS.has(action)) throw new HttpError(400, 'Unknown action.');
    if (busy.has(botId)) throw new HttpError(409, 'Another action is still running for this bot. Give it a moment.');
    busy.add(botId);
    let bot = null;
    try {
      bot = await findBot(botId);
      const result = await doAction(bot, action, deploymentId);
      activity.add({ actor, bot: bot.name, action, ok: true, message: result.message });
      invalidate();
      return { ok: true, action, bot: bot.name, ...result };
    } catch (err) {
      activity.add({ actor, bot: (bot && bot.name) || String(botId), action, ok: false, message: describeError(err).message });
      throw err;
    } finally {
      busy.delete(botId);
    }
  }

  async function runBulk(action, botIds, { actor } = {}) {
    if (!BULK_ACTIONS.has(action)) throw new HttpError(400, 'That action is not available for all bots at once.');
    const ov = await getOverview({ maxAgeMs: 5000 });
    const wanted = Array.isArray(botIds) && botIds.length ? new Set(botIds) : null;
    const targets = ov.bots.filter((b) => !wanted || wanted.has(b.id));
    const results = [];
    for (const bot of targets) {
      const c = bot.capabilities;
      const applicable = { start: c.start, stop: c.stop, restart: c.restart, redeploy: c.redeploy }[action];
      if (!applicable) {
        results.push({ id: bot.id, name: bot.name, ok: true, skipped: true, message: 'Skipped, nothing to do right now.' });
        continue;
      }
      try {
        const r = await runAction(bot.id, action, { actor });
        results.push({ id: bot.id, name: bot.name, ok: true, message: r.message });
      } catch (err) {
        const d = describeError(err);
        results.push({ id: bot.id, name: bot.name, ok: false, message: d.message });
        if (d.kind === 'railway_rate' || d.kind === 'railway_auth' || d.kind === 'railway_network') break;
      }
    }
    return { results };
  }

  // -- Logs -----------------------------------------------------------------------------

  async function getLogs(botId, { kind = 'deploy', deploymentId, limit = 200 } = {}) {
    const bot = await findBot(botId);
    const wantBuild = kind === 'build';
    let target = deploymentId;
    if (target) {
      await ownedDeployment(bot, target);
    } else if (!wantBuild && bot.deployment && bot.deployment.inFlight && bot.activeDeployments[0]) {
      target = bot.activeDeployments[0].id; // a new build is running: show what is serving right now
    } else {
      target = bot.deployment && bot.deployment.id;
    }
    if (!target) return { deploymentId: null, kind: wantBuild ? 'build' : 'deploy', lines: [], fetchedAt: new Date(now()).toISOString() };

    const data = await railway.request(wantBuild ? D.BuildLogs : D.DeploymentLogs, {
      deploymentId: target,
      limit: clampInt(limit, 10, 1000, 200),
    });
    const raw = (wantBuild ? data.buildLogs : data.deploymentLogs) || [];
    const lines = raw
      .map((l) => {
        const message = stripAnsi(String(l.message ?? ''));
        return { ts: l.timestamp, severity: normalizeSeverity(l.severity, message), message };
      })
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    return { deploymentId: target, kind: wantBuild ? 'build' : 'deploy', lines, fetchedAt: new Date(now()).toISOString() };
  }

  // -- Variables ------------------------------------------------------------------------

  async function readVariables(bot, rendered) {
    if (rendered) {
      const data = await railway.request(D.VariablesRendered, { ...ids, serviceId: bot.id });
      return data.variablesForServiceDeployment || {};
    }
    const data = await railway.request(D.Variables, { ...ids, serviceId: bot.id, unrendered: true });
    return data.variables || {};
  }

  async function listVariables(botId, { rendered = false } = {}) {
    const bot = await findBot(botId);
    const vars = await readVariables(bot, rendered);
    const variables = Object.entries(vars)
      .map(([name, value]) => ({ name, length: String(value ?? '').length, kind: variableKind(name, value) }))
      .sort(byName);
    return { variables, count: variables.length, rendered };
  }

  async function revealVariables(botId, { names, rendered = false, actor } = {}) {
    const bot = await findBot(botId);
    const vars = await readVariables(bot, rendered);
    const wanted = Array.isArray(names) && names.length ? names : Object.keys(vars);
    const values = {};
    for (const n of wanted) if (Object.hasOwn(vars, n)) values[n] = String(vars[n] ?? '');
    activity.add({
      actor,
      bot: bot.name,
      action: 'show-variables',
      ok: true,
      message: Array.isArray(names) && names.length ? `Showed ${names.join(', ')}` : `Showed all ${wanted.length} variables`,
    });
    return { values };
  }

  async function setVariable(botId, { name, value, redeploy = true, actor } = {}) {
    checkVarName(name);
    checkVarValue(value);
    const bot = await findBot(botId);
    await railway.request(D.VariableUpsert, {
      input: { ...ids, serviceId: bot.id, name, value, skipDeploys: !redeploy },
    });
    activity.add({
      actor,
      bot: bot.name,
      action: 'set-variable',
      ok: true,
      message: `Saved ${name}${redeploy ? ' (redeploying)' : ' (no redeploy yet)'}`,
    });
    invalidate();
    return { ok: true, redeployed: Boolean(redeploy) };
  }

  async function deleteVariable(botId, { name, redeploy = true, actor } = {}) {
    checkVarName(name);
    const bot = await findBot(botId);
    await railway.request(D.VariableDelete, { input: { ...ids, serviceId: bot.id, name } });
    activity.add({ actor, bot: bot.name, action: 'delete-variable', ok: true, message: `Deleted ${name}` });
    invalidate();
    // variableDelete has no skipDeploys flag; redeploy on request so the bot picks the change up
    if (redeploy) await firstThatWorks(redeployAttempts(bot));
    return { ok: true, redeployed: Boolean(redeploy) };
  }

  async function importVariables(botId, { text, redeploy = true, actor } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Paste some KEY=value lines first.');
    if (text.length > 200000) throw new HttpError(400, 'That is too much text to import at once.');
    const parsed = parseEnv(text.replace(/^\s*export\s+/gm, ''));
    const names = Object.keys(parsed);
    if (!names.length) throw new HttpError(400, 'No KEY=value lines were found.');
    if (names.length > 300) throw new HttpError(400, 'Too many variables in one go (max 300).');
    const variables = {};
    for (const n of names) {
      checkVarName(n);
      variables[n] = checkVarValue(parsed[n]);
    }
    const bot = await findBot(botId);
    await railway.request(D.VariableBulk, {
      input: { ...ids, serviceId: bot.id, variables, replace: false, skipDeploys: !redeploy },
    });
    activity.add({
      actor,
      bot: bot.name,
      action: 'import-variables',
      ok: true,
      message: `Imported ${names.length} variable(s): ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', ...' : ''}`,
    });
    invalidate();
    return { ok: true, count: names.length, names, redeployed: Boolean(redeploy) };
  }

  // -- Settings -------------------------------------------------------------------------

  async function getSettings(botId) {
    const bot = await findBot(botId);
    const data = await railway.request(D.ServiceInstanceDetail, { serviceId: bot.id, environmentId: ids.environmentId });
    const si = data.serviceInstance || {};
    return {
      name: bot.name,
      source: bot.source,
      builder: si.builder || null,
      region: si.region || null,
      dockerfilePath: si.dockerfilePath || null,
      settings: {
        startCommand: si.startCommand || '',
        buildCommand: si.buildCommand || '',
        rootDirectory: si.rootDirectory || '',
        restartPolicyType: si.restartPolicyType || 'ON_FAILURE',
        restartPolicyMaxRetries: si.restartPolicyMaxRetries ?? 10,
        healthcheckPath: si.healthcheckPath || '',
        healthcheckTimeout: si.healthcheckTimeout ?? null,
        numReplicas: si.numReplicas ?? 1,
        cronSchedule: si.cronSchedule || '',
        sleepApplication: Boolean(si.sleepApplication),
      },
    };
  }

  async function updateSettings(botId, { changes, redeploy = false, actor } = {}) {
    const input = validateSettings(changes);
    const bot = await findBot(botId);
    await railway.request(D.ServiceInstanceUpdate, { serviceId: bot.id, environmentId: ids.environmentId, input });
    const fields = Object.keys(input);
    if (redeploy) await firstThatWorks(redeployAttempts(bot));
    activity.add({
      actor,
      bot: bot.name,
      action: 'change-settings',
      ok: true,
      message: `Changed ${fields.join(', ')}${redeploy ? ' and redeployed' : ''}`,
    });
    invalidate();
    return { ok: true, applied: fields, redeployed: Boolean(redeploy) };
  }

  async function renameBot(botId, { name, actor } = {}) {
    const clean = typeof name === 'string' ? name.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (!clean || clean.length > 64 || /[\u0000-\u001f]/.test(clean)) {
      throw new HttpError(400, 'Give the bot a name between 1 and 64 characters.');
    }
    const bot = await findBot(botId);
    if (clean === bot.name) return { ok: true, name: clean };
    await railway.request(D.ServiceRename, { id: bot.id, input: { name: clean } });
    activity.add({ actor, bot: bot.name, action: 'rename', ok: true, message: `Renamed to ${clean}` });
    invalidate();
    return { ok: true, name: clean };
  }

  return {
    getOverview,
    findBot,
    runAction,
    runBulk,
    listDeployments,
    getLogs,
    listVariables,
    revealVariables,
    setVariable,
    deleteVariable,
    importVariables,
    getSettings,
    updateSettings,
    renameBot,
    getIds: () => ({ ...ids }),
    invalidate,
  };
}

module.exports = {
  createBots,
  validateSettings,
  normalizeBot,
  normalizeDeployment,
  capabilities,
  stripAnsi,
  normalizeSeverity,
};
