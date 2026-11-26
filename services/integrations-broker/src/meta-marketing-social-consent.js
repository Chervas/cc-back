'use strict';

const C = require('./meta-marketing-oauth-contract');
const { fail } = require('./errors');
const { graphId } = require('./meta-marketing-contract');

function config(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) fail('invalid_request');
  const accounts = new Set();
  for (const row of rows) {
    if (
      !row ||
      Object.keys(row).sort().join(',') !== 'accountId,channel,clinicId,pageId' ||
      !graphId(row.accountId) ||
      !graphId(row.pageId) ||
      !Number.isSafeInteger(row.clinicId) ||
      row.clinicId <= 0 ||
      !['instagram', 'messenger'].includes(row.channel) ||
      (row.channel === 'messenger' && row.pageId !== row.accountId) ||
      accounts.has(row.channel + row.accountId)
    )
      fail('invalid_request');
    accounts.add(row.channel + row.accountId);
  }
  return rows;
}

function targetsFor(accounts, assets, clinicIds) {
  const pages = new Set(assets.filter(asset => asset.kind === 'facebook_page').map(asset => asset.id));
  return (accounts || []).filter(row => pages.has(row.pageId) && clinicIds.includes(row.clinicId))
    .map(({ clinicId, channel, pageId, accountId }) => ({ clinicId, channel, pageId, accountId }))
    .sort((a, b) => a.clinicId - b.clinicId || a.channel.localeCompare(b.channel) || a.accountId.localeCompare(b.accountId));
}

function sameTarget(a, b) {
  return a.channel === b.channel && a.pageId === b.pageId && a.clinicId === b.clinicId && a.accountId === b.accountId;
}

function targetDigest(accounts) {
  return C.hash(JSON.stringify(accounts.map(a => [a.clinicId, a.channel, a.pageId, a.accountId])));
}

function scopesFor(scopes, accounts) {
  const requested = new Set(scopes);
  for (const { channel } of accounts) {
    if (!['instagram', 'messenger'].includes(channel)) fail('invalid_request');
    for (const name of ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'pages_messaging']) requested.add(name);
    if (channel === 'instagram')
      for (const name of ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments']) requested.add(name);
  }
  return [...requested].sort();
}

function journal(store) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_social_consents (
    renewal TEXT PRIMARY KEY, enrollment TEXT NOT NULL, accounts TEXT NOT NULL,
    candidate_digest TEXT, metadata TEXT
  )`);
  const find = id => db.prepare('SELECT * FROM meta_marketing_social_consents WHERE renewal=?').get(id);
  function active(enrollment, credential) {
    const row = find(credential.versionId);
    if (!row || row.enrollment !== enrollment || row.candidate_digest !== credential.digest || !row.metadata) return null;
    return row;
  }
  return {
    find, active,
    begin(id, enrollment, accounts, replay) {
      const old = find(id);
      const serialized = JSON.stringify(accounts);
      if (replay) {
        if ((old?.accounts || '[]') !== serialized || (old && old.enrollment !== enrollment)) fail('idempotency_conflict');
      } else if (accounts.length) {
        db.prepare('INSERT INTO meta_marketing_social_consents(renewal,enrollment,accounts) VALUES(?,?,?)').run(id,enrollment,serialized);
      }
    },
    capture(id, digest, metadata) {
      const updated = db.prepare('UPDATE meta_marketing_social_consents SET candidate_digest=?,metadata=? WHERE renewal=? AND candidate_digest IS NULL')
        .run(digest, JSON.stringify(metadata), id);
      if (updated.changes !== 1) fail('idempotency_conflict');
    },
  };
}

function inspect(raw, binding, original, accounts, now) {
  const base = C.bindingFor(binding);
  const scopes = scopesFor(base.scopes, accounts);
  const checked = C.inspected(raw, { ...binding, metaMarketingOAuth: { ...base, scopes } }, now);
  if (checked.subjectId !== original.subjectId || checked.appId !== original.appId || checked.tokenType !== 'USER') fail('oauth_identity_mismatch');
  for (const account of accounts) {
    const required = scopesFor([], [account]);
    if (checked.granularScopes.some(g => required.includes(g.scope) && !g.targetIds.some(id => id === account.pageId || id === account.accountId)))
      fail('oauth_credentials_incomplete');
  }
  const targets = new Set(accounts.flatMap(a => [a.accountId, a.pageId]));
  return { ...checked, granularScopes: checked.granularScopes.map(g => ({ ...g, targetIds: g.targetIds.filter(id => targets.has(id)) })) };
}

module.exports = { config, targetsFor, targetDigest, sameTarget, scopesFor, journal, inspect };
