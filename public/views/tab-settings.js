// Settings: how Railway starts, restarts and scales this bot. Only what you change is sent.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { get, patch, post, botPath } from '../lib/api.js';
import { button, checkbox, field, toast, withBusy } from '../lib/ui.js';
import { boost, refresh } from '../lib/store.js';
import { note } from './parts.js';

const RESTART_CHOICES = [
  ['ON_FAILURE', 'Start again if it crashes'],
  ['ALWAYS', 'Always start again'],
  ['NEVER', 'Do not start again'],
];

const GROUPS = [
  {
    title: 'How the bot starts',
    text: 'Railway usually works these out by itself. Change them only if you know why.',
    fields: [
      { key: 'startCommand', kind: 'text', mono: true, label: 'Start command', hint: 'The command that starts the bot, for example node index.js. Leave it empty to let Railway decide.' },
      { key: 'buildCommand', kind: 'text', mono: true, label: 'Build command', hint: 'Runs once before the bot starts, for example npm run build. Most bots do not need one.' },
      { key: 'rootDirectory', kind: 'text', mono: true, label: 'Folder in the repository', hint: 'Only needed when the bot lives in a sub-folder of its GitHub repository.' },
    ],
  },
  {
    title: 'If the bot stops',
    fields: [
      { key: 'restartPolicyType', kind: 'select', label: 'Restart rule', choices: RESTART_CHOICES, hint: 'What Railway does when the bot stops by itself.' },
      { key: 'restartPolicyMaxRetries', kind: 'number', min: 0, max: 10, label: 'Tries before giving up', hint: 'How many times Railway tries to start it again (0 to 10).', onlyWhen: (v) => v.restartPolicyType === 'ON_FAILURE' },
    ],
  },
  {
    title: 'Health check',
    text: 'For bots that have a web page. A Discord bot without one can skip this.',
    fields: [
      { key: 'healthcheckPath', kind: 'text', mono: true, label: 'Health check address', hint: 'A web address inside the bot that answers when it is healthy, for example /health.' },
      { key: 'healthcheckTimeout', kind: 'number', min: 1, max: 3600, nullable: true, label: 'Wait time in seconds', hint: 'How long Railway waits for that answer. Leave empty for the default.' },
    ],
  },
  {
    title: 'Copies and timetable',
    fields: [
      { key: 'numReplicas', kind: 'number', min: 1, max: 50, label: 'Copies running at the same time', hint: 'A Discord bot almost always needs exactly 1. With 2 copies, every message is answered twice.' },
      { key: 'cronSchedule', kind: 'text', mono: true, label: 'Timetable', hint: 'Only for a bot that runs on a schedule, for example 0 * * * * for every hour. Leave empty for a bot that runs all the time.' },
      { key: 'sleepApplication', kind: 'check', label: 'Pause the bot when nothing uses it', hint: 'A Discord bot should stay awake, so leave this off.' },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);

function normalize(def, value) {
  if (def.kind === 'check') return Boolean(value);
  if (def.kind === 'number') {
    if (value === '' || value === null || value === undefined) return null;
    return Number(value);
  }
  return String(value ?? '').trim();
}

export function createSettingsTab({ botId, getBot }) {
  let original = null;
  let lastName = '';
  let destroyed = false;
  const controls = new Map(); // key -> { def, read, write, wrap }

  const body = h('div', { class: 'tabview' }, h('p', { class: 'muted' }, 'Reading the settings…'));

  // ---- rename
  const renameInput = h('input', { class: 'input', id: 'rename', maxlength: '64', autocomplete: 'off' });
  const renameBtn = button({
    label: 'Rename',
    icon: 'edit',
    onClick: async () => {
      const name = renameInput.value.trim();
      const bot = getBot();
      if (!name || (bot && name === bot.name)) {
        toast('Type a new name first.', { kind: 'info' });
        return;
      }
      try {
        await withBusy(renameBtn, () => post(botPath(botId, '/rename'), { name }));
        toast(`Renamed to ${name}.`, { kind: 'ok' });
        refresh({ maxAge: 0 });
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    },
  });

  // ---- the form
  const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const status = h('span', { role: 'status' });
  const discard = button({ label: 'Discard changes', onClick: () => fill(original) });
  const save = button({ label: 'Save', icon: 'check', variant: 'primary', onClick: () => submit(false, save) });
  const saveRedeploy = button({ label: 'Save and redeploy', icon: 'rocket', onClick: () => submit(true, saveRedeploy), title: 'Save, then build and start the bot again so it uses the new settings' });
  const formbar = h('div', { class: 'formbar', hidden: true }, status, h('div', { class: 'formbar__buttons' }, discard, saveRedeploy, save));

  // The save bar sticks to the bottom of the window. Lift the messages above it so they never cover its buttons.
  function liftMessages() {
    const lift = formbar.hidden || !formbar.isConnected ? 0 : formbar.offsetHeight + 16;
    document.documentElement.style.setProperty('--toast-lift', `${lift}px`);
  }
  const barWatcher = typeof ResizeObserver === 'function' ? new ResizeObserver(liftMessages) : null;
  if (barWatcher) barWatcher.observe(formbar);

  function buildControl(def) {
    const id = `set-${def.key}`;
    if (def.kind === 'check') {
      const c = checkbox({ label: def.label, hint: def.hint, onChange: changed });
      return { wrap: c.el, read: () => c.input.checked, write: (v) => { c.input.checked = Boolean(v); } };
    }
    let input;
    if (def.kind === 'select') {
      input = h('select', { class: 'select', id }, def.choices.map(([value, label]) => h('option', { value }, label)));
      input.addEventListener('change', changed);
    } else if (def.kind === 'number') {
      input = h('input', { class: 'input', id, type: 'number', inputmode: 'numeric', min: String(def.min), max: String(def.max), step: '1' });
      input.addEventListener('input', changed);
    } else {
      input = h('input', { class: `input${def.mono ? ' input--mono' : ''}`, id, type: 'text', autocomplete: 'off', spellcheck: 'false' });
      input.addEventListener('input', changed);
    }
    return {
      wrap: field({ label: def.label, hint: def.hint, control: input, id }),
      read: () => input.value,
      write: (v) => { input.value = v === null || v === undefined ? '' : String(v); },
    };
  }

  function readAll() {
    const out = {};
    for (const [key, c] of controls) out[key] = c.read();
    return out;
  }

  function diff() {
    if (!original) return {};
    const now = readAll();
    const changes = {};
    for (const def of ALL_FIELDS) {
      const a = normalize(def, now[def.key]);
      const b = normalize(def, original[def.key]);
      if (a !== b) changes[def.key] = a;
    }
    return changes;
  }

  function changed() {
    const now = readAll();
    for (const [key, c] of controls) {
      if (c.def.onlyWhen) c.wrap.hidden = !c.def.onlyWhen(now);
    }
    const n = Object.keys(diff()).length;
    formbar.hidden = n === 0;
    liftMessages();
    status.textContent = n ? `You changed ${n} ${n === 1 ? 'setting' : 'settings'}. Nothing is saved yet.` : '';
    errorBox.hidden = true;
  }

  function fill(values) {
    for (const [key, c] of controls) c.write(values[key]);
    changed();
  }

  async function submit(redeploy, btn) {
    const changes = diff();
    if (!Object.keys(changes).length) return;
    errorBox.hidden = true;
    try {
      const r = await withBusy(btn, () => patch(botPath(botId, '/settings'), { changes, redeploy }));
      toast(`Saved ${r.applied.length === 1 ? 'one setting' : `${r.applied.length} settings`}.${r.redeployed ? ' The bot is redeploying.' : ' They apply the next time the bot is deployed.'}`, { kind: 'ok' });
      boost();
      refresh({ maxAge: 0 });
      await load();
    } catch (err) {
      errorBox.replaceChildren(icon('alert'), h('span', null, err.message));
      errorBox.hidden = false;
      errorBox.scrollIntoView({ block: 'nearest' });
    }
  }

  function build(data) {
    controls.clear();
    const groups = GROUPS.map((g) =>
      h(
        'section',
        { class: 'group' },
        h('div', { class: 'group__head' }, h('h3', null, g.title), g.text ? h('p', null, g.text) : null),
        h(
          'div',
          { class: 'form-grid form-grid--2' },
          g.fields.map((def) => {
            const c = buildControl(def);
            controls.set(def.key, { def, ...c });
            return c.wrap;
          }),
        ),
      ),
    );

    const facts = h(
      'dl',
      { class: 'facts' },
      h('dt', null, 'Code from'),
      h('dd', null, data.source.repo ? `GitHub: ${data.source.repo}` : data.source.image ? `Image: ${data.source.image}` : 'Not set'),
      data.builder ? [h('dt', null, 'Builder'), h('dd', null, data.builder)] : null,
      data.region ? [h('dt', null, 'Region'), h('dd', null, data.region)] : null,
      data.dockerfilePath ? [h('dt', null, 'Dockerfile'), h('dd', null, h('code', null, data.dockerfilePath))] : null,
    );

    body.replaceChildren(
      h('section', { class: 'panel' }, h('h2', null, 'Name'), h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'rename' }, 'Bot name on Railway'), h('div', { class: 'field__row' }, renameInput, renameBtn), h('p', { class: 'field__hint' }, 'Other services that refer to this bot by its name in their variables may need to be updated.'))),
      h('section', { class: 'panel' }, h('h2', null, 'Settings'), ...groups, errorBox),
      h('section', { class: 'panel' }, h('h2', null, 'Good to know'), facts),
      formbar,
    );
  }

  async function load() {
    try {
      const data = await get(botPath(botId, '/settings'));
      if (destroyed) return;
      original = data.settings;
      if (!controls.size) build(data);
      renameInput.value = data.name;
      lastName = data.name;
      fill(original);
    } catch (err) {
      if (destroyed) return;
      body.replaceChildren(note({ kind: 'bad', title: 'Could not read the settings', body: err.message, actions: [button({ label: 'Try again', icon: 'refresh', small: true, onClick: load })] }));
    }
  }

  load();

  return {
    el: body,
    update(bot) {
      if (controls.size && document.activeElement !== renameInput && lastName !== bot.name) {
        renameInput.value = bot.name;
        lastName = bot.name;
      }
    },
    destroy() {
      destroyed = true;
      if (barWatcher) barWatcher.disconnect();
      document.documentElement.style.removeProperty('--toast-lift');
    },
  };
}
