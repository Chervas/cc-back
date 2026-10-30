'use strict';

// Process-local report snapshots. Operational reads and permission checks remain
// outside this cache; no provider, job or queue is created here.
function createReportReadCache({ freshMs = 60000, staleMs = 300000, maxEntries = 64, now = Date.now } = {}) {
  const entries = new Map(), pending = new Map();
  let generation = 0;
  const touch = (key, entry) => { entries.delete(key); entries.set(key, entry); };
  function refresh(key, load) {
    if (pending.has(key)) return pending.get(key);
    const version = generation;
    const task = Promise.resolve().then(load).then(value => {
      if (version === generation) {
        touch(key, { value, at: now(), error: false });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      }
      return value;
    }).finally(() => { if (pending.get(key) === task) pending.delete(key); });
    pending.set(key, task);
    return task;
  }
  async function read(key, load, { force = false } = {}) {
    const entry = entries.get(key), age = entry ? now() - entry.at : Infinity;
    if (!force && entry && age < freshMs) {
      touch(key, entry);
      return { value: entry.value, status: 'hit', generated_at: new Date(entry.at).toISOString() };
    }
    if (!force && entry && age < staleMs) {
      touch(key, entry);
      refresh(key, load).catch(() => { if (entries.get(key) === entry) entry.error = true; });
      return { value: entry.value, status: entry.error ? 'stale-error' : 'refreshing', generated_at: new Date(entry.at).toISOString() };
    }
    const value = await refresh(key, load);
    return { value, status: 'miss', generated_at: new Date(now()).toISOString() };
  }
  // An in-flight read started before a mutation may finish, but cannot repopulate
  // the new cache generation or be reused by a post-mutation read.
  function clear() { generation++; entries.clear(); pending.clear(); }
  return { read, clear, size: () => entries.size };
}

module.exports = { createReportReadCache };
