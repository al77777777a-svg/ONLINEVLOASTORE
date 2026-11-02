// A list of what was done from this dashboard: restarts, changes, sign-ins. Secret values are never in it.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { get } from '../lib/api.js';
import { dialogShell } from '../lib/ui.js';
import { ago, fullDate } from '../lib/format.js';
import { note, emptyState } from './parts.js';

const THIS_COMPUTER = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function who(actor) {
  if (!actor) return 'the dashboard';
  return THIS_COMPUTER.has(actor) ? 'this computer' : actor;
}

function what(entry) {
  const text = entry.message || entry.action;
  return entry.bot ? `${entry.bot}: ${text}` : text;
}

export async function openActivity() {
  const shell = dialogShell({ title: 'Activity', size: 'md', drawer: true });
  shell.body.appendChild(h('p', { class: 'muted' }, 'Loading…'));
  shell.foot.appendChild(h('button', { type: 'button', class: 'btn', onClick: () => shell.close() }, 'Close'));
  shell.open();
  try {
    const { entries } = await get('/api/activity?limit=100');
    if (!entries.length) {
      shell.body.replaceChildren(emptyState({ title: 'Nothing yet', text: 'When you restart a bot or change a setting, it shows up here.' }));
      return;
    }
    shell.body.replaceChildren(
      h('p', { class: 'muted' }, 'The newest actions are at the top. Passwords and secret values are never written here.'),
      h(
        'ul',
        { class: 'feed' },
        entries.map((e) =>
          h(
            'li',
            { class: e.ok ? 'feed__ok' : 'feed__fail' },
            icon(e.ok ? 'check-circle' : 'x-circle', { title: e.ok ? 'Worked' : 'Failed' }),
            h('div', null, h('div', { class: 'feed__what', dir: 'auto' }, what(e)), h('div', { class: 'feed__meta' }, h('span', { title: fullDate(e.ts) }, ago(e.ts)), ' from ', who(e.actor))),
          ),
        ),
      ),
    );
  } catch (err) {
    shell.body.replaceChildren(note({ kind: 'bad', title: 'Could not load the activity', body: err.message }));
  }
}
