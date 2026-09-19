'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
module.exports = async ({ models, report, now, writes, calls, setAfterRemote, setBeforeRemote, setProviderMode,
  web, uploadWeb, getSetting, health, nativeAttemptId }) => {
  const A = models.GoogleAdsConversionUploadAttempt, J = models.GoogleConversionSubmission;
  const { reconcileManagedGoogleConversion: reconcile } = require('../../../services/googleConversionDiagnosticsBroker.service');
  const { reconcileGoogleDataManagerDiagnostics: batch } = require('../../../services/googleDataManagerDiagnostics.service');
  const run = attemptId => reconcile({ models, attemptId, now });
  // Sequelize deliberately skips timestamp-only model updates; use the owned
  // fixture connection to set the real SQL scheduling boundary explicitly.
  const age = id => models.sequelize.query('UPDATE GoogleAdsConversionUploadAttempts SET updated_at = ? WHERE id = ?',
    { replacements: [new Date(+now() - 120000), id] });
  const postponeAll = () => models.sequelize.query('UPDATE GoogleAdsConversionUploadAttempts SET updated_at = ?',
    { replacements: [new Date(+now() + 3600000)] });
  const poll = () => batch({ models, minAgeMinutes: 1, now: now(),
    credentials: { load: () => assert.fail('managed diagnostics cannot read local credentials') },
    ensureAccessToken: () => assert.fail('managed diagnostics cannot refresh OAuth'),
    retrieveStatus: () => assert.fail('managed diagnostics cannot use legacy request IDs') });
  const readLead = models.LeadIntake.findByPk;
  try {
    models.LeadIntake.findByPk = () => assert.fail('receipt reads must not load clinical lead contacts');
    const nativeWrites = writes();
    assert.equal((await run(nativeAttemptId)).state, 'succeeded'); assert.equal(writes(), nativeWrites);
    assert.equal((await health()).get('fictitious-campaign').processed, 1);
    report.checks.push('native diagnostics use the persisted owned UUID, current mandate and recipient, never load lead contacts and make processed status visible in actual Health');

    const lost = web(); setAfterRemote(command => { if (command.operation === 'google.ads.conversion.ingest.v1') {
      setAfterRemote(null); throw Object.assign(Error('fictitious lost ACK'), { code: 'broker_timeout' }); } });
    await assert.rejects(uploadWeb(lost), { code: 'broker_timeout' });
    const unknown = await A.findOne({ where: { eventId: lost.eventId } });
    assert.equal(unknown.status, 'pending'); assert.equal(unknown.providerRequestId, null);
    await postponeAll(); await age(unknown.id);
    const before = writes(), result = await poll();
    assert.equal(result.checked, 1, 'lost ACK must be selected: ' + JSON.stringify(result));
    assert.equal(result.succeeded, 1, 'lost ACK must reconcile: ' + JSON.stringify((await A.findByPk(unknown.id)).responseMetadata));
    assert.equal(result.errors, 0);
    assert.equal(writes(), before); await unknown.reload(); assert.equal(unknown.status, 'succeeded'); assert(unknown.providerRequestId);
    report.checks.push('actual SQL batch selects a marked pending ACK-loss row without a Google request ID and recovers success by signed status, without reingestion or legacy credential access');

    const legacyPending = await A.create({ dedupeKey: require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex'),
      status: 'pending', assignmentScope: 'clinic', attemptCount: 1, eventName: 'lead', attemptedAt: new Date(+now() - 120000), requestMetadata: {} });
    await postponeAll(); await age(legacyPending.id);
    assert.equal((await poll()).checked, 0);
    report.checks.push('batch selection does not adopt an old unmarked pending legacy attempt');

    const noReceipt = web(); setBeforeRemote(command => { if (command.operation === 'google.ads.conversion.ingest.v1') {
      setBeforeRemote(null); throw Object.assign(Error('fictitious pre-receipt outage'), { code: 'broker_timeout' }); } });
    await assert.rejects(uploadWeb(noReceipt), { code: 'broker_timeout' });
    const absent = await A.findOne({ where: { eventId: noReceipt.eventId } });
    await postponeAll(); await age(absent.id);
    const absentWrites = writes(), unresolved = await poll();
    assert.equal(unresolved.errors, 1); assert.equal(unresolved.unconfirmed, 1); assert.equal(writes(), absentWrites);
    await absent.reload(); assert.equal(absent.status, 'pending'); assert.equal(absent.providerRequestId, null);
    assert.equal((await J.findByPk(absent.requestMetadata.broker_submission_id)).state, 'unknown');
    report.checks.push('a missing durable broker receipt remains explicitly unconfirmed and persists a bounded diagnostic error without resending or marking processing/success');

    const preparedInput = web(), preparedWrites = writes();
    J.addHook('beforeUpdate', 'fictitious_stop_before_dispatch', value => {
      if (value.state === 'attempted') throw Error('fictitious stop before dispatch');
    });
    try { await assert.rejects(uploadWeb(preparedInput)); }
    finally { J.removeHook('beforeUpdate', 'fictitious_stop_before_dispatch'); }
    const prepared = await A.findOne({ where: { eventId: preparedInput.eventId } });
    assert.equal((await J.findByPk(prepared.requestMetadata.broker_submission_id)).state, 'prepared');
    await postponeAll(); await age(prepared.id); const preparedCalls = calls();
    const preparedResult = await poll();
    assert.equal(preparedResult.checked, 1); assert.equal(preparedResult.unconfirmed, 1); assert.equal(preparedResult.processing, 0);
    assert.equal(calls(), preparedCalls); assert.equal(writes(), preparedWrites);
    assert.equal((await J.findByPk(prepared.requestMetadata.broker_submission_id)).state, 'prepared');
    report.checks.push('a transaction interrupted before dispatch stays prepared and unconfirmed; the real diagnostic batch neither sends nor asks Google to invent a receipt');

    const pending = await uploadWeb(web()), stable = await A.findByPk(pending.audit_id);
    const setting = await getSetting(), activation = structuredClone(setting.activation), version = setting.version;
    const unchanged = calls();
    await setting.update({ activation: { ...activation, status: 'paused' } });
    await assert.rejects(run(stable.id), { code: 'conversion_paused' }); assert.equal(calls(), unchanged);
    await setting.update({ activation, version });
    await models.Clinica.update({ estado_clinica: false }, { where: { id_clinica: 71 } });
    await assert.rejects(run(stable.id), { code: 'conversion_paused' }); assert.equal(calls(), unchanged);
    await models.Clinica.update({ estado_clinica: true }, { where: { id_clinica: 71 } });
    await models.GoogleConnectionAssignment.update({ status: 'disconnected' }, { where: { id: 100 } });
    await assert.rejects(run(stable.id), { code: 'scope_denied' }); assert.equal(calls(), unchanged);
    await models.GoogleConnectionAssignment.update({ status: 'active' }, { where: { id: 100 } });
    const key = process.env.GOOGLE_ADS_BROKER_KEY_ID;
    try { process.env.GOOGLE_ADS_BROKER_KEY_ID = 'different-reader'; await assert.rejects(run(stable.id)); }
    finally { process.env.GOOGLE_ADS_BROKER_KEY_ID = key; }
    assert.equal(calls(), unchanged);
    report.checks.push('paused clinic/mandate, revoked assignment and a different signing identity all stop diagnostics before transport and never use a legacy fallback');

    const metadata = structuredClone(stable.requestMetadata);
    await stable.update({ requestMetadata: { ...metadata, broker_submission_id: unknown.requestMetadata.broker_submission_id } });
    await assert.rejects(run(stable.id), { code: 'conversion_submission_conflict' }); assert.equal(calls(), unchanged);
    await stable.update({ requestMetadata: metadata });
    const priorHistory = JSON.stringify(stable.history);
    setAfterRemote(async command => { if (command.operation === 'google.ads.conversion.status.v1') {
      setAfterRemote(null); await setting.update({ activation: { ...activation, status: 'paused' } }); } });
    await assert.rejects(run(stable.id), { code: 'conversion_paused' });
    await stable.reload(); assert.equal(stable.status, 'accepted'); assert.equal(JSON.stringify(stable.history), priorHistory);
    await setting.update({ activation, version });
    assert.equal((await run(stable.id)).state, 'succeeded');
    const completed = await A.findByPk(stable.id, { raw: true }), terminalCalls = calls();
    assert.equal((await run(stable.id)).state, 'succeeded'); assert.equal(calls(), terminalCalls);
    assert.equal(JSON.stringify((await A.findByPk(stable.id, { raw: true })).history), JSON.stringify(completed.history));
    report.checks.push('swapped UUIDs cannot borrow receipts; revocation during a status read prevents local acceptance, and recovery never downgrades or rewrites terminal history');

    const waiting = await uploadWeb(web()); setProviderMode('EMPTY');
    assert.equal((await run(waiting.audit_id)).state, 'accepted');
    setProviderMode('SUCCESS');
    setAfterRemote(command => { if (command.operation === 'google.ads.conversion.status.v1') {
      setAfterRemote(null); throw Object.assign(Error('PRIVATE_PROVIDER_BODY'), { code: 'provider_failed', response: { data: { token: 'PRIVATE_PROVIDER_TOKEN' } } }); } });
    await assert.rejects(run(waiting.audit_id), { code: 'provider_failed' });
    const errorRow = await A.findByPk(waiting.audit_id);
    assert.equal(errorRow.status, 'accepted'); assert.doesNotMatch(JSON.stringify(errorRow.responseMetadata), /PRIVATE_PROVIDER/);
    assert.equal(errorRow.responseMetadata.diagnostics_error.code, 'provider_failed');
    assert.equal((await run(waiting.audit_id)).state, 'succeeded');
    assert.equal((await A.findByPk(waiting.audit_id)).responseMetadata.diagnostics_error, null);
    report.checks.push('empty provider status stays processing; diagnostic errors contain only bounded codes and successful recovery performs no ingestion');

    const racing = await uploadWeb(web()); let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    setAfterRemote(async command => { if (command.operation === 'google.ads.conversion.status.v1') {
      setAfterRemote(null); enter(); await blocked;
      throw Object.assign(Error('fictitious late read failure'), { code: 'provider_timeout' });
    } });
    const first = run(racing.audit_id).then(value => ({ value }), error => ({ error }));
    let timer;
    try {
      await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fictitious barrier timeout')), 5000); })]);
      clearTimeout(timer);
      assert.equal((await run(racing.audit_id)).state, 'succeeded');
      const snapshot = JSON.stringify((await A.findByPk(racing.audit_id)).get({ plain: true }));
      release(); assert.equal((await first).error?.code, 'provider_timeout');
      assert.equal(JSON.stringify((await A.findByPk(racing.audit_id)).get({ plain: true })), snapshot);
      assert.equal((await J.findOne({ where: { attempt_id: racing.audit_id } })).last_error, null);
    } finally { clearTimeout(timer); release(); await first; }
    report.checks.push('a delayed diagnostics failure racing a confirmed successful read cannot overwrite terminal status, metadata, timestamp or audit history');
  } finally {
    models.LeadIntake.findByPk = readLead; setAfterRemote(null); setBeforeRemote(null); setProviderMode('SUCCESS');
  }
};
