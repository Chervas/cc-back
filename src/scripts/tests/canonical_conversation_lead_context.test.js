'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Sequelize = require('sequelize');
const phone = require('../../lib/phone');

// Execute the full production helper with an explicit dependency allowlist.
// No application/model registry, real database, queue or provider is loaded.
const forbidden = () => { throw Error('CANONICAL_LEAD_CONTEXT_OFFLINE_ONLY'); };
require('node:net').Socket.prototype.connect = forbidden;
require('node:tls').connect = forbidden;
global.fetch = forbidden;

const PHONE = '+34600000001';
const OLD_LEAD = 10;
const CURRENT_LEAD = 20;
const { Op } = Sequelize;

function fixture({ leadId = CURRENT_LEAD, empty = false, patientId = 100 } = {}) {
  const calls = { updates: [], creates: [], observations: [], transactions: 0 };
  const history = [
    { id: 1, conversation_id: 5, metadata: { lead_id: OLD_LEAD }, body: 'Synthetic earlier request' },
    { id: 2, conversation_id: 5, metadata: { lead_id: CURRENT_LEAD }, body: 'Synthetic current request' },
  ];
  const attach = row => Object.defineProperty(row, 'update', { value: async (patch, options) => {
    calls.updates.push({ id: row.id, patch: { ...patch }, transaction: options.transaction });
    Object.assign(row, patch); return row;
  } });
  const rows = empty ? [] : [attach({ id: 5, clinic_id: 72, channel: 'whatsapp', contact_id: PHONE,
    lead_id: leadId, patient_id: patientId, assignee_id: 44, unread_count: 2,
    last_message_at: '2026-10-30T10:00:00Z', last_inbound_at: '2026-10-30T09:00:00Z' })];
  const tx = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  const db = {
    Sequelize,
    sequelize: { transaction: async work => { calls.transactions++; return work(tx); }, query: forbidden },
    Conversation: {
      findAll: async ({ where }) => rows.filter(row => row.clinic_id === where.clinic_id
        && row.channel === where.channel && where[Op.or].some(clause => clause.contact_id
          ? clause.contact_id[Op.in].includes(row.contact_id)
          : clause.patient_id ? Number(clause.patient_id) === Number(row.patient_id)
            : Number(clause.lead_id) === Number(row.lead_id))),
      create: async (values, options) => {
        const row = attach({ id: 6 + calls.creates.length, ...values });
        calls.creates.push({ values: { ...values }, transaction: options.transaction });
        rows.push(row); return row;
      },
      destroy: forbidden,
    },
    Message: { update: forbidden, create: forbidden, destroy: forbidden },
    ConversationRead: { findAll: forbidden, update: forbidden, create: forbidden, destroy: forbidden },
    WhatsAppWebOrigin: { update: forbidden },
  };
  const modules = {
    '../../models': db,
    './phone': phone,
    '../services/whatsapp.service': {},
    '../services/temporaryPatientDirection.service': { observeConversation: async (row, options) => {
      calls.observations.push({ id: row.id, transaction: options.transaction }); return row;
    } },
  };
  const sandbox = { module: { exports: {} }, process: { env: { META_WHATSAPP_DEFAULT_COUNTRY_CODE: '+34' } },
    require: name => {
      assert(Object.hasOwn(modules, name), `unmocked dependency forbidden: ${name}`);
      return modules[name];
    } };
  const filename = require.resolve('../../lib/canonical-conversation');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const lookup = overrides => sandbox.module.exports.findCanonicalWhatsappConversation({
    clinicId: 72, contactId: PHONE, leadId: OLD_LEAD, ...overrides,
  });
  return { rows, history, calls, tx, lookup };
}

test('opening either of two requests preserves the current chat link and message history', async () => {
  const f = fixture();
  const before = structuredClone({ rows: f.rows, history: f.history });
  for (const leadId of [OLD_LEAD, CURRENT_LEAD, OLD_LEAD]) {
    const conversation = await f.lookup({ leadId, preserveExistingLead: true, createIfMissing: false });
    assert.equal(conversation.id, 5);
    assert.equal(conversation.lead_id, CURRENT_LEAD);
  }
  assert.deepEqual({ rows: f.rows, history: f.history }, before);
  assert.equal(f.calls.updates.length, 0);
  assert.equal(f.calls.creates.length, 0);
});

test('default reception and explicit false still associate the chat with the incoming request', async () => {
  for (const options of [{}, { preserveExistingLead: false }]) {
    const f = fixture({ leadId: OLD_LEAD });
    const history = structuredClone(f.history);
    const conversation = await f.lookup({ leadId: CURRENT_LEAD, ...options });
    assert.equal(conversation.lead_id, CURRENT_LEAD);
    assert.deepEqual(f.calls.updates, [{ id: 5, patch: { lead_id: CURRENT_LEAD }, transaction: null }]);
    assert.deepEqual(f.history, history);
    assert.equal(conversation.patient_id, 100);
  }
});

test('preserveExistingLead attaches a NULL link and then leaves it attached on another request lookup', async () => {
  const f = fixture({ leadId: null });
  const first = await f.lookup({ preserveExistingLead: true, transaction: f.tx });
  assert.equal(first.lead_id, OLD_LEAD);
  const second = await f.lookup({ leadId: CURRENT_LEAD, preserveExistingLead: true, transaction: f.tx });
  assert.equal(second.id, first.id);
  assert.equal(second.lead_id, OLD_LEAD);
  assert.deepEqual(f.calls.updates, [{ id: 5, patch: { lead_id: OLD_LEAD }, transaction: f.tx }]);
});

test('a read without a chat still returns null without creating one', async () => {
  const f = fixture({ empty: true });
  assert.equal(await f.lookup({ preserveExistingLead: true, createIfMissing: false }), null);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.calls.observations.length, 0);
});

test('explicit creation retains its lead and transaction even with preservation enabled', async () => {
  const f = fixture({ empty: true });
  const created = await f.lookup({ leadId: CURRENT_LEAD, preserveExistingLead: true,
    createIfMissing: true, transaction: f.tx });
  assert.equal(created.lead_id, CURRENT_LEAD);
  assert.equal(created.clinic_id, 72);
  assert.equal(created.contact_id, PHONE);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.calls.creates[0].transaction, f.tx);
  assert.equal(f.calls.observations[0].transaction, f.tx);
  const existing = await f.lookup({ preserveExistingLead: true, createIfMissing: true });
  assert.equal(existing.id, created.id);
  assert.equal(existing.lead_id, CURRENT_LEAD);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.calls.updates.length, 0);
});

test('lead preservation does not bypass the existing patient ownership conflict', async () => {
  const f = fixture();
  const before = structuredClone(f.rows);
  await assert.rejects(f.lookup({ preserveExistingLead: true, patientId: 999 }),
    error => error.code === 'whatsapp_contact_identity_conflict');
  assert.deepEqual(f.rows, before);
  assert.equal(f.calls.updates.length, 0);
  assert.equal(f.calls.creates.length, 0);
});
