// Plain-language numbers, times and lists.

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return plural(s, 'second');
  const m = Math.floor(s / 60);
  if (m < 60) return plural(m, 'minute');
  const hr = Math.floor(m / 60);
  if (hr < 48) return plural(hr, 'hour');
  const d = Math.floor(hr / 24);
  if (d < 60) return plural(d, 'day');
  return plural(Math.floor(d / 30), 'month');
}

export function ago(ts, now = Date.now()) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const ms = now - t;
  return ms < 10_000 ? 'just now' : `${duration(ms)} ago`;
}

export const lasting = (ts, now = Date.now()) => {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? duration(now - t) : '';
};

export function clock(ts) {
  const t = new Date(ts);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString([], { hour12: false });
}

// The month is written as a word, so "2 Nov" can never be read as the 11th of February.
const DATE_FORMAT = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
const DATE_FORMAT_SECONDS = { ...DATE_FORMAT, second: '2-digit' };

export function fullDate(ts, { seconds = false } = {}) {
  const t = new Date(ts);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleString(undefined, seconds ? DATE_FORMAT_SECONDS : DATE_FORMAT);
}

export const shortHash = (hash) => (hash ? String(hash).slice(0, 7) : '');

export function megabytes(mb) {
  if (mb === null || mb === undefined || !Number.isFinite(Number(mb))) return '';
  const n = Number(mb);
  return n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} GB` : `${Math.round(n)} MB`;
}

/** "a", "a and b", "a, b and c" */
export function nameList(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Retry failed webhooks\n\nlong text" -> "Retry failed webhooks" */
export const firstLine = (text) => String(text || '').split('\n', 1)[0].trim();

/** Only link to GitHub when the repo looks like owner/name. */
export function githubUrl(repo) {
  return /^[\w.-]+\/[\w.-]+$/.test(repo || '') ? `https://github.com/${repo}` : null;
}

export function railwayUrl(overview, serviceId) {
  if (!overview || !overview.project || !overview.environment) return 'https://railway.com/dashboard';
  const base = `https://railway.com/project/${encodeURIComponent(overview.project.id)}`;
  const env = `environmentId=${encodeURIComponent(overview.environment.id)}`;
  return serviceId ? `${base}/service/${encodeURIComponent(serviceId)}?${env}` : `${base}?${env}`;
}

// How each state is worded on a tile.
export function sinceText(bot, now = Date.now()) {
  const d = bot.deployment;
  if (!d) return 'Nothing has been deployed yet.';
  const t = d.since;
  switch (bot.state) {
    case 'online': return `Running for ${lasting(t, now)}`;
    case 'crashed': return `Crashed ${ago(t, now)}`;
    case 'failed': return `Failed ${ago(t, now)}`;
    case 'building': return `Building for ${lasting(t, now)}`;
    case 'deploying': return `Starting for ${lasting(t, now)}`;
    case 'queued': return `Waiting in line for ${lasting(t, now)}`;
    case 'stopped': return `Stopped ${ago(t, now)}`;
    case 'sleeping': return `Asleep for ${lasting(t, now)}`;
    case 'approval': return 'Waiting for your approval on Railway';
    case 'skipped': return `Skipped ${ago(t, now)}`;
    default: return '';
  }
}

const VERBS = {
  crashed: ['has crashed', 'have crashed'],
  failed: ['has failed', 'have failed'],
  stopped: ['is stopped', 'are stopped'],
  building: ['is building', 'are building'],
  deploying: ['is starting', 'are starting'],
  queued: ['is waiting in line', 'are waiting in line'],
  approval: ['needs your approval', 'need your approval'],
  sleeping: ['is asleep', 'are asleep'],
  none: ['has not been deployed yet', 'have not been deployed yet'],
  skipped: ['was skipped', 'were skipped'],
  unknown: ['has an unknown state', 'have an unknown state'],
};
const ORDER = ['crashed', 'failed', 'stopped', 'approval', 'building', 'deploying', 'queued', 'sleeping', 'none', 'skipped', 'unknown'];

export function summarize(bots) {
  const total = bots.length;
  const online = bots.filter((b) => b.state === 'online').length;
  const groups = new Map();
  for (const b of bots) {
    if (b.state === 'online') continue;
    groups.set(b.state, [...(groups.get(b.state) || []), b.name]);
  }
  const sentences = [];
  for (const state of ORDER) {
    const names = groups.get(state);
    if (!names) continue;
    const verb = (VERBS[state] || VERBS.unknown)[names.length === 1 ? 0 : 1];
    sentences.push(`${nameList(names)} ${verb}.`);
  }
  let headline;
  if (!total) headline = 'No bots found';
  else if (online === total) headline = total === 1 ? 'Your bot is online' : `All ${total} bots are online`;
  else headline = `${online} of ${total} ${total === 1 ? 'bot is' : 'bots are'} online`;
  return { headline, detail: sentences.join(' '), online, total };
}
