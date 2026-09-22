'use strict';
const { createHmac, timingSafeEqual, randomUUID, randomBytes, hkdfSync,
  createCipheriv, createDecipheriv } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { BrokerError, fail } = require('./errors');
const { audit } = require('./contracts');
const MAX_BYTES = 3 * 1024 * 1024;
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const PHONE_FIELDS = new Set(['messages', 'history', 'smb_message_echoes', 'smb_app_state_sync']);

// The caller supplies a KMS-unwrapped data key. No key is generated or stored in
// the SQL database, and no AWS credential or clinical database is loaded here.
function createInboxCipher({ key, keyId }) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof keyId !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(keyId)) fail('invalid_request');
  const encryption = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'cc-wa-inbox-encryption-v1', 32));
  const dedup = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'cc-wa-inbox-dedup-v1', 32));
  let closed = false;
  const check = () => { if (closed) fail('secret_unavailable'); };
  return {
    keyId,
    digest(appId, raw) { check(); return createHmac('sha256', dedup).update(appId + '\0').update(raw).digest('hex'); },
    seal(raw, aad) {
      check(); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryption, iv);
      cipher.setAAD(Buffer.from(aad));
      return Buffer.concat([iv, cipher.update(raw), cipher.final(), cipher.getAuthTag()]);
    },
    open(sealed, aad) {
      check();
      try {
        const body = Buffer.from(sealed);
        if (body.length < 28 || body.length > MAX_BYTES + 28) fail('secret_unavailable');
        const cipher = createDecipheriv('aes-256-gcm', encryption, body.subarray(0, 12));
        cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(body.subarray(-16));
        return Buffer.concat([cipher.update(body.subarray(12, -16)), cipher.final()]);
      } catch { fail('secret_unavailable'); }
    },
    close() { encryption.fill(0); dedup.fill(0); closed = true; },
  };
}

function scopeOf(raw, bindings) {
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { fail('invalid_request'); }
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)
    || !body.entry.length || body.entry.length > 100) fail('invalid_request');
  const scopes = new Set(); const kinds = new Set();
  for (const entry of body.entry) {
    const binding = bindings.find(b => b.wabaId === entry?.id);
    if (!binding || !Array.isArray(entry.changes) || !entry.changes.length || entry.changes.length > 100) fail('scope_denied');
    for (const change of entry.changes) {
      if (!change || typeof change.field !== 'string' || !/^[a-z_]{1,80}$/.test(change.field)
        || !change.value || typeof change.value !== 'object' || Array.isArray(change.value)) fail('invalid_request');
      const phone = change.value.metadata?.phone_number_id;
      if (phone !== undefined && !binding.phoneIds.includes(phone) || PHONE_FIELDS.has(change.field) && !id(phone)) fail('scope_denied');
      scopes.add(binding.wabaId + ':' + (phone || 'account'));
      kinds.add(change.field);
    }
  }
  // Store the complete signed batch; never route all its contacts using the
  // first message. Unknown account-level changes are held for later review.
  return { scopes: [...scopes].sort(), kinds: [...kinds].sort() };
}

function createWhatsappInbox({ store, cipher, appId, bindings, auditContext, now = () => Date.now(),
  maxRows = 100000, maxBytes = 1024 * 1024 * 1024, maxAuditBacklog = 10000, scopeBindings }) {
  if (!store?.db || !cipher || !id(appId) || !Array.isArray(bindings) || !bindings.length
    || bindings.length > 64 || new Set(bindings.map(b => b.wabaId)).size !== bindings.length
    || bindings.some(b => !id(b.wabaId) || !Array.isArray(b.phoneIds) || !b.phoneIds.length || b.phoneIds.some(p => !id(p)))
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(maxAuditBacklog) || maxAuditBacklog < 1 || !auditContext
    || Object.keys(auditContext).sort().join(',') !== 'connectionRef,operation,policyVersion,resourceRef,tenantRef') fail('invalid_request');
  bindings = structuredClone(bindings); auditContext = structuredClone(auditContext);
  if (scopeBindings !== undefined) {
    const contract = require('./whatsapp-inbox-scopes');
    scopeBindings = contract.validateScopes(scopeBindings); contract.validateBindings(bindings, scopeBindings);
  }
  const scopesFor = rowScopes => scopeBindings?.filter(s => rowScopes.includes(s.wabaId + ':' + s.phoneId) || rowScopes.includes(s.wabaId + ':account'));
  const contextsFor = rowScopes => {
    if (!scopeBindings) return [auditContext];
    const result = new Map();
    for (const s of scopesFor(rowScopes)) for (const clinicId of s.clinicIds) {
      const context = { ...auditContext, tenantRef: 'clinic:' + clinicId, resourceRef: 'wa-phone:' + s.phoneId };
      result.set(context.tenantRef + '/' + context.resourceRef, context);
    }
    if (!result.size) fail('scope_denied'); return [...result.values()];
  };
  const eventsFor = (receipt, reason, at, rowScopes) => contextsFor(rowScopes).map(context => audit({ ...event(receipt, reason, at), ...context }));
  const event = (receipt, reason, at) => audit({ version: 2, eventId: randomUUID(), occurredAt: new Date(at).toISOString(),
    actorType: 'service', actorId: reason === 'whatsapp_inbox_imported' ? 'staging:whatsapp-inbox' : 'gateway:whatsapp-inbox', action: 'integration.completed', result: 'success',
    reason, correlationId: receipt, ...auditContext });
  event(randomUUID(), 'whatsapp_inbox_stored', now()); // Validate fixed, redacted context at construction.
  store.db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_inbox (
    receipt TEXT PRIMARY KEY, app_id TEXT NOT NULL, digest TEXT NOT NULL, key_id TEXT NOT NULL,
    body BLOB NOT NULL, byte_count INTEGER NOT NULL, scopes TEXT NOT NULL, kinds TEXT NOT NULL,
    received_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('held','leased','imported')),
    lease TEXT, lease_until INTEGER, imported_at INTEGER, import_receipt TEXT,
    UNIQUE(app_id,digest));
    CREATE INDEX IF NOT EXISTS whatsapp_inbox_pending ON whatsapp_inbox(state,received_at);
    CREATE TABLE IF NOT EXISTS whatsapp_inbox_retry (
      receipt TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0, reason TEXT,
      last_attempt_at INTEGER NOT NULL DEFAULT 0);`);
  const aad = row => JSON.stringify(['cc-wa-inbox-v1', row.app_id, row.receipt, row.key_id, row.digest, row.scopes, row.kinds, row.received_at]);
  const receiptFor = row => ({ receipt: row.receipt, persisted: true, businessProcessed: row.state === 'imported' });
  const clean = error => new BrokerError(error instanceof BrokerError ? error.code : 'audit_unavailable');
  return {
    accept({ raw, signature, appSecret }) {
      if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_BYTES) fail('invalid_request');
      if (!Buffer.isBuffer(appSecret) || appSecret.length < 16) fail('secret_unavailable');
      if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) fail('invalid_signature');
      const expected = createHmac('sha256', appSecret).update(raw).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) fail('invalid_signature');
      const scope = scopeOf(raw, bindings); const digest = cipher.digest(appId, raw);
      try {
        return store.transaction(() => {
          const existing = store.db.prepare('SELECT * FROM whatsapp_inbox WHERE app_id=? AND digest=?').get(appId, digest);
          if (existing) {
            if (existing.key_id !== cipher.keyId) fail('secret_version_changed');
            // A duplicate ACK also verifies the stored ciphertext, so corruption
            // or loss of its key cannot be hidden by an idempotency receipt.
            const saved = cipher.open(existing.body, aad(existing));
            try { if (!saved.equals(raw)) fail('idempotency_conflict'); } finally { saved.fill(0); }
            return { ...receiptFor(existing), replayed: true };
          }
          const capacity = store.db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(byte_count),0) AS bytes FROM whatsapp_inbox').get();
          if (capacity.rows >= maxRows || capacity.bytes + raw.length > maxBytes || store.backlog().pending + contextsFor(scope.scopes).length > maxAuditBacklog) fail('audit_unavailable');
          const row = { receipt: randomUUID(), app_id: appId, digest, key_id: cipher.keyId,
            scopes: JSON.stringify(scope.scopes), kinds: JSON.stringify(scope.kinds), received_at: now(), state: 'held' };
          const sealed = cipher.seal(raw, aad(row));
          try {
            store.db.prepare("INSERT INTO whatsapp_inbox(receipt,app_id,digest,key_id,body,byte_count,scopes,kinds,received_at,state) VALUES (?,?,?,?,?,?,?,?,?,'held')")
              .run(row.receipt, appId, digest, cipher.keyId, sealed, raw.length, row.scopes, row.kinds, row.received_at);
            for (const item of eventsFor(row.receipt, 'whatsapp_inbox_stored', row.received_at, scope.scopes)) store.appendAudit(item);
          } finally { sealed.fill(0); }
          return { ...receiptFor(row), replayed: false };
        });
      } catch (error) { throw clean(error); }
    },
    pending(limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_request');
      try {
        return store.db.prepare("SELECT i.receipt,i.received_at FROM whatsapp_inbox i LEFT JOIN whatsapp_inbox_retry r ON r.receipt=i.receipt WHERE i.app_id=? AND (i.state='held' OR (i.state='leased' AND i.lease_until<=?)) AND COALESCE(r.next_attempt_at,0)<=? ORDER BY COALESCE(r.last_attempt_at,i.received_at),i.received_at,i.receipt LIMIT ?")
          .all(appId, now(), now(), limit).map(row => ({ receipt: row.receipt, receivedAt: row.received_at }));
      } catch (error) { throw clean(error); }
    },
    health() {
      const groups = store.db.prepare("SELECT i.scopes,COUNT(*) pending,MIN(CASE WHEN r.reason IS NULL OR r.reason='import_retry' THEN i.received_at END) oldestPendingAt,SUM(CASE WHEN r.reason='review_required' THEN 1 ELSE 0 END) blockingReview,SUM(CASE WHEN r.reason IN ('unsupported_event','unmatched_status') THEN 1 ELSE 0 END) review FROM whatsapp_inbox i LEFT JOIN whatsapp_inbox_retry r ON r.receipt=i.receipt WHERE i.app_id=? AND i.state<>'imported' GROUP BY i.scopes").all(appId);
      return { observedAt: now(), groups: groups.map(row => ({ ...row, scopes: JSON.parse(row.scopes) })) };
    },
    // No automatic consumer. The caller must have a separately authenticated,
    // approved import grant and commit the business transaction before confirm.
    lease(receipt) {
      if (!uuid(receipt)) fail('invalid_request');
      try {
        return store.transaction(() => {
          const row = store.db.prepare('SELECT * FROM whatsapp_inbox WHERE app_id=? AND receipt=?').get(appId, receipt);
          if (!row || row.state === 'imported' || row.lease_until > now()) fail('scope_denied');
          const retry = store.db.prepare('SELECT * FROM whatsapp_inbox_retry WHERE receipt=?').get(receipt);
          if (retry?.next_attempt_at > now()) fail('scope_denied');
          const raw = cipher.open(row.body, aad(row)); let committed = false;
          try {
            const lease = randomUUID(); const until = now() + 60000;
            store.db.prepare("UPDATE whatsapp_inbox SET state='leased',lease=?,lease_until=? WHERE receipt=?").run(lease, until, receipt);
            // Fairness also survives a consumer crash before it can report an error.
            store.db.prepare('INSERT INTO whatsapp_inbox_retry(receipt,attempts,last_attempt_at) VALUES(?,1,?) ON CONFLICT(receipt) DO UPDATE SET attempts=attempts+1,last_attempt_at=excluded.last_attempt_at').run(receipt, now());
            committed = true;
            return { receipt, lease, leaseUntil: until, raw, receivedAt: row.received_at,
              scopes: JSON.parse(row.scopes), kinds: JSON.parse(row.kinds), automaticActionsAllowed: false,
              ...(scopeBindings ? { scopeBindings: scopesFor(JSON.parse(row.scopes)) } : {}) };
          } finally { if (!committed) raw.fill(0); }
        });
      } catch (error) { throw clean(error); }
    },
    defer({ receipt, lease, reason }) {
      if (!uuid(receipt) || !uuid(lease) || !['unsupported_event','unmatched_status','review_required','import_retry'].includes(reason)) fail('invalid_request');
      return store.transaction(() => {
        const row = store.db.prepare('SELECT state,lease,lease_until FROM whatsapp_inbox WHERE app_id=? AND receipt=?').get(appId, receipt);
        if (!row || row.state !== 'leased' || row.lease !== lease || row.lease_until <= now()) fail('scope_denied');
        const retry = store.db.prepare('SELECT attempts FROM whatsapp_inbox_retry WHERE receipt=?').get(receipt);
        const delay = Math.min(3600000, 60000 * 2 ** Math.min(6, retry.attempts - 1));
        store.db.prepare('UPDATE whatsapp_inbox_retry SET reason=?,next_attempt_at=? WHERE receipt=?').run(reason, now() + delay, receipt);
        return { receipt, deferred: true, businessProcessed: false };
      });
    },
    confirm({ receipt, lease, importReceipt }) {
      if (!uuid(receipt) || !uuid(lease) || !uuid(importReceipt)) fail('invalid_request');
      try {
        return store.transaction(() => {
          const row = store.db.prepare('SELECT * FROM whatsapp_inbox WHERE app_id=? AND receipt=?').get(appId, receipt);
          if (!row || row.lease !== lease) fail('scope_denied');
          if (row.state === 'imported') {
            if (row.import_receipt !== importReceipt) fail('idempotency_conflict');
            return receiptFor(row);
          }
          if (row.state !== 'leased' || row.lease_until <= now()) fail('scope_denied');
          if (store.backlog().pending + contextsFor(JSON.parse(row.scopes)).length > maxAuditBacklog) fail('audit_unavailable');
          store.db.prepare("UPDATE whatsapp_inbox SET state='imported',imported_at=?,import_receipt=? WHERE receipt=?")
            .run(now(), importReceipt, receipt);
          for (const item of eventsFor(receipt, 'whatsapp_inbox_imported', now(), JSON.parse(row.scopes))) store.appendAudit(item);
          return { receipt, persisted: true, businessProcessed: true };
        });
      } catch (error) { throw clean(error); }
    },
  };
}
module.exports = { MAX_BYTES, createInboxCipher, scopeOf, createWhatsappInbox };
