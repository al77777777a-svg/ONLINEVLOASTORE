// First start: connect to Railway and choose a dashboard password.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { get, post } from '../lib/api.js';
import { button, withBusy } from '../lib/ui.js';
import { mark, note, stepsList } from './parts.js';

export function renderSetup({ onDone }) {
  const root = h('main', { class: 'auth auth--wide' });
  const card = h('div', { class: 'auth__card' }, h('p', { class: 'muted' }, 'Getting ready…'));
  root.appendChild(card);

  get('/api/setup')
    .then((info) => build(card, info, onDone))
    .catch((err) => card.replaceChildren(note({ kind: 'bad', title: 'The setup could not start', body: err.message })));

  return root;
}

function build(card, info, onDone) {
  const defaults = info.defaults || {};
  const locked = info.locked || {};

  const token = h('input', {
    class: 'input input--mono',
    id: 'token',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'Paste the token here',
    'aria-describedby': 'token-help',
  });
  const showToken = button({
    label: 'Show token',
    icon: 'eye',
    iconOnly: true,
    onClick: () => {
      const hidden = token.type === 'password';
      token.type = hidden ? 'text' : 'password';
      showToken.setAttribute('aria-label', hidden ? 'Hide token' : 'Show token');
    },
  });
  const projectId = h('input', { class: 'input input--mono', id: 'project-id', value: defaults.projectId || '', autocomplete: 'off', spellcheck: 'false' });
  const environmentId = h('input', { class: 'input input--mono', id: 'environment-id', value: defaults.environmentId || '', autocomplete: 'off', spellcheck: 'false' });
  const more = h(
    'details',
    { class: 'more' },
    h('summary', null, 'My token is an account or workspace token'),
    h(
      'div',
      { class: 'form-grid' },
      h('p', { class: 'muted' }, 'A project token already knows its project, so you can leave these as they are. An account token needs both IDs. You can find them in the address of your project page on Railway.'),
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'project-id' }, 'Project ID'), projectId),
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'environment-id' }, 'Environment ID'), environmentId),
    ),
  );

  const results = h('div', { 'aria-live': 'polite' });
  const step2 = h('section', { class: 'wiz' });

  function showResults(res) {
    const parts = [stepsList(res.steps)];
    if (res.ok) {
      parts.push(
        note({
          kind: 'info',
          title: `Connected to ${res.projectName}`,
          body: `${res.services.length} ${res.services.length === 1 ? 'bot' : 'bots'} found: ${res.services.join(', ')}.`,
        }),
      );
    }
    results.replaceChildren(...parts);
    step2.classList.toggle('wiz--done', Boolean(res.ok));
    if (res.needsIds) {
      more.open = true;
      projectId.focus();
    }
  }

  async function runCheck(btn) {
    results.replaceChildren();
    try {
      const res = await withBusy(btn, () => post('/api/setup/test', { token: token.value, projectId: projectId.value, environmentId: environmentId.value }));
      showResults(res);
    } catch (err) {
      results.replaceChildren(note({ kind: 'bad', title: 'Could not check the token', body: err.message }));
    }
  }

  const check = button({ label: 'Check token', icon: 'check', onClick: () => runCheck(check) });

  const password = h('input', { class: 'input', id: 'new-password', type: 'password', autocomplete: 'new-password', 'aria-describedby': 'password-help' });
  const repeat = h('input', { class: 'input', id: 'repeat-password', type: 'password', autocomplete: 'new-password' });
  const error = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const save = button({ label: 'Save and open the dashboard', icon: 'lock', variant: 'primary', type: 'submit' });

  function fail(message, steps) {
    error.replaceChildren(icon('alert'), h('span', null, message));
    error.hidden = false;
    if (steps) showResults({ ok: false, steps });
  }

  const link = defaults.projectId ? `https://railway.com/project/${encodeURIComponent(defaults.projectId)}/settings/tokens` : 'https://railway.com/dashboard';

  const step1 = h(
    'section',
    { class: 'wiz' },
    h('div', { class: 'wiz__num', 'aria-hidden': 'true' }, '1'),
    h('h2', { class: 'wiz__title' }, 'Create a Railway token'),
    h(
      'div',
      { class: 'wiz__body' },
      h('p', { class: 'muted' }, 'A token is a long password that lets this dashboard control your bots. Make a project token: it works for one project only, so it is the safest kind.'),
      h(
        'ol',
        { class: 'wiz__steps' },
        h('li', null, 'Open your project on Railway and go to Settings, then Tokens.'),
        h('li', null, 'Name the token VOLA Control and choose the environment your bots run in. This is usually production.'),
        h('li', null, 'Press Create, then copy the token. Railway shows it only once.'),
      ),
      h('div', null, h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Open Railway token settings')),
    ),
  );

  step2.append(
    h('div', { class: 'wiz__num', 'aria-hidden': 'true' }, '2'),
    h('h2', { class: 'wiz__title' }, 'Paste the token'),
    h(
      'div',
      { class: 'wiz__body' },
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'token' }, 'Railway token'), h('div', { class: 'field__row' }, token, showToken), h('p', { class: 'field__hint', id: 'token-help' }, 'It stays on this computer, in the file called .env next to the dashboard.')),
      more,
      h('div', null, check),
      results,
    ),
  );

  const step3 = h(
    'section',
    { class: 'wiz' },
    h('div', { class: 'wiz__num', 'aria-hidden': 'true' }, '3'),
    h('h2', { class: 'wiz__title' }, 'Choose a dashboard password'),
    h(
      'div',
      { class: 'wiz__body' },
      h('p', { class: 'muted', id: 'password-help' }, 'Anyone who knows this password can stop and change your bots. Use at least 8 characters.'),
      h('div', { class: 'form-grid form-grid--2' }, h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'new-password' }, 'Password'), password), h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'repeat-password' }, 'Type it again'), repeat)),
      error,
      h('div', null, save),
    ),
  );

  const blocked = locked.connection || locked.password;
  const form = h(
    'form',
    {
      class: 'wizard',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (!token.value.trim()) {
          token.focus();
          fail('Paste your Railway token in step 2.');
          return;
        }
        if (password.value.length < 8) {
          password.focus();
          fail('Choose a password with at least 8 characters.');
          return;
        }
        if (password.value !== repeat.value) {
          repeat.focus();
          fail('The two passwords are not the same.');
          return;
        }
        try {
          await withBusy(save, () => post('/api/setup/save', { token: token.value, password: password.value, projectId: projectId.value, environmentId: environmentId.value }));
          onDone();
        } catch (err) {
          fail(err.message, err.steps);
        }
      },
    },
    blocked
      ? note({
          kind: 'warn',
          title: 'Some settings come from your computer',
          body: 'A Railway token or a dashboard password is already set as an environment variable, so this page cannot change it. Remove that variable or set both values the same way, then reload.',
        })
      : null,
    step1,
    step2,
    step3,
  );

  const logo = mark({ cells: 6 });
  [...logo.children].forEach((cell, i) => {
    cell.dataset.state = i < 5 ? 'online' : 'empty';
  });

  card.replaceChildren(
    logo,
    h('div', null, h('h1', null, 'Set up VOLA Control'), h('p', { class: 'auth__lead' }, 'Three short steps, and you can control your bots from here.')),
    form,
    h('p', { class: 'muted' }, 'Only the computer that runs the dashboard can do this setup.'),
  );
}
