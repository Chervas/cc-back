'use strict';
const { createHash } = require('node:crypto');
const { fail } = require('./errors');
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys;
function validateScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 1000) fail('invalid_request');
  const found = new Set();
  for (const scope of scopes) {
    if (!exact(scope, 'clinicIds,phoneId,wabaId') || !id(scope.wabaId) || !id(scope.phoneId) || found.has(scope.phoneId)
      || !Array.isArray(scope.clinicIds) || !scope.clinicIds.length || scope.clinicIds.length > 1000
      || scope.clinicIds.some((n, i, all) => !Number.isSafeInteger(n) || n < 1 || n > 2147483647 || i && all[i-1] >= n)) fail('invalid_request');
    found.add(scope.phoneId);
  }
  return scopes.map(s => ({wabaId:s.wabaId,phoneId:s.phoneId,clinicIds:[...s.clinicIds]})).sort((a,b) => a.phoneId.localeCompare(b.phoneId));
}
function bindingsFor(scopes) {
  const grouped = new Map();
  for (const s of validateScopes(scopes)) { const phones = grouped.get(s.wabaId) || []; phones.push(s.phoneId); grouped.set(s.wabaId, phones); }
  if (grouped.size > 64) fail('invalid_request');
  return [...grouped].sort(([a],[b]) => a.localeCompare(b)).map(([wabaId,phoneIds]) => ({wabaId,phoneIds:phoneIds.sort()}));
}
function validateBindings(bindings, scopes) {
  const expected = bindingsFor(scopes);
  if (!Array.isArray(bindings) || bindings.some(b => !exact(b,'phoneIds,wabaId') || !Array.isArray(b.phoneIds))) fail('invalid_request');
  const normalized = bindings.map(b => ({wabaId:b.wabaId,phoneIds:[...b.phoneIds].sort()})).sort((a,b) => a.wabaId.localeCompare(b.wabaId));
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) fail('scope_denied');
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function pinScopes(store, config, cipher, cohort) {
  const scopes = validateScopes(config.scopes);
  // The capture service/audit anchor stays unchanged. Clinical ownership is
  // captured separately per phone and cannot be reassigned by a later config.
  const anchor = JSON.stringify([cohort,config.application.appId,cipher.keyId,config.auditContext.tenantRef,config.auditContext.connectionRef]);
  const next = digest([anchor,scopes]);
  store.transaction(() => {
    store.db.exec('CREATE TABLE IF NOT EXISTS whatsapp_inbox_scope_identity (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL, anchor TEXT NOT NULL, scopes TEXT NOT NULL); CREATE TABLE IF NOT EXISTS whatsapp_inbox_scope_migrations (digest TEXT PRIMARY KEY, previous_digest TEXT, scopes TEXT NOT NULL)');
    const old = store.db.prepare('SELECT * FROM whatsapp_inbox_scope_identity WHERE id=1').get();
    if (old) {
      if (old.anchor !== anchor) fail('scope_denied');
      if (old.digest === next) return;
      if (config.previousScopesDigest !== old.digest) fail('scope_denied');
      const before = validateScopes(JSON.parse(old.scopes));
      for (const item of before) if (JSON.stringify(scopes.find(s => s.phoneId === item.phoneId)) !== JSON.stringify(item)) fail('scope_denied');
      if (scopes.length <= before.length) fail('scope_denied');
    } else {
      const identityTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='whatsapp_inbox_identity'").get();
      const legacy = identityTable && store.db.prepare('SELECT digest FROM whatsapp_inbox_identity WHERE id=1').get();
      const inboxTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='whatsapp_inbox'").get();
      if (legacy) {
        // One explicit original phone+clinic must reproduce the exact old
        // identity. No plaintext or old encrypted message is read or rewritten.
        if (config.previousScopesDigest !== legacy.digest) fail('scope_denied');
        const clinicId = Number(config.auditContext.tenantRef.split(':')[1]);
        const origins = scopes.filter(s => s.clinicIds.length === 1 && s.clinicIds[0] === clinicId
          && [{wabaId:s.wabaId,phoneIds:[s.phoneId]},{phoneIds:[s.phoneId],wabaId:s.wabaId}].some(binding =>
            digest([cohort,config.application.appId,cipher.keyId,[binding],config.auditContext.tenantRef,config.auditContext.connectionRef]) === legacy.digest));
        if (origins.length !== 1) fail('scope_denied');
      } else if (config.previousScopesDigest !== null || inboxTable && store.db.prepare('SELECT 1 FROM whatsapp_inbox LIMIT 1').get()) fail('scope_denied');
    }
    store.db.prepare('INSERT INTO whatsapp_inbox_scope_migrations VALUES (?,?,?)').run(next,old?.digest || config.previousScopesDigest,JSON.stringify(scopes));
    store.db.prepare('INSERT INTO whatsapp_inbox_scope_identity VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,anchor=excluded.anchor,scopes=excluded.scopes').run(next,anchor,JSON.stringify(scopes));
  });
  return next;
}
module.exports = { validateScopes, bindingsFor, validateBindings, pinScopes };
