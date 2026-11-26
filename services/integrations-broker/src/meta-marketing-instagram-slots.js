'use strict';

const { randomUUID } = require('node:crypto');
const C = require('./meta-marketing-oauth-contract');
const I = require('./meta-marketing-instagram-extension-contract');
const { graphId } = require('./meta-marketing-contract');
const { fail } = require('./errors');
const { candidateSlot } = require('./meta-marketing-candidate-slot');

// A slot belongs to one active enrollment and one of its confirmed Facebook pages.
// The public request cannot supply an ARN, KMS key, or Secrets Manager version.
function createInstagramSlots({ store, client, environment, account, limit }) {
  const ensure = candidateSlot(client, 'clinicaclick-meta-marketing-instagram-extension');
  store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_instagram_slots (
    scope TEXT NOT NULL, page TEXT NOT NULL, connection TEXT NOT NULL, clinic_ids TEXT NOT NULL,
    app_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE, version_id TEXT NOT NULL UNIQUE, arn TEXT,
    PRIMARY KEY(scope,page))`);
  const get = (scope, page) => store.db.prepare('SELECT * FROM meta_marketing_instagram_slots WHERE scope=? AND page=?').get(scope,page);

  function settings(binding, page, row) {
    const b = C.bindingFor(binding);
    if (!row || row.connection !== binding.connectionRef || row.app_id !== b.appId
        || row.clinic_ids !== JSON.stringify(b.clinicIds) || row.scope !== b.scopeKey || row.page !== page) fail('scope_denied');
    if (!row.arn) return null;
    return I.config({ scopeKey:b.scopeKey, parentPageId:page, secretArn:row.arn,
      slotVersionId:row.version_id, expiresAt:binding.expiresAt }, environment, account);
  }

  return async function resolve(binding, page, prepare, auditAllocation) {
    if (!graphId(page)) fail('invalid_request');
    const b = C.bindingFor(binding);
    const found = get(b.scopeKey,page);
    const existing = found && settings(binding,page,found);
    if (existing || !prepare) return existing || null;
    const row = store.transaction(() => {
      prepare();
      if (!found) {
        if (store.db.prepare('SELECT COUNT(*) AS n FROM meta_marketing_instagram_slots').get().n >= limit) fail('rate_limited');
        auditAllocation();
        const name = '/clinicaclick/integrations/prod/meta-marketing/'+environment+'/instagram-extension/'
          +b.scopeKey.replace(':','-')+'/page-'+page+'/candidate';
        store.db.prepare('INSERT INTO meta_marketing_instagram_slots VALUES(?,?,?,?,?,?,?,NULL)')
          .run(b.scopeKey,page,binding.connectionRef,JSON.stringify(b.clinicIds),b.appId,name,randomUUID());
      }
      return get(b.scopeKey,page);
    });
    const arn = await ensure(row,AbortSignal.timeout(9000));
    return store.transaction(() => {
      prepare();
      store.db.prepare('UPDATE meta_marketing_instagram_slots SET arn=? WHERE scope=? AND page=? AND version_id=? AND (arn IS NULL OR arn=?)')
        .run(arn,b.scopeKey,page,row.version_id,arn);
      return settings(binding,page,get(b.scopeKey,page));
    });
  };
}
module.exports = { createInstagramSlots };
