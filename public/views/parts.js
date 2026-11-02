// Small pieces that several screens share.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

/** A short message box. kind: info | warn | bad */
export function note({ kind = 'info', title, body, actions } = {}) {
  const iconName = kind === 'bad' ? 'alert' : kind === 'warn' ? 'alert-circle' : 'info';
  return h(
    'div',
    { class: `note note--${kind}`, role: kind === 'bad' ? 'alert' : undefined },
    icon(iconName),
    h('div', { class: 'note__body' }, title ? h('strong', null, title) : null, body ? h('div', null, body) : null, actions ? h('div', { class: 'panel__tools' }, actions) : null),
  );
}

/** The results of a connection check, one line each. */
export function stepsList(steps) {
  return h(
    'ul',
    { class: 'steps' },
    (steps || []).map((s) =>
      h(
        'li',
        { class: `step ${s.ok ? 'step--ok' : 'step--fail'}` },
        icon(s.ok ? 'check-circle' : 'x-circle'),
        h('div', null, h('div', { class: 'step__name' }, s.name), h('div', { class: 'step__detail' }, s.detail)),
      ),
    ),
  );
}

export function emptyState({ title, text, actions }) {
  return h('div', { class: 'empty' }, h('h3', null, title), text ? h('p', null, text) : null, actions ? h('div', { class: 'panel__tools' }, actions) : null);
}

/** The little wall of lit tiles: one cell per bot. */
export function mark({ hero = false, cells = 0 } = {}) {
  const el = h('div', { class: hero ? 'mark mark--hero' : 'mark', 'aria-hidden': 'true' });
  for (let i = 0; i < cells; i += 1) el.appendChild(h('i'));
  return el;
}

export function setMarkCells(markEl, bots) {
  const count = Math.min(9, Math.max(3, Math.ceil(bots.length / 3) * 3));
  while (markEl.children.length < count) markEl.appendChild(h('i'));
  while (markEl.children.length > count) markEl.lastElementChild.remove();
  [...markEl.children].forEach((cell, i) => {
    const next = bots[i] ? bots[i].state : 'empty';
    if (cell.dataset.state !== next) cell.dataset.state = next;
  });
}

const FAVICON_COLORS = {
  online: '#16794A',
  building: '#F0B323',
  deploying: '#F0B323',
  queued: '#F0B323',
  crashed: '#C42B2B',
  failed: '#C42B2B',
  sleeping: '#355E9E',
  approval: '#6B4FC8',
};

export function setFavicon(bots) {
  const link = document.getElementById('favicon');
  if (!link) return;
  const count = Math.min(9, Math.max(3, Math.ceil(bots.length / 3) * 3));
  const rows = count / 3;
  const size = 9.4;
  const gap = 1.3;
  const top = (32 - (rows * size + (rows - 1) * gap)) / 2;
  let cells = '';
  for (let i = 0; i < count; i += 1) {
    const x = (i % 3) * (size + gap) + 1;
    const y = top + Math.floor(i / 3) * (size + gap);
    const bot = bots[i];
    const fill = bot ? FAVICON_COLORS[bot.state] || '#566573' : null;
    cells += fill
      ? `<rect x='${x}' y='${y.toFixed(2)}' width='${size}' height='${size}' rx='2.4' fill='${fill}'/>`
      : `<rect x='${x + 0.8}' y='${(y + 0.8).toFixed(2)}' width='${size - 1.6}' height='${size - 1.6}' rx='2' fill='none' stroke='#8D9BA6' stroke-width='1.6'/>`;
  }
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>${cells}</svg>`)}`;
}

export const STATE_WORDS = {
  online: 'Online',
  building: 'Building',
  deploying: 'Starting',
  queued: 'Waiting',
  crashed: 'Crashed',
  failed: 'Failed',
  stopped: 'Stopped',
  sleeping: 'Asleep',
  approval: 'Needs approval',
  skipped: 'Skipped',
  none: 'Not deployed',
};
