'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('sequelize');
const phone = require('../../lib/phone');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

function fixture(extraRows = []) {
  const old = { id: 10, clinic_id: 72, channel: 'whatsapp', patient_id: 101, lead_id: null,
    contact_id: '34600000001', unread_count: 2, last_message_at: '2026-10-18T10:00:00Z' };
  const patient = { id_paciente: 101, clinica_id: 72, telefono_movil: '34600000002' };
  const rows = [old, ...extraRows], creates = [], locks = [];
  const tx = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } };
  const db = { Sequelize: S, sequelize: { transaction: async work => work(tx) },
    Clinica: { findByPk: async (id, options) => { locks.push(['clinic', id, options.transaction]); return { id_clinica: id }; } },
    Paciente: { findByPk: async (id, options) => { locks.push(['patient', id, options.transaction]); return patient; } },
    PacienteClinica: { findOne: async () => null },
    Conversation: {
      findAll: async ({ where }) => rows.filter(row => Number(row.clinic_id) === Number(where.clinic_id)
        && row.channel === where.channel && where[S.Op.or].some(predicate => predicate.contact_id
          ? predicate.contact_id[S.Op.in].includes(row.contact_id)
          : predicate.logic ? predicate.logic[S.Op.in].includes(String(row.contact_id).replace(/\D/g, '').replace(/^00/, ''))
          : predicate.patient_id ? Number(predicate.patient_id) === Number(row.patient_id)
            : Number(predicate.lead_id) === Number(row.lead_id))),
      create: async (values, options) => {
        assert.equal(options.transaction, tx); const row = { id: 100 + creates.length, ...values };
        creates.push(row); rows.push(row); return row;
      },
      destroy: () => { throw Error('CONVERSATION_DELETE_FORBIDDEN'); },
    },
    Message: new Proxy({}, { get: () => () => { throw Error('MESSAGE_MUTATION_FORBIDDEN'); } }),
  };
  const canonical = loadSource('../lib/canonical-conversation', { '../../models': db, './phone': phone,
    '../services/whatsapp.service': {},
    '../services/temporaryPatientDirection.service': { observeConversation: async row => row },
  }, {});
  const lookup = (overrides = {}) => canonical.findCanonicalWhatsappConversation({ clinicId: 72,
    contactId: patient.telefono_movil, patientId: patient.id_paciente, requireExactContact: true,
    isolatePatientContact: true, ...overrides });
  return { old, patient, rows, creates, locks, tx, lookup };
}

test('verification creates an exact new-number chat without editing or merging the old chat', async () => {
  const f = fixture(), frozenOld = structuredClone(f.old);
  assert.equal(await f.lookup(), null, 'read-only lookup ignores same-patient old-number conversation');
  const created = await f.lookup({ createIfMissing: true });
  assert.equal(phone.normalizePhoneE164(created.contact_id), phone.normalizePhoneE164(f.patient.telefono_movil)); assert.equal(created.patient_id, 101);
  assert.equal(created.clinic_id, 72); assert.equal(f.creates.length, 1); assert.notEqual(created.id, f.old.id);
  assert.deepEqual(f.old, frozenOld); assert.equal(f.rows.length, 2);
  assert.equal((await f.lookup({ createIfMissing: true })).id, created.id); assert.equal(f.creates.length, 1);
  assert(f.locks.every(([, , tx]) => tx === f.tx));
});

test('generic strict-contact lookup still rejects a patient old-number chat', async () => {
  const f = fixture();
  await assert.rejects(f.lookup({ isolatePatientContact: false, createIfMissing: true }),
    error => error.code === 'whatsapp_contact_identity_conflict');
  assert.equal(f.creates.length, 0); assert.equal(f.rows.length, 1);
});

test('verification uses one exact same-patient chat without normalizing or moving it', async () => {
  const exact = { id: 20, clinic_id: 72, channel: 'whatsapp', patient_id: 101, lead_id: null,
    contact_id: '+34 600 000 002', unread_count: 1 };
  const f = fixture([exact]), frozen = structuredClone(f.rows);
  assert.equal((await f.lookup({ createIfMissing: true })).id, exact.id);
  assert.equal(f.creates.length, 0); assert.deepEqual(f.rows, frozen);
});

test('foreign, unowned, lead-owned and duplicate exact chats require review without reassignment/merge', async () => {
  const exact = { id: 20, clinic_id: 72, channel: 'whatsapp', patient_id: 101, lead_id: null, contact_id: '34600000002' };
  for (const rows of [[{ ...exact, patient_id: 999 }], [{ ...exact, patient_id: null }],
    [{ ...exact, lead_id: 45 }], [exact, { ...exact, id: 21 }]]) {
    const f = fixture(rows), frozen = structuredClone(f.rows);
    await assert.rejects(f.lookup({ createIfMissing: true }), error => error.code === 'whatsapp_contact_identity_conflict');
    assert.equal(f.creates.length, 0); assert.deepEqual(f.rows, frozen);
  }
});

test('locked patient mobile must still match the frozen destination before selecting or creating a chat', async () => {
  const f = fixture();
  await assert.rejects(f.lookup({ contactId: '34600000003', createIfMissing: true }),
    error => error.code === 'whatsapp_contact_identity_conflict');
  assert.equal(f.creates.length, 0); assert.deepEqual(f.locks.map(([type, id]) => [type, id]), [['clinic', 72], ['patient', 101]]);
  await assert.rejects(f.lookup({ requireExactContact: false, createIfMissing: true }),
    error => error.code === 'whatsapp_contact_identity_conflict');
  const foreign = fixture(); foreign.patient.clinica_id = 99;
  await assert.rejects(foreign.lookup({ createIfMissing: true }), error => error.code === 'whatsapp_contact_identity_conflict');
  assert.equal(foreign.creates.length, 0);
});
