'use strict';

const OWNER_LOCK = 'cc-whatsapp-inbox-staging-v1';
const unavailable = code => Object.assign(Error(code), { code, inboxDatabaseUnavailable: true });
const zero = value => value === 0 || value === '0';

function destroyOwnedConnection(current) {
  // mysql2.destroy() currently calls stream.end(), which can leave a failed
  // peer half-open and prevent the supervisor from observing process exit.
  // Capture only this dedicated connection's transport before driver cleanup.
  const stream = (current?.connection || current)?.stream;
  try { current?.destroy?.(); } catch {}
  try { stream?.destroy?.(); } catch {}
}

// A lost session is never replaced while a poll/transaction is in progress.
// The existing supervisor restarts the consumer, which reacquires ownership
// before reconciling durable receipts. No SQL statement is retried here.
function createInboxDatabaseSession({ connect, tables, isStopping = () => false, closeTimeoutMs = 3000, checkTimeoutMs = 3000 }) {
  if (typeof connect !== 'function' || !Array.isArray(tables)
    || tables.some(table => !/^[A-Za-z][A-Za-z0-9_]*$/.test(table))) throw Error('inbox_database_session_configuration_invalid');
  let connection, opening, closing, closed = false, lost = false;
  const running = () => { if (closed || isStopping()) throw unavailable('inbox_database_stopped'); };
  const bounded = async operation => {
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => { destroyOwnedConnection(connection); reject(unavailable('inbox_database_session_unavailable')); }, checkTimeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  const state = async () => {
    running();
    if (!connection || lost) throw unavailable('inbox_database_session_unavailable');
    let row;
    try {
      [[row]] = await bounded(() => connection.execute('SELECT CONNECTION_ID() AS connection_id,IS_USED_LOCK(?) AS owner_id,@@GLOBAL.read_only AS read_only,@@GLOBAL.super_read_only AS super_read_only', [OWNER_LOCK]));
    } catch { throw unavailable('inbox_database_session_unavailable'); }
    running();
    if (!row || !zero(row.read_only) || !zero(row.super_read_only)) throw unavailable('inbox_database_writer_required');
    return row;
  };
  const assertOwnership = async () => {
    const row = await state();
    if (!Number.isSafeInteger(Number(row.connection_id)) || Number(row.connection_id) <= 0
      || Number(row.owner_id) !== Number(row.connection_id)) throw unavailable('inbox_database_owner_lost');
    return connection;
  };
  const close = () => closing ||= (async () => {
    closed = true;
    if (opening) await opening.catch(() => {});
    if (!connection) return;
    const current = connection; connection = null;
    let timer;
    try {
      await Promise.race([Promise.resolve().then(() => current.end()).catch(() => {}),
        new Promise(resolve => { timer = setTimeout(resolve, closeTimeoutMs); })]);
    } finally { clearTimeout(timer); destroyOwnedConnection(current); }
  })();
  const open = () => {
    if (closed || isStopping()) return Promise.reject(unavailable('inbox_database_stopped'));
    if (opening) return opening;
    opening = (async () => {
      running();
      try { connection = await connect(); } catch { throw unavailable('inbox_database_connection_unavailable'); }
      // mysql2 single connections emit fatal errors even while idle. The next
      // ownership check drains the process instead of leaving an alive dead loop.
      (connection.connection || connection).on?.('error', () => { lost = true; });
      await state();
      let owner;
      try { [[owner]] = await bounded(() => connection.execute('SELECT GET_LOCK(?,0) AS acquired', [OWNER_LOCK])); }
      catch { throw unavailable('inbox_database_session_unavailable'); }
      running();
      if (Number(owner?.acquired) !== 1) throw unavailable('inbox_consumer_owner_exists');
      for (const table of tables) {
        running();
        try { await bounded(() => connection.query('SELECT 1 FROM ' + table + ' LIMIT 0')); }
        catch { throw unavailable('inbox_database_schema_unavailable'); }
      }
      await assertOwnership();
      return connection;
    })();
    return opening;
  };
  return { open, assertOwnership, close };
}

module.exports = { createInboxDatabaseSession, OWNER_LOCK };
