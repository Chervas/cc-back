'use strict';

const { createHash } = require('node:crypto');
const { getPhoneIdentityCandidates, normalizePhoneE164 } = require('./phone');
const { assertScope } = require('./whatsappInboxScopes');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };

// Explicit maintenance only. Never called by the live importer as a fallback.
async function repairOrphanedContactBinding(connection, { scope, clinicId, peer,
  expectedContactKey, expectedConversationId }) {
  if (!Number.isSafeInteger(clinicId) || clinicId < 1
    || !Number.isSafeInteger(expectedConversationId) || expectedConversationId < 1
    || !/^[1-9][0-9]{6,14}$/.test(peer || '')
    || !scope?.clinicIds?.includes(clinicId)
    || !/^[1-9][0-9]{0,29}$/.test(scope.phoneId || '')
    || hash([clinicId, scope.phoneId, peer]) !== expectedContactKey) fail('contact_repair_identity_mismatch');
  const query = async (sql, values = []) => (await connection.execute(sql, values))[0];
  const lock = 'wa-inbox:' + hash([clinicId, scope.phoneId]).slice(0, 48);
  let locked = false;
  let transaction = false;
  try {
    const [owner] = await query('SELECT GET_LOCK(?,2) acquired', [lock]);
    if (Number(owner.acquired) !== 1) fail('contact_repair_busy');
    locked = true;
    await connection.beginTransaction(); transaction = true;
    await assertScope(connection, scope, { lock: true });
    const bindings = await query('SELECT conversation_id FROM WhatsappInboxContactKeys WHERE contact_key=? FOR UPDATE', [expectedContactKey]);
    if (bindings.length !== 1 || bindings[0].conversation_id !== expectedConversationId) fail('contact_repair_binding_changed');
    if ((await query('SELECT id FROM Conversations WHERE id=? FOR UPDATE', [expectedConversationId])).length) fail('contact_repair_not_orphaned');
    const candidates = getPhoneIdentityCandidates('+' + peer);
    const rows = await query("SELECT id,contact_id FROM Conversations WHERE clinic_id=? AND channel='whatsapp' AND contact_id IN ("
      + candidates.map(() => '?').join(',') + ') ORDER BY id LIMIT 2 FOR UPDATE', [clinicId, ...candidates]);
    if (rows.length > 1 || rows.some(row => normalizePhoneE164(row.contact_id) !== '+' + peer)) fail('contact_repair_ambiguous');
    let conversationId = rows[0]?.id;
    const created = !conversationId;
    if (created) {
      const inserted = await query("INSERT INTO Conversations(clinic_id,channel,contact_id,unread_count,createdAt,updatedAt) VALUES(?,'whatsapp',?,0,NOW(3),NOW(3))", [clinicId, peer]);
      conversationId = inserted.insertId;
    } else if (![peer, '+' + peer].includes(rows[0].contact_id)) {
      await query('UPDATE Conversations SET contact_id=?,updatedAt=NOW(3) WHERE id=?', ['+' + peer, conversationId]);
    }
    const updated = await query('UPDATE WhatsappInboxContactKeys SET conversation_id=? WHERE contact_key=? AND conversation_id=?',
      [conversationId, expectedContactKey, expectedConversationId]);
    if (updated.affectedRows !== 1) fail('contact_repair_binding_changed');
    await assertScope(connection, scope, { lock: true });
    await connection.commit(); transaction = false;
    return { conversationId, previousConversationId: expectedConversationId, created, clinicId };
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    if (locked) await query('SELECT RELEASE_LOCK(?)', [lock]);
  }
}

module.exports = { repairOrphanedContactBinding };
