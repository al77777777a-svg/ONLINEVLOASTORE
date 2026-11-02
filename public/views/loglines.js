// Drawing log lines. Every line is added as plain text, so a bot cannot put markup on this page.

import { h } from '../lib/dom.js';
import { clock, fullDate } from '../lib/format.js';

function highlight(text, query) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) parts.push(text.slice(from, at));
    parts.push(h('mark', null, text.slice(at, at + needle.length)));
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}

export function renderLogLines(box, lines, { query = '' } = {}) {
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    fragment.appendChild(
      h(
        'div',
        { class: `logline logline--${line.severity}` },
        h('time', { datetime: line.ts, title: fullDate(line.ts, { seconds: true }) }, clock(line.ts)),
        h('span', { class: 'logline__msg', dir: 'auto' }, highlight(line.message, query)),
      ),
    );
  }
  box.replaceChildren(fragment);
}

export function showLogMessage(box, text) {
  box.replaceChildren(h('div', { class: 'logbox__empty' }, text));
}

export const atBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 48;
export const scrollToEnd = (box) => {
  box.scrollTop = box.scrollHeight;
};

export function linesToText(lines) {
  return lines.map((l) => `${l.ts} ${l.severity.toUpperCase().padEnd(5)} ${l.message}`).join('\n');
}
