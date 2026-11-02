// Logs: what the bot prints while it runs, and what Railway printed while building it.

import { h, copyText, downloadText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { get, botPath } from '../lib/api.js';
import { button, toast, withBusy } from '../lib/ui.js';
import { ago, firstLine, plural } from '../lib/format.js';
import { renderLogLines, showLogMessage, atBottom, scrollToEnd, linesToText } from './loglines.js';
import { note } from './parts.js';

export function createLogsTab({ botId, getBot, query }) {
  const opts = {
    kind: query.get('kind') === 'build' ? 'build' : 'deploy',
    deployment: query.get('deployment') || '',
    limit: 200,
    level: 'all',
    search: '',
    live: false,
    wrap: true,
  };
  let lines = [];
  let fetchedAt = 0;
  let error = null;
  let loading = false;
  let destroyed = false;
  let first = true;
  let timer = null;
  let deployments = [];

  // ---- controls
  const kindButtons = [
    { id: 'deploy', label: 'Running' },
    { id: 'build', label: 'Build' },
  ].map((k) =>
    h('button', { type: 'button', 'aria-pressed': String(opts.kind === k.id), dataset: { value: k.id }, onClick: () => { opts.kind = k.id; syncSegs(); load(true); } }, k.label),
  );
  const levelButtons = [
    { id: 'all', label: 'All' },
    { id: 'warn', label: 'Warnings' },
    { id: 'error', label: 'Errors' },
  ].map((k) =>
    h('button', { type: 'button', 'aria-pressed': String(opts.level === k.id), dataset: { value: k.id }, onClick: () => { opts.level = k.id; syncSegs(); render(); } }, k.label),
  );
  function syncSegs() {
    for (const b of kindButtons) b.setAttribute('aria-pressed', String(b.dataset.value === opts.kind));
    for (const b of levelButtons) b.setAttribute('aria-pressed', String(b.dataset.value === opts.level));
  }

  const deploySelect = h('select', { class: 'select', id: 'log-deployment', 'aria-label': 'Which deployment', onChange: () => { opts.deployment = deploySelect.value; load(true); } }, h('option', { value: '' }, 'Newest deployment'));
  const limitSelect = h(
    'select',
    { class: 'select', 'aria-label': 'How many lines', onChange: () => { opts.limit = Number(limitSelect.value); load(true); } },
    [100, 200, 500, 1000].map((n) => h('option', { value: String(n), selected: n === opts.limit }, `${n} lines`)),
  );
  const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Search the log', 'aria-label': 'Search the log', autocomplete: 'off', onInput: () => { opts.search = searchInput.value.trim(); render(); } });
  const liveBtn = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', title: 'Load new lines every 5 seconds' }, icon('pulse'), h('span', { class: 'btn__label' }, 'Live'));
  liveBtn.addEventListener('click', () => {
    opts.live = !opts.live;
    liveBtn.setAttribute('aria-pressed', String(opts.live));
    liveBtn.classList.toggle('btn--primary', opts.live);
    clearInterval(timer);
    if (opts.live) {
      timer = setInterval(() => !document.hidden && load(false), 5000);
      load(false);
    }
    renderMeta();
  });
  const wrapBtn = button({ label: 'Wrap long lines', icon: 'wrap', iconOnly: true, title: 'Wrap long lines', onClick: () => { opts.wrap = !opts.wrap; wrapBtn.setAttribute('aria-pressed', String(opts.wrap)); box.classList.toggle('logbox--wrap', opts.wrap); } });
  wrapBtn.setAttribute('aria-pressed', 'true');
  const copyBtn = button({ label: 'Copy', icon: 'copy', iconOnly: true, title: 'Copy the lines you see', onClick: async () => { const list = visible(); const ok = await copyText(linesToText(list)); toast(ok ? `Copied ${plural(list.length, 'line')}.` : 'Your browser did not allow copying.', { kind: ok ? 'ok' : 'error' }); } });
  const saveBtn = button({ label: 'Download', icon: 'download', iconOnly: true, title: 'Download the lines you see as a text file', onClick: () => { const bot = getBot(); downloadText(`${bot ? bot.name : 'bot'}-${opts.kind === 'build' ? 'build' : 'run'}-log.txt`, linesToText(visible())); } });
  const refreshBtn = button({ label: 'Refresh', icon: 'refresh', onClick: () => load(true) });

  const bar = h(
    'div',
    { class: 'logbar' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Which log' }, kindButtons),
    deploySelect,
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Which lines' }, levelButtons),
    h('div', { class: 'search logbar__grow' }, icon('search'), searchInput),
  );
  const bar2 = h('div', { class: 'logbar' }, limitSelect, liveBtn, refreshBtn, wrapBtn, copyBtn, saveBtn, h('span', { class: 'logmeta', role: 'status' }));
  const meta = bar2.lastElementChild;

  // ---- the log itself
  const box = h('div', { class: 'logbox logbox--wrap', tabindex: '0', role: 'region', 'aria-label': 'Log lines' });
  showLogMessage(box, 'Reading the logs…');
  const jump = button({ label: 'Jump to newest', icon: 'arrow-down', variant: 'primary', small: true, className: 'jump', onClick: () => { scrollToEnd(box); jump.hidden = true; } });
  jump.hidden = true;
  box.addEventListener('scroll', () => { if (atBottom(box)) jump.hidden = true; }, { passive: true });
  const errorSlot = h('div');

  const el = h('div', { class: 'tabview' }, h('section', { class: 'panel' }, bar, bar2, errorSlot, h('div', { class: 'logwrap' }, box, jump)));

  function visible() {
    let list = lines;
    if (opts.level === 'warn') list = list.filter((l) => l.severity === 'warn' || l.severity === 'error');
    if (opts.level === 'error') list = list.filter((l) => l.severity === 'error');
    if (opts.search) {
      const needle = opts.search.toLowerCase();
      list = list.filter((l) => l.message.toLowerCase().includes(needle));
    }
    return list;
  }

  function renderMeta() {
    const bits = [];
    if (fetchedAt) bits.push(`${plural(visible().length, 'line')} shown, updated ${ago(new Date(fetchedAt).toISOString())}`);
    if (opts.live) bits.push('live');
    meta.textContent = bits.join(', ');
  }

  function render() {
    const bot = getBot();
    const stick = first || atBottom(box);
    const list = visible();
    if (!bot || !bot.deployment) {
      showLogMessage(box, 'This bot has not been deployed yet, so there are no logs.');
    } else if (loading && !lines.length && first) {
      showLogMessage(box, 'Reading the logs…');
    } else if (!list.length) {
      showLogMessage(
        box,
        lines.length
          ? 'No lines match your filter.'
          : opts.kind === 'build'
            ? 'There are no build lines for this deployment. Bots that use a ready-made image have none.'
            : 'No log lines yet. If the bot just started, wait a few seconds and press Refresh.',
      );
    } else {
      const before = box.scrollTop;
      renderLogLines(box, list, { query: opts.search });
      if (stick) {
        scrollToEnd(box);
        jump.hidden = true;
      } else {
        box.scrollTop = before;
        jump.hidden = false;
      }
    }
    renderMeta();
  }

  async function load(manual) {
    const bot = getBot();
    if (destroyed || loading || !bot) return;
    if (!bot.deployment) {
      render();
      return;
    }
    loading = true;
    errorSlot.replaceChildren();
    const run = async () => {
      try {
        const q = new URLSearchParams({ kind: opts.kind, limit: String(opts.limit) });
        if (opts.deployment) q.set('deploymentId', opts.deployment);
        const data = await get(botPath(botId, `/logs?${q}`));
        lines = data.lines;
        fetchedAt = Date.now();
        error = null;
      } catch (err) {
        error = err;
        errorSlot.replaceChildren(note({ kind: 'bad', title: 'Could not read the logs', body: err.message }));
      }
    };
    try {
      if (manual) await withBusy(refreshBtn, run);
      else await run();
    } finally {
      loading = false;
      render();
      first = false;
    }
  }

  async function loadDeployments() {
    try {
      const data = await get(botPath(botId, '/deployments?limit=20'));
      deployments = data.deployments;
    } catch {
      return; // the picker simply stays on "Newest deployment"
    }
    if (destroyed) return;
    const options = [h('option', { value: '' }, 'Newest deployment')];
    for (const d of deployments) {
      const msg = d.commit && firstLine(d.commit.message);
      options.push(h('option', { value: d.id }, `${d.label}${d.isActive ? ' (live)' : ''}, ${ago(d.createdAt)}${msg ? `: ${msg.slice(0, 48)}` : ''}`));
    }
    if (opts.deployment && !deployments.some((d) => d.id === opts.deployment)) options.push(h('option', { value: opts.deployment }, 'Chosen deployment'));
    deploySelect.replaceChildren(...options);
    deploySelect.value = opts.deployment;
  }

  loadDeployments();

  return {
    el,
    update(bot) {
      if (first && !loading) load(false);
      else if (!bot.deployment) render();
    },
    setQuery(q) {
      opts.kind = q.get('kind') === 'build' ? 'build' : 'deploy';
      opts.deployment = q.get('deployment') || '';
      deploySelect.value = opts.deployment;
      syncSegs();
      load(true);
    },
    tick: renderMeta,
    destroy() {
      destroyed = true;
      clearInterval(timer);
    },
  };
}
