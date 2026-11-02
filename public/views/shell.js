// The frame around every screen: the top bar and the room for the current page.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { post } from '../lib/api.js';
import { button, withBusy } from '../lib/ui.js';
import { ago, railwayUrl } from '../lib/format.js';
import { refresh } from '../lib/store.js';
import { mark, setMarkCells, setFavicon } from './parts.js';
import { openActivity } from './activity.js';
import { openSettings } from './settings-dialog.js';

function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set) return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function createShell({ onSignedOut }) {
  const brandMark = mark();
  const projectName = h('strong', null, '');
  const envName = h('span', null, '');
  const scope = h('span', { class: 'scope', hidden: true }, projectName, envName);
  const updated = h('span', { class: 'refresh-note num', role: 'status' });
  let latest = null;
  let pageTitle = '';
  let problems = 0;

  const refreshBtn = button({
    label: 'Refresh',
    icon: 'refresh',
    hideLabelOnSmall: true,
    title: 'Ask Railway for the newest state now',
    onClick: () => withBusy(refreshBtn, () => refresh({ force: true })),
  });
  const activityBtn = button({
    label: 'Activity',
    icon: 'pulse',
    hideLabelOnSmall: true,
    title: 'What was done from this dashboard',
    onClick: () => openActivity(),
  });
  const railwayLink = h(
    'a',
    { class: 'btn', href: 'https://railway.com/dashboard', target: '_blank', rel: 'noopener noreferrer', title: 'Open your project on Railway', 'aria-label': 'Open the project on Railway' },
    icon('external'),
    h('span', { class: 'btn__label hide-sm' }, 'Railway'),
  );
  const settingsBtn = button({
    label: 'Settings',
    icon: 'gear',
    hideLabelOnSmall: true,
    title: 'Connection, password and checks',
    onClick: () => openSettings({ onSignedOut }),
  });
  const themeBtn = button({ label: 'Switch theme', icon: 'moon', iconOnly: true, onClick: toggleTheme });
  const signOut = button({
    label: 'Sign out',
    icon: 'logout',
    hideLabelOnSmall: true,
    onClick: async () => {
      try {
        await post('/api/logout');
      } catch {
        /* signing out should always leave the page */
      }
      onSignedOut('');
    },
  });

  function syncThemeButton() {
    const dark = currentTheme() === 'dark';
    themeBtn.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
    themeBtn.title = dark ? 'Light theme' : 'Dark theme';
    themeBtn.querySelector('svg').replaceWith(icon(dark ? 'sun' : 'moon'));
  }
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('vc-theme', next);
    } catch {
      /* the choice just will not be remembered */
    }
    syncThemeButton();
  }
  syncThemeButton();

  const main = h('main', { class: 'main container', id: 'main', tabindex: '-1' });
  const el = h(
    'div',
    { class: 'shell' },
    h(
      'header',
      { class: 'topbar' },
      h(
        'div',
        { class: 'topbar__inner container' },
        h('a', { class: 'brand', href: '#/', 'aria-label': 'VOLA Control, all bots' }, brandMark, 'VOLA Control'),
        scope,
        h('div', { class: 'topbar__actions' }, updated, refreshBtn, activityBtn, railwayLink, settingsBtn, themeBtn, signOut),
      ),
    ),
    main,
  );

  function applyTitle() {
    document.title = `${problems ? `(${problems}) ` : ''}${pageTitle ? `${pageTitle} - ` : ''}VOLA Control`;
  }

  function tickUpdated() {
    if (!latest || !latest.updatedAt) {
      updated.textContent = '';
      return;
    }
    const text = ago(new Date(latest.updatedAt).toISOString());
    updated.textContent = text === 'just now' ? 'Updated just now' : `Updated ${text}`;
  }

  function update(state) {
    latest = state;
    const ov = state.overview;
    if (ov) {
      scope.hidden = false;
      projectName.textContent = ov.project.name;
      envName.textContent = ov.environment.name;
      railwayLink.href = railwayUrl(ov);
      setMarkCells(brandMark, ov.bots);
      setFavicon(ov.bots);
      problems = ov.bots.filter((b) => b.state === 'crashed' || b.state === 'failed').length;
      applyTitle();
    }
    tickUpdated();
  }

  return {
    el,
    main,
    update,
    tick: tickUpdated,
    setTitle(title) {
      pageTitle = title || '';
      applyTitle();
    },
  };
}
