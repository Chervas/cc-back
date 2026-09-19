'use strict';
const C = require('./googleAdsEnrollment.contract');
const clientContract = require('./googleAdsEnrollmentClient.service');
const CLOSING = new Set(['google_discovery_session_required', 'google_discovery_scope_forbidden',
  'google_ads_enrollment_scope_conflict', 'google_ads_enrollment_scope_unconfigured', 'google_ads_enrollment_disabled',
  'google_ads_enrollment_account_in_use', 'asset_revoked']);
const safe = error => CLOSING.has(error?.code) || error?.code === 'google_ads_enrollment_lease_lost'
  ? error.code : clientContract.safe(error);
function createGoogleAdsEnrollmentWorker({ repository, client, scope, now = Date.now,
  enabled = () => process.env.GOOGLE_ADS_ENROLLMENT_WORKER_ENABLED === 'true' }) {
  let running = false;
  async function advance(row) {
    C.request(row);
    const assertEnabled = () => { if (!enabled()) C.fail('google_ads_enrollment_worker_disabled'); };
    const beforeExecute = async () => {
      assertEnabled(); const result = await repository.assertClaim(row); assertEnabled(); return result;
    };
    assertEnabled();
    if (row.state === 'revoke_pending') return repository.revoked(row, await client.revoke(row, { beforeExecute }));
    let context;
    try {
      context = await scope.restore(row);
      assertEnabled();
      if (row.state === 'prepared') return await repository.activating(row, context);
      if (row.state === 'activation_confirmed') return await repository.awaitingMapping(row, context);
      if (!['prepare_pending','activate_pending'].includes(row.state)) C.fail('google_ads_enrollment_scope_conflict');
      let result;
      if (Number(row.attempts) > 1) {
        // Recover a committed result after an HTTP/SQL ACK was lost. A status
        // denial is not proof of absence: only the original durable command ID
        // may be retried, never a replacement command or a legacy credential.
        try { result = await client.status(row, context, { beforeExecute }); }
        catch (error) { if (error?.code !== 'scope_denied') throw error; }
        if (result?.state === 'revoked' || result?.state === 'active' && result.accessBlocked) C.fail('asset_revoked');
      }
      if (row.state === 'prepare_pending') {
        result ||= await client.prepare(row, context, { beforeExecute });
        return await repository.prepared(row, context, result);
      }
      if (result?.state !== 'active') result = await client.activate(row, context, { beforeExecute });
      return await repository.activated(row, context, result);
    } finally { if (context) scope.release(context); }
  }
  return { async run() {
    if (!enabled() || running) return { status: 'completed', skipped: true, reason: 'google_ads_enrollment_worker_disabled_or_busy' };
    running = true; let advanced = 0; let failed = 0; let cancelled = 0;
    try {
      const deadline = now() + 30000;
      for (let count = 0; count < 20 && enabled() && now() < deadline; count++) {
        const row = await repository.claim(); if (!row) break;
        try { await advance(row); advanced++; }
        catch (error) {
          const code = safe(error); failed++;
          if (code === 'google_ads_enrollment_lease_lost') continue;
          try {
            if (row.state !== 'revoke_pending' && CLOSING.has(code)) { await repository.cancelClaim(row, code); cancelled++; }
            else await repository.retry(row, code);
          } catch (retryError) { if (retryError?.code !== 'google_ads_enrollment_lease_lost') throw retryError; }
        }
      }
      return { status: failed ? 'failed' : 'completed', retryable: false, advanced, failed, cancelled };
    } catch (error) { return { status: 'failed', retryable: false, advanced, failed, cancelled, error: safe(error) }; }
    finally { running = false; }
  } };
}
module.exports = { createGoogleAdsEnrollmentWorker, safe };
