import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { post } from '../lib/api.js';
import { button, withBusy } from '../lib/ui.js';
import { mark } from './parts.js';

export function renderLogin({ session, notice, onDone }) {
  const password = h('input', {
    class: 'input',
    id: 'password',
    type: 'password',
    name: 'password',
    autocomplete: 'current-password',
    required: true,
    autofocus: true,
    'aria-describedby': 'login-error',
  });
  const error = h('div', { class: 'form-error', id: 'login-error', role: 'alert', hidden: true });
  const submit = button({ label: 'Sign in', variant: 'primary', type: 'submit', className: 'btn--block' });

  function showError(message) {
    error.replaceChildren(icon('alert'), h('span', null, message));
    error.hidden = false;
    password.setAttribute('aria-invalid', 'true');
  }

  const form = h(
    'form',
    {
      class: 'form-grid',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        password.removeAttribute('aria-invalid');
        if (!password.value) {
          showError('Type your dashboard password.');
          password.focus();
          return;
        }
        try {
          await withBusy(submit, () => post('/api/login', { password: password.value }));
          onDone();
        } catch (err) {
          showError(err.message);
          password.select();
        }
      },
    },
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'password' }, 'Password'), password),
    error,
    submit,
  );

  return h(
    'main',
    { class: 'auth' },
    h(
      'div',
      { class: 'auth__card' },
      mark({ hero: true, cells: 6 }),
      h('div', null, h('h1', null, 'VOLA Control'), h('p', { class: 'auth__lead' }, 'Sign in to manage your bots.')),
      notice ? h('div', { class: 'form-error', role: 'status' }, icon('info'), h('span', null, notice)) : null,
      form,
      session && session.demo
        ? h('p', { class: 'auth__hint' }, 'Demo mode: the bots are pretend and nothing on Railway is touched. ', session.demoHint ? ['The password is ', h('code', null, session.demoHint), '.'] : null)
        : null,
    ),
  );
}
