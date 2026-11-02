// The first section of a bot: the important facts, the newest log lines, and help when it is down.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { get, botPath } from '../lib/api.js';
import { button, withBusy } from '../lib/ui.js';
import { firstLine, githubUrl, megabytes, shortHash, fullDate } from '../lib/format.js';
import { renderLogLines, showLogMessage, scrollToEnd } from './loglines.js';

const RESTART_WORDS = {
  ALWAYS: 'Starts again whenever it stops',
  ON_FAILURE: 'Starts again when it crashes',
  NEVER: 'Never starts again by itself',
};

function volumeRow(v) {
  const used = Number(v.usedMB);
  const size = Number(v.sizeMB);
  const known = Number.isFinite(used) && Number.isFinite(size) && size > 0;
  return h(
    'li',
    null,
    h('strong', null, v.name),
    ` at `,
    h('code', null, v.mountPath || '/'),
    known
      ? [
          h('progress', { class: 'progress', max: size, value: Math.min(used, size), 'data-level': used / size > 0.85 ? 'high' : '', 'aria-label': 'Space used' }),
          h('span', { class: 'muted num' }, `${megabytes(used)} of ${megabytes(size)} used`),
        ]
      : null,
  );
}

export function createOverviewTab({ botId, getBot }) {
  const facts = h('dl', { class: 'facts' });
  const logBox = h('div', { class: 'logbox logbox--mini logbox--wrap', tabindex: '0', role: 'region', 'aria-label': 'Newest log lines' });
  const fix = h('section', { class: 'panel', hidden: true });
  let timer = null;
  let shownKey = '';
  let logKey = '';
  let loading = false;
  let destroyed = false;

  const refreshBtn = button({ label: 'Refresh', icon: 'refresh', small: true, onClick: () => loadLogs(true) });
  const allLogs = h('a', { class: 'btn btn--small', href: `#/bot/${encodeURIComponent(botId)}/logs` }, icon('terminal'), 'Open all logs');

  async function loadLogs(manual = false) {
    const bot = getBot();
    if (loading || destroyed || !bot) return;
    if (!bot.deployment) {
      showLogMessage(logBox, 'This bot has not been deployed yet, so there are no logs.');
      return;
    }
    loading = true;
    try {
      const run = async () => {
        const data = await get(botPath(botId, '/logs?limit=40'));
        const lines = data.lines.slice(-14);
        if (!lines.length) {
          showLogMessage(logBox, 'No log lines yet. If the bot just started, wait a few seconds and press Refresh.');
          logBox.classList.remove('logbox--cut');
        } else {
          renderLogLines(logBox, lines);
          scrollToEnd(logBox);
          logBox.classList.toggle('logbox--cut', logBox.scrollTop > 2);
        }
      };
      if (manual) await withBusy(refreshBtn, run);
      else await run();
    } catch (err) {
      showLogMessage(logBox, `Could not read the logs. ${err.message}`);
    } finally {
      loading = false;
    }
  }

  function renderFacts(bot) {
    const d = bot.deployment;
    const rows = [];
    const add = (term, ...desc) => rows.push(h('dt', null, term), h('dd', null, ...desc));

    add('Status', `${bot.label}${d ? `, since ${fullDate(d.since)}` : ''}`);

    if (bot.source.repo) {
      const url = githubUrl(bot.source.repo);
      add('Code', url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, bot.source.repo) : bot.source.repo, d && d.commit && d.commit.branch ? ` on ${d.commit.branch}` : '');
    } else if (bot.source.image) {
      add('Image', h('code', null, bot.source.image));
    }

    if (d && d.commit) {
      const c = d.commit;
      const bits = [c.hash ? shortHash(c.hash) : null, c.author].filter(Boolean).join(', ');
      add('Running version', h('span', { dir: 'auto' }, firstLine(c.message) || c.reason || 'No message'), bits ? h('div', { class: 'muted' }, bits) : null);
    }

    if (bot.domains.length) {
      add('Public address', h('ul', null, bot.domains.map((domain) => h('li', null, h('a', { href: `https://${domain}`, target: '_blank', rel: 'noopener noreferrer' }, domain)))));
    }
    add('Restart rule', RESTART_WORDS[bot.restartPolicy] || bot.restartPolicy || 'Not set');
    add('Copies running', String(bot.numReplicas ?? 1));
    if (bot.startCommand) add('Start command', h('code', null, bot.startCommand));
    if (bot.cronSchedule) add('Runs on a timetable', h('code', null, bot.cronSchedule));
    if (bot.volumes.length) add('Storage', h('ul', null, bot.volumes.map(volumeRow)));

    facts.replaceChildren(...rows);
  }

  function renderFix(bot) {
    const down = bot.state === 'crashed' || bot.state === 'failed';
    fix.hidden = !down;
    if (!down) return;
    const base = `#/bot/${encodeURIComponent(botId)}`;
    fix.replaceChildren(
      h('h2', null, bot.state === 'crashed' ? 'This bot crashed. What to try' : 'The last deployment failed. What to try'),
      h(
        'ol',
        { class: 'fixlist' },
        h('li', null, 'Read the red lines in the log. They usually say what went wrong.'),
        h('li', null, 'If they mention a token, password or database address, open ', h('a', { href: `${base}/variables` }, 'Variables'), ' and check that value.'),
        h('li', null, 'Press Restart. If it crashes again, press Redeploy.'),
        h('li', null, 'Still stuck? Open ', h('a', { href: `${base}/deployments` }, 'Deployments'), ' and roll back to a version that worked.'),
      ),
    );
  }

  const el = h(
    'div',
    { class: 'cols' },
    h('section', { class: 'panel' }, h('h2', null, 'Details'), facts),
    h(
      'div',
      { class: 'tabview' },
      fix,
      h('section', { class: 'panel' }, h('div', { class: 'panel__head' }, h('h2', null, 'Newest log lines'), h('div', { class: 'panel__tools' }, refreshBtn, allLogs)), logBox),
    ),
  );

  function update(bot) {
    const key = JSON.stringify([bot.state, bot.label, bot.name, bot.deployment && [bot.deployment.id, bot.deployment.since, bot.deployment.commit], bot.domains, bot.volumes, bot.startCommand, bot.restartPolicy, bot.numReplicas]);
    if (key !== shownKey) {
      shownKey = key;
      renderFacts(bot);
      renderFix(bot);
    }
    const lk = `${bot.deployment ? bot.deployment.id : ''}|${bot.state}`;
    if (lk !== logKey) {
      logKey = lk;
      loadLogs();
    }
  }

  timer = setInterval(() => {
    if (!document.hidden) loadLogs();
  }, 20_000);
  showLogMessage(logBox, 'Reading the logs…');

  return {
    el,
    update,
    destroy() {
      destroyed = true;
      clearInterval(timer);
    },
  };
}
