'use strict';
const { keyFor, receiptFor } = require('../../services/platform-audit/src/event');
function createReconciliation({ repository, reader, now = () => new Date() }) {
  return { async run() {
    const rows = []; const cutoff = now().getTime() + 10000;
    while (rows.length < 25 && now().getTime() < cutoff) { const row = await repository.claim(now(), 'reconcile'); if (!row) break; rows.push(row); }
    if (!rows.length) return { status: 'completed', reconciled: 0, failed: 0 };
    let result;
    try {
      result = await reader.read({ mode: 'reconcile', actorId: 'platform_audit_reconciler', sessionRef: null,
        refs: rows.map(row => ({ key: keyFor(row), digest: row.digest, versionId: null })) });
      if (result.results.length !== rows.length) throw Error();
      for (let i = 0; i < rows.length; i++) if (result.results[i].status === 'verified') receiptFor(rows[i], result.results[i].receipt);
    } catch {
      for (const row of rows) await repository.retry(row, 'audit_unavailable', now());
      return { status: 'failed', error: 'audit_reconciliation_pending', reconciled: 0, failed: rows.length };
    }
    let reconciled = 0; let failed = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; const value = result.results[i];
      if (value.status === 'verified' && await repository.acknowledge(row, value.receipt, now())) reconciled++;
      else { await repository.retry(row, value.error || 'audit_unavailable', now()); failed++; }
    }
    return { status: failed ? 'failed' : 'completed', ...(failed ? { error: 'audit_reconciliation_pending' } : {}), reconciled, failed };
  } };
}
let singleton;
module.exports = { createReconciliation, async run() {
  if (process.env.PLATFORM_AUDIT_RECONCILIATION_ENABLED !== 'true') return { skipped: true };
  singleton ||= createReconciliation({ repository: require('./platformAudit.repository').createRepository(require('../../models').PlatformAuditEvent),
    reader: require('./platformAudit.readerClient') });
  return singleton.run();
} };
