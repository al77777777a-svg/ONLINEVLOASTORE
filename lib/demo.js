'use strict';

/**
 * Demo mode: a pretend Railway that answers the same GraphQL documents the real one does,
 * entirely in memory. It lets you click every button without touching real bots, and it is what
 * the automated tests run against. Nothing here ever leaves your computer.
 *
 * Try this: the "bc" bot starts crashed because its DISCORD_TOKEN is a placeholder. Change that
 * variable to anything else, redeploy, and the bot comes back online.
 */

const crypto = require('node:crypto');

const TOKEN = 'demo-token';
const RATE_LIMIT = 1000;

class Fail extends Error {}

function createDemo({ speed = 1 } = {}) {
  const T = (ms) => Math.max(5, Math.round(ms / speed));
  const uuid = () => crypto.randomUUID();
  const iso = (t = Date.now()) => new Date(t).toISOString();

  const project = { id: 'demo-project', name: 'VOLA STORE (demo)' };
  const environment = { id: 'demo-environment', name: 'production' };
  const ids = { projectId: project.id, environmentId: environment.id };

  let requests = 0;
  const windowEnd = Date.now() + 3600 * 1000;
  const timers = new Set();
  let services = [];

  function later(ms, fn) {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, T(ms));
    t.unref();
    timers.add(t);
  }

  // ------------------------------------------------------------------ data

  const SEEDS = [
    {
      name: 'vola-store-payment',
      state: 'SUCCESS',
      start: 'node src/index.js',
      commit: 'Retry failed webhook deliveries',
      ageMs: 3 * 3600e3,
      domain: 'vola-store-payment-production.up.railway.app',
      pool: ['Payment webhook received', 'Order marked as paid', 'Receipt sent to customer'],
    },
    {
      name: 'reaicovola',
      state: 'SUCCESS',
      start: 'npm start',
      commit: 'Add /status command',
      ageMs: 26 * 3600e3,
      pool: ['Command /status used', 'Cache refreshed', 'Presence updated'],
    },
    {
      name: 'VOLA-STORE-Welcome',
      state: 'SUCCESS',
      start: 'node index.js',
      commit: 'New welcome embed',
      ageMs: 5 * 86400e3,
      pool: ['Sent welcome message to a new member', 'Assigned starter role', 'Member count updated'],
    },
    {
      name: 'bc',
      state: 'CRASHED',
      start: 'node bot.js',
      commit: 'Update dependencies',
      ageMs: 40 * 60e3,
      bad: true,
      pool: ['Broadcast queued', 'Broadcast delivered'],
    },
    {
      name: 'vola-store-ticket',
      state: 'SUCCESS',
      start: 'node src/main.js',
      commit: 'Fix ticket transcript export',
      ageMs: 2 * 86400e3,
      domain: 'vola-store-ticket-production.up.railway.app',
      volume: { name: 'vola-store-ticket-volume', mountPath: '/data', size: 5000, used: 312 },
      pool: ['Ticket opened', 'Ticket closed, transcript saved', 'Staff replied in ticket'],
    },
  ];

  function pushLog(list, severity, message, at = Date.now()) {
    list.push({ timestamp: iso(at), message, severity });
    if (list.length > 600) list.splice(0, list.length - 600);
  }

  const runtimeLog = (dep, severity, message, at) => pushLog(dep.logs, severity, message, at);
  const buildLog = (dep, message, at) => pushLog(dep.buildLogs, 'info', message, at);

  function newDeployment(svc, status, { commit, ageMs = 0, reason = 'deploy' } = {}) {
    const created = Date.now() - ageMs;
    return {
      id: uuid(),
      status,
      createdAt: iso(created),
      updatedAt: iso(created),
      statusUpdatedAt: iso(created),
      stopped: false,
      hidden: false,
      meta: {
        branch: svc.branch,
        commitMessage: commit,
        commitHash: crypto.randomBytes(20).toString('hex'),
        commitAuthor: 'demo-user',
        repo: svc.repo,
        reason,
      },
      logs: [],
      buildLogs: [],
    };
  }

  function seedBuildLogs(dep, at) {
    const lines = [
      'Using Railpack to build the project',
      'Detected Node.js application',
      'Installing dependencies with npm ci',
      'added 214 packages in 6s',
      'Build time: 12.4 seconds',
      'Pushing image to registry',
    ];
    lines.forEach((l, i) => buildLog(dep, l, at + i * 1500));
  }

  function makeService(seed) {
    const slug = seed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const svc = {
      id: `svc-${slug}`,
      name: seed.name,
      repo: `demo-org/${slug}`,
      branch: 'main',
      domain: seed.domain || null,
      volume: seed.volume || null,
      pool: seed.pool,
      instance: {
        startCommand: seed.start,
        buildCommand: 'npm ci',
        rootDirectory: null,
        restartPolicyType: 'ON_FAILURE',
        restartPolicyMaxRetries: 10,
        healthcheckPath: null,
        healthcheckTimeout: null,
        numReplicas: 1,
        cronSchedule: null,
        sleepApplication: false,
        builder: 'RAILPACK',
        region: 'europe-west4-drams3a',
        dockerfilePath: null,
      },
      variables: {
        NODE_ENV: 'production',
        DISCORD_TOKEN: seed.bad ? 'demo_bad_token_replace_me' : `demo_token_not_a_real_secret_${seed.name.length}`,
        GUILD_ID: '1000000000000000000',
        LOG_LEVEL: 'info',
        DATABASE_URL: '${{Postgres.DATABASE_URL}}',
      },
      deployments: [],
    };

    const older = [
      ['Tweak embed colours', 9 * 86400e3],
      ['Refactor command loader', 6 * 86400e3],
    ];
    for (const [commit, age] of older) {
      const d = newDeployment(svc, 'REMOVED', { commit, ageMs: seed.ageMs + age });
      seedBuildLogs(d, Date.parse(d.createdAt));
      svc.deployments.push(d);
    }
    const current = newDeployment(svc, seed.state, { commit: seed.commit, ageMs: seed.ageMs });
    seedBuildLogs(current, Date.parse(current.createdAt));
    const t0 = Date.parse(current.createdAt) + 9000;
    if (seed.bad) {
      runtimeLog(current, 'info', `Starting ${seed.start}`, t0);
      runtimeLog(current, 'error', 'DiscordAPIError[40001]: An invalid token was provided', t0 + 1500);
      runtimeLog(current, 'error', `    at ${svc.name}/src/client.js:42:11`, t0 + 1501);
      runtimeLog(current, 'error', 'Process exited with code 1. Restart policy gave up after 10 retries.', t0 + 1600);
    } else {
      runtimeLog(current, 'info', `Starting ${seed.start}`, t0);
      runtimeLog(current, 'info', `Logged in as ${seed.name}#0001`, t0 + 1500);
      for (let i = 0; i < 14; i += 1) {
        const text = seed.pool[i % seed.pool.length];
        runtimeLog(current, i % 6 === 5 ? 'warn' : 'info', text, Date.now() - (14 - i) * 41000);
      }
    }
    svc.deployments.unshift(current);
    return svc;
  }

  function reset() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    services = SEEDS.map(makeService);
  }
  reset();

  // ------------------------------------------------------------------ behaviour

  function setStatus(dep, status) {
    dep.status = status;
    dep.statusUpdatedAt = iso();
    dep.updatedAt = dep.statusUpdatedAt;
  }

  const isBad = (svc) => String(svc.variables.DISCORD_TOKEN || '').startsWith('demo_bad');

  function finishBoot(svc, dep) {
    if (dep.status !== 'DEPLOYING') return; // cancelled or stopped meanwhile
    if (isBad(svc)) {
      runtimeLog(dep, 'error', 'DiscordAPIError[40001]: An invalid token was provided');
      runtimeLog(dep, 'error', 'Process exited with code 1');
      setStatus(dep, 'CRASHED');
      return;
    }
    runtimeLog(dep, 'info', `Logged in as ${svc.name}#0001`);
    runtimeLog(dep, 'info', 'Ready!');
    setStatus(dep, 'SUCCESS');
    for (const other of svc.deployments) {
      if (other !== dep && other.status === 'SUCCESS') {
        setStatus(other, 'REMOVED');
      }
    }
  }

  function boot(svc, dep) {
    setStatus(dep, 'DEPLOYING');
    runtimeLog(dep, 'info', `Starting ${svc.instance.startCommand || 'the default start command'}`);
    later(2000, () => finishBoot(svc, dep));
  }

  function deploy(svc, reason, commit) {
    const latest = svc.deployments[0];
    const dep = newDeployment(svc, 'BUILDING', {
      commit: commit || (latest && latest.meta.commitMessage) || 'Manual deploy',
      reason,
    });
    svc.deployments.unshift(dep);
    buildLog(dep, 'Using Railpack to build the project');
    later(3000, () => {
      if (dep.status !== 'BUILDING') return;
      ['Installing dependencies with npm ci', 'Build time: 11.8 seconds', 'Pushing image to registry'].forEach((l) => buildLog(dep, l));
      boot(svc, dep);
    });
    return dep;
  }

  function restart(svc, dep) {
    boot(svc, dep);
  }

  // Idle chatter so the log view looks alive.
  const ticker = setInterval(() => {
    for (const svc of services) {
      const dep = svc.deployments[0];
      if (dep && dep.status === 'SUCCESS' && Math.random() < 0.5) {
        runtimeLog(dep, 'info', svc.pool[Math.floor(Math.random() * svc.pool.length)]);
      }
    }
  }, T(4000));
  ticker.unref();

  // ------------------------------------------------------------------ GraphQL shapes

  const depShape = (svc, dep) => ({
    id: dep.id,
    status: dep.status,
    createdAt: dep.createdAt,
    updatedAt: dep.updatedAt,
    statusUpdatedAt: dep.statusUpdatedAt,
    deploymentStopped: dep.stopped,
    canRedeploy: true,
    canRollback: svc.deployments.indexOf(dep) > 0 && ['SUCCESS', 'REMOVED'].includes(dep.status) && !dep.stopped,
    url: null,
    staticUrl: null,
    meta: dep.meta,
  });

  const visible = (svc) => svc.deployments.filter((d) => !d.hidden);

  const instanceShape = (svc) => ({
    id: `si-${svc.id}`,
    serviceId: svc.id,
    serviceName: svc.name,
    deletedAt: null,
    source: { repo: svc.repo, image: null },
    startCommand: svc.instance.startCommand,
    restartPolicyType: svc.instance.restartPolicyType,
    cronSchedule: svc.instance.cronSchedule,
    numReplicas: svc.instance.numReplicas,
    domains: {
      serviceDomains: svc.domain ? [{ domain: svc.domain }] : [],
      customDomains: [],
    },
    latestDeployment: visible(svc)[0] ? depShape(svc, visible(svc)[0]) : null,
    activeDeployments: visible(svc)
      .filter((d) => d.status === 'SUCCESS')
      .map((d) => ({ id: d.id, status: d.status, createdAt: d.createdAt })),
  });

  function needIds(v) {
    if (v.projectId !== ids.projectId || v.environmentId !== ids.environmentId) throw new Fail('Not Authorized');
  }

  // Some Railway mutations (redeploy, deploy, update settings) take only a service and an environment.
  function needEnv(v) {
    if (v.environmentId !== ids.environmentId) throw new Fail('Not Authorized');
  }

  function svcById(id) {
    const svc = services.find((s) => s.id === id);
    if (!svc) throw new Fail('Service not found');
    return svc;
  }

  function depById(id) {
    for (const svc of services) {
      const dep = svc.deployments.find((d) => d.id === id);
      if (dep) return [svc, dep];
    }
    throw new Fail('Deployment not found');
  }

  const rendered = (svc) => {
    const out = {};
    for (const [k, v] of Object.entries(svc.variables)) {
      out[k] = String(v).replace(/\$\{\{[^}]+\}\}/g, 'postgresql://demo:demo@localhost:5432/demo');
    }
    return {
      ...out,
      RAILWAY_ENVIRONMENT_NAME: environment.name,
      RAILWAY_PROJECT_ID: project.id,
      RAILWAY_SERVICE_NAME: svc.name,
    };
  };

  const handlers = {
    ProjectToken: () => ({ projectToken: { projectId: ids.projectId, environmentId: ids.environmentId } }),

    Overview: (v) => {
      needIds(v);
      return {
        project: { id: project.id, name: project.name },
        environment: {
          id: environment.id,
          name: environment.name,
          serviceInstances: { edges: services.map((svc) => ({ node: instanceShape(svc) })) },
        },
      };
    },

    Volumes: (v) => {
      needIds(v);
      return {
        environment: {
          volumeInstances: {
            edges: services
              .filter((s) => s.volume)
              .map((s) => ({
                node: {
                  id: `vi-${s.id}`,
                  serviceId: s.id,
                  mountPath: s.volume.mountPath,
                  currentSizeMB: s.volume.used,
                  sizeMB: s.volume.size,
                  state: 'READY',
                  volume: { id: `vol-${s.id}`, name: s.volume.name },
                },
              })),
          },
        },
      };
    },

    ServiceInstanceDetail: (v) => {
      needEnv(v);
      const svc = svcById(v.serviceId);
      const i = svc.instance;
      return {
        serviceInstance: {
          id: `si-${svc.id}`,
          serviceId: svc.id,
          serviceName: svc.name,
          source: { repo: svc.repo, image: null },
          builder: i.builder,
          buildCommand: i.buildCommand,
          startCommand: i.startCommand,
          rootDirectory: i.rootDirectory,
          dockerfilePath: i.dockerfilePath,
          cronSchedule: i.cronSchedule,
          healthcheckPath: i.healthcheckPath,
          healthcheckTimeout: i.healthcheckTimeout,
          restartPolicyType: i.restartPolicyType,
          restartPolicyMaxRetries: i.restartPolicyMaxRetries,
          numReplicas: i.numReplicas,
          region: i.region,
          sleepApplication: i.sleepApplication,
        },
      };
    },

    Deployments: (v) => {
      needIds(v);
      const svc = svcById(v.serviceId);
      return {
        deployments: {
          edges: visible(svc)
            .slice(0, v.first || 20)
            .map((d) => ({ node: depShape(svc, d) })),
        },
      };
    },

    DeploymentLogs: (v) => {
      const [, dep] = depById(v.deploymentId);
      return { deploymentLogs: dep.logs.slice(-(v.limit || 200)) };
    },

    BuildLogs: (v) => {
      const [, dep] = depById(v.deploymentId);
      return { buildLogs: dep.buildLogs.slice(-(v.limit || 200)) };
    },

    Variables: (v) => {
      needIds(v);
      return { variables: { ...svcById(v.serviceId).variables } };
    },

    VariablesRendered: (v) => {
      needIds(v);
      return { variablesForServiceDeployment: rendered(svcById(v.serviceId)) };
    },

    VariableUpsert: ({ input }) => {
      needIds(input);
      const svc = svcById(input.serviceId);
      if (input.name === 'FAIL_ME') throw new Fail('Demo: simulated Railway error');
      svc.variables[input.name] = input.value;
      if (!input.skipDeploys) deploy(svc, 'variable change');
      return { variableUpsert: true };
    },

    VariableDelete: ({ input }) => {
      needIds(input);
      const svc = svcById(input.serviceId);
      if (!Object.hasOwn(svc.variables, input.name)) throw new Fail('Variable not found');
      delete svc.variables[input.name];
      return { variableDelete: true };
    },

    VariableBulk: ({ input }) => {
      needIds(input);
      const svc = svcById(input.serviceId);
      Object.assign(svc.variables, input.variables);
      if (!input.skipDeploys) deploy(svc, 'variable change');
      return { variableCollectionUpsert: true };
    },

    DeploymentRestart: ({ id }) => {
      const [svc, dep] = depById(id);
      if (!['SUCCESS', 'DEPLOYING'].includes(dep.status)) {
        throw new Fail(`Deployment cannot be restarted while it is ${dep.status}`);
      }
      restart(svc, dep);
      return { deploymentRestart: true };
    },

    DeploymentStop: ({ id }) => {
      const [, dep] = depById(id);
      if (!['SUCCESS', 'DEPLOYING', 'CRASHED'].includes(dep.status)) {
        throw new Fail(`Deployment cannot be stopped while it is ${dep.status}`);
      }
      dep.stopped = true;
      setStatus(dep, 'REMOVED');
      runtimeLog(dep, 'info', 'Stopping container (requested from the dashboard)');
      return { deploymentStop: true };
    },

    DeploymentCancel: ({ id }) => {
      const [, dep] = depById(id);
      if (!['BUILDING', 'QUEUED', 'INITIALIZING', 'WAITING'].includes(dep.status)) {
        throw new Fail(`Deployment cannot be cancelled while it is ${dep.status}`);
      }
      setStatus(dep, 'REMOVED');
      return { deploymentCancel: true };
    },

    DeploymentRemove: ({ id }) => {
      const [, dep] = depById(id);
      setStatus(dep, 'REMOVED');
      dep.stopped = true;
      dep.hidden = true;
      return { deploymentRemove: true };
    },

    DeploymentRollback: ({ id }) => {
      const [svc, dep] = depById(id);
      if (!depShape(svc, dep).canRollback) throw new Fail('Deployment cannot be rolled back');
      deploy(svc, 'rollback', dep.meta.commitMessage);
      return { deploymentRollback: true };
    },

    DeploymentRedeploy: ({ id }) => {
      const [svc] = depById(id);
      const dep = deploy(svc, 'redeploy');
      return { deploymentRedeploy: { id: dep.id, status: dep.status } };
    },

    ServiceInstanceRedeploy: (v) => {
      needEnv(v);
      deploy(svcById(v.serviceId), 'redeploy');
      return { serviceInstanceRedeploy: true };
    },

    ServiceInstanceDeploy: (v) => {
      needEnv(v);
      const dep = deploy(svcById(v.serviceId), 'deploy', 'Latest commit from main');
      return { serviceInstanceDeployV2: dep.id };
    },

    ServiceInstanceUpdate: (v) => {
      needEnv(v);
      const svc = svcById(v.serviceId);
      for (const [k, val] of Object.entries(v.input)) {
        if (!Object.hasOwn(svc.instance, k)) throw new Fail(`Unknown setting ${k}`);
        svc.instance[k] = val;
      }
      return { serviceInstanceUpdate: true };
    },

    ServiceRename: ({ id, input }) => {
      const svc = svcById(id);
      svc.name = input.name;
      return { serviceUpdate: { id: svc.id, name: svc.name } };
    },
  };

  // ------------------------------------------------------------------ transport

  async function transport({ body, headers }) {
    requests += 1;
    const h = new Headers({
      'content-type': 'application/json',
      'x-ratelimit-limit': String(RATE_LIMIT),
      'x-ratelimit-remaining': String(Math.max(0, RATE_LIMIT - requests)),
      'x-ratelimit-reset': String(Math.floor(windowEnd / 1000)),
    });
    const reply = (json, status = 200) => ({ status, headers: h, json, text: JSON.stringify(json) });

    const token = headers['Project-Access-Token'] || String(headers.Authorization || '').replace(/^Bearer /, '');
    if (token !== TOKEN) return reply({ errors: [{ message: 'Not Authorized' }], data: null });

    await new Promise((resolve) => setTimeout(resolve, Math.min(80, T(80))));
    const handler = handlers[body.operationName];
    if (!handler) return reply({ errors: [{ message: `The demo does not implement ${body.operationName}` }], data: null });
    try {
      return reply({ data: handler(body.variables || {}) });
    } catch (err) {
      if (err instanceof Fail) return reply({ errors: [{ message: err.message }], data: null });
      throw err;
    }
  }

  function stop() {
    clearInterval(ticker);
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  return {
    TOKEN,
    ids,
    transport,
    reset,
    stop,
    getRequestCount: () => requests,
    // exposed for tests
    get services() {
      return services;
    },
  };
}

module.exports = { createDemo, TOKEN };
