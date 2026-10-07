'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedConsentConsistencyFixture } = require('./helpers/owned-consent-consistency-fixture');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const failure = message => error => error.message === message;
const packageAnchor = (options, packageId) => options.transaction && options.lock === options.transaction.LOCK.UPDATE
  && Number(options.where?.id) === Number(packageId) && options.attributes?.length === 1 && options.attributes[0] === 'id';
const waitUntilBlocked = async promise => {
  const result = await Promise.race([promise.then(() => 'settled', () => 'settled'), new Promise(r => setTimeout(() => r('waiting'), 40))]);
  assert.equal(result, 'waiting', 'real SQL operation must be waiting for the locked anchor');
};

test('consent/care consistency: actual services, tablet JWT and concurrent transactions on owned SQL',
  { skip: process.env.CONSENT_CONSISTENCY_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedConsentConsistencyFixture(context), { db, consents } = f;
      const record = text => context.report.checks.push(text);

      const cita = await f.appointment();
      const packages = await Promise.all(Array.from({ length: 3 }, () => consents.createPackageForAppointment(cita.id_cita, { createdBy: 7 })));
      assert.equal(new Set(packages.map(row => row.id)).size, 1);
      assert.equal(await db.ConsentSignaturePackage.count({ where: { cita_id: cita.id_cita } }), 1);
      assert.equal(await db.PatientConsentDocument.count({ where: { cita_id: cita.id_cita } }), 1);
      const pkg = packages[0], doc = pkg.documents[0], frozen = doc.snapshot_hash;
      assert.equal(doc.clinic_template_version_id, 201);
      assert.match(doc.snapshot_html, /Paciente Ficticio A/);
      assert.equal(doc.snapshot_json.context.profesional.id, 7);
      await assert.rejects(f.start(cita), error => error.code === 'care_arrival_required');
      await f.arrive(cita);
      await assert.rejects(f.start(cita), error => error.code === 'appointment_consent_required');
      record('Three concurrent real preparations serialize on the native appointment row: one package and one document with exact version/context/hash; arrival alone does not allow care');

      await assert.rejects(consents.loginTabletKiosk({ username: 'owned-tablet-a', password: 'wrong' }), failure('invalid_tablet_kiosk_credentials'));
      const login = await consents.loginTabletKiosk({ username: 'owned-tablet-a', password: f.password });
      const foreign = await consents.loginTabletKiosk({ username: 'owned-tablet-b', password: f.password });
      await assert.rejects(consents.createTabletSessionForKiosk(pkg.id, 'invalid-token'), failure('invalid_tablet_kiosk_token'));
      await assert.rejects(consents.createTabletSessionForKiosk(pkg.id, foreign.token), failure('tablet_kiosk_package_forbidden'));
      const tablet = await consents.createTabletSessionForKiosk(pkg.id, login.token, { base_url: 'https://owned-tablet.invalid' });
      assert(tablet.public_token);
      assert.equal((await db.PatientConsentDocument.findByPk(doc.id)).signed_at, null);
      const view = await consents.getPublicPackage(tablet.public_token, { userAgent: 'OWNED tablet A' });
      assert.equal(view.documents[0].snapshot_hash, frozen);
      assert.equal(view.intake, null);
      await assert.rejects(f.start(cita), error => error.code === 'appointment_consent_required');
      await assert.rejects(consents.signPublicPackage('invalid-token', f.signature('invalid')), failure('invalid_consent_public_token'));
      record('Real bcrypt kiosk login and freshly re-read JWT clinic scope: invalid credentials/token and foreign clinic are denied; tablet queue/view preserve evidence and cannot authorize care; no tablet transport is sent');

      // Both tablets have captured the same snapshot before either SQL CAS.
      const both = deferred(), release = deferred(); let attempts = 0;
      db.ConsentSignaturePackage.addHook('beforeFind', 'owned-two-tablets', async options => {
        if (!packageAnchor(options, pkg.id) || attempts >= 2) return;
        if (++attempts === 2) both.resolve();
        await release.promise;
      });
      const races = [consents.signPublicPackage(tablet.public_token, f.signature('tablet-A')),
        consents.signPublicPackage(tablet.public_token, f.signature('tablet-B'))];
      const raced = Promise.allSettled(races);
      await both.promise; release.resolve();
      const results = await raced;
      db.ConsentSignaturePackage.removeHook('beforeFind', 'owned-two-tablets');
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal(results.filter(row => row.status === 'rejected' && row.reason.message === 'consent_document_signature_conflict').length, 1);
      let signed = await db.PatientConsentDocument.findByPk(doc.id);
      assert.equal(signed.status, 'signed'); assert.notEqual(signed.snapshot_hash, frozen);
      const signedHash = signed.snapshot_hash, patientEvidence = signed.snapshot_json.signature_evidence;
      assert.equal((await f.signatureEvents(doc)).length, 1);
      await assert.rejects(consents.signConsentDocument(doc.id, f.signature('re-sign')), failure('consent_document_already_closed'));
      const reused = await consents.createPackageForAppointment(cita.id_cita);
      assert.equal(reused.documents.length, 1); assert.equal(reused.documents[0].snapshot_hash, signedHash);
      await assert.rejects(f.start(cita), error => error.code === 'appointment_consent_required');
      await assert.rejects(consents.signProfessionalConsentDocument(doc.id, { accepted_statement: true }, null), failure('professional_signature_actor_required'));
      await assert.rejects(consents.signProfessionalConsentDocument(doc.id, { accepted_statement: true, professional_id: 8 }, 7), failure('professional_signature_actor_mismatch'));
      await consents.signProfessionalConsentDocument(doc.id, { accepted_statement: true }, 7);
      signed = await db.PatientConsentDocument.findByPk(doc.id);
      assert.deepEqual(signed.snapshot_json.signature_evidence, patientEvidence);
      assert.equal(signed.professional_signed_by, 7);
      const dualHash = signed.snapshot_hash;
      await consents.signProfessionalConsentDocument(doc.id, { accepted_statement: true }, 7);
      assert.equal((await f.signatureEvents(doc)).length, 2);
      assert.equal((await db.PatientConsentDocument.findByPk(doc.id)).snapshot_hash, dualHash);
      const starts = await Promise.all([f.start(cita), f.start(cita)]);
      assert.equal(starts.filter(row => row.replayed).length, 1);
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: cita.id_cita, action: 'start' } }), 1);
      assert.equal(await db.PatientOperationalEvent.count({ where: { patient_id: 1, metadata: { appointment_id: cita.id_cita, action: 'start' } } }), 1);
      assert.equal((await db.CitaPaciente.findByPk(cita.id_cita)).estado, 'info_confirmada');
      record('Two real public-package devices race with captured identical hash: one CAS succeeds, one 409, one signature event; no re-signing or regeneration of signed evidence. Authenticated professional ID is checked; dual signature preserves patient evidence. Concurrent care starts produce one append-only start and no status/payment/communication mutation');

      // Event failure must roll the signature and aggregate count back together.
      const rollback = await f.prepare(12), beforeRollback = rollback.doc.snapshot_hash;
      db.ConsentDeliveryEvent.addHook('beforeCreate', 'owned-signature-event-failure', row => {
        if (row.patient_consent_document_id === rollback.doc.id && row.event_payload?.event === 'document_signed') throw Error('OWNED_SIGNATURE_EVENT_FAILURE');
      });
      await assert.rejects(consents.signConsentDocument(rollback.doc.id, f.signature('rollback')), failure('OWNED_SIGNATURE_EVENT_FAILURE'));
      db.ConsentDeliveryEvent.removeHook('beforeCreate', 'owned-signature-event-failure');
      const rolled = await db.PatientConsentDocument.findByPk(rollback.doc.id), rolledPackage = await db.ConsentSignaturePackage.findByPk(rollback.pkg.id);
      assert.equal(rolled.status, 'pending'); assert.equal(rolled.signed_at, null); assert.equal(rolled.snapshot_hash, beforeRollback);
      assert.equal(rolledPackage.signed_count, 0); assert.equal((await f.signatureEvents(rolled)).length, 0);
      record('Injected native event insertion failure rolls back document signature, snapshot hash, event and package aggregate together');

      // A revocation committed after display must win over that stale signature.
      const revoked = await f.prepare(12), atCas = deferred(), revokeRelease = deferred(); let revocationCaptured = false;
      db.ConsentSignaturePackage.addHook('beforeFind', 'owned-revocation-race', async options => {
        if (!revocationCaptured && packageAnchor(options, revoked.pkg.id)) {
          revocationCaptured = true; atCas.resolve(); await revokeRelease.promise;
        }
      });
      const staleSignature = consents.signConsentDocument(revoked.doc.id, f.signature('stale'));
      const staleResult = Promise.allSettled([staleSignature]);
      await atCas.promise;
      await consents.revokeConsentDocument(revoked.doc.id, { reason: 'Prueba ficticia de revocación' });
      const revokedHash = (await db.PatientConsentDocument.findByPk(revoked.doc.id)).snapshot_hash;
      revokeRelease.resolve();
      const [stale] = await staleResult;
      db.ConsentSignaturePackage.removeHook('beforeFind', 'owned-revocation-race');
      assert.equal(stale.status, 'rejected'); assert.equal(stale.reason.message, 'consent_document_signature_conflict');
      const currentRevoked = await db.PatientConsentDocument.findByPk(revoked.doc.id);
      assert.equal(currentRevoked.status, 'revoked'); assert.equal(currentRevoked.snapshot_hash, revokedHash); assert.equal(currentRevoked.signed_at, null);
      assert.equal((await f.signatureEvents(revoked.doc)).length, 0);
      record('Real revocation committed between display and signature CAS remains revoked with its exact hash: no stale tablet signature can revive it');

      // A professional and patient cannot last-write-wins the other's snapshot.
      const mixed = await f.prepare(), captured = deferred(), mixedRelease = deferred(); let mixedCount = 0;
      db.ConsentSignaturePackage.addHook('beforeFind', 'owned-patient-professional', async options => {
        if (!packageAnchor(options, mixed.pkg.id) || mixedCount >= 2) return;
        if (++mixedCount === 2) captured.resolve(); await mixedRelease.promise;
      });
      const mixedResult = Promise.allSettled([consents.signConsentDocument(mixed.doc.id, f.signature('mixed-patient')),
        consents.signProfessionalConsentDocument(mixed.doc.id, { accepted_statement: true }, 7)]);
      await captured.promise; mixedRelease.resolve(); const mixedOutcomes = await mixedResult;
      db.ConsentSignaturePackage.removeHook('beforeFind', 'owned-patient-professional');
      assert.equal(mixedOutcomes.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal(mixedOutcomes.filter(row => row.status === 'rejected' && row.reason.message === 'consent_document_signature_conflict').length, 1);
      let mixedDoc = await db.PatientConsentDocument.findByPk(mixed.doc.id);
      await f.arrive(mixed.cita);
      await assert.rejects(f.start(mixed.cita), error => error.code === 'appointment_consent_required');
      if (!mixedDoc.signed_at) await consents.signConsentDocument(mixed.doc.id, f.signature('mixed-patient-reread'));
      else await consents.signProfessionalConsentDocument(mixed.doc.id, { accepted_statement: true }, 7);
      mixedDoc = await db.PatientConsentDocument.findByPk(mixed.doc.id);
      assert(mixedDoc.snapshot_json.signature_evidence); assert(mixedDoc.snapshot_json.professional_signature_evidence);
      assert.equal((await f.signatureEvents(mixed.doc)).length, 2); await f.start(mixed.cita);
      record('Patient/professional real SQL interleaving rejects the stale hash; re-read/retry preserves both evidences and only then permits care');

      // Requirement DELETE is paused inside its real transaction, while start
      // waits on the same treatment anchor, then sees the new hard requirement.
      const replace = await f.prepare(12); await f.arrive(replace.cita);
      await consents.signConsentDocument(replace.doc.id, f.signature('old-template'));
      const deleted = deferred(), replacementRelease = deferred();
      db.TreatmentConsentRequirement.addHook('afterBulkDestroy', 'owned-requirement-gap', async options => {
        if (Number(options.where?.tratamiento_id) === 12) { deleted.resolve(); await replacementRelease.promise; }
      });
      const replacing = consents.saveTreatmentRequirements(12, { clinic_id: 100, requirements: [{ clinic_template_id: 101 }] });
      const replaceDone = Promise.allSettled([replacing]); await deleted.promise;
      const duringGap = f.start(replace.cita), gapResult = Promise.allSettled([duringGap]);
      await waitUntilBlocked(duringGap); replacementRelease.resolve();
      const [replaceOutcome] = await replaceDone, [gapOutcome] = await gapResult;
      db.TreatmentConsentRequirement.removeHook('afterBulkDestroy', 'owned-requirement-gap');
      assert.equal(replaceOutcome.status, 'fulfilled'); assert.equal(replaceOutcome.value.length, 1);
      assert.equal(gapOutcome.status, 'rejected'); assert.equal(gapOutcome.reason.code, 'appointment_consent_required');
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: replace.cita.id_cita, action: 'start' } }), 0);
      assert.equal((await db.TreatmentConsentRequirement.findOne({ where: { tratamiento_id: 12 } })).clinic_template_id, 101);
      record('Actual care start blocks during paused DELETE/INSERT replacement on treatment UPDATE/SHARE anchor; after commit it checks the new requirement, never a transient empty set');

      db.TreatmentConsentRequirement.addHook('beforeBulkCreate', 'owned-requirement-failure', () => { throw Error('OWNED_REQUIREMENT_INSERT_FAILURE'); });
      await assert.rejects(consents.saveTreatmentRequirements(12, { clinic_id: 100, requirements: [{ clinic_template_id: 102 }] }), failure('OWNED_REQUIREMENT_INSERT_FAILURE'));
      db.TreatmentConsentRequirement.removeHook('beforeBulkCreate', 'owned-requirement-failure');
      assert.equal((await db.TreatmentConsentRequirement.findOne({ where: { tratamiento_id: 12 } })).clinic_template_id, 101);
      await assert.rejects(db.sequelize.transaction(async transaction => {
        const inside = await consents.saveTreatmentRequirements(12, { clinic_id: 100, requirements: [{ clinic_template_id: 102 }] }, transaction);
        assert.equal(inside[0].clinic_template_id, 102); assert.equal(transaction.finished, undefined);
        throw Error('OWNED_CALLER_ROLLBACK');
      }), failure('OWNED_CALLER_ROLLBACK'));
      assert.equal((await db.TreatmentConsentRequirement.findOne({ where: { tratamiento_id: 12 } })).clinic_template_id, 101);
      const brokenCita = await f.appointment(13), packagesBefore = await db.ConsentSignaturePackage.count(), documentsBefore = await db.PatientConsentDocument.count();
      await assert.rejects(consents.createPackageForAppointment(brokenCita.id_cita), failure('consent_template_version_unavailable'));
      assert.equal(await db.ConsentSignaturePackage.count(), packagesBefore); assert.equal(await db.PatientConsentDocument.count(), documentsBefore);
      record('Replacement insertion failure and supplied caller rollback preserve prior requirements; missing exact template version rolls back partial package/document creation. No finished transaction is reused for final signature reads');

      const multiple = await f.prepare(14), aggregates = deferred(), aggregatesRelease = deferred(); let aggregateReads = 0;
      await consents.signProfessionalConsentDocument(multiple.doc.id, { accepted_statement: true }, 7);
      db.ConsentSignaturePackage.addHook('beforeFind', 'owned-two-document-count', async options => {
        if (!packageAnchor(options, multiple.pkg.id) || aggregateReads >= 2) return;
        if (++aggregateReads === 2) aggregates.resolve(); await aggregatesRelease.promise;
      });
      const multipleDone = Promise.allSettled(multiple.pkg.documents.map(row => consents.signConsentDocument(row.id, f.signature('independent-' + row.id))));
      await aggregates.promise;
      aggregatesRelease.resolve(); const multipleResults = await multipleDone;
      db.ConsentSignaturePackage.removeHook('beforeFind', 'owned-two-document-count');
      for (const result of multipleResults) assert.equal(result.status, 'fulfilled', result.reason?.message);
      const counted = await db.ConsentSignaturePackage.findByPk(multiple.pkg.id);
      assert.equal(await db.PatientConsentDocument.count({ where: { package_id: multiple.pkg.id, status: 'signed' } }), 2);
      assert.equal(counted.required_count, 2); assert.equal(counted.signed_count, 2); assert.equal(counted.status, 'signed');
      record('Concurrent signatures of two DIFFERENT native documents retain exact package count2/statussigned, not last-write-wins count1');

      const nonTx = await f.prepare(14); await consents.signConsentDocument(nonTx.pkg.documents[0].id, f.signature('nonTx-first'));
      const aggregateCaptured = deferred(), aggregateContinue = deferred(); let held = false;
      db.PatientConsentDocument.addHook('afterFind', 'owned-nonTx-refresh', async (_rows, options) => {
        if (held || !options.raw || Number(options.where?.package_id) !== nonTx.pkg.id) return;
        held = true; assert(options.transaction, 'even a public refresh must own a transaction');
        aggregateCaptured.resolve(); await aggregateContinue.promise;
      });
      const publicRefresh = consents.refreshPackageCounts(nonTx.pkg.id), publicRefreshDone = Promise.allSettled([publicRefresh]);
      await aggregateCaptured.promise;
      const secondSignature = consents.signConsentDocument(nonTx.pkg.documents[1].id, f.signature('nonTx-second'));
      const secondSignatureDone = Promise.allSettled([secondSignature]);
      await waitUntilBlocked(secondSignature); aggregateContinue.resolve();
      assert.equal((await publicRefreshDone)[0].status, 'fulfilled'); assert.equal((await secondSignatureDone)[0].status, 'fulfilled');
      db.PatientConsentDocument.removeHook('afterFind', 'owned-nonTx-refresh');
      const finalCount = await db.ConsentSignaturePackage.findByPk(nonTx.pkg.id);
      assert.equal(finalCount.signed_count, 2); assert.equal(finalCount.status, 'signed');
      record('Public refresh with NO supplied transaction now locks its parent before count read; a concurrent second signature waits and writes fresh count2 after that refresh, never overwritten by stale count1');

      const reusableA = await f.prepare(15), reusableB = await f.prepare(16), capturedCandidates = deferred(), continueCandidates = deferred();
      let firstCandidateLock = false;
      db.ConsentSignaturePackage.addHook('beforeFind', 'owned-new-package-candidate', async options => {
        if (!firstCandidateLock && packageAnchor(options, reusableA.pkg.id)) {
          firstCandidateLock = true; capturedCandidates.resolve(); await continueCandidates.promise;
        }
      });
      const initialReusableSign = consents.signConsentDocument(reusableA.doc.id, f.signature('reusable-A'));
      const initialReusableDone = Promise.allSettled([initialReusableSign]); await capturedCandidates.promise;
      // Born AFTER the signing sweep's candidate receipt. This new package is
      // deliberately outside its anchor set and must not be swept implicitly.
      const reusableC = await f.prepare(16), reusableCHash = reusableC.doc.snapshot_hash;
      continueCandidates.resolve(); assert.equal((await initialReusableDone)[0].status, 'fulfilled');
      db.ConsentSignaturePackage.removeHook('beforeFind', 'owned-new-package-candidate');
      assert.equal((await db.PatientConsentDocument.findByPk(reusableB.doc.id)).status, 'superseded');
      let survivingC = await db.PatientConsentDocument.findByPk(reusableC.doc.id);
      assert.equal(survivingC.status, 'pending'); assert.equal(survivingC.snapshot_hash, reusableCHash);
      const signedReusableHash = (await db.PatientConsentDocument.findByPk(reusableA.doc.id)).snapshot_hash;
      const refreshReuse = await consents.createPackageForAppointment(reusableC.cita.id_cita);
      assert.equal(refreshReuse.id, reusableC.pkg.id);
      assert.equal((await db.PatientConsentDocument.findByPk(reusableC.doc.id)).status, 'superseded');
      assert.equal((await db.PatientConsentDocument.findByPk(reusableA.doc.id)).snapshot_hash, signedReusableHash);
      assert.equal(await db.PatientConsentDocument.count({ where: { cita_id: reusableC.cita.id_cita } }), 1);
      record('Reusable signature locks candidate packages in ascending ID order: existing sibling superseded, document born after candidate capture is NOT swept; subsequent actual package preparation reuses exact signed evidence and reconciles only its newly captured scope');

      // An independent reusable set (same literal template, different patient)
      // is prepared before either signature, to exercise actual sibling drift.
      await db.Paciente.create({ id_paciente: 3, clinica_id: 100, public_id: 'owned_consent_patient_3', nombre: 'Otro', apellidos: 'Ficticio', fecha_nacimiento: '1990-01-01' });
      const siblingCitaA = await f.appointment(15, { paciente_id: 3 }), siblingCitaB = await f.appointment(16, { paciente_id: 3 });
      const siblingPackA = await consents.createPackageForAppointment(siblingCitaA.id_cita), siblingPackB = await consents.createPackageForAppointment(siblingCitaB.id_cita);
      const siblingDocA = siblingPackA.documents[0], siblingDocB = siblingPackB.documents[0], siblingCaptured = deferred(), siblingContinue = deferred();
      let staleCandidateOnce = false;
      db.ConsentSignaturePackage.addHook('beforeFind', 'owned-signed-sibling', async options => {
        if (!staleCandidateOnce && packageAnchor(options, siblingPackA.id)) {
          staleCandidateOnce = true; siblingCaptured.resolve(); await siblingContinue.promise;
        }
      });
      const staleReusable = consents.signConsentDocument(siblingDocA.id, f.signature('stale-reusable'));
      const staleReusableDone = Promise.allSettled([staleReusable]); await siblingCaptured.promise;
      await consents.signConsentDocument(siblingDocB.id, f.signature('committed-sibling'));
      const siblingBefore = (await db.PatientConsentDocument.findByPk(siblingDocB.id)).toJSON();
      siblingContinue.resolve(); const [staleReusableOutcome] = await staleReusableDone;
      db.ConsentSignaturePackage.removeHook('beforeFind', 'owned-signed-sibling');
      assert.equal(staleReusableOutcome.status, 'rejected'); assert.equal(staleReusableOutcome.reason.message, 'consent_document_signature_conflict');
      const siblingAfter = (await db.PatientConsentDocument.findByPk(siblingDocB.id)).toJSON();
      assert.equal(siblingAfter.status, 'signed'); assert.equal(siblingAfter.snapshot_hash, siblingBefore.snapshot_hash);
      assert.deepEqual(siblingAfter.snapshot_json, siblingBefore.snapshot_json); assert.equal((await f.signatureEvents(siblingDocB)).length, 1);
      assert.equal((await db.PatientConsentDocument.findByPk(siblingDocA.id)).status, 'superseded');
      record('A sibling commits its REAL reusable signature after another signer captured candidates but before parent anchors: stale operation returns409; signed sibling snapshot/evidence remain untouched, no duplicate events or revival');

      // Preserve the reviewed pre-fix lock-order reproduction explicitly, on a
      // separate owned package. This is NOT the current production sign path:
      // it demonstrates why child-then-parent refresh caused ER_LOCK_DEADLOCK.
      const oldOrder = await f.prepare(14), oldReads = deferred(), oldRelease = deferred(); let oldCount = 0;
      const oldTransaction = async document => db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
        await db.PatientConsentDocument.update({ status: 'signed', signed_at: new Date() }, { where: { id: document.id }, transaction });
        await db.ConsentDeliveryEvent.create({ package_id: oldOrder.pkg.id, patient_consent_document_id: document.id,
          channel: 'tablet', status: 'viewed', event_payload: { event: 'OWNED_PRE_FIX_LOCK_ORDER_REPRODUCTION_ONLY' } }, { transaction });
        const rows = await db.PatientConsentDocument.findAll({ where: { package_id: oldOrder.pkg.id }, raw: true, transaction });
        if (++oldCount === 2) oldReads.resolve(); await oldRelease.promise;
        await db.ConsentSignaturePackage.update({ signed_count: rows.filter(row => row.status === 'signed').length }, { where: { id: oldOrder.pkg.id }, transaction });
      });
      const oldDone = Promise.allSettled(oldOrder.pkg.documents.map(oldTransaction)); await oldReads.promise; oldRelease.resolve();
      const oldOutcomes = await oldDone;
      assert.equal(oldOutcomes.filter(row => row.status === 'rejected' && row.reason.original?.code === 'ER_LOCK_DEADLOCK').length, 1);
      assert.equal(oldOutcomes.filter(row => row.status === 'fulfilled').length, 1);
      record('Preserved PRE-FIX SQL algorithm (separate synthetic package, not current service) deterministically reproduces one ER_LOCK_DEADLOCK: two child writes/FK locks then parent aggregate upgrade. Current service regressions above serialize parent first and pass');

      await db.ClinicTabletKiosk.update({ status: 'disabled' }, { where: { id: 1 } });
      await assert.rejects(consents.createTabletSessionForKiosk(rollback.pkg.id, login.token), failure('tablet_kiosk_not_found'));
      assert.equal(await db.CitaPaciente.count({ where: { estado: 'completada' } }), 0);
      context.report.boundaries = { native_sql: true, tablet_jwt_bcrypt_and_current_scope: true, external_sends: 0,
        employee_endpoint_auth_e2e: false, protocol_freeze_tested: false, clinical_composition_inferred: false,
        clinical_approval_created: false, production_data_touched: false };
    });
  });
