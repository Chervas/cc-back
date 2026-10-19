'use strict';

const { Op } = require('sequelize');
const { randomUUID, createHash } = require('node:crypto');
const S = require('./whatsappAuthorizationState.contract');
const { isGlobalAdmin, MARKETING_WRITE_ROLES } = require('../lib/role-helpers');
const manual = require('../lib/whatsappManualDisconnect');
function createService({ models, sessions, audit, broker = require('../lib/whatsappAuthorizedBrokerClient'),
  control = require('./whatsappDisconnectControl.service'), now = () => new Date() } = {}) {
  const db = () => models || require('../../models');
  async function locked(raw, actor, commit) {
    S.exact(raw, commit ? ['assetId', 'clinicId', 'scopeToken'] : ['assetId', 'clinicId']);
    if (!S.id(raw.assetId) || !S.id(raw.clinicId)) S.fail();
    S.request({ ...actor, requestId: randomUUID() }, 'status');
    if (!control.available()) S.fail('whatsapp_disconnect_unavailable', 503);
    return db().sequelize.transaction(async transaction => {
      const options = { transaction, lock: transaction.LOCK.UPDATE };
      await (sessions || require('./accessSession.service')).verifyReference({ userId: actor.userId,
        sessionRef: actor.sessionRef, expiresAt: new Date(actor.sessionExpiresAt * 1000) }, { transaction });
      const asset = await db().ClinicMetaAsset.findByPk(raw.assetId, options);
      if (!asset || asset.assetType !== 'whatsapp_phone_number' || !['clinic', 'group'].includes(asset.assignmentScope)) S.fail();
      const scope = { type: asset.assignmentScope, id: Number(asset.assignmentScope === 'clinic' ? asset.clinicaId : asset.grupoClinicaId) };
      if (!S.id(scope.id)) S.fail();
      const clinics = await db().Clinica.findAll({ ...options, where: scope.type === 'clinic'
        ? { id_clinica: scope.id } : { grupoClinicaId: scope.id }, attributes: ['id_clinica'], order: [['id_clinica', 'ASC']], limit: 1001, raw: true });
      const clinicIds = clinics.map(c => Number(c.id_clinica));
      if (!clinicIds.length || clinicIds.length > 1000 || !clinicIds.includes(raw.clinicId)) S.fail('whatsapp_authorization_forbidden', 403);
      if (!isGlobalAdmin(actor.userId)) {
        const memberships = await db().UsuarioClinica.findAll({ ...options, where: { id_usuario: actor.userId,
          id_clinica: { [Op.in]: clinicIds }, rol_clinica: { [Op.in]: MARKETING_WRITE_ROLES },
          [Op.or]: [{ estado_invitacion: 'aceptada' }, { estado_invitacion: null }] }, attributes: ['id_clinica'], raw: true });
        if (clinicIds.some(id => !memberships.some(m => Number(m.id_clinica) === id))) S.fail('whatsapp_authorization_forbidden', 403);
      }
      const archived = asset.additionalData?.whatsappArchive;
      if (commit === 'archive' && archived?.archivedAt) {
        if (archived.scopeToken !== raw.scopeToken || JSON.stringify(archived.scope) !== JSON.stringify(scope)
          || JSON.stringify(archived.clinicIds) !== JSON.stringify(clinicIds)
          || manual.current(asset)?.state !== 'disconnected') S.fail('whatsapp_authorization_conflict', 409);
        return { success: true, archived: true, assetId: asset.id, clinicCount: clinicIds.length };
      }
      const bindings = [];
      for (const clinicId of clinicIds) {
        const binding = await broker.binding(clinicId, raw.assetId, asset);
        if (!binding) S.fail('whatsapp_disconnect_unavailable', 503);
        bindings.push(binding);
      }
      const first = bindings[0];
      if (bindings.some(b => b.authorizationId !== first.authorizationId || b.connectionRef !== first.connectionRef)) S.fail('whatsapp_authorization_conflict', 409);
      const identity = { authorizationId: first.authorizationId, connectionRef: first.connectionRef,
        localAuthorizationId: asset.whatsappAuthorizationId || null, phoneId: asset.phoneNumberId, wabaId: asset.wabaId,
        scope, clinicIds };
      const scopeToken = createHash('sha256').update(JSON.stringify({ assetId: asset.id, ...identity })).digest('hex');
      const previous = manual.current(asset, first);
      if (previous && (JSON.stringify(previous.clinicIds) !== JSON.stringify(clinicIds)
        || previous.scopeToken !== scopeToken || previous.version !== 1
        || !Array.isArray(previous.receipts) || previous.receipts.length !== clinicIds.length
        || previous.receipts.some((receipt, index) => receipt.clinicId !== clinicIds[index]
          || !S.uuid(receipt.requestId) || typeof receipt.confirmed !== 'boolean')
        || new Set(previous.receipts.map(receipt => receipt.requestId)).size !== clinicIds.length)) S.fail('whatsapp_authorization_conflict', 409);
      if (commit && raw.scopeToken !== scopeToken) S.fail('whatsapp_authorization_conflict', 409);
      if (commit === 'archive') {
        if (previous?.state !== 'disconnected') S.fail('whatsapp_archive_requires_disconnect', 409);
        const routing = await db().WhatsappChannelBinding.findAll({ ...options,
          where: { asset_id: asset.id, is_active: true }, attributes: ['id', 'clinic_id'], raw: true });
        if (routing.some(binding => !clinicIds.includes(Number(binding.clinic_id)))) S.fail('whatsapp_authorization_conflict', 409);
        await db().WhatsappChannelBinding.update({ is_active: false, updated_by: actor.userId }, {
          where: { asset_id: asset.id, clinic_id: { [Op.in]: clinicIds }, is_active: true }, transaction,
        });
        await db().WhatsappPhoneActivation.update({ state: 'archived', updated_by: actor.userId }, {
          where: { asset_id: asset.id, authorization_id: asset.whatsappAuthorizationId, state: 'active' }, transaction,
        });
        await asset.update({ isActive: false, additionalData: { ...(asset.additionalData || {}),
          routing_disabled: true, requireClinicSelection: true,
          whatsappArchive: { version: 1, archivedAt: now().toISOString(), actorId: actor.userId, scopeToken, scope, clinicIds },
        } }, { transaction });
        await require('./whatsappConnectionAudit').append({ db: db(), audit, actor, scope, requestId: randomUUID(),
          assetIds: [asset.id], action: 'integration.whatsapp.routing', reason: 'routing_saved', transaction, now: now() });
        await db().WhatsappAccountHealthEvent.findOrCreate({ where: { dedupe_key: createHash('sha256').update(`archive:${asset.id}:${scopeToken}`).digest('hex') },
          defaults: { asset_id: asset.id, clinic_id: scope.type === 'clinic' ? scope.id : null,
            group_id: scope.type === 'group' ? scope.id : null, waba_id: asset.wabaId, phone_number_id: asset.phoneNumberId,
            event_type: 'connection_archived', source: 'clinicaclick_manual_archive', previous_state: 'disconnected',
            state: 'disconnected', severity: 'info', can_send: false, reason_code: 'clinicaclick_manual_disconnect',
            details: { actor_id: actor.userId, scope, clinic_ids: clinicIds, scope_token: scopeToken }, observed_at: now() }, transaction });
        return { success: true, archived: true, assetId: asset.id, clinicCount: clinicIds.length };
      }
      let intent = previous;
      if (commit && !intent) {
        intent = { version: 1, ...identity, scopeToken, state: 'pending', actorId: actor.userId,
          sessionRef: actor.sessionRef, requestedAt: now().toISOString(),
          receipts: bindings.map(b => ({ clinicId: b.clinicId, requestId: randomUUID(), confirmed: false })) };
        await asset.update({ additionalData: { ...(asset.additionalData || {}), whatsappManualDisconnect: intent } }, { transaction });
      }
      return { assetId: asset.id, scope, clinicCount: clinicIds.length, scopeToken,
        state: intent?.state || 'connected', ...(commit ? { intent } : {}) };
    });
  }
  async function disconnect(raw, actor) {
    const prepared = await locked(raw, actor, true);
    const intent = prepared.intent;
    if (intent.state !== 'disconnected') {
      const startedAt = Date.now();
      for (const receipt of intent.receipts.filter(r => !r.confirmed)) {
        if (Date.now() - startedAt >= 15000) break;
        try {
          const result = await control.execute({ requestId: receipt.requestId, tenantRef: 'clinic:' + receipt.clinicId,
            connectionRef: intent.connectionRef, assetRef: 'wa-phone:' + intent.phoneId,
            operation: 'meta.whatsapp.authorized.phone.revoke.v1', payload: {} });
          if (result.requestId !== receipt.requestId || result.data?.revoked !== true) break;
          await db().sequelize.transaction(async transaction => {
            const asset = await db().ClinicMetaAsset.findByPk(prepared.assetId, { transaction, lock: transaction.LOCK.UPDATE });
            const current = manual.current(asset);
            if (!current || current.scopeToken !== intent.scopeToken) S.fail('whatsapp_authorization_conflict', 409);
            const next = structuredClone(current);
            next.receipts.find(r => r.requestId === receipt.requestId).confirmed = true;
            if (next.receipts.every(r => r.confirmed)) { next.state = 'disconnected'; next.confirmedAt = now().toISOString(); }
            await asset.update({ additionalData: { ...(asset.additionalData || {}), whatsappManualDisconnect: next } }, { transaction });
          });
        } catch { break; }
      }
    }
    const latest = await locked({ assetId: raw.assetId, clinicId: raw.clinicId }, actor, false);
    return { ...latest, success: true, sendingStopped: true };
  }
  return { preview: (raw, actor) => locked(raw, actor, false), disconnect,
    archive: (raw, actor) => locked(raw, actor, 'archive') };
}
module.exports = { createService, ...createService() };
