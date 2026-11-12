'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { importLease } = require('../../lib/whatsappInboxImport');

const scope = { clinicId: 71, wabaId: '101', phoneId: '201' };
const now = Date.parse('2026-11-12T12:40:00Z'), seconds = String(Math.floor(now / 1000) - 30);
function receipt(status = 'sent', extra = {}, envelope = {}) {
  return { receipt: randomUUID(), lease: randomUUID(), automaticActionsAllowed: false,
    raw: Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: envelope.wabaId || scope.wabaId,
      changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
        metadata: { phone_number_id: envelope.phoneId || scope.phoneId }, statuses: [{
          id: 'wamid.FICTITIOUS_owned', status, timestamp: seconds,
          recipient_id: '19995550101', recipient_user_id: 'ES.FictitiousScopedUser', ...extra,
        }] } }] }] })) };
}
function fixture({ business = null, generationConflict = false, databaseFailure = false } = {}) {
  const state = { message: { id: 91, conversation_id: 81, status: 'pending', sent_at: null,
    metadata: { wamid: 'wamid.FICTITIOUS_owned', phoneNumberId: scope.phoneId,
      provider_acceptance_status: 'accepted', private_binding: { kept: true } } },
  imports: new Map(), aliasWrites: 0, commits: 0, rollbacks: 0, sql: [] };
  let before;
  const connection = {
    async beginTransaction() { before = structuredClone({ message: state.message, imports: state.imports, aliasWrites: state.aliasWrites }); },
    async commit() { state.commits++; before = null; },
    async rollback() { state.rollbacks++; Object.assign(state, before); before = null; },
    async execute(sql, args = []) {
      state.sql.push(sql);
      let rows;
      if (sql.startsWith('SELECT GET_LOCK')) rows = [{ acquired: 1 }];
      else if (sql.startsWith('SELECT RELEASE_LOCK')) rows = [{ released: 1 }];
      else if (sql.includes('information_schema.TABLES')) rows = [{ n: 3 }];
      else if (sql.startsWith('INSERT IGNORE INTO WhatsappContactIdentityLocks')) rows = { affectedRows: 0 };
      else if (sql.startsWith('SELECT clinic_id FROM WhatsappContactIdentityLocks')) rows = [{ clinic_id: scope.clinicId }];
      else if (sql.startsWith('SELECT * FROM WhatsappInboxImports')) rows = state.imports.has(args[0]) ? [state.imports.get(args[0])] : [];
      else if (sql.startsWith('SELECT id_clinica FROM Clinicas')) rows = [{ id_clinica: args[0] }];
      else if (sql.startsWith('SELECT m.id,m.conversation_id,m.status,m.metadata,m.sent_at')) {
        rows = args[0] === scope.clinicId && args[1] === state.message.metadata.wamid ? [structuredClone(state.message)] : [];
      } else if (sql.startsWith('SELECT contact_id FROM Conversations')) rows = [{ contact_id: '+19995550101' }];
      else if (sql.includes("JSON_EXTRACT(additionalData,'$.businessId')")) {
        if (databaseFailure) throw Error('FICTITIOUS_DATABASE_FAILURE');
        rows = business ? [{ business_id: business, portfolio_id: business, health_id: null }] : [];
      } else if (sql.startsWith('SELECT identity_key FROM WhatsappContactIdentities')) {
        rows = generationConflict ? [{ identity_key: 'fictitious-different-generation' }] : [];
      } else if (sql.startsWith('SELECT conversation_id FROM WhatsappContactIdentities')) rows = [];
      else if (sql.startsWith('INSERT INTO WhatsappContactIdentities')) { state.aliasWrites++; rows = { affectedRows: 1 }; }
      else if (sql.startsWith('UPDATE Messages SET status=')) {
        assert.equal(args[3], state.message.id);
        state.message.status = args[0]; state.message.metadata = JSON.parse(args[1]);
        state.message.sent_at ||= args[2]; rows = { affectedRows: 1 };
      } else if (sql.startsWith('INSERT INTO WhatsappInboxImports')) {
        assert.equal(args[5], 0, 'a status receipt must not create messages');
        state.imports.set(args[0], { receipt: args[0], digest: args[1], import_receipt: args[2], clinic_id: args[3], phone_id: args[4] });
        rows = { affectedRows: 1 };
      } else throw Error('UNEXPECTED_SQL_IN_OFFLINE_STATUS_TEST');
      return [rows];
    },
  };
  return { state, run: (value, selectedScope = scope) => importLease(connection, value, selectedScope, now,
    { contactIdentityEnabled: true, validateScope: async () => {} }) };
}

test('exact owned delivery/read/sent receipts survive missing business metadata without learning an alias', async () => {
  const f = fixture();
  for (const status of ['delivered', 'read', 'sent']) {
    const signed = receipt(status), result = await f.run(signed);
    assert.equal(result.replayed, false);
    const historyLength = f.state.message.metadata.wa_status_history.length;
    assert.equal((await f.run(signed)).importReceipt, result.importReceipt);
    assert.equal(f.state.message.metadata.wa_status_history.length, historyLength, 'replay does not append status history');
  }
  assert.equal(f.state.message.status, 'read', 'late sent does not regress read');
  assert.equal(f.state.message.sent_at.toISOString(), new Date(Number(seconds) * 1000).toISOString());
  assert.deepEqual(f.state.message.metadata.private_binding, { kept: true });
  assert.equal(f.state.message.metadata.provider_acceptance_status, 'accepted');
  assert.equal(f.state.aliasWrites, 0);
  assert.equal(f.state.imports.size, 3);
  assert.equal(f.state.rollbacks, 0);
});

test('available unique business metadata still binds the exact scoped provider identity', async () => {
  const f = fixture({ business: '301' });
  await f.run(receipt());
  assert.equal(f.state.message.status, 'sent'); assert.equal(f.state.aliasWrites, 2);
});

test('identity generation conflicts and unrelated database failures remain closed and roll back the status', async () => {
  for (const options of [{ business: '301', generationConflict: true }, { databaseFailure: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(receipt()), error => error.inboxReason === 'import_retry');
    assert.equal(f.state.message.status, 'pending'); assert.equal(f.state.message.sent_at, null);
    assert.equal(f.state.aliasWrites, 0); assert.equal(f.state.imports.size, 0);
    assert.equal(f.state.rollbacks, 1);
  }
});

test('foreign WAMID, clinic, WABA or sender phone cannot use the optional identity fallback', async () => {
  for (const [signed, selectedScope] of [[receipt('sent', { id: 'wamid.FICTITIOUS_foreign' }), scope],
    [receipt(), { ...scope, clinicId: 72 }], [receipt('sent', {}, { wabaId: '102' }), scope],
    [receipt('sent', {}, { phoneId: '202' }), scope]]) {
    const f = fixture();
    await assert.rejects(f.run(signed, selectedScope), error => ['unmatched_status', 'review_required'].includes(error.inboxReason));
    assert.equal(f.state.message.status, 'pending'); assert.equal(f.state.aliasWrites, 0);
    assert.equal(f.state.imports.size, 0);
  }
});
