'use strict';

const D = require('./documents');
const { createRailway } = require('./railway');
const { describeError } = require('./errors');

/**
 * Check a Railway token end to end and report each step in plain words.
 * Tries it as a project token first (recommended), then as an account/workspace token.
 */
async function testConnection({ token, projectId = '', environmentId = '', apiUrl, transport } = {}) {
  const cleanToken = String(token || '').trim();
  const steps = [];
  const fail = (extra = {}) => ({ ok: false, steps, ...extra });

  if (!cleanToken) {
    steps.push({ name: 'Token', ok: false, detail: 'Paste a Railway token first.' });
    return fail();
  }
  if (/\s/.test(cleanToken)) {
    steps.push({ name: 'Token', ok: false, detail: 'The token has spaces in it. Copy only the token itself.' });
    return fail();
  }

  let mode = null;
  let ids = { projectId: String(projectId || '').trim(), environmentId: String(environmentId || '').trim() };
  let railway = createRailway({ token: cleanToken, mode: 'project', url: apiUrl, transport });

  // 1) As a project token (it can only touch one environment of one project: the safest choice).
  try {
    const data = await railway.request(D.ProjectToken, {});
    mode = 'project';
    ids = { projectId: data.projectToken.projectId, environmentId: data.projectToken.environmentId };
    steps.push({ name: 'Token', ok: true, detail: 'Railway accepted it as a project token.' });
  } catch (err) {
    const d = describeError(err);
    if (err.kind === 'network' || err.kind === 'rate') {
      steps.push({ name: 'Reach Railway', ok: false, detail: d.message });
      return fail();
    }
  }

  // 2) As an account or workspace token (needs the project and environment IDs).
  if (!mode) {
    if (!ids.projectId || !ids.environmentId) {
      steps.push({
        name: 'Token',
        ok: false,
        detail:
          'Railway did not accept this as a project token. If it is an account or workspace token, fill in the project ID and environment ID below. Otherwise create a new project token.',
      });
      return fail({ needsIds: true });
    }
    railway = createRailway({ token: cleanToken, mode: 'bearer', url: apiUrl, transport });
    mode = 'bearer';
  }

  // 3) Read the project.
  let data;
  try {
    data = await railway.request(D.Overview, ids);
  } catch (err) {
    steps.push({ name: 'Read project', ok: false, detail: describeError(err).message });
    return fail();
  }
  if (!data || !data.environment) {
    steps.push({ name: 'Read project', ok: false, detail: 'Railway did not return that environment. Check the environment ID.' });
    return fail();
  }
  const projectName = (data.project && data.project.name) || 'Railway project';
  steps.push({ name: 'Read project', ok: true, detail: `${projectName} / ${data.environment.name}` });

  const services = ((data.environment.serviceInstances && data.environment.serviceInstances.edges) || [])
    .map((e) => e.node)
    .filter((si) => si && !si.deletedAt)
    .map((si) => si.serviceName)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  steps.push({
    name: 'Find bots',
    ok: services.length > 0,
    detail: services.length ? `${services.length} found: ${services.join(', ')}` : 'No services were found in this environment.',
  });

  return {
    ok: services.length > 0,
    steps,
    mode,
    projectId: ids.projectId,
    environmentId: ids.environmentId,
    projectName,
    environmentName: data.environment.name,
    services,
    rate: railway.getRate(),
  };
}

module.exports = { testConnection };
