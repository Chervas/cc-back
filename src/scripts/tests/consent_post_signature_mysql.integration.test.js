'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedConsentConsistencyFixture } = require('./helpers/owned-consent-consistency-fixture');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('consent post-signature reads/mock delivery/revocation preserve native SQL evidence and closed states',
  { skip: process.env.CONSENT_POST_SIGNATURE_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedConsentConsistencyFixture(context), { db, consents } = f;
      const observations = context.report.observations = [], violations = [];
      const check = (name, passed, actual) => { observations.push({ name, passed, actual }); if (!passed) violations.push(name); };
      const pausePackageRead = async (item, name, work) => {
        const captured = deferred(), release = deferred(); let paused = false;
        db.ConsentSignaturePackage.addHook('afterFind', name, async (row, options) => {
          if (paused || options.transaction || Number(row?.id) !== item.pkg.id || !options.include?.some(include => include.as === 'documents')) return;
          paused = true; captured.resolve(); await release.promise;
        });
        const result = Promise.allSettled([work()]); await captured.promise;
        return { result, resume: () => { release.resolve(); db.ConsentSignaturePackage.removeHook('afterFind', name); } };
      };

      const viewing = await f.prepare(12), tablet = await consents.createTabletSession(viewing.pkg.id, { base_url: 'https://owned-tablet.invalid' });
      const staleView = await pausePackageRead(viewing, 'owned-stale-view', () => consents.getPublicPackage(tablet.public_token));
      await consents.signConsentDocument(viewing.doc.id, f.signature('view-winner'));
      const viewSigned = (await db.PatientConsentDocument.findByPk(viewing.doc.id)).toJSON();
      staleView.resume(); const [viewResult] = await staleView.result;
      const viewAfter = (await db.PatientConsentDocument.findByPk(viewing.doc.id)).toJSON(), viewPackage = await db.ConsentSignaturePackage.findByPk(viewing.pkg.id);
      check('Stale public view does NOT turn a signed document into viewed', viewResult.status === 'fulfilled' && viewAfter.status === 'signed'
        && viewAfter.snapshot_hash === viewSigned.snapshot_hash && viewPackage.signed_count === 1 && viewPackage.status === 'signed',
      { document_status: viewAfter.status, package_status: viewPackage.status, signed_count: viewPackage.signed_count, view_outcome: viewResult.status });

      const mocking = await f.prepare(12);
      const staleMock = await pausePackageRead(mocking, 'owned-stale-mock', () => consents.sendPackageMock(mocking.pkg.id, { channel: 'whatsapp', base_url: 'https://owned-tablet.invalid' }));
      await consents.signConsentDocument(mocking.doc.id, f.signature('mock-winner'));
      const mockSigned = (await db.PatientConsentDocument.findByPk(mocking.doc.id)).toJSON();
      staleMock.resume(); const [mockResult] = await staleMock.result;
      const mockAfter = (await db.PatientConsentDocument.findByPk(mocking.doc.id)).toJSON(), mockPackage = await db.ConsentSignaturePackage.findByPk(mocking.pkg.id);
      const mockedEvents = await db.ConsentDeliveryEvent.count({ where: { package_id: mocking.pkg.id, status: 'mock_sent' } });
      check('Stale MOCK delivery does NOT turn signed into sent or claim a mock receipt', mockAfter.status === 'signed'
        && mockAfter.snapshot_hash === mockSigned.snapshot_hash && mockPackage.signed_count === 1 && mockPackage.status === 'signed'
        && mockedEvents === 0 && mockResult.status === 'rejected' && mockResult.reason.message === 'consent_package_has_no_pending_documents',
      { document_status: mockAfter.status, package_status: mockPackage.status, signed_count: mockPackage.signed_count,
        mocked_events: mockedEvents, mock_outcome: mockResult.status, error: mockResult.reason?.message });

      const revoking = await f.prepare(), revokeCaptured = deferred(), revokeRelease = deferred(); let revokePaused = false;
      db.PatientConsentDocument.addHook('afterFind', 'owned-stale-revoke', async (row, options) => {
        if (revokePaused || options.transaction || Number(row?.id) !== revoking.doc.id || !options.include) return;
        revokePaused = true; revokeCaptured.resolve(); await revokeRelease.promise;
      });
      const staleRevoke = Promise.allSettled([consents.revokeConsentDocument(revoking.doc.id, { reason: 'Revocación ficticia después de ambas firmas' })]);
      await revokeCaptured.promise;
      await consents.signConsentDocument(revoking.doc.id, f.signature('revoke-patient-winner'));
      await consents.signProfessionalConsentDocument(revoking.doc.id, { accepted_statement: true }, 7);
      const revokeSigned = (await db.PatientConsentDocument.findByPk(revoking.doc.id)).toJSON();
      revokeRelease.resolve(); const [revokeResult] = await staleRevoke;
      db.PatientConsentDocument.removeHook('afterFind', 'owned-stale-revoke');
      const revokeAfter = (await db.PatientConsentDocument.findByPk(revoking.doc.id)).toJSON();
      check('Revocation rereads CURRENT snapshot and preserves both signature evidences', revokeResult.status === 'fulfilled' && revokeAfter.status === 'revoked'
        && JSON.stringify(revokeAfter.snapshot_json.signature_evidence) === JSON.stringify(revokeSigned.snapshot_json.signature_evidence)
        && JSON.stringify(revokeAfter.snapshot_json.professional_signature_evidence) === JSON.stringify(revokeSigned.snapshot_json.professional_signature_evidence)
        && revokeAfter.snapshot_json.revocation_evidence?.reason === 'Revocación ficticia después de ambas firmas'
        && revokeAfter.snapshot_hash !== revokeSigned.snapshot_hash && !!revokeAfter.signed_at && !!revokeAfter.professional_signed_at,
      { status: revokeAfter.status, patient_evidence_present: !!revokeAfter.snapshot_json.signature_evidence,
        professional_evidence_present: !!revokeAfter.snapshot_json.professional_signature_evidence });

      const rollback = await f.prepare(12); await consents.signConsentDocument(rollback.doc.id, f.signature('rollback-base'));
      const rollbackBefore = (await db.PatientConsentDocument.findByPk(rollback.doc.id)).toJSON();
      db.ConsentDeliveryEvent.addHook('beforeCreate', 'owned-revoke-event-failure', row => {
        if (row.patient_consent_document_id === rollback.doc.id && row.event_payload?.event === 'document_revoked') throw Error('OWNED_REVOKE_EVENT_FAILURE');
      });
      await assert.rejects(consents.revokeConsentDocument(rollback.doc.id), error => error.message === 'OWNED_REVOKE_EVENT_FAILURE');
      db.ConsentDeliveryEvent.removeHook('beforeCreate', 'owned-revoke-event-failure');
      const rollbackAfter = await db.PatientConsentDocument.findByPk(rollback.doc.id), rollbackPackage = await db.ConsentSignaturePackage.findByPk(rollback.pkg.id);
      check('Revocation event insertion failure rolls document/hash/package counters back together', rollbackAfter.status === 'signed'
        && rollbackAfter.snapshot_hash === rollbackBefore.snapshot_hash && !rollbackAfter.revoked_at && rollbackPackage.signed_count === 1,
      { status: rollbackAfter.status, same_hash: rollbackAfter.snapshot_hash === rollbackBefore.snapshot_hash, signed_count: rollbackPackage.signed_count });

      await f.arrive(revoking.cita);
      await assert.rejects(f.start(revoking.cita), error => error.code === 'appointment_consent_required');
      check('Revoked evidence never authorizes clinical start', true, { preserved_signatures_are_history_not_current_permission: true });

      for (const status of ['cancelled', 'expired']) {
        const closed = await f.prepare(12), session = await consents.createTabletSession(closed.pkg.id);
        for (const mode of ['view', 'mock']) {
          // Reopen only this OWNED synthetic setup between independent probes.
          await db.ConsentSignaturePackage.update({ status: 'pending' }, { where: { id: closed.pkg.id } });
          const oldRead = await pausePackageRead(closed, 'owned-closed-package-' + status + '-' + mode,
            () => mode === 'view' ? consents.getPublicPackage(session.public_token) : consents.sendPackageMock(closed.pkg.id, { channel: 'email' }));
          await db.ConsentSignaturePackage.update({ status }, { where: { id: closed.pkg.id } });
          oldRead.resume(); const [outcome] = await oldRead.result;
          assert.equal(outcome.status, 'rejected'); assert.equal(outcome.reason.statusCode, 410);
          assert.equal((await db.ConsentSignaturePackage.findByPk(closed.pkg.id)).status, status);
          assert.equal((await db.PatientConsentDocument.findByPk(closed.doc.id)).status, 'pending');
          const freshCounts = await consents.refreshPackageCounts(closed.pkg.id);
          assert.equal(freshCounts.status, status); assert.equal((await db.ConsentSignaturePackage.findByPk(closed.pkg.id)).status, status);
        }
      }
      check('Cancelled/expired package changed after initial read is reread/denied for view and mock; standalone counts never revive it', true, { cases: 4 });

      for (const status of ['revoked', 'rejected', 'expired', 'cancelled', 'superseded', 'voided']) {
        const closedDoc = await f.prepare(12), session = await consents.createTabletSession(closedDoc.pkg.id);
        const oldRead = await pausePackageRead(closedDoc, 'owned-terminal-doc-' + status, () => consents.getPublicPackage(session.public_token));
        const patch = { status, ...(status === 'revoked' ? { revoked_at: new Date() } : {}) };
        await db.PatientConsentDocument.update(patch, { where: { id: closedDoc.doc.id } });
        oldRead.resume(); const [outcome] = await oldRead.result;
        assert.equal(outcome.status, 'fulfilled');
        assert.equal((await db.PatientConsentDocument.findByPk(closedDoc.doc.id)).status, status);
        assert.equal((await db.PatientConsentDocument.findByPk(closedDoc.doc.id)).snapshot_hash, closedDoc.doc.snapshot_hash);
        const events = await db.ConsentDeliveryEvent.findAll({ where: { patient_consent_document_id: closedDoc.doc.id }, raw: true });
        assert.equal(events.filter(row => row.event_payload?.event === 'public_package_viewed').length, 0);
        await assert.rejects(consents.sendPackageMock(closedDoc.pkg.id), error => error.message === 'consent_package_has_no_pending_documents');
      }
      check('Stale read preserves every terminal document state/hash; no viewed or mock receipt is added for a now-closed document', true, { terminal_states: 6 });

      for (const mode of ['view', 'mock']) {
        const eventRollback = await f.prepare(12), session = await consents.createTabletSession(eventRollback.pkg.id);
        db.ConsentDeliveryEvent.addHook('beforeCreate', 'owned-read-mock-event-failure', row => {
          if (row.patient_consent_document_id === eventRollback.doc.id
            && (row.event_payload?.event === 'public_package_viewed' || row.event_payload?.mocked)) throw Error('OWNED_DELIVERY_EVENT_FAILURE');
        });
        await assert.rejects(mode === 'view' ? consents.getPublicPackage(session.public_token) : consents.sendPackageMock(eventRollback.pkg.id),
          error => error.message === 'OWNED_DELIVERY_EVENT_FAILURE');
        db.ConsentDeliveryEvent.removeHook('beforeCreate', 'owned-read-mock-event-failure');
        const currentDoc = await db.PatientConsentDocument.findByPk(eventRollback.doc.id), currentPackage = await db.ConsentSignaturePackage.findByPk(eventRollback.pkg.id);
        assert.equal(currentDoc.status, 'pending'); assert.equal(currentDoc.snapshot_hash, eventRollback.doc.snapshot_hash);
        assert.equal(currentPackage.status, 'pending'); assert.equal(currentPackage.signed_count, 0);
      }
      check('View/mock event failures roll back their CAS delivery state and aggregate; mock_sent never means a provider send', true, { external_provider_attempts: 0 });

      const revokeRace = await f.prepare(12); await consents.signConsentDocument(revokeRace.doc.id, f.signature('revoke-race-base'));
      const bothRevokers = deferred(), releaseRevokers = deferred(); let revokers = 0;
      db.ConsentSignaturePackage.addHook('beforeFind', 'owned-two-revokers', async options => {
        if (revokers >= 2 || !options.transaction || options.lock !== options.transaction.LOCK.UPDATE
          || Number(options.where?.id) !== revokeRace.pkg.id || options.attributes?.length !== 1) return;
        if (++revokers === 2) bothRevokers.resolve(); await releaseRevokers.promise;
      });
      const revokedTwice = Promise.allSettled([consents.revokeConsentDocument(revokeRace.doc.id, { reason: 'Dispositivo A' }),
        consents.revokeConsentDocument(revokeRace.doc.id, { reason: 'Dispositivo B' })]);
      await bothRevokers.promise; releaseRevokers.resolve(); const revokeOutcomes = await revokedTwice;
      db.ConsentSignaturePackage.removeHook('beforeFind', 'owned-two-revokers');
      assert.equal(revokeOutcomes.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal(revokeOutcomes.filter(row => row.status === 'rejected' && row.reason.message === 'consent_document_cannot_be_revoked').length, 1);
      const revokeEvents = await db.ConsentDeliveryEvent.findAll({ where: { patient_consent_document_id: revokeRace.doc.id }, raw: true });
      assert.equal(revokeEvents.filter(row => row.event_payload?.event === 'document_revoked').length, 1);
      check('Concurrent revocations serialize current document and append exactly one revocation event without overwriting signature history', true, { winners: 1, rejected_closed: 1 });

      context.report.boundaries = { real_services_and_native_sql: true, external_sends: 0, employee_endpoint_auth_e2e: false,
        clinical_approval_created: false, protocol_freeze_tested: false, production_data_touched: false };
      assert.deepEqual(violations, [], 'Post-signature consistency violations: ' + JSON.stringify(observations));
      context.report.checks.push('Actual stale public view and mock delivery cannot degrade signed/closed evidence; revocation snapshots retain current patient+professional signatures and roll back with their event/counter');
    });
  });
