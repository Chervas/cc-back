'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedConsentConsistencyFixture } = require('./helpers/owned-consent-consistency-fixture');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('patient/professional signature rechecks current package lifecycle after anchor before any evidence write',
  { skip: process.env.CONSENT_SIGNATURE_LIFECYCLE_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedConsentConsistencyFixture(context), { db, consents } = f;
      const violations = [], observations = context.report.observations = [];
      for (const actor of ['patient', 'professional']) for (const closure of ['cancelled', 'expired', 'date_expired']) {
        const item = await f.prepare(actor === 'patient' ? 12 : 11);
        if (actor === 'professional') await consents.signConsentDocument(item.doc.id, f.signature('already-signed-patient'));
        const original = (await db.PatientConsentDocument.findByPk(item.doc.id)).toJSON();
        const count = (await db.ConsentSignaturePackage.findByPk(item.pkg.id)).signed_count;
        const events = (await f.signatureEvents(item.doc)).length, captured = deferred(), release = deferred(); let paused = false;
        db.PatientConsentDocument.addHook('afterFind', 'owned-signature-lifecycle', async (row, options) => {
          if (paused || options.transaction || Number(row?.id) !== item.doc.id || !options.include) return;
          paused = true; captured.resolve(); await release.promise;
        });
        const late = Promise.allSettled([actor === 'patient'
          ? consents.signConsentDocument(item.doc.id, f.signature('late-patient'))
          : consents.signProfessionalConsentDocument(item.doc.id, { accepted_statement: true }, 7)]);
        await captured.promise;
        const closing = closure === 'date_expired' ? { expires_at: new Date(Date.now() - 1000) } : { status: closure };
        await db.ConsentSignaturePackage.update(closing, { where: { id: item.pkg.id } });
        const closedPackage = (await db.ConsentSignaturePackage.findByPk(item.pkg.id)).toJSON();
        release.resolve(); const [outcome] = await late;
        db.PatientConsentDocument.removeHook('afterFind', 'owned-signature-lifecycle');
        const actual = (await db.PatientConsentDocument.findByPk(item.doc.id)).toJSON(), actualPackage = await db.ConsentSignaturePackage.findByPk(item.pkg.id);
        const unchangedField = key => JSON.stringify(actual[key]) === JSON.stringify(original[key]);
        const passed = outcome.status === 'rejected' && outcome.reason.message === 'consent_package_unavailable'
          && outcome.reason.statusCode === 410 && actual.status === original.status && actual.snapshot_hash === original.snapshot_hash
          && JSON.stringify(actual.snapshot_json) === JSON.stringify(original.snapshot_json) && !actual.professional_signed_at
          && ['signed_at', 'signed_by_patient_id', 'signed_by_representative_id', 'professional_signed_by',
            'revoked_at', 'channel', 'delivery_status'].every(unchangedField)
          && actualPackage.status === closedPackage.status && actualPackage.signed_count === count
          && actualPackage.required_count === closedPackage.required_count
          && JSON.stringify(actualPackage.expires_at) === JSON.stringify(closedPackage.expires_at)
          && (await f.signatureEvents(item.doc)).length === events;
        observations.push({ actor, closure, passed, actual: { outcome: outcome.status, error: outcome.reason?.message,
          document_status: actual.status, package_status: actualPackage.status, signature_events: (await f.signatureEvents(item.doc)).length } });
        if (!passed) violations.push(actor + ':' + closure);
        // Clinical start after a rejected late signature must still fail on its
        // actual missing patient/professional evidence, not on a fake package badge.
        if (passed) {
          await f.arrive(item.cita);
          const beforeCare = await db.AppointmentCareEvent.count({ where: { appointment_id: item.cita.id_cita } });
          const beforeOperational = await db.PatientOperationalEvent.count();
          await assert.rejects(f.start(item.cita), error => error.code === 'appointment_consent_required');
          assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: item.cita.id_cita } }), beforeCare);
          assert.equal(await db.PatientOperationalEvent.count(), beforeOperational);
        }
      }
      const validCountersign = await f.prepare();
      await consents.signConsentDocument(validCountersign.doc.id, f.signature('normal-patient'));
      assert.equal((await db.ConsentSignaturePackage.findByPk(validCountersign.pkg.id)).status, 'signed');
      await consents.signProfessionalConsentDocument(validCountersign.doc.id, { accepted_statement: true }, 7);
      const valid = await db.PatientConsentDocument.findByPk(validCountersign.doc.id);
      assert(valid.signed_at); assert(valid.professional_signed_at); assert(valid.snapshot_json.signature_evidence);
      await f.arrive(validCountersign.cita); await f.start(validCountersign.cita);
      context.report.boundaries = { real_services_and_native_sql: true, external_sends: 0, employee_endpoint_auth_e2e: false,
        clinical_approval_created: false, protocol_freeze_tested: false, production_data_touched: false };
      assert.deepEqual(violations, [], 'Late signature lifecycle violations: ' + JSON.stringify(observations));
      context.report.checks.push('Six actual late patient/professional signature races reject package cancellation/status expiry/date expiry after initial display, preserving hash/events/counts/closed state and denying care; a valid signed package still permits professional countersignature');
    });
  });
