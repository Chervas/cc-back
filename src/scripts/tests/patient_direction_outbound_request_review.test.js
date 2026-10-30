'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Op } = require('sequelize');

function matches(row, where = {}) {
  return Reflect.ownKeys(where).every(key => {
    const value = where[key];
    if (key === Op.or) return value.some(clause => matches(row, clause));
    if (value && typeof value === 'object') {
      return Reflect.ownKeys(value).every(operator => operator === Op.in ? value[operator].includes(row[key])
        : operator === Op.ne ? row[key] !== value[operator] : assert.fail(`unsupported operator ${String(operator)}`));
    }
    return row[key] === value;
  });
}

function fixture({ relationship = 'existing_patient', decision = null, requestKind = 'commercial', assignments = 'old',
  leadClinicId = 72, choiceClinicId = 72, settingEnabled = true } = {}) {
  const calls = { leadReads: 0, context: 0, decisions: 0, assignmentReads: [], transactions: 0, writes: [], configs: [] };
  const lead = { id: 10, clinica_id: leadClinicId, asignado_a: null, archived_at: null, status_lead: 'nuevo' };
  lead.update = async patch => { calls.writes.push(['lead', patch]); Object.assign(lead, patch); };
  const setting = { clinic_id: 72, is_enabled: settingEnabled, director_user_id: 44,
    director_phone_asset_id: 222, clinic_phone_asset_id: 111, default_successor_user_id: 99 };
  const base = { id: 1, clinic_id: 72, lead_intake_id: 9, patient_id: 100, conversation_id: 5,
    phone_e164: '+34000000001', active_phone_key: 'patient-direction:222:34000000001', status: 'active',
    director_user_id: 44, director_phone_asset_id: 222, clinic_phone_asset_id: 111, metadata: {} };
  const rows = assignments === 'old' ? [{ ...base }] : assignments === 'exact' ? [{ ...base }, { ...base, id: 2, lead_intake_id: 10 }]
    : assignments === 'other_clinic' ? [{ ...base, clinic_id: 66, lead_intake_id: 10 }] : [];
  const attachUpdate = row => Object.assign(row, { update: async patch => { calls.writes.push(['assignment', patch]); Object.assign(row, patch); } });
  rows.forEach(attachUpdate);
  const db = {
    LeadIntake: {
      findByPk: async id => { calls.leadReads++; return Number(id) === lead.id ? lead : null; },
      update: async (patch, { where }) => { if (matches(lead, where)) await lead.update(patch); },
    },
    LeadContactAttempt: { findOne: async () => null },
    PatientDirectionSetting: { findOne: async ({ where }) => matches(setting, where) ? setting : null },
    PatientDirectionProfile: { findByPk: async () => null },
    PatientDirectionAssignment: {
      findOne: async options => { calls.assignmentReads.push(options); return rows.find(row => matches(row, options.where)) || null; },
      create: async values => {
        calls.writes.push(['assignment.create', values]);
        const row = attachUpdate({ id: rows.length + 1, ...values }); rows.push(row); return row;
      },
    },
    Usuario: { findByPk: async () => ({ id_usuario: 44, nombre: 'Synthetic director' }) },
    PatientDirectionEvent: { create: async values => { calls.writes.push(['audit', values]); return values; } },
    Message: { create: async values => { calls.writes.push(['message', values]); return values; } },
    sequelize: { transaction: async work => { calls.transactions++; return work({ LOCK: { UPDATE: 'UPDATE' } }); } },
  };
  const modules = {
    sequelize: { Op }, '../../models': db,
    './whatsapp.service': {
      normalizePhoneNumber: value => value || null,
      getClinicConfig: async (clinicId, options) => { const result = { kind: 'clinic', clinicId, purpose: options?.purpose || null }; calls.configs.push(result); return result; },
      getConfigByAssetId: async (assetId, { clinicId }) => { const result = { kind: 'asset', assetId, clinicId }; calls.configs.push(result); return result; },
    },
    '../lib/whatsapp-channel-role': { isWhatsappRoutingConfigAvailable: () => true },
    './queue.service': { queues: { outboundWhatsApp: { add: () => assert.fail('provider queue forbidden') } } },
    '../lib/role-helpers': { isGlobalAdmin: () => false },
    './leadPatientContext.service': { createLeadPatientContextService: models => {
      assert.equal(models, db);
      return { get: async () => { calls.context++; return { relationship, request_kind: requestKind }; } };
    } },
    './leadPatientAttention.service': { createLeadPatientAttentionService: models => {
      assert.equal(models, db);
      return { decisions: async ids => {
        calls.decisions++; assert.deepEqual(Array.from(ids), [10]);
        return new Map(decision ? [[10, { version: 1, decision, clinic_id: choiceClinicId, director_user_id: 44, request_kind: requestKind }]] : []);
      } };
    } },
  };
  const sandbox = { module: { exports: {} }, console, require: name => {
    assert(Object.hasOwn(modules, name), `unmocked dependency forbidden: ${name}`);
    return modules[name];
  } };
  const filename = require.resolve('../../services/patientDirection.service');
  // Evaluate the complete production module with an explicit dependency allowlist.
  // No production model registry, queues or provider clients are loaded.
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const input = { clinicId: 72, leadId: 10, patientId: 100, conversationId: 5,
    phone: '+34000000001', actorUserId: 44 };
  return { service: sandbox.module.exports, input, calls, rows, lead, setting };
}

for (const relationship of ['existing_patient', 'possible_patient']) {
  for (const decision of [null, 'clinic']) {
    test(`${relationship}/${decision || 'pending'} blocks old phone/patient/chat assignment before any lookup or ensure`, async () => {
      for (const automation of [false, true]) {
        const f = fixture({ relationship, decision });
        const result = await f.service.resolveOutboundPolicy({ ...f.input, automation, allowTake: true });
        assert.equal(result.mode, 'clinic_default'); assert.equal(result.assignment, null);
        assert.equal(result.requiresTakeConfirmation, false);
        assert.equal(result.clinicConfig.assetId, 111);
        assert.equal(f.calls.assignmentReads.length, 0);
        assert.equal(f.calls.transactions, 0);
        assert.deepEqual(f.calls.writes, []);
        assert.equal(f.rows[0].lead_intake_id, 9);
      }
    });
  }
  test(`${relationship}/director uses only the current lead and clinic, including patient_care requests`, async () => {
    const f = fixture({ relationship, decision: 'director', requestKind: 'patient_care', assignments: 'exact' });
    const result = await f.service.resolveOutboundPolicy(f.input);
    assert.equal(result.mode, 'patient_director'); assert.equal(result.assignment.id, 2);
    assert.equal(result.assignment.lead_intake_id, 10); assert.equal(result.assignment.clinic_id, 72);
    assert.equal(result.clinicConfig.assetId, 222);
    assert.equal(f.calls.transactions, 0); assert.deepEqual(f.calls.writes, []);
  });
}

test('accepted review preserves the 409 conflict when only another request owns the phone', async () => {
  const f = fixture({ decision: 'director' });
  await assert.rejects(f.service.resolveOutboundPolicy(f.input), { status: 409, code: 'patient_direction_request_conflict' });
  assert.equal(f.calls.transactions, 1);
  assert.deepEqual(f.calls.writes, []);
  assert.equal(f.rows[0].lead_intake_id, 9);
  assert.equal(f.calls.configs.length, 0);
});

test('ensureAssignment retains its explicit accepted-request conflict independently of routing', async () => {
  const f = fixture({ decision: 'director' });
  await assert.rejects(f.service.ensureAssignment({ ...f.input, startReason: 'existing_patient_request_accepted' }),
    { status: 409, code: 'patient_direction_request_conflict' });
  assert.deepEqual(f.calls.writes, []);
});

test('accepted review can materialize a new exact assignment when the phone has no owner', async () => {
  const f = fixture({ decision: 'director', assignments: 'none' });
  const result = await f.service.resolveOutboundPolicy(f.input);
  assert.equal(result.mode, 'patient_director');
  assert.equal(result.assignment.lead_intake_id, 10); assert.equal(result.assignment.clinic_id, 72);
  assert.equal(result.assignment.start_reason, 'existing_patient_request_accepted');
  assert.equal(f.calls.transactions, 1);
  assert.equal(f.calls.writes.filter(([kind]) => kind === 'assignment.create').length, 1);
});

test('an exact lead assignment in a different clinic is never used', async () => {
  const f = fixture({ decision: 'director', assignments: 'other_clinic' });
  await assert.rejects(f.service.resolveOutboundPolicy(f.input), { code: 'patient_direction_phone_already_assigned' });
  assert.equal(f.calls.configs.length, 0); assert.deepEqual(f.calls.writes, []);
});

test('a director decision from another clinic does not authorize the current request', async () => {
  const f = fixture({ decision: 'director', choiceClinicId: 66, assignments: 'exact' });
  const result = await f.service.resolveOutboundPolicy(f.input);
  assert.equal(result.mode, 'clinic_default'); assert.equal(result.assignment, null);
  assert.equal(f.calls.assignmentReads.length, 0); assert.equal(f.calls.transactions, 0);
});

for (const relationship of ['new_contact', 'unknown']) {
  test(`${relationship} retains existing broad assignment reuse`, async () => {
    const f = fixture({ relationship });
    const result = await f.service.resolveOutboundPolicy(f.input);
    assert.equal(result.mode, 'patient_director'); assert.equal(result.assignment.id, 1);
    assert.equal(f.calls.decisions, 0); assert.equal(f.calls.transactions, 0);
  });
}

for (const purpose of ['bulk_campaigns', 'review_requests', 'lead_first_contact']) {
  test(`${purpose} retains the clinic sender for pending, transferred and accepted reviews`, async () => {
    for (const decision of [null, 'clinic', 'director']) {
      const f = fixture({ decision });
      const result = await f.service.resolveOutboundPolicy({ ...f.input, purpose });
      assert.equal(result.mode, 'clinic_default'); assert.equal(result.assignment, null);
      assert.equal(result.clinicConfig.kind, 'clinic'); assert.equal(result.clinicConfig.purpose, purpose);
      assert.equal(result.requiresTakeConfirmation, false);
      assert.equal(f.calls.transactions, 0); assert.deepEqual(f.calls.writes, []);
    }
  });
  test(`${purpose} keeps new-contact first-assignment behavior`, async () => {
    const f = fixture({ relationship: 'new_contact', assignments: 'none' });
    const result = await f.service.resolveOutboundPolicy({ ...f.input, purpose, automation: true });
    assert.equal(result.mode, 'clinic_default'); assert.equal(result.clinicConfig.purpose, purpose);
    assert.equal(result.assignment.start_reason, 'automatic_first_contact');
    assert.equal(f.calls.transactions, 1);
  });
}

test('consent still bypasses assignments and request review entirely', async () => {
  const f = fixture();
  const result = await f.service.resolveOutboundPolicy({ ...f.input, purpose: 'patient_consent' });
  assert.equal(result.mode, 'clinic_default'); assert.equal(result.assignment, null);
  assert.equal(result.clinicConfig.kind, 'clinic'); assert.equal(result.clinicConfig.purpose, null);
  assert.equal(f.calls.leadReads, 0); assert.equal(f.calls.context, 0); assert.equal(f.calls.decisions, 0);
  assert.equal(f.calls.assignmentReads.length, 0); assert.equal(f.calls.transactions, 0);
});

test('accepted current requests preserve human take confirmation and automation behavior', async () => {
  for (const options of [{}, { allowTake: true }, { automation: true }]) {
    const f = fixture({ decision: 'director', assignments: 'exact' });
    const result = await f.service.resolveOutboundPolicy({ ...f.input, actorUserId: 99, ...options });
    assert.equal(result.assignment.id, 2);
    assert.equal(result.requiresTakeConfirmation, !options.allowTake && !options.automation);
  }
});

test('patient-only routing without a lead retains the original lookup behavior', async () => {
  const f = fixture();
  const result = await f.service.resolveOutboundPolicy({ ...f.input, leadId: null });
  assert.equal(result.mode, 'patient_director'); assert.equal(result.assignment.id, 1);
  assert.equal(f.calls.leadReads, 0); assert.equal(f.calls.context, 0);
});
