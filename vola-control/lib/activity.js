'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * A small audit trail of everything the dashboard did (restarts, variable changes, logins...).
 * Kept in memory and appended to data/activity.jsonl. Secret values are never written here.
 */
function createActivity({ dir, max = 200 } = {}) {
  const file = dir ? path.join(dir, 'activity.jsonl') : null;
  const entries = [];

  if (file) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines.slice(-max)) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          /* skip a damaged line */
        }
      }
      if (text.length > 1_000_000) {
        fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
    } catch {
      /* no file yet */
    }
  }

  function add(entry) {
    const e = { ts: new Date().toISOString(), ...entry };
    entries.push(e);
    if (entries.length > max) entries.splice(0, entries.length - max);
    if (file) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFile(file, JSON.stringify(e) + '\n', () => {});
      } catch {
        /* the audit file is best-effort */
      }
    }
    return e;
  }

  function list(limit = 50) {
    return entries.slice(-limit).reverse();
  }

  return { add, list };
}

module.exports = { createActivity };
