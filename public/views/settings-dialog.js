// Settings of the dashboard itself: is the Railway connection healthy, change the token, change the password.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { get, post } from '../lib/api.js';
import { button, dialogShell, toast, withBusy } from '../lib/ui.js';
import { refresh, state as store } from '../lib/store.js';
import { fullDate } from '../lib/format.js';
import { note, stepsList } from './parts.js';

function section(title, ...children) {
  return h('section', { class: 'group' }, h('div', { class: 'group__head' }, h('h3', null, title)), ...children);
}

function labelled(label, control, hint) {
  return h('div', { class: 'field' }, h('label', { class: 'field__label' }, label, control), hint ? h('p', { class: 'field__hint' }, hint) : null);
}

function onEnter(input, fn) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fn();
    }
  });
}

export function openSettings() {
  const shell = dialogShell({ title: 'Settings', size: 'lg' });

  // ---- connection
  const checkBody = h('div', { class: 'form-grid' }, h('p', { class: 'muted' }, 'Checking the connection…'));
  const tokenSlot = h('div', { class: 'form-grid' });
  const recheck = button({ label: 'Check again', icon: 'refresh', small: true, onClick: () => runCheck(true) });

  async function runCheck(manual) {
    try {
      const d = await (manual ? withBusy(recheck, () => get('/api/diagnostics')) : get('/api/diagnostics'));
      const rate = d.rate;
      const facts = h(
        'dl',
        { class: 'facts' },
        h('dt', null, 'Token type'),
        h('dd', null, d.tokenType),
        h('dt', null, 'Requests sent'),
        h('dd', { class: 'num' }, `${d.requests} since the dashboard started`),
        h('dt', null, 'Railway allowance'),
        h('dd', { class: 'num' }, rate ? `${rate.remaining} of ${rate.limit} requests left${rate.resetAt ? `, renews ${fullDate(rate.resetAt)}` : ''}` : 'Not reported yet'),
      );
      checkBody.replaceChildren(stepsList(d.steps), facts, h('div', null, recheck));
      buildTokenForm(d);
      buildAbout(d);
      refresh({ maxAge: 0 });
    } catch (err) {
      checkBody.replaceChildren(note({ kind: 'bad', title: 'The check failed', body: err.message }), h('div', null, recheck));
    }
  }

  function buildTokenForm(d) {
    if (d.demo) {
      tokenSlot.replaceChildren(note({ kind: 'info', title: 'Demo mode', body: 'The bots are pretend, so there is no Railway token to change. Start the dashboard normally to connect your real project.' }));
      return;
    }
    if (d.locked && d.locked.connection) {
      tokenSlot.replaceChildren(note({ kind: 'info', title: 'The token is set outside this page', body: 'It comes from an environment variable on this computer. Change it where you set it, then restart the dashboard.' }));
      return;
    }
    const token = h('input', { class: 'input input--mono', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the new token' });
    const result = h('div');
    const save = button({
      label: 'Check and save',
      icon: 'check',
      onClick: async () => {
        result.replaceChildren();
        try {
          const r = await withBusy(save, () => post('/api/connection', { token: token.value }));
          token.value = '';
          toast(`Connected to ${r.projectName}.`, { kind: 'ok' });
          runCheck(false);
        } catch (err) {
          result.replaceChildren(err.steps ? stepsList(err.steps) : note({ kind: 'bad', title: 'Could not save the token', body: err.message }));
        }
      },
    });
    onEnter(token, () => save.click());
    tokenSlot.replaceChildren(
      h('p', { class: 'muted' }, 'Use this if Railway says the token is wrong, or after you made a new one. The old token keeps working on Railway until you delete it there.'),
      labelled('New Railway token', token),
      h('div', null, save),
      result,
    );
  }

  // ---- password
  const passwordSlot = h('div', { class: 'form-grid' });
  function buildPassword(d) {
    if (d.demo) {
      passwordSlot.replaceChildren(note({ kind: 'info', title: 'Demo mode', body: 'The demo password is fixed. Start the dashboard normally to set your own.' }));
      return;
    }
    if (d.locked && d.locked.password) {
      passwordSlot.replaceChildren(note({ kind: 'info', title: 'The password is set outside this page', body: 'It comes from an environment variable on this computer. Change it where you set it, then restart the dashboard.' }));
      return;
    }
    const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const again = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const result = h('div');
    const save = button({
      label: 'Change password',
      icon: 'lock',
      onClick: async () => {
        result.replaceChildren();
        const fail = (m) => result.replaceChildren(h('div', { class: 'form-error', role: 'alert' }, icon('alert'), h('span', null, m)));
        if (next.value.length < 8) return fail('Choose a password with at least 8 characters.');
        if (next.value !== again.value) return fail('The two new passwords are not the same.');
        try {
          await withBusy(save, () => post('/api/password', { current: current.value, next: next.value }));
          current.value = next.value = again.value = '';
          toast('Password changed. Every other browser was signed out.', { kind: 'ok' });
        } catch (err) {
          fail(err.message);
        }
        return undefined;
      },
    });
    onEnter(again, () => save.click());
    passwordSlot.replaceChildren(
      h('div', { class: 'form-grid form-grid--2' }, labelled('Current password', current), labelled('New password', next), labelled('New password again', again)),
      h('div', null, save),
      result,
    );
  }

  // ---- about
  const aboutSlot = h('div');
  function buildAbout(d) {
    const ov = store.overview;
    aboutSlot.replaceChildren(
      h(
        'dl',
        { class: 'facts' },
        h('dt', null, 'Version'),
        h('dd', null, `VOLA Control ${d.version}`),
        h('dt', null, 'Refreshing'),
        h('dd', null, `Every ${(ov && ov.pollSeconds) || 30} seconds while this page is open, and faster while a bot is changing.`),
        h('dt', null, 'Project'),
        h('dd', { class: 'mono' }, d.ids && d.ids.projectId ? d.ids.projectId : ''),
        h('dt', null, 'Environment'),
        h('dd', { class: 'mono' }, d.ids && d.ids.environmentId ? d.ids.environmentId : ''),
      ),
    );
    buildPassword(d);
  }

  shell.body.append(section('Connection to Railway', checkBody), section('Railway token', tokenSlot), section('Dashboard password', passwordSlot), section('About', aboutSlot));
  shell.foot.appendChild(h('button', { type: 'button', class: 'btn btn--primary', onClick: () => shell.close() }, 'Done'));
  shell.open();
  runCheck(false);
}
