// Deployments: every version Railway has built for this bot. Go back to an older one, or clean up.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { get, botPath } from '../lib/api.js';
import { button } from '../lib/ui.js';
import { runBotAction } from '../lib/actions.js';
import { ago, firstLine, fullDate, shortHash } from '../lib/format.js';
import { note, emptyState } from './parts.js';

export function createDeploymentsTab({ botId, getBot }) {
  let deployments = [];
  let loaded = false;
  let error = null;
  let destroyed = false;
  let lastKey = '';

  const list = h('div', { class: 'deps', role: 'list' }, h('p', { class: 'muted panel__pad' }, 'Reading the deployments…'));
  const refreshBtn = button({ label: 'Refresh', icon: 'refresh', small: true, onClick: () => load() });
  const el = h(
    'div',
    { class: 'tabview' },
    h('section', { class: 'panel panel--flush' }, h('div', { class: 'panel__head' }, h('h2', null, 'Deployments'), refreshBtn), list),
    note({ kind: 'info', title: 'What is a deployment?', body: 'Each time Railway builds your bot, it makes a new deployment. The one marked Live is the one running now. You can go back to an older one if a new version breaks.' }),
  );

  async function load() {
    try {
      const data = await get(botPath(botId, '/deployments?limit=25'));
      deployments = data.deployments;
      error = null;
    } catch (err) {
      error = err;
    }
    loaded = true;
    render();
  }

  async function act(action, d, btn) {
    const bot = getBot();
    if (!bot) return;
    await runBotAction(bot, action, { button: btn, deploymentId: d.id });
    load();
  }

  function row(d) {
    const msg = d.commit && (firstLine(d.commit.message) || d.commit.reason);
    const base = `#/bot/${encodeURIComponent(botId)}/logs?deployment=${encodeURIComponent(d.id)}`;
    const tools = [
      h('a', { class: 'btn btn--small', href: base, title: 'Read what this version printed while running' }, icon('terminal'), 'Logs'),
      h('a', { class: 'btn btn--small', href: `${base}&kind=build`, title: 'Read the build log of this version' }, icon('layers'), 'Build'),
    ];
    if (d.inFlight) {
      const cancel = button({ label: 'Cancel', icon: 'x', small: true, onClick: () => act('cancel', d, cancel) });
      tools.push(cancel);
    }
    if (d.canRollback && !d.isActive && !d.inFlight) {
      const back = button({ label: 'Roll back', icon: 'undo', small: true, title: 'Run this older version again', onClick: () => act('rollback', d, back) });
      tools.push(back);
    }
    if (!d.isActive && !d.inFlight) {
      const remove = button({ label: 'Remove this deployment', icon: 'trash', iconOnly: true, small: true, variant: 'quiet', title: 'Remove from the list', onClick: () => act('remove', d, remove) });
      tools.push(remove);
    }
    return h(
      'div',
      { class: 'dep', role: 'listitem' },
      h('div', { class: 'dep__state', dataset: { state: d.state } }, h('span', { class: 'dot' }), d.label, d.isActive ? h('span', { class: 'chip chip--live' }, 'Live') : null),
      h(
        'div',
        { class: 'dep__what' },
        h('div', { class: 'dep__msg', dir: 'auto', title: msg || undefined }, msg || 'No message'),
        h(
          'div',
          { class: 'dep__meta' },
          h('span', { title: fullDate(d.createdAt) }, ago(d.createdAt)),
          d.commit && d.commit.hash ? h('span', { class: 'mono' }, shortHash(d.commit.hash)) : null,
          d.commit && d.commit.branch ? h('span', null, d.commit.branch) : null,
          d.commit && d.commit.author ? h('span', null, d.commit.author) : null,
        ),
      ),
      h('div', { class: 'dep__tools' }, tools),
    );
  }

  function render() {
    if (destroyed) return;
    if (error) {
      list.replaceChildren(h('div', { class: 'panel__bar' }, note({ kind: 'bad', title: 'Could not read the deployments', body: error.message, actions: [button({ label: 'Try again', icon: 'refresh', small: true, onClick: load })] })));
      return;
    }
    if (!loaded) return;
    if (!deployments.length) {
      list.replaceChildren(emptyState({ title: 'Nothing deployed yet', text: 'Press Deploy newest code on the top of this page to make the first deployment.' }));
      return;
    }
    list.replaceChildren(...deployments.map(row));
  }

  load();
  const timer = setInterval(() => {
    if (!document.hidden && deployments.some((d) => d.inFlight)) load();
  }, 10_000);

  return {
    el,
    update(bot) {
      const key = `${bot.deployment ? bot.deployment.id : ''}|${bot.state}`;
      if (key !== lastKey) {
        const first = lastKey === '';
        lastKey = key;
        if (!first) load();
      }
    },
    destroy() {
      destroyed = true;
      clearInterval(timer);
    },
  };
}
