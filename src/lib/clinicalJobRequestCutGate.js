'use strict';
// Operator-only, short-lived admission barrier for the existing SQL scheduler.
// A dedicated connection owns the lock. No application models or job handlers.
const { createHash } = require('node:crypto');
async function acquireClinicalJobRequestCutGate({ connect, database, lockWaitSeconds = 2 }) {
  if (typeof connect !== 'function' || !/^[A-Za-z0-9_]{1,64}$/.test(database || '')
    || !Number.isInteger(lockWaitSeconds) || lockWaitSeconds < 1 || lockWaitSeconds > 5) {
    throw Error('clinical_cut_gate_arguments_invalid');
  }
  const connection = await connect();
  const query = async (sql, values = []) => (await connection.query({ sql, values, timeout: (lockWaitSeconds + 2) * 1000 }))[0];
  const name = 'cc_job_cut_' + createHash('sha256').update(database).digest('hex').slice(0, 32);
  let tableLocked = false, namedLocked = false, closing, id;
  const release = () => {
    if (!closing) closing = (async () => {
      try {
        if (tableLocked) { await query('COMMIT'); await query('UNLOCK TABLES'); }
        if (namedLocked) await query('SELECT RELEASE_LOCK(?) AS released', [name]);
      } finally { await connection.end(); }
    })();
    return closing;
  };
  const verify = async () => {
    if (closing || !tableLocked) throw Error('clinical_cut_gate_not_held');
    const [owner] = await query('SELECT CONNECTION_ID() AS id, DATABASE() AS db, IS_USED_LOCK(?) AS owner', [name]);
    if (Number(owner.id) !== id || Number(owner.owner) !== id || owner.db !== database) throw Error('clinical_cut_gate_owner_changed');
    const [{ n }] = await query("SELECT COUNT(*) AS n FROM JobRequests WHERE status='running'");
    if (Number(n) !== 0) throw Error('clinical_cut_gate_active_jobs');
    return { connectionId: id, database, runningJobs: 0 };
  };
  try {
    const [target] = await query('SELECT DATABASE() AS db, CONNECTION_ID() AS id, @@autocommit AS autocommit');
    if (target.db !== database || Number(target.autocommit) !== 1) throw Error('clinical_cut_gate_connection_invalid');
    id = Number(target.id);
    const [{ acquired }] = await query('SELECT GET_LOCK(?,0) AS acquired', [name]);
    if (Number(acquired) !== 1) throw Error('clinical_cut_gate_busy');
    namedLocked = true;
    const [{ n: triggers }] = await query('SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', ['JobRequests']);
    if (Number(triggers)) throw Error('clinical_cut_gate_triggers_require_review');
    await query('SET SESSION lock_wait_timeout=?', [lockWaitSeconds]);
    await query('SET SESSION innodb_lock_wait_timeout=?', [lockWaitSeconds]);
    await query('SET autocommit=0');
    await query('LOCK TABLES JobRequests READ');
    tableLocked = true;
    await verify();
    return Object.freeze({ connectionId: id, database, verify, release });
  } catch (error) {
    try { await release(); } catch { /* Closing the owned connection releases locks. */ }
    throw error;
  }
}
module.exports = { acquireClinicalJobRequestCutGate };
