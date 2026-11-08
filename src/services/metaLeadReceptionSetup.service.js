'use strict';

// Human setup for an already enrolled direct-clinic Page. All provider I/O stays
// in the closed Lead reader; no campaigns, credentials or arbitrary RPC enter here.
const { Op } = require('sequelize');
const { createHash } = require('node:crypto');
const C = require('./metaMarketingEnrollment.contract');
const fail = (code, httpStatus = 409) => { throw Object.assign(Error(code), { code, httpStatus }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SAFE = new Set(['meta_lead_setup_invalid', 'meta_lead_setup_forbidden', 'meta_lead_setup_conflict',
  'meta_lead_setup_not_ready', 'meta_lead_setup_unconfirmed', 'meta_lead_setup_unavailable',
  'meta_oauth_scope_invalid', 'meta_oauth_scope_forbidden', 'meta_oauth_session_required', 'auth_email_verification_required',
  'broker_cohort_disabled', 'meta_leads_disabled', 'scope_denied', 'asset_revoked', 'connection_blocked',
  'meta_broker_scope_changed', 'meta_broker_binding_invalid', 'meta_broker_not_active',
  'meta_credential_renewal_required', 'meta_business_activation_uncertain', 'rate_limited']);
const safe = error => SAFE.has(error?.code) ? error.code : 'meta_lead_setup_unavailable';
function command(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || !['check', 'enable'].includes(value.action)
    || typeof value.revision !== 'string' || !C.HASH.test(value.revision) || Object.keys(value).sort().join(',') !== (value.action === 'check'
      ? 'action,revision' : 'action,confirmed,expectedSubscriptionRevision,revision')
    || value.action === 'enable' && (value.confirmed !== true || typeof value.expectedSubscriptionRevision !== 'string' || !C.HASH.test(value.expectedSubscriptionRevision))) {
    fail('meta_lead_setup_invalid', 400);
  }
  return value;
}
function createService({ models, sessions, reader, authorize, now = () => new Date(),
  enabled = () => process.env.META_MARKETING_LEADGEN_ENABLED === 'true' }) {
  const authorization = authorize || require('./metaMarketingOAuthScope.service').createScope({ models, sessions, now }).authorize;
  const leadReader = () => reader || require('./metaMarketingLeadReader.service').forModels(models);
  const tx = fn => models.sequelize.transaction({ isolationLevel: 'REPEATABLE READ' }, fn);
  async function resolve(input, mappingId = null) {
    const scopeKey = input.scopeKey;
    const authorizeDirect = async transaction => {
      const access = await authorization(input, transaction);
      if (input.scopeKey !== scopeKey || !/^clinic:[1-9][0-9]{0,9}$/.test(scopeKey)
        || JSON.stringify(access.clinicIds) !== JSON.stringify([Number(scopeKey.split(':')[1])])) fail('meta_lead_setup_forbidden', 403);
      return access;
    };
    // Deny foreign actors before inspecting enrollment or asset metadata. This
    // transaction ends before taking any enrollment lock: it must not retain a
    // clinic lock while the ordinary Lead reader holds enrollment -> clinic.
    await tx(authorizeDirect);
    if (!enabled()) return { enabled: false, pages: [] };
    return tx(async transaction => {
      const options = { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false };
      // Match the reader's enrollment-first order. Always lock the latest row
      // (or its absent range), then repeat fresh session/email/WRITE checks
      // before examining the row, hydrating mappings or contacting the broker.
      const stored = await models.MetaMarketingEnrollmentRequest.findOne({ ...options, where: { scope_key: scopeKey },
        order: [['requested_at', 'DESC'], ['enrollment_id', 'DESC']] });
      const access = await authorizeDirect(transaction);
      if (!enabled()) return { enabled: false, pages: [] };
      if (!stored || stored.state !== 'active') return { enabled: true, pages: [] };
      const enrollment = C.request(stored);
      if (enrollment.scope_key !== input.scopeKey || JSON.stringify(enrollment.clinicIds) !== JSON.stringify(access.clinicIds)) fail('meta_lead_setup_forbidden', 403);
      const workspace = await models.CampaignWorkspaceSetting.findOne({ ...options,
        where: { scope_type: 'clinic', scope_id: access.clinicIds[0] }, attributes: ['preferences'] });
      // Any explicit registry belongs to the existing administrative routing
      // path. In particular [] is an intentional closed route, never absence.
      if (workspace?.preferences?.meta_lead_routes !== undefined) return { enabled: true, pages: [] };
      const accounts = enrollment.selected.filter(asset => asset.kind === 'ad_account');
      const selectedPages = enrollment.selected.filter(asset => asset.kind === 'facebook_page');
      if (accounts.length !== 1 || !selectedPages.length) return { enabled: true, pages: [] };
      const mappings = await models.ClinicMetaAsset.findAll({ ...options,
        attributes: ['id', 'assetType', 'metaAssetId', 'metaConnectionId', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'isActive'],
        where: { id: { [Op.in]: enrollment.mappingIds }, metaConnectionId: enrollment.meta_connection_id,
          assignmentScope: 'clinic', clinicaId: access.clinicIds[0], grupoClinicaId: null, isActive: true },
        order: [['id', 'ASC']], limit: 101 });
      const matches = asset => mappings.filter(row => row.assetType === asset.kind
        && String(row.metaAssetId).replace(/^act_/, '') === asset.id);
      const account = matches(accounts[0]);
      if (account.length !== 1) fail('meta_lead_setup_not_ready');
      const pages = [];
      for (const asset of selectedPages) {
        const found = matches(asset);
        if (found.length !== 1) fail('meta_lead_setup_not_ready');
        const page = found[0];
        if (mappingId !== null && Number(page.id) !== mappingId) continue;
        const pair = await leadReader().preparePair(Number(page.id), Number(account[0].id), { transaction });
        const authority = await leadReader().assertPair(pair, { transaction });
        if ([authority.page, authority.account].some(state => state.scopeKey !== input.scopeKey
          || state.enrollmentId !== enrollment.enrollment_id || JSON.stringify(state.clinicIds) !== JSON.stringify(access.clinicIds))
          || authority.page.id !== asset.id || authority.account.id !== accounts[0].id
          || authority.page.mappingId !== Number(page.id) || authority.account.mappingId !== Number(account[0].id)
          || authority.route?.recipientClinicId !== null) fail('meta_lead_setup_forbidden', 403);
        pages.push({ pair, pageMappingId: Number(page.id), pageId: asset.id, accountId: accounts[0].id,
          revision: hash([enrollment.enrollment_id, enrollment.selection_digest, Number(page.id), Number(account[0].id), authority.fingerprint]) });
      }
      return { enabled: true, pages };
    });
  }
  const publicPage = page => ({ pageMappingId: page.pageMappingId, pageId: page.pageId, accountId: page.accountId, revision: page.revision });
  return {
    async overview(input) { const current = await resolve(input); return { enabled: current.enabled, pages: current.pages.map(publicPage) }; },
    async execute(input, mappingId, body) {
      command(body);
      if (!C.positive(mappingId)) fail('meta_lead_setup_invalid', 400);
      const current = await resolve(input, mappingId);
      if (!current.enabled || current.pages.length !== 1) fail('meta_lead_setup_not_ready');
      const initial = current.pages[0];
      if (initial.revision !== body.revision) fail('meta_lead_setup_conflict');
      const guard = async () => {
        const latest = await resolve(input, mappingId);
        if (!latest.enabled || latest.pages.length !== 1 || latest.pages[0].revision !== initial.revision) fail('meta_lead_setup_conflict');
        return latest.pages[0];
      };
      const deadline = +now() + 45000;
      const read = async (operation, payload) => {
        const latest = await guard();
        const remaining = deadline - +now();
        if (remaining < 1000) fail('meta_lead_setup_unavailable', 503);
        const result = await leadReader().read(latest.pair, operation, payload, { timeoutMs: Math.min(30000, remaining) });
        await guard();
        if (result.page?.id !== initial.pageId) fail('meta_lead_setup_unavailable', 503);
        return result;
      };
      try {
        let result = await read('pageStatus', {});
        const state = value => !value.page.has_lead_access ? 'access_required'
          : value.subscription.subscribed && value.subscription.fields.includes('leadgen') ? 'verified' : 'subscription_required';
        if (body.action === 'enable') {
          if (result.subscription.revision !== body.expectedSubscriptionRevision) fail('meta_lead_setup_conflict');
          if (state(result) === 'subscription_required') {
            await read('pageEnable', { expectedSubscriptionRevision: body.expectedSubscriptionRevision });
            result = await read('pageStatus', {});
            if (state(result) === 'subscription_required') fail('meta_lead_setup_unconfirmed');
          }
        }
        await guard();
        return { status: 'completed', ...publicPage(initial), state: state(result),
          subscriptionRevision: result.subscription.revision, checkedAt: now().toISOString() };
      } catch (error) {
        // Only the Lead reader's in-process cooldown proof can produce WAIT.
        const waiting = require('./metaMarketingLeadReader.service').cooldownWait(error, 'campaign_meta_page_reception', +now());
        if (waiting) { await guard(); return { status: 'waiting', reason: waiting.reason, nextAllowedAt: waiting.nextAllowedAt.toISOString() }; }
        throw error;
      }
    },
  };
}
let singleton;
const instance = () => singleton ||= createService({ models: require('../../models'), sessions: require('./accessSession.service') });
module.exports = { createService, command, safe, overview: (...args) => instance().overview(...args), execute: (...args) => instance().execute(...args) };
