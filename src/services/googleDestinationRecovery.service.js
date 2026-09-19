'use strict';
const { Op, IndexHints } = require('sequelize');
const A = require('../../services/integrations-broker/src/google-action-management-contract');
const C = require('../../services/integrations-broker/src/google-destination-contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { project: projectPlan } = require('./googleAdsActionManagementBrokerClient.service');
const { project: projectDestination } = require('./googleDataManagerDestinationsBrokerClient.service');
const { fromDestinationList } = require('../../services/platform-audit/src/google-destination-event');
const fail = code => { throw Object.assign(Error(code), { code }); };
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const stamp = v => typeof v === 'string' && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const LIMIT = 20;
function projectReference(row, parent, ctx, requestId) {
  const { actor, captured, scopeKey, scopeDigest } = ctx;
  for (const value of [row, parent]) {
    if (!value || Number(value.actor_user_id) !== actor.userId || value.scope_key !== scopeKey || value.scope_digest !== scopeDigest
      || !(value.session_expires_at instanceof Date) || !uuid(value.session_ref)) fail('google_destination_recovery_unavailable');
    const original = { userId: Number(value.actor_user_id), sessionRef: value.session_ref, expiresAt: value.session_expires_at.getTime() };
    if (value.owner_digest !== A.hash({ actor: original, scopeKey, captured })) fail('google_destination_recovery_unavailable');
  }
  if (!uuid(row.authorization_id) || !uuid(row.plan_id) || row.plan_id !== parent.plan_id || !uuid(parent.apply_command_id)
    || parent.closed_at || parent.receipt?.state !== 'applied' || Number(row.mapping_id) !== Number(ctx.runtime.account.id)
    || row.customer_id !== captured.customerId || row.revoke_command_id !== null && !uuid(row.revoke_command_id)
    || !(row.created_at instanceof Date) || !(row.updated_at instanceof Date)) fail('google_destination_recovery_unavailable');
  C.validate(C.OPERATIONS.authorize, row.input);
  if (row.input.planId !== row.plan_id) fail('google_destination_recovery_unavailable');
  projectPlan('status', parent.receipt, requestId, { planId: parent.plan_id });
  projectPlan('prepare', { planId: parent.plan_id, state: 'prepared', expiresAt: parent.receipt.expiresAt, changes: parent.receipt.changes }, parent.plan_id, parent.input);
  const expected = row.input.targets.map(target => {
    const change = parent.receipt.changes.find(item => item.event === target.event);
    if (!change) fail('google_destination_recovery_unavailable');
    const conversionActionId = change.change === 'unchanged' ? change.actionId : parent.receipt.results.find(item => item.event === target.event)?.actionId;
    return { event: target.event, conversionActionId, sources: [...target.sources] };
  });
  projectDestination('authorize', { authorizationId: row.authorization_id, planId: row.plan_id, state: 'active', destinations: expected }, row.authorization_id, row.input);
  if (row.receipt) {
    projectDestination('status', row.receipt, requestId, { authorizationId: row.authorization_id });
    if (row.receipt.planId !== row.plan_id || canonical(row.receipt.destinations) !== canonical(expected)) fail('google_destination_recovery_unavailable');
  }
  return { authorizationId: row.authorization_id, input: structuredClone(row.input), expected, revokeId: row.revoke_command_id,
    createdAt: row.created_at.toISOString(), observedAt: row.updated_at.toISOString(), observedState: row.receipt?.state || 'unknown',
    outcomeUnknown: !row.receipt || Boolean(row.revoke_command_id && row.receipt.state !== 'revoked') };
}
async function listDestinations({ prepareContext, now }, context, input, options) {
  if (!exact(input, 'cursor,planId') || input.planId !== null && !uuid(input.planId)
    || !exact(options, 'requestId') || !uuid(options.requestId)
    || input.cursor !== null && (!exact(input.cursor, 'createdAt,authorizationId') || !stamp(input.cursor.createdAt) || !uuid(input.cursor.authorizationId))
    || input.planId !== null && input.cursor !== null) fail('invalid_request');
  input = structuredClone(input);
  const requestId = options.requestId;
  const ctx = await prepareContext(context, 'list'), { actor, captured, scopeKey, scopeDigest, guard, m, events, runtime } = ctx;
  const append = async (reason, rows, transaction) => {
    try {
      const date = new Date(now()), health = await events.health(date, { includeUnresolved: false, transaction });
      if (!Number.isSafeInteger(health.pending) || health.pending >= 10000 || !Number.isFinite(health.oldestAgeSeconds) || health.oldestAgeSeconds >= 3600) fail('audit_unavailable');
      await events.append(fromDestinationList({ actor, captured, scopeKey, mappingId: runtime.account.id, requestId, reason, rows, input, now: date }), { transaction });
    } catch { fail('audit_unavailable'); }
  };
  await guard();
  // The attempted read is durable even if projection or the final capture fails.
  await m.sequelize.transaction(async transaction => { await guard(transaction); await append('list_requested', null, transaction); });
  const page = await m.sequelize.transaction(async transaction => {
    await guard(transaction);
    const where = { actor_user_id: actor.userId, mapping_id: runtime.account.id, scope_key: scopeKey, scope_digest: scopeDigest,
      ...(input.planId ? { plan_id: input.planId } : {}),
      ...(input.cursor ? { [Op.or]: [{ created_at: { [Op.lt]: new Date(input.cursor.createdAt) } },
        { created_at: new Date(input.cursor.createdAt), authorization_id: { [Op.lt]: input.cursor.authorizationId } }] } : {}) };
    // Repeatable-read observation only: never updates decisions, commands or broker state.
    const rows = await m.GoogleDestinationAuthorization.findAll({ where, order: [['created_at','DESC'],['authorization_id','DESC']],
      ...(!input.planId ? { indexHints: [{ type: IndexHints.FORCE, values: ['cc_google_destination_recovery'] }] } : {}),
      limit: LIMIT + 1, transaction, raw: true, logging: false });
    const selected = rows.slice(0, LIMIT);
    const parents = selected.length ? await m.GoogleAdsActionPlan.findAll({ where: { plan_id: { [Op.in]: selected.map(row => row.plan_id) } },
      transaction, raw: true, logging: false }) : [];
    const byId = new Map(parents.map(parent => [parent.plan_id, parent]));
    const items = selected.map(row => projectReference(row, byId.get(row.plan_id), ctx, requestId));
    await guard(transaction); await append('list_prepared', items, transaction);
    const last = selected.at(-1);
    return { requestId, customerId: captured.customerId, scopeKey, items,
      nextCursor: rows.length > LIMIT ? { createdAt: last.created_at.toISOString(), authorizationId: last.authorization_id } : null };
  });
  await guard(); return page;
}
module.exports = { listDestinations, projectReference, LIMIT };
