// Shared building blocks: buttons, messages (toasts) and dialogs.

import { h, uid } from './dom.js';
import { icon } from './icons.js';

// ------------------------------------------------------------------ buttons

/**
 * Buttons that are "not available" stay focusable (aria-disabled) so a tooltip can say why,
 * and a button that is working shows a spinner and ignores further clicks.
 */
export const isLocked = (el) => el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-busy') === 'true';

export function button({
  label,
  icon: iconName,
  variant = '',
  title = '',
  onClick,
  type = 'button',
  small = false,
  iconOnly = false,
  hideLabelOnSmall = false,
  className = '',
} = {}) {
  const classes = ['btn', variant && `btn--${variant}`, small && 'btn--small', iconOnly && 'btn--icon', className].filter(Boolean).join(' ');
  const el = h(
    'button',
    { type, class: classes, title: title || undefined, 'aria-label': iconOnly || hideLabelOnSmall ? label : undefined, dataset: { title } },
    iconName && icon(iconName),
    !iconOnly && h('span', { class: hideLabelOnSmall ? 'btn__label hide-sm' : 'btn__label' }, label),
  );
  el.addEventListener('click', (event) => {
    if (isLocked(el)) {
      event.preventDefault();
      return;
    }
    if (onClick) onClick(event);
  });
  return el;
}

export function setLocked(el, locked, reason = '') {
  if (locked) {
    el.setAttribute('aria-disabled', 'true');
    if (reason) el.title = reason;
  } else {
    el.removeAttribute('aria-disabled');
    if (el.dataset.title) el.title = el.dataset.title;
    else el.removeAttribute('title');
  }
}

export function setLabel(el, text) {
  const span = el.querySelector('.btn__label');
  if (span && span.textContent !== text) span.textContent = text;
}

export function setIcon(el, name) {
  const old = el.querySelector('svg.icon');
  if (old && old.dataset.name === name) return;
  const fresh = icon(name);
  fresh.dataset.name = name;
  if (old) old.replaceWith(fresh);
  else el.prepend(fresh);
}

export async function withBusy(el, fn) {
  if (!el) return fn();
  if (el.getAttribute('aria-busy') === 'true') return undefined;
  const first = el.querySelector('svg.icon');
  const spinner = icon('loader', { className: 'spin' });
  el.setAttribute('aria-busy', 'true');
  if (first) first.replaceWith(spinner);
  else el.prepend(spinner);
  try {
    return await fn();
  } finally {
    el.removeAttribute('aria-busy');
    if (first && spinner.isConnected) spinner.replaceWith(first);
    else spinner.remove();
  }
}

// ------------------------------------------------------------------ toasts

export function toast(message, { kind = 'info', timeout } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const ms = timeout ?? (kind === 'error' ? 11000 : 5500);
  let timer = null;
  const el = h(
    'div',
    { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'ok' ? 'check-circle' : kind === 'error' ? 'alert' : 'info'),
    h('p', null, message),
    h('button', { class: 'btn btn--quiet btn--icon btn--small', type: 'button', 'aria-label': 'Dismiss message', onClick: dismiss }, icon('x')),
  );
  function dismiss() {
    clearTimeout(timer);
    el.remove();
  }
  const arm = (t) => {
    clearTimeout(timer);
    timer = setTimeout(dismiss, t);
  };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => arm(3000));
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  arm(ms);
  return dismiss;
}

// ------------------------------------------------------------------ dialogs

/**
 * A dialog with a title, a scrolling body and a row of buttons.
 * The body and the buttons sit inside one <form>, so Enter submits.
 */
export function dialogShell({ title, size = 'md', drawer = false }) {
  const titleId = uid('dialog-title');
  const body = h('div', { class: 'dialog__body' });
  const foot = h('div', { class: 'dialog__foot' });
  const form = h('form', { class: 'dialog__form', novalidate: true }, body, foot);
  const dlg = h(
    'dialog',
    { class: `dialog dialog--${size}${drawer ? ' dialog--drawer' : ''}`, 'aria-labelledby': titleId },
    h(
      'div',
      { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: titleId }, title),
      h('button', { class: 'btn btn--quiet btn--icon', type: 'button', 'aria-label': 'Close', onClick: () => dlg.close() }, icon('x')),
    ),
    form,
  );
  const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
  // Never let Enter inside a dialog reload the page; the dialogs that submit add their own handler.
  form.addEventListener('submit', (e) => e.preventDefault());

  let pressedOnBackdrop = false;
  dlg.addEventListener('pointerdown', (e) => {
    pressedOnBackdrop = e.target === dlg;
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && pressedOnBackdrop) dlg.close();
  });
  const closed = new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      () => {
        dlg.remove();
        resolve();
      },
      { once: true },
    );
  });

  return {
    dlg,
    form,
    body,
    foot,
    closed,
    open() {
      document.body.appendChild(dlg);
      dlg.showModal();
    },
    close() {
      if (dlg.open) dlg.close();
    },
    setError(message) {
      if (!message) {
        errorBox.hidden = true;
        errorBox.replaceChildren();
        return;
      }
      errorBox.replaceChildren(icon('alert'), h('span', null, message));
      errorBox.hidden = false;
      if (!errorBox.isConnected) body.appendChild(errorBox);
      errorBox.scrollIntoView({ block: 'nearest' });
    },
  };
}

/** "Are you sure?" -> { confirmed, checked } */
export function confirmDialog({ title, body, list, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'normal', checkbox }) {
  return new Promise((resolve) => {
    const shell = dialogShell({ title, size: 'sm' });
    let checkInput = null;
    const outcome = { confirmed: false, checked: Boolean(checkbox && checkbox.checked) };

    const paragraphs = (Array.isArray(body) ? body : [body]).filter(Boolean);
    for (const p of paragraphs) shell.body.appendChild(typeof p === 'string' ? h('p', null, p) : p);
    if (list && list.length) {
      shell.body.appendChild(
        h(
          'ul',
          { class: 'dialog__list' },
          list.map((item) => h('li', null, item.icon ? icon(item.icon) : null, h('strong', null, item.text), item.note ? h('span', { class: 'muted' }, item.note) : null)),
        ),
      );
    }
    if (checkbox) {
      checkInput = h('input', { type: 'checkbox', checked: Boolean(checkbox.checked) });
      shell.body.appendChild(
        h('label', { class: 'check' }, checkInput, h('span', { class: 'check__text' }, h('span', null, checkbox.label), checkbox.hint ? h('span', { class: 'check__hint' }, checkbox.hint) : null)),
      );
    }

    const danger = tone === 'danger';
    const cancel = h('button', { type: 'button', class: 'btn', onClick: () => shell.close(), autofocus: danger ? true : undefined }, cancelLabel);
    const confirm = h('button', { type: 'submit', class: `btn ${danger ? 'btn--danger-solid' : 'btn--primary'}`, autofocus: danger ? undefined : true }, confirmLabel);
    shell.foot.append(cancel, confirm);
    shell.form.addEventListener('submit', (e) => {
      e.preventDefault();
      outcome.confirmed = true;
      if (checkInput) outcome.checked = checkInput.checked;
      shell.close();
    });
    shell.closed.then(() => resolve(outcome));
    shell.open();
  });
}

/**
 * A dialog with fields. `onSubmit` may throw to show a message and keep the dialog open.
 * Resolves with what onSubmit returned, or null when the person cancelled.
 */
export function formDialog({ title, size = 'md', intro, fields, submitLabel = 'Save', tone = 'primary', cancelLabel = 'Cancel', onSubmit }) {
  return new Promise((resolve) => {
    const shell = dialogShell({ title, size });
    let result = null;
    let busy = false;
    if (intro) shell.body.appendChild(typeof intro === 'string' ? h('p', { class: 'muted' }, intro) : intro);
    for (const f of [].concat(fields || [])) shell.body.appendChild(f);

    const cancel = h('button', { type: 'button', class: 'btn', onClick: () => shell.close() }, cancelLabel);
    const submit = h('button', { type: 'submit', class: `btn ${tone === 'danger' ? 'btn--danger-solid' : 'btn--primary'}` }, submitLabel);
    shell.foot.append(cancel, submit);

    shell.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      shell.setError(null);
      cancel.setAttribute('aria-disabled', 'true');
      try {
        await withBusy(submit, async () => {
          result = await onSubmit();
          if (result === undefined) result = true;
        });
        shell.close();
      } catch (err) {
        shell.setError(err && err.message ? err.message : String(err));
        result = null;
        cancel.removeAttribute('aria-disabled');
        busy = false;
      }
    });
    shell.closed.then(() => resolve(result));
    shell.open();
  });
}

/** A labelled form control with optional help text. */
export function field({ label, hint, control, id }) {
  const fieldId = id || (control && control.id) || uid('field');
  if (control && !control.id) control.id = fieldId;
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'field__label', for: fieldId }, label),
    control,
    hint ? h('p', { class: 'field__hint', id: `${fieldId}-hint` }, hint) : null,
  );
}

export function checkbox({ label, hint, checked = false, onChange }) {
  const input = h('input', { type: 'checkbox', checked });
  if (onChange) input.addEventListener('change', () => onChange(input.checked));
  const el = h('label', { class: 'check' }, input, h('span', { class: 'check__text' }, h('span', null, label), hint ? h('span', { class: 'check__hint' }, hint) : null));
  return { el, input };
}
