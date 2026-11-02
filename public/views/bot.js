// The page for one bot: a big status banner, the main buttons, and its sections.

import { h } from '../lib/dom.js';
import { icon, stateIcon } from '../lib/icons.js';
import { button, setLocked, setLabel, setIcon } from '../lib/ui.js';
import { runBotAction } from '../lib/actions.js';
import { state as store, findBot } from '../lib/store.js';
import { firstLine, sinceText, railwayUrl } from '../lib/format.js';
import { emptyState } from './parts.js';
import { createOverviewTab } from './tab-overview.js';
import { createLogsTab } from './tab-logs.js';
import { createVariablesTab } from './tab-variables.js';
import { createSettingsTab } from './tab-settings.js';
import { createDeploymentsTab } from './tab-deployments.js';

export const TABS = [
  { id: 'overview', label: 'Overview', icon: 'home', create: createOverviewTab },
  { id: 'logs', label: 'Logs', icon: 'terminal', create: createLogsTab },
  { id: 'variables', label: 'Variables', icon: 'braces', create: createVariablesTab },
  { id: 'settings', label: 'Settings', icon: 'sliders', create: createSettingsTab },
  { id: 'deployments', label: 'Deployments', icon: 'layers', create: createDeploymentsTab },
];

export function createBotPage({ id, tab, query }) {
  let bot = findBot(id);
  let toggleMode = 'stop';
  let current = null;
  const prev = {};

  // ---- banner
  const statusIcon = h('span');
  const statusText = h('span');
  const name = h('h1', { class: 'banner__name', id: 'page-title', tabindex: '-1' });
  const since = h('p', { class: 'lamp__since num' });
  const sourceText = h('span', { dir: 'auto' });
  const sourceLine = h('p', null, icon('globe'), sourceText);
  const changeText = h('span', { dir: 'auto' });
  const changeLine = h('p', null, icon('commit'), changeText);
  const banner = h(
    'div',
    { class: 'banner lamp' },
    h('div', { class: 'banner__main' }, h('p', { class: 'lamp__status' }, statusIcon, statusText), name, since),
    h('div', { class: 'banner__side' }, sourceLine, changeLine),
  );

  // ---- buttons
  const restart = button({ label: 'Restart', icon: 'restart', onClick: () => runBotAction(bot, 'restart', { button: restart }) });
  const toggle = button({ label: 'Stop', icon: 'stop', className: 'btn--stop', onClick: () => runBotAction(bot, toggleMode, { button: toggle }) });
  const redeploy = button({ label: 'Redeploy', icon: 'rocket', title: 'Build the bot again and replace the running copy', onClick: () => runBotAction(bot, 'redeploy', { button: redeploy }) });
  const deployLatest = button({
    label: 'Deploy newest code',
    icon: 'zap',
    title: 'Take the latest commit from GitHub and deploy it',
    onClick: () => runBotAction(bot, 'deploy-latest', { button: deployLatest }),
  });
  const onRailway = h('a', { class: 'btn', href: 'https://railway.com/dashboard', target: '_blank', rel: 'noopener noreferrer' }, icon('external'), h('span', { class: 'btn__label' }, 'Open on Railway'));
  const controls = h('div', { class: 'controls' }, restart, toggle, redeploy, deployLatest, h('span', { class: 'controls__spacer' }), onRailway);
  const head = h('section', { class: 'bot-head', 'aria-label': 'Status and main buttons' }, banner, controls);

  // ---- sections
  const nav = h(
    'nav',
    { class: 'tabs', 'aria-label': 'Sections of this bot' },
    TABS.map((t) => h('a', { href: `#/bot/${encodeURIComponent(id)}/${t.id}`, dataset: { tab: t.id } }, icon(t.icon), t.label)),
  );
  const tabview = h('div', { class: 'tabview' });

  // On a narrow screen not every tab fits. Keep the open tab in view and fade the edge while more tabs are hidden.
  let revealPending = true;
  function syncTabs() {
    if (nav.clientWidth === 0) return; // not on the page yet
    if (revealPending) {
      revealPending = false;
      const open = nav.querySelector('[aria-current="page"]');
      if (open && nav.scrollWidth > nav.clientWidth) {
        const inside = open.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
        nav.scrollLeft = inside - (nav.clientWidth - open.offsetWidth) / 2;
      }
    }
    nav.classList.toggle('tabs--more', nav.scrollWidth - nav.clientWidth - nav.scrollLeft > 4);
  }
  nav.addEventListener('scroll', syncTabs, { passive: true });
  const sizeWatcher = typeof ResizeObserver === 'function' ? new ResizeObserver(syncTabs) : null;
  if (sizeWatcher) sizeWatcher.observe(nav);

  const content = h('div', { class: 'bot-content', hidden: true }, head, nav, tabview);
  const loading = h('p', { class: 'muted' }, 'Loading this bot…');
  const missing = h(
    'div',
    { hidden: true },
    emptyState({
      title: 'This bot was not found',
      text: 'It may have been deleted or renamed on Railway, or it belongs to another project.',
      actions: [h('a', { class: 'btn btn--primary', href: '#/' }, 'Back to all bots')],
    }),
  );
  const crumb = h('a', { class: 'crumb', href: '#/' }, icon('chevron-left'), 'All bots');
  const el = h('div', { class: 'bot' }, crumb, loading, missing, content);

  function setIf(key, value, apply) {
    if (prev[key] === value) return;
    prev[key] = value;
    apply(value);
  }

  function setTab(tabId, q) {
    const def = TABS.find((t) => t.id === tabId) || TABS[0];
    if (current && current.id === def.id) {
      if (current.view.setQuery) current.view.setQuery(q);
      return;
    }
    if (current && current.view.destroy) current.view.destroy();
    const view = def.create({ botId: id, getBot: () => bot, query: q || new URLSearchParams() });
    current = { id: def.id, view };
    tabview.replaceChildren(view.el);
    for (const a of nav.children) {
      if (a.dataset.tab === def.id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    revealPending = true;
    syncTabs();
    if (bot && view.update) view.update(bot, store);
    api.title = `${bot ? `${bot.name}, ` : ''}${def.label}`;
  }

  function update(state) {
    bot = findBot(id);
    const waiting = !state.overview && !state.error;
    loading.hidden = !waiting;
    missing.hidden = Boolean(bot) || waiting;
    content.hidden = !bot;
    if (!bot) {
      api.title = 'Bot not found';
      return;
    }
    const c = bot.capabilities;
    const d = bot.deployment;

    setIf('state', bot.state, (s) => {
      banner.dataset.state = s;
      statusIcon.replaceChildren(stateIcon(s));
    });
    setIf('label', bot.label, (t) => {
      statusText.textContent = t;
    });
    setIf('name', bot.name, (t) => {
      name.textContent = t;
      if (current) api.title = `${t}, ${TABS.find((x) => x.id === current.id).label}`;
    });
    setIf('since', sinceText(bot), (t) => {
      since.textContent = t;
    });

    const source = bot.source.repo ? `GitHub: ${bot.source.repo}${d && d.commit && d.commit.branch ? ` on ${d.commit.branch}` : ''}` : bot.source.image ? `Image: ${bot.source.image}` : 'No code source';
    setIf('source', source, (t) => {
      sourceText.textContent = t;
    });
    const msg = d && d.commit ? firstLine(d.commit.message) : '';
    setIf('change', msg, (t) => {
      changeLine.hidden = !t;
      changeText.textContent = t;
    });

    toggleMode = c.stop ? 'stop' : 'start';
    setIf('toggle', toggleMode, (mode) => {
      setLabel(toggle, mode === 'stop' ? 'Stop' : 'Start');
      setIcon(toggle, mode === 'stop' ? 'stop' : 'play');
      toggle.classList.toggle('btn--stop', mode === 'stop');
    });
    setLocked(restart, !c.restart, 'Restart works while the bot is running or has crashed.');
    setLocked(redeploy, !c.redeploy, 'A build is already running. Wait until it has finished.');
    setLocked(deployLatest, !c.deployLatest, 'A build is already running. Wait until it has finished.');
    restart.classList.toggle('btn--primary', bot.state === 'crashed');
    toggle.classList.toggle('btn--primary', toggleMode === 'start' && bot.state !== 'sleeping');
    onRailway.href = railwayUrl(state.overview, bot.id);

    if (current && current.view.update) current.view.update(bot, state);
  }

  const api = {
    kind: 'bot',
    id,
    el,
    title: '',
    update,
    setTab,
    tick() {
      if (bot) setIf('since', sinceText(bot), (t) => (since.textContent = t));
      if (current && current.view.tick) current.view.tick();
    },
    destroy() {
      if (current && current.view.destroy) current.view.destroy();
      current = null;
      if (sizeWatcher) sizeWatcher.disconnect();
    },
  };

  setTab(tab, query);
  return api;
}
