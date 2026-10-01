'use strict';

const { randomUUID } = require('node:crypto');
const { audit } = require('./contracts');
const { BrokerError } = require('./errors');
const { verifyArchiveEnvelope } = require('./whatsapp-inbox-archive');
const { scopeOf } = require('./whatsapp-inbox');

// Offline-only: callers must obtain each tag from S3, restore into a new
// stopped SQLite database, and verify the complete object inventory before use.
function restoreArchiveBatch({ store, appId, bindings, ciphers, auditContext, records, now = Date.now() }) {
  if (!store?.db || !Array.isArray(records) || !records.length || records.length > 1000
    || !(ciphers instanceof Map) || !Number.isSafeInteger(now) || !Array.isArray(bindings)) {
    throw new BrokerError('invalid_request');
  }
  const prepared = [];
  let bytes = 0;
  try {
    for (const item of records) {
      if (!Buffer.isBuffer(item?.envelope) || !['imported', 'not_imported'].includes(item?.tagState)) {
        throw new BrokerError('invalid_request');
      }
      bytes += item.envelope.length;
      if (bytes > 128 * 1024 * 1024) throw new BrokerError('invalid_request');
      const record = JSON.parse(item.envelope.toString('utf8'));
      const cipher = ciphers.get(record.keyId);
      if (!cipher) throw new BrokerError('audit_unavailable');
      const checked = verifyArchiveEnvelope(item.envelope, cipher, appId);
      try {
        const actual = scopeOf(checked.raw, bindings);
        if (JSON.stringify(actual.scopes) !== JSON.stringify(record.scopes)
          || JSON.stringify(actual.kinds) !== JSON.stringify(record.kinds)) {
          throw new BrokerError('audit_unavailable');
        }
      } finally { checked.raw.fill(0); }
      prepared.push({ record, body: Buffer.from(record.body, 'base64'), tagState: item.tagState });
    }
    return store.transaction(() => {
      const foreign = store.db.prepare('SELECT 1 FROM whatsapp_inbox WHERE restored_at IS NULL LIMIT 1').get();
      if (foreign) throw new BrokerError('scope_denied');
      const find = store.db.prepare('SELECT * FROM whatsapp_inbox WHERE receipt=?');
      const insert = store.db.prepare(`INSERT INTO whatsapp_inbox
        (receipt,app_id,digest,key_id,body,byte_count,scopes,kinds,received_at,state,
         imported_at,import_receipt,archived_at,archive_tagged_at,restored_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      let restored = 0;
      for (const item of prepared) {
        const { record, body, tagState } = item;
        const prior = find.get(record.receipt);
        if (prior) {
          if (prior.restored_at === null || prior.app_id !== record.appId || prior.digest !== record.digest
            || prior.key_id !== record.keyId || !Buffer.from(prior.body).equals(body)
            || prior.scopes !== JSON.stringify(record.scopes) || prior.kinds !== JSON.stringify(record.kinds)
            || prior.received_at !== record.receivedAt
            || prior.state !== (tagState === 'imported' ? 'imported' : 'held')) {
            throw new BrokerError('idempotency_conflict');
          }
          continue;
        }
        const imported = tagState === 'imported';
        insert.run(record.receipt, record.appId, record.digest, record.keyId, body,
          record.byteCount, JSON.stringify(record.scopes), JSON.stringify(record.kinds),
          record.receivedAt, imported ? 'imported' : 'held', imported ? now : null,
          imported ? randomUUID() : null, now, imported ? now : null, now);
        restored++;
      }
      if (restored) store.appendAudit(audit({ version: 2, eventId: randomUUID(),
        occurredAt: new Date(now).toISOString(), actorType: 'operator', actorId: 'inbox-restore',
        action: 'integration.completed', result: 'success', reason: 'whatsapp_inbox_restored',
        correlationId: prepared[0].record.receipt, ...auditContext }));
      return { restored, replayed: prepared.length - restored };
    });
  } catch (error) {
    throw error instanceof BrokerError ? error : new BrokerError('audit_unavailable');
  } finally {
    for (const item of prepared) item.body.fill(0);
  }
}

module.exports = { restoreArchiveBatch };
