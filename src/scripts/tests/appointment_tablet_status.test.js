'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { appointmentTabletStatus } = require('../../services/appointmentTabletStatus.service');

function fixture({ reason = 'current_privacy_pending', privacyQueued = false, questionnaire = null,
  packageStatus = 'pending', expires = '2026-10-16', foreignPackage = false, combinedPrivacy = false } = {}) {
  const queries = [], transaction = {}, Op = { in: Symbol('in'), or: Symbol('or'), gt: Symbol('gt') };
  const pkg = { id: 21, paciente_id: foreignPackage ? 99 : 17, clinica_id: 72, status: packageStatus, expires_at: expires };
  const request = questionnaire && { id: 22, package_id: 21, status: questionnaire, created_at: '2026-10-15T07:00:00Z',
    answers: { allergies: 'PRIVATE - must never leak' }, submitted_personal: { dni: 'PRIVATE' } };
  const db = { Sequelize: { Op },
    ClinicConsentTemplate: { findAll: async options => { queries.push(['templates', options]); return [{ id: 5 }]; } },
    ClinicConsentTemplateVersion: { findOne: async options => { queries.push(['version', options]); return { id: 6 }; } },
    PatientConsentDocument: { findAll: async options => { queries.push(['documents', options]); return [{ id: 7, package_id: 21 }]; } },
    ConsentSignaturePackage: { findByPk: async (id, options) => { queries.push(['package', options]); return pkg; } },
    PatientIntakeRequest: { findOne: async options => { queries.push(['request', options]);
      return options.where.package_id ? combinedPrivacy ? { id: 99 } : null : request; } },
    ConsentDeliveryEvent: { findOne: async options => { queries.push(['delivery', options]);
      return privacyQueued ? { id: 8, createdAt: '2026-10-15T08:00:00Z' } : null; } },
  };
  const run = () => appointmentTabletStatus({ db, appointment: { id_cita: 10, paciente_id: 17, clinica_id: 72 },
    transaction, now: new Date('2026-10-15T10:00:00Z'), assessPrivacy: async () => ({ reason }) });
  return { run, queries, transaction, db };
}
test('opening status does not imply either send, create questionnaires or expose clinical answers', async () => {
  const f = fixture(), result = await f.run();
  assert.deepEqual(result, { privacy: { state: 'not_sent' }, intake: { state: 'not_sent' } });
  assert(f.queries.every(([, options]) => options.transaction === f.transaction));
  assert(f.queries.filter(([name]) => name === 'request').every(([, options]) => !options.attributes.includes('answers')));
});
test('LOPD-only tablet hand-off survives reopening without claiming that medical data was sent', async () => {
  const f = fixture({ privacyQueued: true });
  const first = await f.run(), reopened = await f.run();
  assert.deepEqual(first, reopened); assert.equal(first.privacy.state, 'sent'); assert.equal(first.privacy.package_id, 21);
  assert.equal(first.privacy.sent_at, '2026-10-15T08:00:00.000Z'); assert.equal(first.intake.state, 'not_sent');
});
test('medical hand-off does not imply LOPD hand-off', async () => {
  const f = fixture({ questionnaire: 'pending' }), result = await f.run();
  assert.equal(result.privacy.state, 'not_sent'); assert.equal(result.intake.state, 'sent');
  assert(!JSON.stringify(result).includes('PRIVATE'));
});
for (const [reason, state] of [['current_privacy_signed', 'completed'], ['privacy_received_on_paper', 'paper']]) {
  test(`${reason} has its own completed state, never a fake questionnaire`, async () => {
    const f = fixture({ reason }), result = await f.run();
    assert.equal(result.privacy.state, state); assert.equal(result.intake.state, 'not_sent');
    assert(!f.queries.some(([name]) => name === 'documents'));
  });
}
for (const options of [{ packageStatus: 'cancelled' }, { packageStatus: 'expired' }, { expires: '2026-10-15T09:59:00Z' }, { foreignPackage: true }]) {
  test(`inactive/foreign parent is not shown as sent: ${JSON.stringify(options)}`, async () => {
    const result = await fixture({ privacyQueued: true, questionnaire: 'pending', ...options }).run();
    assert.equal(result.privacy.state, 'not_sent'); assert.equal(result.intake.state, 'not_sent');
  });
}
for (const [questionnaire, state] of [['submitted', 'submitted'], ['reviewed', 'confirmed']]) {
  test(`${questionnaire} remains received even when its old tablet access has expired`, async () => {
    const result = await fixture({ questionnaire, packageStatus: 'expired' }).run();
    assert.equal(result.intake.state, state); assert(!JSON.stringify(result).includes('PRIVATE'));
  });
}
test('a historical combined hand-off is not falsely represented as an independent LOPD item', async () => {
  const result = await fixture({ privacyQueued: true, combinedPrivacy: true }).run();
  assert.equal(result.privacy.state, 'not_sent');
});
test('clinic and patient scope are explicit on every document/questionnaire read', async () => {
  const f = fixture(); await f.run();
  for (const [name, options] of f.queries) {
    if (name === 'documents') { assert.equal(options.where.paciente_id, 17); assert.equal(options.where.clinica_id, 72); }
    if (name === 'request' && options.where.patient_id) { assert.equal(options.where.patient_id, 17); assert.equal(options.where.clinic_id, 72); }
  }
});
