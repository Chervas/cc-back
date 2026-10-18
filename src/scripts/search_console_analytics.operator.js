'use strict';

// Injection-only operator: importing or running --plan does not load SQL/models,
// credentials or providers. Applying DDL is a separate reviewed migration step.
const C = require('../lib/searchConsoleAnalyticsContract');

function retentionPlan(asOf = new Date()) {
  return { asOf: asOf.toISOString().slice(0, 10), detailedFrom: C.cutoff(asOf),
    policy: '24 complete calendar months plus current month',
    archiveBeforePurge: true, partialOldMonth: 'explicit error',
    gates: ['SC_ANALYTICS_WRITE_ENABLED', 'SC_ANALYTICS_READ_ENABLED', 'SC_ANALYTICS_ARCHIVE_ENABLED', 'SC_ANALYTICS_PURGE_ENABLED'],
    required: ['reviewed additive schema', 'source provenance and completeness', 'independent archive read-back verification', 'aggregate reconciliation before read cutover'] };
}

async function backfillInterval({ repository, source, siteUrl, startDate, endDate, validate,
  provenanceReviewed = false, complete = false } = {}) {
  C.property(siteUrl); C.range(startDate, endDate);
  if (provenanceReviewed !== true || complete !== true) C.fail('sc_analytics_backfill_review_required');
  if (!repository?.isWriteEnabled?.()) C.fail('sc_analytics_write_disabled');
  if (!source?.[Symbol.asyncIterator]) C.fail('sc_analytics_bounded_source_required');
  const handle = await repository.beginInterval({ siteUrl, startDate, endDate, validate });
  let page = [], seen = 0;
  try {
    for await (const row of source) {
      // A clinic-scoped legacy row is evidence only after provenance review:
      // site_url historically did not participate in the legacy unique key.
      if (row.site_url !== siteUrl) C.fail('sc_analytics_ambiguous_legacy_property');
      page.push(row); seen++;
      if (page.length === 250) { await repository.stageRows(handle, page); page = []; }
    }
    if (page.length) await repository.stageRows(handle, page);
    const result = await repository.commitInterval(handle, { complete: true, rowLimitReached: false, validate });
    return { ...result, sourceRows: seen, clones: 'identical identities retained once; conflicts abort' };
  } catch (error) { await repository.abortInterval(handle).catch(() => {}); throw error; }
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
module.exports = { retentionPlan, backfillInterval, rollupAndPurge };
