'use strict';

// Incident containment for the observed legacy schema. Never boot the app or
// send mail. The caller supplies a dedicated mysql2 connection and a receipt.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { ADMIN_USER_IDS } = require('./role-helpers');

async function rotateGlobalAdminPasswords({ connection, expectedUsers, record }) {
  const ids = [...ADMIN_USER_IDS].sort((a, b) => a - b);
  if (ids.join(',') !== '1,44' || !Array.isArray(expectedUsers) || expectedUsers.length !== ids.length
    || expectedUsers.some((user, index) => user.id !== ids[index] || typeof user.email !== 'string' || !user.email)) {
    throw Error('admin_rotation_scope_changed');
  }
  const query = async (sql, values = []) => (await connection.execute({ sql, values, timeout: 5000 }))[0];
  const replacements = await Promise.all(ids.map(async id => ({ id,
    // 48 random bytes produce 64 ASCII characters, below bcrypt's 72-byte limit.
    hash: await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 12) })));
  let phase = 'preparing'; let started = false;
  try {
    await connection.beginTransaction(); started = true;
    // This operation was reviewed for legacy runtimes. A session-schema rollout
    // requires a different cut that revokes managed sessions/challenges too.
    const managed = await query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('AuthSessions','AuthEmailChallenges')");
    if (managed.length) throw Error('admin_rotation_schema_changed');
    const engines = await query("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('Usuarios','PasswordResetTokens')");
    if (engines.length !== 2 || engines.some(row => row.ENGINE !== 'InnoDB')) throw Error('admin_rotation_transaction_required');
    const users = await query('SELECT id_usuario,email_usuario,password_usuario,estado_cuenta,es_provisional FROM Usuarios WHERE id_usuario IN (?,?) ORDER BY id_usuario FOR UPDATE', ids);
    if (users.length !== ids.length || users.some((user, index) => Number(user.id_usuario) !== ids[index]
      || user.email_usuario !== expectedUsers[index].email || user.estado_cuenta !== 'activo'
      || Number(user.es_provisional) !== 0 || !user.password_usuario)) throw Error('admin_rotation_inventory_changed');
    let revokedResetLinks = 0;
    for (const replacement of replacements) {
      const result = await query('UPDATE Usuarios SET password_usuario=?,updatedAt=UTC_TIMESTAMP(3) WHERE id_usuario=?', [replacement.hash, replacement.id]);
      if (result.affectedRows !== 1) throw Error('admin_rotation_update_failed');
      const reset = await query("UPDATE PasswordResetTokens SET status='revoked',updated_at=UTC_TIMESTAMP(3) WHERE user_id=? AND status='pending'", [replacement.id]);
      revokedResetLinks += reset.affectedRows;
    }
    const after = await query('SELECT id_usuario,password_usuario FROM Usuarios WHERE id_usuario IN (?,?) ORDER BY id_usuario', ids);
    const pending = await query("SELECT COUNT(*) AS remaining FROM PasswordResetTokens WHERE user_id IN (?,?) AND status='pending'", ids);
    if (after.length !== ids.length || after.some((user, index) => user.password_usuario !== replacements[index].hash
      || user.password_usuario === users[index].password_usuario) || Number(pending[0].remaining) !== 0) throw Error('admin_rotation_verification_failed');
    const result = { userIds: ids, changedPasswords: ids.length, revokedResetLinks, oldJwtSessionsRevoked: false,
      method: 'random_48_bytes_bcrypt_12_no_password_retained', verifiedInsideTransaction: true };
    await record({ status: 'commit_pending', ...result });
    phase = 'committing';
    await connection.commit(); phase = 'committed';
    await record({ status: 'committed', ...result });
    return result;
  } catch {
    let rollbackConfirmed = !started;
    if (started && phase === 'preparing') {
      try { await connection.rollback(); rollbackConfirmed = true; } catch {}
    }
    // A missing COMMIT acknowledgement must never trigger an automatic replay.
    const status = phase === 'committed' ? 'committed_receipt_failed'
      : phase === 'committing' ? 'commit_outcome_unknown' : rollbackConfirmed ? 'rolled_back' : 'rollback_unconfirmed';
    try { await record({ status, userIds: ids, oldJwtSessionsRevoked: false }); } catch {}
    throw Error('admin_rotation_' + status);
  } finally {
    for (const replacement of replacements) replacement.hash = null;
  }
}

module.exports = { rotateGlobalAdminPasswords };
