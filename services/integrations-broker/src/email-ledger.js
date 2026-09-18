'use strict';

const { canonicalDigest } = require('./canonical-digest');
const { fail } = require('./errors');
const contract = require('./email-contract');

// The command ledger deduplicates a signed attempt. This second fence binds
// ALL attempts (and signing-key rotations) to the same durable outbox identity.
// No recipient, subject, body, OTP, URL or credential is stored here.
class EmailLedger {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS email_deliveries (
      tenant TEXT NOT NULL, outbox TEXT NOT NULL, digest TEXT NOT NULL,
      attempt INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('started','accepted','rejected','retryable','unknown')),
      result TEXT, PRIMARY KEY(tenant,outbox));`);
  }
  reserve({ tenantRef, connectionRef, payload }) {
    const digest = canonicalDigest({ connectionRef, templateKey: payload.templateKey, input: contract.commandInput(payload) });
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM email_deliveries WHERE tenant=? AND outbox=?').get(tenantRef, payload.outboxId);
      if (row) {
        if (row.digest !== digest) fail('idempotency_conflict');
        if (['started', 'unknown'].includes(row.state)) fail('outcome_unknown');
        if (row.state !== 'retryable' || payload.attempt <= row.attempt) return JSON.parse(row.result);
        this.store.db.prepare("UPDATE email_deliveries SET attempt=?,state='started',result=NULL WHERE tenant=? AND outbox=?")
          .run(payload.attempt, tenantRef, payload.outboxId);
      } else {
        this.store.db.prepare("INSERT INTO email_deliveries VALUES (?,?,?,?,'started',NULL)")
          .run(tenantRef, payload.outboxId, digest, payload.attempt);
      }
      return null;
    });
  }
  settle({ tenantRef, payload }, result) {
    const state = result.accepted ? 'accepted' : result.retryable ? 'retryable' : 'rejected';
    const row = this.store.db.prepare("UPDATE email_deliveries SET state=?,result=? WHERE tenant=? AND outbox=? AND attempt=? AND state='started'")
      .run(state, JSON.stringify(result), tenantRef, payload.outboxId, payload.attempt);
    if (row.changes !== 1) fail('outcome_unknown');
  }
  uncertain({ tenantRef, payload }) {
    this.store.db.prepare("UPDATE email_deliveries SET state='unknown',result=NULL WHERE tenant=? AND outbox=? AND attempt=? AND state='started'")
      .run(tenantRef, payload.outboxId, payload.attempt);
  }
}
module.exports = { EmailLedger };
