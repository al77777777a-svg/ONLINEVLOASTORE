// The front page: one lit tile per bot, with the buttons you need most.

import { h } from '../lib/dom.js';
import { icon, stateIcon } from '../lib/icons.js';
import { button, setLocked, setLabel, setIcon } from '../lib/ui.js';
import { runBotAction, runBulk } from '../lib/actions.js';
import { refresh } from '../lib/store.js';
import { summarize, sinceText, firstLine, ago } from '../lib/format.js';
import { note, emptyState } from './parts.js';

const REASONS = {
  restart: 'Restart works while the bot is running or has crashed.',
  redeploy: 'A build is already running. Wait until it has finished.',
};

function changeLine(bot) {
  const d = bot.deployment;
  const message = d && d.commit && firstLine(d.commit.message);
  if (message) return { icon: 'commit', text: message };
  if (d && d.commit && d.commit.reason) return { icon: 'commit', text: `Reason: ${d.commit.reason}` };
  if (bot.source.repo) return { icon: 'commit', text: bot.source.repo };
  if (bot.source.image) return { icon: 'layers', text: bot.source.image };
  return { icon: 'commit', text: 'No details from Railway yet' };
}

function createTile(initial) {
  let bot = initial;
  let toggleMode = 'stop';
  const prev = {};
  const href = `#/bot/${encodeURIComponent(bot.id)}`;

  const statusIcon = h('span', { class: 'lamp__icon' });
  const statusText = h('span');
  const nameLink = h('a', { href });
  const since = h('p', { class: 'lamp__since num' });
  const lamp = h(
    'div',
    { class: 'tile__lamp lamp' },
    h('p', { class: 'lamp__status' }, statusIcon, statusText),
    h('div', null, h('h2', { class: 'tile__name' }, nameLink), since),
  );

  const changeIcon = h('span', { class: 'tile__change-icon' });
  const changeText = h('span', { dir: 'auto' });
  const change = h('p', { class: 'tile__change' }, changeIcon, changeText);

  const restart = button({ label: 'Restart', icon: 'restart', onClick: () => runBotAction(bot, 'restart', { button: restart }) });
  const toggle = button({ label: 'Stop', icon: 'stop', className: 'btn--stop', onClick: () => runBotAction(bot, toggleMode, { button: toggle }) });
  const redeploy = button({ label: 'Redeploy', icon: 'rocket', onClick: () => runBotAction(bot, 'redeploy', { button: redeploy }) });
  const manage = h('a', { class: 'btn', href, title: 'Logs, variables, settings and more' }, icon('sliders'), h('span', { class: 'btn__label' }, 'Manage'));

  const el = h('li', { class: 'tile' }, lamp, h('div', { class: 'tile__panel' }, change, h('div', { class: 'tile__actions' }, restart, toggle, redeploy, manage)));

  function setIf(key, value, apply) {
    if (prev[key] === value) return;
    prev[key] = value;
    apply(value);
  }

  function update(next, now = Date.now()) {
    bot = next;
    const c = bot.capabilities;
    setIf('state', bot.state, (s) => {
      lamp.dataset.state = s;
      statusIcon.replaceChildren(stateIcon(s));
    });
    setIf('label', bot.label, (t) => {
      statusText.textContent = t;
    });
    setIf('name', bot.name, (t) => {
      nameLink.textContent = t;
    });
    setIf('since', sinceText(bot, now), (t) => {
      since.textContent = t;
    });
    const line = changeLine(bot);
    setIf('change', `${line.icon}|${line.text}`, () => {
      changeIcon.replaceChildren(icon(line.icon));
      changeText.textContent = line.text;
      change.title = line.text;
    });

    toggleMode = c.stop ? 'stop' : 'start';
    setIf('toggle', toggleMode, (mode) => {
      setLabel(toggle, mode === 'stop' ? 'Stop' : 'Start');
      setIcon(toggle, mode === 'stop' ? 'stop' : 'play');
      toggle.classList.toggle('btn--stop', mode === 'stop');
    });
    setLocked(restart, !c.restart, REASONS.restart);
    setLocked(redeploy, !c.redeploy, REASONS.redeploy);

    const needsAttention = bot.state === 'crashed';
    const wantsStart = toggleMode === 'start' && bot.state !== 'sleeping';
    restart.classList.toggle('btn--primary', needsAttention);
    toggle.classList.toggle('btn--primary', wantsStart);
  }

  update(bot);
  return { el, update };
}

function skeleton() {
  return h(
    'li',
    { class: 'tile tile--skeleton', 'aria-hidden': 'true' },
    h('div', { class: 'tile__lamp' }, h('p', { class: 'lamp__status' }, 'Loading'), h('div')),
    h('div', { class: 'tile__panel' }),
  );
}

export function createHome() {
  const headline = h('h1', { id: 'page-title', tabindex: '-1' }, 'Your bots');
  const detail = h('p', { class: 'summary__sub' });
  const notice = h('div');
  const grid = h('ul', { class: 'tiles', 'aria-label': 'Bots' });
  const tiles = new Map();
  let noticeKey = '';
  let skeletonShown = false;
  let lastBots = [];

  const bulkDefs = [
    { action: 'restart', label: 'Restart', icon: 'restart', cap: 'restart' },
    { action: 'redeploy', label: 'Redeploy', icon: 'rocket', cap: 'redeploy' },
    { action: 'start', label: 'Start', icon: 'play', cap: 'start' },
    { action: 'stop', label: 'Stop', icon: 'stop', cap: 'stop', className: 'btn--stop' },
  ];
  const bulkButtons = bulkDefs.map((def) => {
    const btn = button({
      label: def.label,
      icon: def.icon,
      small: true,
      className: def.className || '',
      title: `${def.label} every bot that can`,
      onClick: () => runBulk(def.action, lastBots, { button: btn }),
    });
    return { def, btn };
  });
  const bulk = h(
    'div',
    { class: 'bulk', role: 'group', 'aria-label': 'Actions for all bots', hidden: true },
    h('span', { class: 'bulk__label' }, 'All bots'),
    bulkButtons.map((b) => b.btn),
  );

  const el = h('div', { class: 'home' }, h('section', { class: 'summary' }, h('div', { class: 'summary__text' }, headline, detail), bulk), notice, grid);

  function setNotice(key, node) {
    if (key === noticeKey) return;
    noticeKey = key;
    notice.replaceChildren(...(node ? [node] : []));
  }

  function sync(bots) {
    const seen = new Set();
    bots.forEach((bot, index) => {
      let tile = tiles.get(bot.id);
      if (!tile) {
        tile = createTile(bot);
        tiles.set(bot.id, tile);
      }
      tile.update(bot);
      seen.add(bot.id);
      const at = grid.children[index];
      if (at !== tile.el) grid.insertBefore(tile.el, at || null);
    });
    for (const [id, tile] of tiles) {
      if (!seen.has(id)) {
        tile.el.remove();
        tiles.delete(id);
      }
    }
  }

  function update(state) {
    const ov = state.overview;

    if (!ov) {
      bulk.hidden = true;
      if (state.error) {
        detail.textContent = '';
        headline.textContent = 'Could not load your bots';
        setNotice(
          `error:${state.error.message}`,
          note({
            kind: 'bad',
            title: 'Railway did not answer',
            body: state.error.message,
            actions: [button({ label: 'Try again', icon: 'refresh', small: true, onClick: () => refresh({ force: true }) })],
          }),
        );
        if (skeletonShown) {
          grid.replaceChildren();
          skeletonShown = false;
        }
      } else if (!skeletonShown) {
        headline.textContent = 'Checking your bots…';
        detail.textContent = '';
        grid.replaceChildren(skeleton(), skeleton(), skeleton());
        skeletonShown = true;
      }
      return;
    }

    if (skeletonShown) {
      grid.replaceChildren();
      skeletonShown = false;
    }
    lastBots = ov.bots;
    const s = summarize(ov.bots);
    if (headline.textContent !== s.headline) headline.textContent = s.headline;
    if (detail.textContent !== s.detail) detail.textContent = s.detail;
    bulk.hidden = !ov.bots.length;
    for (const { def, btn } of bulkButtons) {
      const some = ov.bots.some((b) => b.capabilities[def.cap]);
      setLocked(btn, !some, `No bot can ${def.label.toLowerCase()} right now.`);
    }

    if (ov.stale && ov.error) {
      setNotice(
        `stale:${ov.error.message}:${ov.fetchedAt}`,
        note({
          kind: 'warn',
          title: `Railway did not answer. These states are from ${ago(ov.fetchedAt)}.`,
          body: ov.error.message,
          actions: [button({ label: 'Try again', icon: 'refresh', small: true, onClick: () => refresh({ force: true }) })],
        }),
      );
    } else {
      setNotice('', null);
    }

    if (!ov.bots.length) {
      grid.replaceChildren(
        emptyState({
          title: 'No bots found',
          text: 'This Railway environment has no services. Check the project and environment in Settings.',
        }),
      );
      tiles.clear();
      return;
    }
    if (grid.querySelector('.empty')) grid.replaceChildren();
    sync(ov.bots);
  }

  function tick() {
    for (const [id, tile] of tiles) {
      const bot = lastBots.find((b) => b.id === id);
      if (bot) tile.update(bot);
    }
  }

  return { kind: 'home', el, update, tick, title: '' };
}
