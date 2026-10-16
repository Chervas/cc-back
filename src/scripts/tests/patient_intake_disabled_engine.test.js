'use strict';

// The production functions below run only against owned, in-memory fictitious
// rows. Never load the model index, a DB connection, a provider or process env.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { medicalQuestionnaireEnabled } = require('../../lib/patient-intake-configuration');
const source = fs.readFileSync(require.resolve('../../services/consentimientos.service'), 'utf8');

function extract(startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start);
  assert(start >= 0 && end > start, `Production function boundary missing: ${startText}`);
  return source.slice(start, end);
}

const functions = [
  extract('async function refreshPackageCounts(', '\nasync function markPendingConsentDocument('),
  extract('function serializeKioskPackage(', '\nfunction publicSignatureEvidenceForDocument('),
  extract('async function listTabletKioskPackages(', '\nasync function createTabletSessionForKiosk('),
  extract('async function signPublicPackage(', '\nasync function revokeConsentDocument('),
].join('\n');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture({ enabled = false, clinicId = 72, withDocument = true, requestStatus = 'pending',
  packageStatus = 'pending', documentStatus = 'pending' } = {}) {
  const calls = [], writes = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  const request = { id: 400, package_id: 200, patient_id: 17, clinic_id: clinicId, status: requestStatus,
    answers: { allergies: 'FICTITIOUS ANSWER - never expose to kiosk' },
    submitted_at: requestStatus === 'pending' ? null : '2026-10-15T09:00:00Z' };
  const configuration = { patient_intake: { medical_questionnaire_enabled: enabled } };
  const pkg = { id: 200, public_id: 'qa-disabled-200', paciente_id: 17, clinica_id: clinicId,
    status: packageStatus, required_count: withDocument ? 1 : 0, signed_count: 0,
    paciente: { id_paciente: 17, nombre: 'Paciente', apellidos: 'Ficticio' },
    clinica: { id_clinica: clinicId, configuracion: configuration }, intakeRequest: request, documents: [] };
  if (withDocument) pkg.documents.push({ id: 300, public_id: 'qa-disabled-300', package_id: pkg.id,
    paciente_id: 17, clinica_id: clinicId, clinic_template_id: 90, required: true,
    purpose: 'data_protection', blocking_policy: 'hard', status: documentStatus,
    revoked_at: null, signed_at: documentStatus === 'signed' ? '2026-10-15T09:00:00Z' : null });
  const Op = { in: Symbol('in'), or: Symbol('or'), gt: Symbol('gt'), notIn: Symbol('notIn') };
  const db = { Sequelize: { Op }, PatientConsentDocument: {}, PatientIntakeRequest: {},
    Clinica: {}, Paciente: {}, CitaPaciente: {}, Tratamiento: {},
    sequelize: { transaction: async (options, callback) => {
      assert.equal(options.isolationLevel, 'READ COMMITTED');
      return callback(transaction);
    } },
    ConsentSignaturePackage: {
      findByPk: async (id, options) => { assert.equal(id, pkg.id); assert.equal(options.transaction, transaction); return pkg; },
      findAll: async options => {
        calls.push(['kiosk-query', options]);
        assert.equal(options.where.clinica_id[Op.in][0], clinicId);
        assert(options.include.find(item => item.as === 'clinica').attributes.includes('configuracion'));
        return [pkg];
      },
      update: async (values, options) => {
        assert.equal(options.where.id, pkg.id); assert.equal(options.transaction, transaction);
        writes.push(['package', copy(values)]); Object.assign(pkg, values);
      },
    },
  };
  db.PatientConsentDocument.findAll = async options => {
    assert.equal(options.where.package_id, pkg.id); assert.equal(options.transaction, transaction);
    return pkg.documents.filter(doc => !options.where.status[Op.notIn].includes(doc.status));
  };
  db.PatientIntakeRequest.findOne = async options => {
    assert.equal(options.where.package_id, pkg.id); calls.push(['read-request', options]); return request;
  };
  const context = {
    db, Op, Date, toIntOrNull: value => Number(value) || null, toCleanString: value => String(value || '').trim(),
    getPlain: value => value, normalizeBoolean: (value, fallback) => value === undefined ? fallback : value === true,
    medicalQuestionnaireEnabled,
    clinicMedicalQuestionnaireEnabled: async options => {
      assert.equal(options.db, db); assert.equal(options.clinicId, clinicId);
      calls.push(['configuration', options]); return medicalQuestionnaireEnabled(configuration);
    },
    lockConsentPackages: async (ids, tx) => { assert.deepEqual(Array.from(ids), [pkg.id]); assert.equal(tx, transaction); },
    DOCUMENT_PENDING_STATUSES: new Set(['pending', 'sent', 'viewed']),
    DOCUMENT_CLOSED_STATUSES: new Set(['signed', 'cancelled', 'voided', 'superseded']),
    verifyPackageToken: () => ({ package_public_id: pkg.public_id, channel: 'tablet' }),
    getPackageWithDocumentsByPublicId: async id => { assert.equal(id, pkg.public_id); return pkg; },
    getPackageWithDocumentsById: async id => { assert.equal(id, pkg.id); return pkg; },
    requireActiveConsentPackage: row => {
      if (['cancelled', 'expired'].includes(row.status)) throw Object.assign(new Error('unavailable'), { statusCode: 410 });
    },
    consentDocumentChoices: {
      validateDocumentChoiceMap: () => { calls.push(['validate-choice-map']); },
      documentChoiceEvidence: () => { calls.push(['validate-choice-evidence']); },
      payloadForDocument: (_document, payload) => payload,
    },
    normalizeSignatureEvidence: payload => payload,
    requireSignatureEvidence: () => { calls.push(['validate-signature']); },
    signConsentDocument: async id => {
      const document = pkg.documents.find(doc => doc.public_id === id); assert(document);
      assert(calls.some(([name]) => name === 'validate-signature'));
      document.status = 'signed'; document.signed_at = '2026-10-16T09:00:00Z';
      writes.push(['sign-document', id]); await context.refreshPackageCounts(pkg.id, transaction); return document;
    },
    serializePublicPackage: row => ({ id: row.id, status: row.status, documents: copy(row.documents) }),
    requireKioskSession: async () => ({ clinic_id: clinicId }),
    consentClinicIds: async (models, kiosk) => { assert.equal(models, db); return [kiosk.clinic_id]; },
    require: name => {
      if (name === '../lib/availability-calendar') return { resolveClinicTimezone: () => 'Europe/Madrid' };
      if (name === './patientEconomics.service') return { listTabletBudgetSignatureRequestsForClinic: async () => [] };
      throw Error(`Unexpected import in offline fixture: ${name}`);
    },
  };
  vm.runInNewContext(functions + '\nthis.refreshPackageCounts = refreshPackageCounts; this.signPublicPackage = signPublicPackage; this.listTabletKioskPackages = listTabletKioskPackages;', context);
  return { context, pkg, request, configuration, calls, writes, transaction };
}

for (const clinicId of [66, 72]) {
  test(`clinic ${clinicId}: disabled combined questionnaire never hides LOPD or prevents completing it`, async () => {
    const h = fixture({ clinicId }), before = JSON.stringify(h.request);
    const kiosk = await h.context.listTabletKioskPackages('fictitious-token');
    assert.equal(kiosk.total, 1); assert.equal(kiosk.items[0].pending_count, 1);
    assert.equal(kiosk.items[0].intake_pending, false);
    assert(!JSON.stringify(kiosk).includes('FICTITIOUS ANSWER'));
    const result = await h.context.signPublicPackage('fictitious-token', { accepted_statement: true });
    assert.equal(result.signed_count, 1); assert.equal(h.pkg.status, 'signed');
    assert.equal(h.pkg.required_count, 1); assert.equal(h.pkg.signed_count, 1);
    assert.equal(JSON.stringify(h.request), before);
    assert.equal((await h.context.listTabletKioskPackages('fictitious-token')).total, 0);
  });
}

test('disabled health-only item is absent from the actual kiosk list and cannot be signed as a consent', async () => {
  const h = fixture({ withDocument: false }), before = JSON.stringify(h.request);
  const kiosk = await h.context.listTabletKioskPackages('fictitious-token');
  assert.equal(kiosk.total, 0);
  await assert.rejects(h.context.signPublicPackage('fictitious-token', { accepted_statement: true }),
    { message: 'consent_package_has_no_pending_documents', statusCode: 409 });
  assert.equal(h.writes.length, 0); assert.equal(JSON.stringify(h.request), before);
});

test('an enabled combined package retains the health-first gate and creates no signature side effects', async () => {
  const h = fixture({ enabled: true }), before = JSON.stringify([h.pkg, h.request]);
  const kiosk = await h.context.listTabletKioskPackages('fictitious-token');
  assert.equal(kiosk.total, 1); assert.equal(kiosk.items[0].intake_pending, true);
  await assert.rejects(h.context.signPublicPackage('fictitious-token', { accepted_statement: true }),
    { message: 'Completa primero tus datos y el formulario de salud.', statusCode: 409 });
  assert.equal(h.writes.length, 0); assert.equal(JSON.stringify([h.pkg, h.request]), before);
  assert(!h.calls.some(([name]) => name === 'validate-signature'));
});

test('enabled health-only request is still offered on the kiosk', async () => {
  const h = fixture({ enabled: true, withDocument: false });
  const kiosk = await h.context.listTabletKioskPackages('fictitious-token');
  assert.equal(kiosk.total, 1); assert.equal(kiosk.items[0].pending_count, 0);
  assert.equal(kiosk.items[0].intake_pending, true);
});

for (const requestStatus of ['pending', 'submitted', 'reviewed']) {
  test(`disabled ${requestStatus} questionnaire is immutable while signed LOPD counts complete`, async () => {
    const h = fixture({ requestStatus, documentStatus: 'signed' }), before = JSON.stringify(h.request);
    const result = await h.context.refreshPackageCounts(h.pkg.id);
    assert.deepEqual(copy(result), { required_count: 1, signed_count: 1, status: 'signed' });
    assert.equal(JSON.stringify(h.request), before);
    assert.equal(h.writes.length, 1); assert.equal(h.writes[0][0], 'package');
    assert(h.calls.filter(([name]) => name === 'configuration').every(([, options]) => options.transaction === h.transaction));
  });
}

for (const packageStatus of ['cancelled', 'expired']) {
  test(`disabling a questionnaire never revives a ${packageStatus} package`, async () => {
    const h = fixture({ packageStatus, documentStatus: 'signed' }), before = JSON.stringify(h.request);
    assert.equal((await h.context.refreshPackageCounts(h.pkg.id)).status, packageStatus);
    await assert.rejects(h.context.signPublicPackage('fictitious-token'), { statusCode: 410 });
    assert.equal(JSON.stringify(h.request), before);
    assert(!h.writes.some(([name]) => name === 'sign-document'));
  });
}
