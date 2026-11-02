// Variables: the secrets and settings a bot reads when it starts (tokens, database addresses, and so on).
// Values stay hidden until you ask. They are fetched one by one and hide again after 30 seconds.

import { h, copyText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { get, post, put, botPath } from '../lib/api.js';
import { button, checkbox, confirmDialog, field, formDialog, toast, withBusy } from '../lib/ui.js';
import { boost, refresh } from '../lib/store.js';
import { plural } from '../lib/format.js';
import { note, emptyState } from './parts.js';

const NAME_OK = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_HELP = 'Use letters, numbers and underscores. The name cannot start with a number.';
const AUTO_HIDE_MS = 30_000;

export function createVariablesTab({ botId, getBot }) {
  let vars = [];
  let loaded = false;
  let error = null;
  let rendered = false;
  let filter = '';
  let destroyed = false;
  const revealed = new Map(); // name -> { value, timer }

  const list = h('div', { class: 'vars', role: 'list' });
  const slot = h('div');
  const count = h('span', { class: 'chip num' }, '…');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Find a variable', 'aria-label': 'Find a variable', autocomplete: 'off', onInput: () => { filter = search.value.trim().toLowerCase(); render(); } });
  const searchBox = h('div', { class: 'search', hidden: true }, icon('search'), search);
  const railwayOwn = checkbox({
    label: 'Also show variables made by Railway',
    checked: false,
    onChange: (on) => { rendered = on; hideAll(); load(); },
  });

  const addBtn = button({ label: 'Add variable', icon: 'plus', variant: 'primary', small: true, onClick: () => openEditor() });
  const importBtn = button({ label: 'Import .env', icon: 'upload', small: true, title: 'Paste several KEY=value lines at once', onClick: openImport });
  const showAllBtn = button({ label: 'Show all values', icon: 'eye', small: true, onClick: toggleAll });

  const el = h(
    'div',
    { class: 'tabview' },
    h(
      'section',
      { class: 'panel panel--flush' },
      h(
        'div',
        { class: 'panel__head' },
        h('div', { class: 'panel__tools' }, h('h2', null, 'Variables'), count),
        h('div', { class: 'panel__tools' }, searchBox, showAllBtn, importBtn, addBtn),
      ),
      h('div', { class: 'panel__bar' }, railwayOwn.el),
      slot,
      list,
    ),
    note({ kind: 'info', title: 'A bot reads its variables when it starts', body: 'After you change a value, the bot needs a redeploy before it uses the new value. The save buttons below can do that for you.' }),
  );

  // ---- loading
  async function load() {
    try {
      const data = await get(botPath(botId, `/variables${rendered ? '?rendered=1' : ''}`));
      vars = data.variables;
      error = null;
    } catch (err) {
      error = err;
    }
    loaded = true;
    render();
  }

  async function fetchValues(names) {
    const data = await post(botPath(botId, '/variables/reveal'), { names, rendered });
    return data.values;
  }

  // ---- showing and hiding values
  function hide(name) {
    const r = revealed.get(name);
    if (r) clearTimeout(r.timer);
    revealed.delete(name);
  }
  function hideAll() {
    for (const name of [...revealed.keys()]) hide(name);
    render();
  }
  function remember(name, value) {
    hide(name);
    const timer = setTimeout(() => {
      hide(name);
      if (!destroyed) render();
    }, AUTO_HIDE_MS);
    revealed.set(name, { value, timer });
  }

  async function toggleOne(name, btn) {
    if (revealed.has(name)) {
      hide(name);
      render();
      return;
    }
    try {
      const values = await withBusy(btn, () => fetchValues([name]));
      remember(name, values[name] ?? '');
      render();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  async function toggleAll() {
    if (revealed.size) {
      hideAll();
      return;
    }
    try {
      const values = await withBusy(showAllBtn, () => fetchValues(undefined));
      for (const [name, value] of Object.entries(values)) remember(name, value);
      render();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  async function copyOne(name, btn) {
    try {
      const r = revealed.get(name);
      const value = r ? r.value : (await withBusy(btn, () => fetchValues([name])))[name] ?? '';
      const ok = await copyText(value);
      toast(ok ? `Copied the value of ${name}.` : 'Your browser did not allow copying.', { kind: ok ? 'ok' : 'error' });
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  // ---- changing things
  function afterChange(message) {
    toast(message, { kind: 'ok' });
    boost();
    refresh({ maxAge: 0 });
    load();
  }

  async function openEditor({ name = '', existing = false } = {}) {
    let current = '';
    if (existing) {
      try {
        current = ((await fetchValues([name])) || {})[name] ?? '';
      } catch (err) {
        toast(err.message, { kind: 'error' });
        return;
      }
    }
    const nameInput = h('input', { class: 'input input--mono', id: 'var-name', autocomplete: 'off', spellcheck: 'false', readOnly: existing, value: name, autofocus: existing ? undefined : true });
    const valueInput = h('textarea', { class: 'textarea', id: 'var-value', rows: 5, spellcheck: 'false', autocomplete: 'off', autofocus: existing ? true : undefined });
    valueInput.value = current;
    const redeploy = checkbox({ label: 'Redeploy the bot after saving', hint: 'The bot only uses the new value after it redeploys.', checked: true });

    const result = await formDialog({
      title: existing ? `Change ${name}` : 'Add a variable',
      fields: [
        field({ label: 'Name', hint: existing ? 'The name cannot be changed. Add a new variable if you need another name.' : NAME_HELP, control: nameInput }),
        field({ label: 'Value', control: valueInput }),
        redeploy.el,
      ],
      submitLabel: existing ? 'Save' : 'Add variable',
      onSubmit: async () => {
        const n = nameInput.value.trim();
        if (!NAME_OK.test(n) || n.length > 255) throw new Error(NAME_HELP);
        const r = await put(botPath(botId, '/variables'), { name: n, value: valueInput.value, redeploy: redeploy.input.checked });
        return { name: n, redeployed: r.redeployed };
      },
    });
    if (!result) return;
    const bot = getBot();
    hide(result.name);
    afterChange(`Saved ${result.name}. ${result.redeployed ? `${bot ? bot.name : 'The bot'} is redeploying with the new value.` : 'The bot will use it after its next redeploy.'}`);
  }

  async function openImport() {
    const text = h('textarea', { class: 'textarea', id: 'import-text', rows: 9, spellcheck: 'false', autocomplete: 'off', autofocus: true, placeholder: 'DISCORD_TOKEN=abc123\nGUILD_ID=1234567890' });
    const redeploy = checkbox({ label: 'Redeploy the bot after importing', hint: 'The bot only uses the new values after it redeploys.', checked: true });
    const result = await formDialog({
      title: 'Import variables',
      size: 'lg',
      intro: 'Paste lines like KEY=value, the same as in a .env file. Existing variables with the same name are changed. Nothing is deleted.',
      fields: [field({ label: 'Lines to import', control: text }), redeploy.el],
      submitLabel: 'Import',
      onSubmit: async () => {
        if (!text.value.trim()) throw new Error('Paste some KEY=value lines first.');
        return post(botPath(botId, '/variables/import'), { text: text.value, redeploy: redeploy.input.checked });
      },
    });
    if (!result) return;
    afterChange(`Imported ${plural(result.count, 'variable')}. ${result.redeployed ? 'The bot is redeploying.' : 'The bot will use them after its next redeploy.'}`);
  }

  async function askDelete(name) {
    const { confirmed, checked } = await confirmDialog({
      title: `Delete ${name}?`,
      body: 'The bot will no longer have this variable. A bot that needs it may stop working.',
      confirmLabel: 'Delete variable',
      tone: 'danger',
      checkbox: { label: 'Redeploy the bot afterwards', hint: 'The bot only notices the change after it redeploys.', checked: true },
    });
    if (!confirmed) return;
    try {
      const r = await post(botPath(botId, '/variables/delete'), { name, redeploy: checked });
      hide(name);
      afterChange(`Deleted ${name}. ${r.redeployed ? 'The bot is redeploying.' : 'The bot will notice after its next redeploy.'}`);
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  // ---- drawing
  function row(v) {
    const shown = revealed.get(v.name);
    const eyeBtn = button({ label: shown ? `Hide ${v.name}` : `Show ${v.name}`, icon: shown ? 'eye-off' : 'eye', iconOnly: true, small: true, variant: 'quiet', title: shown ? 'Hide the value' : 'Show the value', onClick: () => toggleOne(v.name, eyeBtn) });
    const copyBtn = button({ label: `Copy ${v.name}`, icon: 'copy', iconOnly: true, small: true, variant: 'quiet', title: 'Copy the value', onClick: () => copyOne(v.name, copyBtn) });
    const tools = [eyeBtn, copyBtn];
    if (!rendered) {
      tools.push(
        button({ label: `Change ${v.name}`, icon: 'edit', iconOnly: true, small: true, variant: 'quiet', title: 'Change the value', onClick: () => openEditor({ name: v.name, existing: true }) }),
        button({ label: `Delete ${v.name}`, icon: 'trash', iconOnly: true, small: true, variant: 'quiet', title: 'Delete this variable', onClick: () => askDelete(v.name) }),
      );
    }
    const value = shown
      ? h('div', { class: 'var__value var__value--shown', dir: 'auto' }, shown.value === '' ? h('span', { class: 'muted' }, '(empty)') : shown.value)
      : h('div', { class: 'var__value' }, v.length ? ['•'.repeat(Math.min(v.length, 14)), h('span', { class: 'muted' }, `  ${plural(v.length, 'character')}`)] : h('span', { class: 'muted' }, '(empty)'));
    return h(
      'div',
      { class: 'var', role: 'listitem' },
      h('div', { class: 'var__name' }, v.name, v.kind === 'reference' ? h('span', { class: 'chip', title: 'This value points to another service, for example a database.' }, 'Linked') : null, v.kind === 'railway' ? h('span', { class: 'chip', title: 'Made by Railway. You cannot change it.' }, 'Railway') : null),
      value,
      h('div', { class: 'var__tools' }, tools),
    );
  }

  function render() {
    if (destroyed) return;
    count.textContent = loaded ? String(vars.length) : '…';
    searchBox.hidden = vars.length < 8;
    importBtn.hidden = rendered;
    addBtn.hidden = rendered;
    showAllBtn.hidden = !vars.length;
    const label = showAllBtn.querySelector('.btn__label');
    if (label) label.textContent = revealed.size ? 'Hide all values' : 'Show all values';

    slot.replaceChildren();
    if (error) {
      slot.appendChild(h('div', { class: 'panel__pad' }, note({ kind: 'bad', title: 'Could not read the variables', body: error.message, actions: [button({ label: 'Try again', icon: 'refresh', small: true, onClick: load })] })));
      list.replaceChildren();
      return;
    }
    if (!loaded) {
      list.replaceChildren(h('p', { class: 'muted panel__pad' }, 'Reading the variables…'));
      return;
    }
    const shown = vars.filter((v) => !filter || v.name.toLowerCase().includes(filter));
    if (!vars.length) {
      list.replaceChildren(emptyState({ title: 'No variables yet', text: 'Add the values this bot needs, for example its Discord token.', actions: [button({ label: 'Add variable', icon: 'plus', variant: 'primary', onClick: () => openEditor() })] }));
      return;
    }
    if (!shown.length) {
      list.replaceChildren(emptyState({ title: 'Nothing matches', text: `No variable has "${search.value.trim()}" in its name.` }));
      return;
    }
    list.replaceChildren(...shown.map(row));
  }

  render();
  load();

  return {
    el,
    destroy() {
      destroyed = true;
      for (const r of revealed.values()) clearTimeout(r.timer);
      revealed.clear();
    },
  };
}
