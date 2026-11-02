// VOLA Control: decides what to show (setup, sign in, or the dashboard) and keeps it up to date.

import { h, mount } from './lib/dom.js';
import { setSignedOutHandler } from './lib/api.js';
import { state, loadSession, subscribe, start, stop, resetOverview } from './lib/store.js';
import { button } from './lib/ui.js';
import { renderLogin } from './views/login.js';
import { renderSetup } from './views/setup.js';
import { createShell } from './views/shell.js';
import { createHome } from './views/home.js';
import { createBotPage } from './views/bot.js';
import { note } from './views/parts.js';

const root = document.getElementById('app');
let shell = null;
let view = null;
let unsubscribe = null;
let tickTimer = null;

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function parseRoute(hash = location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decode);
  if (parts[0] === 'bot' && parts[1]) return { name: 'bot', id: parts[1], tab: parts[2] || 'overview', query: new URLSearchParams(queryPart) };
  return { name: 'home' };
}

function renderRoute({ moveFocus = true } = {}) {
  if (!shell) return;
  const route = parseRoute();
  let newPage = false;
  if (route.name === 'bot' && view && view.kind === 'bot' && view.id === route.id) {
    view.setTab(route.tab, route.query); // same bot, another section: keep the banner and buttons as they are
  } else {
    if (view && view.destroy) view.destroy();
    view = route.name === 'bot' ? createBotPage({ id: route.id, tab: route.tab, query: route.query }) : createHome();
    shell.main.replaceChildren(view.el);
    window.scrollTo(0, 0);
    newPage = true;
  }
  view.update(state);
  shell.setTitle(view.title);
  if (newPage && moveFocus) {
    // Put the reading position on the new page's title, so keyboard and screen reader users know where they are.
    const heading = document.getElementById('page-title');
    if (heading) heading.focus({ preventScroll: true });
  }
}

function onState(st) {
  if (!shell || !view) return;
  shell.update(st);
  view.update(st);
  shell.setTitle(view.title);
}

function enter() {
  shell = createShell({ onSignedOut: (notice) => leave(notice) });
  mount(root, shell.el);
  resetOverview();
  unsubscribe = subscribe(onState);
  renderRoute({ moveFocus: false });
  start();
  tickTimer = setInterval(() => {
    if (shell) shell.tick();
    if (view && view.tick) view.tick();
  }, 15_000);
}

function teardown() {
  stop();
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  clearInterval(tickTimer);
  if (view && view.destroy) view.destroy();
  view = null;
  shell = null;
}

function leave(notice) {
  teardown();
  boot(notice);
}

function fatal(err) {
  return h(
    'main',
    { class: 'auth' },
    h(
      'div',
      { class: 'auth__card' },
      h('h1', null, 'VOLA Control'),
      note({ kind: 'bad', title: 'The dashboard is not answering', body: err.message }),
      button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => boot() }),
    ),
  );
}

async function boot(notice) {
  let session;
  try {
    session = await loadSession();
  } catch (err) {
    mount(root, fatal(err));
    return;
  }
  if (session.needsSetup) {
    document.title = 'Set up - VOLA Control';
    mount(root, renderSetup({ onDone: () => boot() }));
    return;
  }
  if (!session.authenticated) {
    document.title = 'Sign in - VOLA Control';
    mount(root, renderLogin({ session, notice, onDone: () => boot() }));
    return;
  }
  document.title = 'VOLA Control';
  enter();
}

setSignedOutHandler(() => {
  if (shell) leave('You were signed out. Please sign in again.');
});
window.addEventListener('hashchange', () => renderRoute());
boot();
