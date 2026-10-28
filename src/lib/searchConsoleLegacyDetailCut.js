'use strict';
const C = require('./searchConsoleAnalyticsContract');
const CUT_GATE = 'SC_ANALYTICS_LEGACY_DETAIL_CUT_ENABLED';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = code => C.fail('search_console_' + code);
function mappingSet(assets, clinicId) {
  if (!Array.isArray(assets) || !assets.length || assets.length > 200) fail('cut_mapping_universe_invalid');
  const rows = assets.map(a => {
    const id = Number(a.id), clinic = Number(a.clinicaId), connection = Number(a.googleConnectionId);
    if (![id, clinic, connection].every(n => Number.isSafeInteger(n) && n > 0) || clinic !== Number(clinicId)) fail('cut_mapping_universe_invalid');
    return [id, clinic, connection, C.property(a.siteUrl).siteUrl];
  }).sort((a, b) => a[0] - b[0]);
  if (new Set(rows.map(r => r[0])).size !== rows.length) fail('cut_mapping_universe_invalid');
  return rows;
}
function captureCutPolicy(env) {
  const enabled = env?.[CUT_GATE] === 'true';
  function assertCurrent() {
    if ((env?.[CUT_GATE] === 'true') !== enabled) fail('cut_configuration_changed');
    if (enabled && (env.SC_ANALYTICS_WRITE_ENABLED !== 'true' || env.SC_ANALYTICS_READ_ENABLED !== 'true')) fail('cut_requires_compact_read_write');
  }
  assertCurrent();
  function record(ack, { siteUrl, startDate, endDate, kind }) {
    assertCurrent(); C.property(siteUrl); C.range(startDate, endDate);
    if (ack?.committed !== true || !UUID.test(ack.batchId || '') || !['detail', 'totals'].includes(kind)) fail('compact_commit_ack_unproven');
    return Object.freeze({ batchId: ack.batchId, siteUrl, startDate, endDate, kind });
  }
  function assertRowDates(rows, finalRange) {
    assertCurrent();
    if (rows.some(row => !finalRange || row.keys?.[0] < finalRange.start || row.keys?.[0] > finalRange.end)) fail('compact_detail_outside_final_coverage');
  }
  async function beforePublish({ assets, allAssets, clinicId, range, rows, finalRanges, totalsAcks, detailAcks, confirm }) {
    assertCurrent();
    if (!enabled) return;
    if (JSON.stringify(mappingSet(assets, clinicId)) !== JSON.stringify(mappingSet(allAssets, clinicId))) fail('cut_mapping_universe_changed');
    if (typeof confirm !== 'function') fail('compact_publication_verifier_required');
    const omittedDates = [...new Set(rows.map(row => C.date(row.date)))];
    for (const a of [...assets].sort((a, b) => String(a.siteUrl).localeCompare(String(b.siteUrl)))) {
      const final = finalRanges.get(a.id);
      if (omittedDates.some(date => !final || date < final.start || date > final.end)) fail('compact_final_coverage_missing');
      const start = final && (range.s > final.start ? range.s : final.start);
      const end = final && (range.e < final.end ? range.e : final.end);
      // A future final-data tail with no rows is pending, never fake coverage.
      if (!final || start > end) continue;
      const total = totalsAcks.get(a.id), proofs = detailAcks.get(a.id) || [];
      if (!total || total.startDate > start || total.endDate < end) fail('compact_totals_ack_missing');
      const dates = new Set();
      for (const proof of proofs) for (let time = Date.parse(proof.startDate); time <= Date.parse(proof.endDate); time += 86400000) dates.add(new Date(time).toISOString().slice(0, 10));
      for (let time = Date.parse(start); time <= Date.parse(end); time += 86400000) if (!dates.has(new Date(time).toISOString().slice(0, 10))) fail('compact_detail_ack_missing');
      for (const proof of [total, ...proofs]) {
        assertCurrent(); const observed = await confirm(proof); assertCurrent();
        if (!observed || observed.committed !== true || Object.keys(proof).some(key => observed[key] !== proof[key])
          || (proof.kind === 'detail' ? observed.detailComplete !== true : observed.totalsComplete !== true)) fail('compact_database_publication_unproven');
      }
    }
  }
  return Object.freeze({ enabled, assertCurrent, record, assertRowDates, beforePublish });
}
module.exports = { CUT_GATE, captureCutPolicy, mappingSet };
