'use strict';
const { mutationScope } = require('./businessProfileMutationScope.service');
const { createBusinessProfileMutationJournal, actorFor, safe, status } = require('./businessProfileMutationJournal.service');
const C = require('../../services/integrations-broker/src/google-business-profile-write-contract');
const fail = code => { throw Object.assign(Error(code), { code }); };
const raw = row => row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};

function createBusinessProfileMutations({ models, broker, sessions, journal, scope = mutationScope,
  namespace = () => process.env.JOB_RUNTIME_NAMESPACE,
  enabled = () => process.env.GOOGLE_BUSINESS_PROFILE_WRITES_ENABLED === 'true' && process.env.GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED === 'true' }) {
  const db = () => typeof models === 'function' ? models() : models;
  const log = journal || createBusinessProfileMutationJournal({ models, sessions, namespace, enabled });
  async function user(request) {
    let claims;
    try { claims = await sessions.verify(sessions.bearer(request?.headers?.authorization)); }
    catch { fail('business_profile_session_required'); }
    if (claims.sessionVersion !== 1 || Number(request?.userData?.userId) !== claims.userId) fail('business_profile_session_required');
    return actorFor({ type: 'user', userId: claims.userId, sessionRef: claims.jti, expiresAt: claims.exp * 1000 });
  }
  async function publicAsset(row, input, transaction) {
    const asset = await db().PublicMediaAsset.findByPk(row.local_input.publicMediaAssetId,
      { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}), logging: false });
    if (!asset || asset.public_url !== input.sourceUrl
      || !require('./businessProfileLocal.service').isPublishableBusinessProfileMediaAsset(asset, Number(row.requested_clinic_id))) fail('scope_denied');
  }
  async function checkTarget(row, transaction) {
    if (row.kind === 'photo') return publicAsset(row, row.input, transaction);
    if (row.kind === 'hours') {
      const location = await db().ClinicBusinessLocation.findByPk(row.mapping_id,
        { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}), logging: false });
      if (!Array.isArray(raw(location).regularHours?.periods) || !raw(location).regularHours.periods.length) fail('business_profile_regular_hours_required');
      return;
    }
    const review = await db().BusinessProfileReview.findByPk(row.local_input.reviewId,
      { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}), logging: false });
    const [, account, location] = /^gbp:([0-9]+):([0-9]+)$/.exec(row.asset_ref) || [];
    if (!review || Number(review.business_location_id) !== Number(row.mapping_id)
      || review.review_name !== `accounts/${account}/locations/${location}/reviews/${row.input.reviewId}`) fail('scope_denied');
  }
  async function applyResult({ row, result, completedAt, transaction }) {
    // Revalidate the original immutable SQL input on recovery too.
    await checkTarget(row, transaction);
    const at = new Date(completedAt), options = { transaction, lock: transaction.LOCK.UPDATE, logging: false };
    if (row.kind === 'replyUpdate' || row.kind === 'replyDelete') {
      const review = await db().BusinessProfileReview.findByPk(row.local_input.reviewId, options);
      const { reviewReply: _reply, ...rest } = raw(review);
      const deleted = row.kind === 'replyDelete', replyAt = result.updateTime ? new Date(result.updateTime) : at;
      await review.update({ has_reply: !deleted, reply_comment: deleted ? null : result.comment,
        reply_update_time: deleted ? null : replyAt,
        raw_payload: deleted ? rest : { ...rest, reviewReply: { ...result, updateTime: replyAt.toISOString() } } }, { transaction });
      return;
    }
    const location = await db().ClinicBusinessLocation.findByPk(row.mapping_id, options);
    if (!location) fail('scope_denied');
    const current = raw(location), iso = at.toISOString();
    if (row.kind === 'photo') {
      const items = Array.isArray(current.clinicaclick_media_items) ? current.clinicaclick_media_items : [];
      await location.update({ raw_payload: { ...current,
        clinicaclick_media_items: [result, ...items.filter(item => item?.name !== result.name)].slice(0, 500),
        clinicaclick_content_synced_at: iso } }, { transaction });
    } else {
      const plan = row.local_input.plan;
      const normalized = require('./businessProfileLocal.service').normalizeSpecialHoursPlan(plan, plan?.timeZone);
      const periods = normalized.periods.map(({ kind, startDate, endDate, openTime, closeTime }) =>
        ({ kind, startDate, endDate, openTime: openTime || null, closeTime: closeTime || null }));
      if (C.hash(periods) !== C.hash(row.input.periods)) fail('business_profile_mutation_conflict');
      await location.update({ raw_payload: { ...current, specialHours: result.specialHours,
        clinicaclick_special_hours_plan: { ...normalized, syncedAt: iso, sourceClinicId: Number(row.requested_clinic_id) },
        clinicaclick_special_hours_synced_at: iso }, sync_status: 'synced', last_synced_at: at }, { transaction });
    }
  }
  async function context({ clinicId, location, brokerContext, request, actor, verifyAutomation, target }) {
    actor = actor ? actorFor(actor) : await user(request);
    const first = await scope({ models: db(), clinicId, mappingId: Number(location.id), userId: actor.userId });
    const beforeExecute = async ({ transaction } = {}) => {
      const current = await scope({ models: db(), clinicId, mappingId: Number(location.id), userId: actor.userId, transaction });
      if (C.hash(current.clinicIds) !== C.hash(first.clinicIds)) fail('scope_denied');
      if (target) await checkTarget(target, transaction);
      return true;
    };
    return { actor, verifyAutomation, runtimeNamespace: namespace(), clinicId, clinicIds: first.clinicIds,
      location, brokerContext, broker, beforeExecute, applyResult };
  }
  async function response(ctx, mutation) {
    const result = { success: mutation.state === 'applied', mutation };
    if (!result.success) return result;
    // Return current cache, never an old receipt which could overwrite a newer
    // edit in the UI. The journal already makes its local projection idempotent.
    const row = await db().BusinessProfileMutation.findByPk(mutation.operationId, { logging: false });
    if (['replyUpdate', 'replyDelete'].includes(row.kind)) {
      const review = await db().BusinessProfileReview.findByPk(row.local_input.reviewId,
        { attributes: { exclude: ['raw_payload'] }, logging: false });
      result.review = review ? review.get({ plain: true }) : null;
    } else {
      const location = await db().ClinicBusinessLocation.findByPk(row.mapping_id, { logging: false });
      const current = raw(location);
      if (row.kind === 'photo') {
        const media = (current.clinicaclick_media_items || []).find(item => item?.name === row.broker_receipt.result.name);
        result.photo = media ? require('./businessProfileLocal.service').normalizeMediaItem(media, 0) : null;
      } else Object.assign(result, { specialHours: current.specialHours, plan: current.clinicaclick_special_hours_plan,
        timeZone: current.clinicaclick_special_hours_plan?.timeZone, syncedAt: current.clinicaclick_special_hours_synced_at });
    }
    await ctx.beforeExecute();
    if (ctx.actor.type === 'user') await sessions.verifyReference({ userId: ctx.actor.userId,
      sessionRef: ctx.actor.sessionRef, expiresAt: new Date(ctx.actor.expiresAt) });
    await broker.assert(ctx.location, ctx.brokerContext);
    return result;
  }
  const guarded = fn => async (...args) => {
    try { return await fn(...args); } catch (error) {
      throw Object.assign(Error(safe(error)), { code: safe(error), status: status(error), businessProfileMutation: true });
    }
  };
  return {
    prepare: guarded(location => broker.prepare(location, async () => ({ accessToken: null }), new Map())),
    managed: (location, value) => broker.managed(location, value),
    execute: guarded(async ({ resolved, location, brokerContext, request, actor, verifyAutomation, kind, input, localInput }) => {
      C.validate(kind, input);
      const target = { mapping_id: Number(location.id), asset_ref: location.broker_read_asset_ref,
        requested_clinic_id: Number(resolved.clinicId), kind, input, local_input: localInput };
      const ctx = await context({ clinicId: Number(resolved.clinicId), location, brokerContext, request, actor, verifyAutomation, target });
      return response(ctx, await log.execute(ctx, kind, input, localInput));
    }),
    recover: guarded(async ({ clinicId, operationId, request }) => {
      C.validate('status', { operationId }); const actor = await user(request);
      const row = await db().BusinessProfileMutation.findOne({ where: { operation_id: operationId,
        actor_user_id: actor.userId, requested_clinic_id: clinicId, runtime_namespace: namespace() }, logging: false });
      if (!row) fail('business_profile_mutation_not_found');
      const location = await db().ClinicBusinessLocation.findByPk(row.mapping_id, { logging: false });
      if (!location) fail('scope_denied');
      const brokerContext = await broker.prepare(location, () => fail('broker_binding_invalid'), new Map());
      const ctx = await context({ clinicId, location, brokerContext, actor, target: row });
      return response(ctx, await log.recover(ctx, operationId));
    }),
    pending: guarded(async ({ clinicId, request }) => {
      if (!enabled()) return { success: true, items: [], hasMore: false, enabled: false };
      const actor = await user(request);
      const rows = await db().BusinessProfileMutation.findAll({ where: { actor_user_id: actor.userId,
        requested_clinic_id: clinicId, runtime_namespace: namespace(), state: 'attempted' },
        attributes: ['operation_id', 'mapping_id', 'kind', 'created_at', 'last_error'],
        order: [['created_at', 'ASC'], ['operation_id', 'ASC']], limit: 101, raw: true, logging: false });
      const items = [], checked = new Map();
      for (const row of rows.slice(0, 100)) {
        const mappingId = Number(row.mapping_id);
        if (!checked.has(mappingId)) {
          try { await scope({ models: db(), clinicId, mappingId, userId: actor.userId }); checked.set(mappingId, true); }
          catch (error) { if (error.code === 'scope_denied') checked.set(mappingId, false); else throw error; }
        }
        if (!checked.get(mappingId)) continue;
        items.push({ operationId: row.operation_id, mappingId: row.mapping_id, kind: row.kind,
          state: 'unknown', createdAt: row.created_at, lastError: row.last_error });
      }
      for (const [mappingId, allowed] of checked) if (allowed) await scope({ models: db(), clinicId, mappingId, userId: actor.userId });
      await sessions.verifyReference({ userId: actor.userId, sessionRef: actor.sessionRef, expiresAt: new Date(actor.expiresAt) });
      return { success: true, items, hasMore: rows.length > 100, enabled: true };
    }),
  };
}
let singleton;
const instance = () => singleton ||= createBusinessProfileMutations({ models: () => require('../../models'),
  broker: require('./businessProfileBroker.service'), sessions: require('./accessSession.service') });
module.exports = { createBusinessProfileMutations,
  ...Object.fromEntries(['prepare', 'managed', 'execute', 'recover', 'pending'].map(key => [key, (...args) => instance()[key](...args)])) };
