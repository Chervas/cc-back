'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const recovery = require('../../lib/metaLeadHistoricalRecovery');
const event = { lead_id: '1234567890123456', page_id: '2345678901234567', form_id: '3456789012345678', ad_id: null };
const providerCreatedAt = '2026-11-10T12:34:56+0000';
const lead = clinicId => ({ id: 10, clinica_id: clinicId, external_source: 'meta_leadgen', external_id: event.lead_id });
function row(clinicId) {
  const proof = recovery.issue({ actorId: 1, clinicId, event, source: 'accepted_receipt', providerCreatedAt, recoveredAt: new Date('2026-11-12T10:00:00Z') });
  return { raw_payload: { provider: 'meta_leadgen', lead_id: event.lead_id, provider_created_at: providerCreatedAt },
    attribution_steps: { meta_historical_recovery: recovery.forPersistence(proof, event, clinicId, providerCreatedAt) } };
}
function fixture(rows) {
  const counters = { flowReads: 0, deliveries: 0 }, db = {
    Sequelize: { Op: {} }, LeadAttributionAudit: { findAll: async () => rows },
    AutomationFlowTemplateV2: { findOne: async () => { counters.flowReads++; return null; } },
  };
  const module = { exports: {} }, filename = path.resolve(__dirname, '../../services/leadAutoReply.service.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process, console,
    require: name => name === 'crypto' ? require('node:crypto') : name === '../../models' ? db
      : name === '../lib/metaLeadHistoricalRecovery' ? recovery
      : name === './whatsapp.service' ? { sendMessage: () => { counters.deliveries++; throw Error('must not send'); } } : {},
  }, { filename });
  return { service: module.exports, counters, db };
}

test('a recovery proof is in-process, bound to the exact patient route and is not transplantable', () => {
  assert.throws(() => recovery.forPersistence({}, event, 66), /proof_invalid/);
  const proof = recovery.issue({ actorId: 1, clinicId: 66, event, source: 'provider_form_recovery', providerCreatedAt });
  assert.throws(() => recovery.forPersistence(proof, event, 72, providerCreatedAt), /proof_invalid/);
  assert.throws(() => recovery.forPersistence(proof, { ...event, lead_id: '777' }, 66, providerCreatedAt), /proof_invalid/);
  assert.equal(recovery.forPersistence(proof, event, 66, providerCreatedAt).automatic_messages, 'suppressed');
  assert.throws(() => recovery.forPersistence(proof, event, 66, '2026-11-10T12:34:57Z'), /proof_invalid/);
  for (const timestamp of [undefined, '2026-02-31T10:00:00Z', '2026-11-12T25:00:00Z', '2027-01-01T00:00:00Z'])
    assert.throws(() => recovery.issue({ actorId: 1, clinicId: 66, event, source: 'accepted_receipt', providerCreatedAt: timestamp,
      recoveredAt: new Date('2026-11-12T10:00:00Z') }), /proof_invalid/);
});

for (const clinicId of [66, 72]) test(`recovered Meta leads remain excluded from ordinary and later backfill auto-replies in clinic ${clinicId}`, async () => {
  const f = fixture([row(clinicId)]);
  for (const idempotencyScope of ['event', 'backfill', 'event']) {
    const result = await f.service.enqueueForLead({ lead: lead(clinicId), eventKind: 'write', idempotencyScope });
    assert.equal(result.skipped, true); assert.equal(result.reason, 'meta_historical_recovery');
  }
  assert.deepEqual(f.counters, { flowReads: 0, deliveries: 0 });
});

test('ordinary Meta leads and unrelated providers retain their normal automation entry', async () => {
  const f = fixture([]);
  for (const value of [lead(66), { ...lead(66), external_source: 'web_form' }]) {
    const result = await f.service.enqueueForLead({ lead: value, eventKind: 'write' });
    assert.equal(result.reason, 'no_active_flow');
  }
  assert.equal(f.counters.flowReads, 2); assert.equal(f.counters.deliveries, 0);
});

test('a malformed or foreign recovered attribution fails closed without starting a flow', async () => {
  const f = fixture([row(72)]);
  await assert.rejects(f.service.enqueueForLead({ lead: lead(66), eventKind: 'write' }), /proof_invalid/);
  assert.equal(f.counters.flowReads, 0);
});

test('durable suppression survives JSON roundtrip and unavailable storage does not authorize a reply', async () => {
  const f = fixture(JSON.parse(JSON.stringify([row(66)])));
  assert.equal(await recovery.suppressesAutomaticReply(f.db, lead(66)), true);
  f.db.LeadAttributionAudit.findAll = async () => { throw Error('storage unavailable'); };
  await assert.rejects(f.service.enqueueForLead({ lead: lead(66), eventKind: 'write' }), /storage unavailable/);
  assert.equal(f.counters.deliveries, 0);
});
