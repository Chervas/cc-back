'use strict';

const Consent = require('./meta-marketing-social-consent');
const C = require('./meta-marketing-oauth-contract');
const K = require('./meta-marketing-credential-shape');
const { assetSetDigest } = require('./meta-marketing-credential-renewal-contract');
const { extendInstagramSelection } = require('./meta-marketing-instagram-selection');
const { graphId } = require('./meta-marketing-contract');

function createSingleClinicSocial({ store, channels, now }) {
  const db = store.db;
  const get = (sql, ...values) => db.prepare(sql).get(...values);
  const hasExtensions = () => !!get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='meta_marketing_instagram_extensions'");
  function owners(channel, accountId) {
    if (!channels.includes(channel) || !graphId(accountId)) return [];
    const ref = (channel === 'messenger' ? 'meta-facebook_page:' : 'meta-instagram_business:') + accountId;
    if (get('SELECT 1 FROM asset_revocations WHERE asset=?', ref)) return [];
    const direct = get('SELECT enrollment FROM meta_marketing_enrollment_claims WHERE asset=?', ref);
    const extensions = channel === 'instagram' && hasExtensions()
      ? db.prepare("SELECT enrollment FROM meta_marketing_instagram_extensions WHERE state='active' AND instagram_id=?").all(accountId) : [];
    return [...(direct ? [direct] : []), ...extensions];
  }

  function scope(binding) {
    if (K.business(binding)) return [];
    const b = C.bindingFor(binding);
    return Consent.singleChannels(channels, b.scopeKey, b.clinicIds);
  }

  function targets(row, binding, assets, subjectId, pageId) {
    const enabled = scope(binding);
    if (!enabled.length) return [];
    const b = C.bindingFor(binding), clinicId = b.clinicIds[0];
    const pages = assets.filter(asset => asset.kind === 'facebook_page' && (!pageId || asset.id === pageId));
    const allowed = [];
    const add = (channel, pageId, accountId) => {
      if (enabled.includes(channel)) allowed.push({ channel, clinicId, pageId, accountId });
    };
    for (const page of pages) {
      add('messenger', page.id, page.id);
      if (!enabled.includes('instagram')) continue;
      const direct = assets.filter(asset => asset.kind === 'instagram_business' && asset.parentPageId === page.id);
      const extensions = hasExtensions() ? db.prepare(`SELECT x.*,f.credential_metadata,f.lane,f.state AS flow_state,f.secret_digest,
          f.config_digest,f.scope_digest AS flow_scopes FROM meta_marketing_instagram_extensions x
          LEFT JOIN meta_marketing_oauth_flows f ON f.id=x.id WHERE x.page=? AND x.state='active'`).all(page.id) : [];
      if (direct.length + extensions.length !== 1) continue;
      if (direct.length) {
        const own = owners('instagram', direct[0].id);
        if (own.length === 1 && own[0].enrollment === row.id) add('instagram', page.id, direct[0].id);
        continue;
      }
      const x = extensions[0], own = owners('instagram', x.instagram_id);
      if (own.length !== 1 || own[0].enrollment !== row.id || x.enrollment !== row.id || x.connection !== row.connection ||
          x.tenant !== row.tenant || x.base_digest !== C.fingerprint(binding) || x.asset_digest !== assetSetDigest(assets) ||
          x.lane !== 'instagram_extension' || x.flow_state !== 'staged' || x.config_digest !== x.candidate_binding_digest ||
          x.flow_scopes !== x.scope_digest || !x.candidate_digest || x.secret_digest !== x.candidate_digest ||
          !x.credential_metadata || !Number.isSafeInteger(x.credential_expires_at) || x.credential_expires_at <= now()) continue;
      const metadata = JSON.parse(x.credential_metadata);
      if (metadata.appId !== b.appId || metadata.subjectId !== subjectId || metadata.tokenType !== 'USER') continue;
      const selected = extendInstagramSelection({ scopeKey: b.scopeKey, selected: assets, expectedAssetSetDigest: x.asset_digest,
        instagramId: x.instagram_id, parentPageId: page.id });
      if (selected.assetSetDigest === x.selection_digest) add('instagram', page.id, x.instagram_id);
    }
    return allowed;
  }

  function discovery(record, row, binding, assets, subjectId, capture) {
    if (!record?.channels || !record.metadata) return {};
    const allowed = scope(binding).filter(channel => JSON.parse(record.channels).includes(channel));
    if (!allowed.length) return {};
    const consent = JSON.parse(record.metadata);
    const eligible = targets(row, binding, assets, subjectId);
    const pages = assets.filter(asset => asset.kind === 'facebook_page').map(asset => asset.id);
    return {
      socialDiscovery: {
        pages: allowed.includes('instagram') && consent.scopes.includes('instagram_basic') ? pages : [],
        capture(raw, linked) {
          // Page inventory may attest the future extension's identity. Reading/sending
          // still requires its separate, current physical claim and selection.
          const assetsForProof = eligible.concat(pages.map(pageId => ({ pageId, accountId: pageId })),
            linked.filter(a => pages.includes(a.pageId)));
          capture(Consent.inspectInitial(raw, binding, assetsForProof.map(a => ({...a, channel: a.channel || allowed[0]})),
            now(), allowed, consent.scopes));
        },
      },
    };
  }

  function authorized(record, target) {
    if (!record?.channels || !record.projection || !JSON.parse(record.channels).includes(target.channel)) return false;
    const proof = JSON.parse(record.projection);
    if ([proof.expiresAt, proof.dataAccessExpiresAt].some(v => v !== null && v <= now())) return false;
    const has = name => Consent.hasPermission(proof, name, target);
    if (!has('pages_show_list') || !has('pages_manage_metadata')) return false;
    return target.channel === 'messenger' ? has('pages_messaging') && has('pages_read_engagement')
      : has('instagram_basic') && (has('instagram_manage_messages') || has('instagram_manage_comments'));
  }

  return { scope, owners, targets, discovery, authorized };
}

module.exports = { createSingleClinicSocial };
