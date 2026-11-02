// What happens when someone presses Restart, Stop, Start and the other bot buttons:
// ask first when it matters, call the server, then say what happened.

import { post, botPath } from './api.js';
import { boost, refresh } from './store.js';
import { confirmDialog, toast, withBusy } from './ui.js';
import { plural } from './format.js';

const ACTIONS = {
  start: { confirm: false },
  restart: {
    confirm: (bot) => bot.state === 'online',
    title: (bot) => `Restart ${bot.name}?`,
    body: () => 'The bot goes offline for a short moment, usually less than a minute, and then starts again.',
    label: 'Restart',
  },
  stop: {
    confirm: () => true,
    tone: 'danger',
    title: (bot) => `Stop ${bot.name}?`,
    body: () => 'The bot goes offline and stays off until you press Start.',
    label: 'Stop bot',
  },
  redeploy: {
    confirm: () => true,
    title: (bot) => `Redeploy ${bot.name}?`,
    body: () => 'Railway builds the bot again from its code and then swaps it in. This usually takes a few minutes.',
    label: 'Redeploy',
  },
  'deploy-latest': {
    confirm: () => true,
    title: (bot) => `Deploy the newest code of ${bot.name}?`,
    body: () => 'Railway takes the latest commit from GitHub, builds it and replaces the running bot.',
    label: 'Deploy newest code',
  },
  cancel: {
    confirm: () => true,
    title: () => 'Cancel this build?',
    body: () => 'Railway stops building this version. The bot that is running now is not touched.',
    label: 'Cancel build',
    cancelLabel: 'Keep building',
  },
  remove: {
    confirm: () => true,
    tone: 'danger',
    title: () => 'Remove this deployment?',
    body: () => 'It disappears from the list on Railway. You cannot undo this.',
    label: 'Remove',
  },
  rollback: {
    confirm: () => true,
    title: (bot) => `Go back to this version of ${bot.name}?`,
    body: () => 'Railway runs this older version again. Newer versions stay in the list.',
    label: 'Roll back',
  },
};

export async function runBotAction(bot, action, { button, deploymentId } = {}) {
  const def = ACTIONS[action];
  if (!def) throw new Error(`Unknown action ${action}`);

  if (def.confirm && def.confirm(bot)) {
    const { confirmed } = await confirmDialog({
      title: def.title(bot),
      body: def.body(bot),
      confirmLabel: def.label,
      cancelLabel: def.cancelLabel || 'Cancel',
      tone: def.tone || 'normal',
    });
    if (!confirmed) return null;
  }

  try {
    const result = await withBusy(button, () => post(botPath(bot.id, `/actions/${action}`), deploymentId ? { deploymentId } : {}));
    toast(result.message, { kind: 'ok' });
    boost();
    refresh({ maxAge: 0 });
    return result;
  } catch (err) {
    toast(err.message, { kind: 'error' });
    refresh({ maxAge: 5 });
    return null;
  }
}

const BULK = {
  start: { cap: 'start', title: 'Start all bots?', yes: 'Start', body: 'Every bot that is switched off will start.', done: 'starting' },
  stop: { cap: 'stop', title: 'Stop all bots?', yes: 'Stop all', body: 'Every bot that is running goes offline until you start it again.', done: 'being stopped', tone: 'danger' },
  restart: { cap: 'restart', title: 'Restart all bots?', yes: 'Restart all', body: 'Each running bot goes offline for a short moment and then starts again.', done: 'restarting' },
  redeploy: { cap: 'redeploy', title: 'Redeploy all bots?', yes: 'Redeploy all', body: 'Railway rebuilds every bot from its code. This takes a few minutes.', done: 'being redeployed' },
};

export async function runBulk(action, bots, { button } = {}) {
  const def = BULK[action];
  const targets = bots.filter((b) => b.capabilities[def.cap]);
  const skipped = bots.filter((b) => !b.capabilities[def.cap]);
  if (!targets.length) {
    toast(`Nothing to do. No bot can ${action} right now.`, { kind: 'info' });
    return null;
  }
  const { confirmed } = await confirmDialog({
    title: def.title,
    body: def.body,
    list: [
      ...targets.map((b) => ({ text: b.name, icon: 'check' })),
      ...skipped.map((b) => ({ text: b.name, icon: 'minus', note: 'skipped' })),
    ],
    confirmLabel: `${def.yes}${targets.length > 1 ? ` (${targets.length})` : ''}`,
    tone: def.tone || 'normal',
  });
  if (!confirmed) return null;

  try {
    const { results } = await withBusy(button, () => post('/api/bulk', { action }));
    const worked = results.filter((r) => r.ok && !r.skipped);
    const failed = results.filter((r) => !r.ok);
    if (worked.length) toast(`${plural(worked.length, 'bot')} ${worked.length === 1 ? 'is' : 'are'} ${def.done}.`, { kind: 'ok' });
    for (const f of failed) toast(`${f.name}: ${f.message}`, { kind: 'error' });
    boost();
    refresh({ maxAge: 0 });
    return results;
  } catch (err) {
    toast(err.message, { kind: 'error' });
    return null;
  }
}
