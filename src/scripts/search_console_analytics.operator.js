'use strict';

// Injection-only operator: importing or running --plan does not load SQL/models,
// credentials or providers. Applying DDL is a separate reviewed migration step.
const C = require('../lib/searchConsoleAnalyticsContract');
const Legacy = require('../lib/searchConsoleLegacyBackfill');

function retentionPlan(asOf = new Date()) {
  return { asOf: asOf.toISOString().slice(0, 10), detailedFrom: C.cutoff(asOf),
    policy: '24 complete calendar months plus current month',
    archiveBeforePurge: true, partialOldMonth: 'explicit error',
    gates: ['SC_ANALYTICS_WRITE_ENABLED', 'SC_ANALYTICS_READ_ENABLED', 'SC_ANALYTICS_ARCHIVE_ENABLED', 'SC_ANALYTICS_PURGE_ENABLED'],
    required: ['reviewed additive schema', 'source provenance and completeness', 'independent archive read-back verification', 'aggregate reconciliation before read cutover'] };
}

async function backfillInterval({ repository, plan, batchId, journal, validate, confirmPreviousAttemptClosed } = {}) {
  const data = Legacy.records(plan); // Reject booleans, serialized or mutated plans.
  if (!repository?.isWriteEnabled?.()) C.fail('sc_analytics_write_disabled');
  if (!Legacy.UUID.test(batchId || '') || journal?.durable !== true || typeof journal.load !== 'function'
    || typeof journal.record !== 'function') C.fail('sc_analytics_backfill_journal_required');
  if (typeof validate !== 'function' || await validate() !== true) C.fail('sc_analytics_authority_changed');
  const binding = { batchId, sourceDigest: plan.planSha256, ...plan.scope };
  const prior = await journal.load(batchId);
  if (prior && (prior.binding?.sourceDigest !== binding.sourceDigest || Legacy.digest(prior.binding) !== Legacy.digest(binding))) C.fail('sc_analytics_backfill_binding_changed');
  if (prior && !['COMMIT_ACK', 'COMMITTED_OBSERVED'].includes(prior.event) && (typeof confirmPreviousAttemptClosed !== 'function'
    || await confirmPreviousAttemptClosed(prior) !== true)) C.fail('sc_analytics_previous_attempt_closure_required');
  await journal.record({ event: 'INSPECT_INTENT', binding });
  // SELECT/row lock resolves actual SQL state; a prior local return value never
  // authorizes replay. A failed/UNKNOWN invocation is never auto-aborted.
  let status = await repository.inspectInterval(binding, { sourceDigest: binding.sourceDigest, validate });
  if (status.state === 'committed') {
    await journal.record({ event: 'COMMITTED_OBSERVED', binding });
    return { batchId, committed: true, replay: true, planSha256: plan.planSha256 };
  }
  if (!['absent', 'staging'].includes(status.state)) C.fail('sc_analytics_batch_not_staging');
  try {
    let handle = status.handle;
    if (status.state === 'absent') {
      await journal.record({ event: 'BEGIN_INTENT', binding });
      handle = await repository.beginInterval({ ...binding, kind: 'detail', validate });
      await journal.record({ event: 'BEGIN_ACK', binding });
    }
    for (const family of ['detail', 'totals']) {
      // Empty totals are explicit evidence only after the audit proved that date;
      // stageRows([],totals:true) binds the two families to one atomic publication.
      for (let at = 0; at < Math.max(data[family].length, 1); at += 250) {
        if (await validate() !== true) C.fail('sc_analytics_authority_changed');
        await journal.record({ event: 'STAGE_INTENT', binding, family, offset: at });
        await repository.stageRows(handle, data[family].slice(at, at + 250), { totals: family === 'totals' });
        await journal.record({ event: 'STAGE_ACK', binding, family, offset: at });
      }
    }
    await journal.record({ event: 'COMMIT_INTENT', binding });
    const result = await repository.commitInterval(handle, { complete: true, rowLimitReached: false, validate,
      reconciliation: { sourceDigest: plan.planSha256, days: plan.days } });
    if (result?.committed !== true) C.fail('sc_analytics_backfill_commit_unproven');
    await journal.record({ event: 'COMMIT_ACK', binding });
    return { ...result, planSha256: plan.planSha256, sourceRows: plan.sourceRows, identicalClones: plan.identicalClones };
  } catch (error) {
    // Do not replace an UNKNOWN commit with an abort or a fresh batch identity.
    // Recovery requires prior transport closure and inspection of this same ID.
    await journal.record({ event: 'UNCERTAIN', binding }).catch(() => {}); throw error;
  }
}

async function rollupAndPurge({ repository, siteUrl, month, archiveStore, validate, purge = false,
  chunkSize = 1000, maxChunks = 1 } = {}) {
  const archive = await repository.archiveMonth({ siteUrl, month, archiveStore, validate });
  if (!purge) return { archive, purge: 'not requested' };
  return { archive, purge: await repository.purgeArchivedMonth({ siteUrl, month, archiveStore, validate, chunkSize, maxChunks }) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] !== '--plan' || args.length > 2) { process.stderr.write('Usage: node src/scripts/search_console_analytics.operator.js --plan [YYYY-MM-DD]\n'); process.exitCode = 2; }
  else { const when = args[1] ? new Date(C.date(args[1])) : new Date(); process.stdout.write(JSON.stringify(retentionPlan(when), null, 2) + '\n'); }
}
module.exports = { retentionPlan, backfillInterval, rollupAndPurge, readLegacyInterval: Legacy.readLegacyInterval,
  prepareLegacyBackfill: Legacy.prepareLegacyBackfill, createBackfillJournal: Legacy.createBackfillJournal };
