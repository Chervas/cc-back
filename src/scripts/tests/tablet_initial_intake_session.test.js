'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../services/consentimientos.service'), 'utf8');
const start = source.indexOf('async function createTabletSession(');
const end = source.indexOf('\nfunction serializeKioskAccess(', start);
assert(start > 0 && end > start);
const functionSource = source.slice(start, end);

function harness({ pendingIntake = false, documents = [], active = true } = {}) {
  const calls = [], writes = [];
  const pkg = { id: 136, paciente_id: 33238, clinica_id: 72, public_id: 'fictitious-package', documents };
  const context = {
    getPackageWithDocumentsById: async () => pkg,
    requireActiveConsentPackage: () => { if (!active) throw Object.assign(new Error('consent_package_expired'), { statusCode: 410 }); },
    signPackageToken: () => 'fictitious-token', buildPublicConsentUrl: () => '/tablet/fictitious',
    DOCUMENT_PENDING_STATUSES: new Set(['pending', 'sent', 'viewed']), getPlain: value => value,
    db: {
      PatientIntakeRequest: { findOne: async options => {
        calls.push(JSON.parse(JSON.stringify(options.where))); return pendingIntake ? { id: 4 } : null;
      } },
      ConsentDeliveryEvent: { findOne: async () => null, create: async row => { writes.push(row); } },
    },
    getLinkTtlHours: () => 12, jwt: { decode: () => ({ exp: 2000000000 }) },
  };
  vm.runInNewContext(functionSource + '\nthis.createSession = createTabletSession;', context);
  return { create: () => context.createSession(136), calls, writes };
}

test('health-only pending questionnaire opens a tablet session without pretending a document is signed', async () => {
  const h = harness({ pendingIntake: true });
  const session = await h.create();
  assert.equal(session.package_id, 136); assert.equal(session.public_token, 'fictitious-token');
  assert.deepEqual(h.calls, [{ package_id: 136, patient_id: 33238, clinic_id: 72, status: 'pending' }]);
  assert.equal(h.writes.length, 0);
});
test('empty package without a pending questionnaire is still rejected', async () => {
  const h = harness(); await assert.rejects(h.create(), { message: 'consent_package_has_no_pending_documents' });
  assert.equal(h.writes.length, 0);
});
test('an expired package cannot be revived by a pending questionnaire', async () => {
  const h = harness({ pendingIntake: true, active: false });
  await assert.rejects(h.create(), { statusCode: 410 }); assert.equal(h.calls.length, 0);
});
test('normal pending consent sessions retain their existing delivery path', async () => {
  let updated = false;
  const doc = { id: 1, status: 'pending', update: async () => { updated = true; } };
  const h = harness({ documents: [doc] }); await h.create();
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 1); assert(updated);
  assert.equal(h.writes[0].channel, 'tablet');
});

const externalStart = source.indexOf('async function createPatientExternalAttestation(');
const externalEnd = source.indexOf('\nasync function revokePatientExternalAttestation(', externalStart);
test('generic external declarations cannot impersonate the reserved audited paper action', async () => {
  let reads = 0;
  const context = { findPacienteByIdentifier: async () => { reads++; return null; } };
  vm.runInNewContext(source.slice(externalStart, externalEnd) + '\nthis.create = createPatientExternalAttestation;', context);
  for (const payload of [{ source: 'registration_privacy_paper/v1' }, { origen: ' registration_privacy_paper/v2 ' }]) {
    await assert.rejects(context.create(1, payload, 1), { code: 'privacy_paper_requires_appointment' });
  }
  assert.equal(reads, 0);
});
