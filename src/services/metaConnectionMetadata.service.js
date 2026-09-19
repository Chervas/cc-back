'use strict';
const { Op } = require('sequelize');
const { marketingScopeInputFromRequest } = require('../lib/oauthMarketingScopeAccess');
const { createHash } = require('node:crypto');
const fail = (code, httpStatus) => { throw Object.assign(Error(code), { code, httpStatus }); };
const signature = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ASSET_FIELDS = Object.freeze(['id', 'clinicaId', 'grupoClinicaId', 'assignmentScope', 'metaConnectionId', 'metaAssetId', 'metaAssetName', 'assetType', 'createdAt', 'updatedAt']);
const TYPES = Object.freeze(['facebook_page', 'instagram_business', 'ad_account']);

// Local metadata is not evidence of credential validity or provider availability.
// No transport or credential loader belongs in this reader. Opening the broker
// cohort later requires a separate, reviewed contract for live validation.
function createMetaConnectionMetadata({ authorize, resolve, session, loadMappings, scopeResponse }) {
  async function snapshot(req) {
    const input = marketingScopeInputFromRequest(req);
    for (const value of [input.clinicIdRaw, input.groupIdRaw]) {
      if (value !== null && value !== '' && (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) || Number(value) > 2147483647)) fail('marketing_connection_scope_invalid', 400);
    }
    const claims = await session(req);
    if (!claims?.userId || Number(claims.userId) !== Number(req.userData?.userId) || claims.sessionVersion !== 1 || !claims.jti) fail('meta_metadata_session_required', 401);
    const authorization = await authorize(req);
    if (!authorization?.requested || !authorization.clinicIds?.length) fail('marketing_connection_scope_required', 400);
    const resolved = await resolve(req);
    const clinicIds = [...new Set(authorization.clinicIds.map(Number))].sort((a, b) => a - b);
    if (clinicIds.length > 1000 || clinicIds.some(id => !Number.isSafeInteger(id) || id <= 0)) fail('meta_metadata_limit', 503);
    const { connection, assignment, scope, source } = resolved;
    return { resolved, clinicIds, session: { userId: claims.userId, jti: claims.jti }, signature: signature({ userId: claims.userId, jti: claims.jti, clinicIds, scope,
      source, connection: connection ? Object.fromEntries(['id', 'metaUserId', 'userId', 'userName', 'userEmail', 'expiresAt', 'updatedAt'].map(k => [k, connection[k]])) : null,
      assignment: assignment ? Object.fromEntries(['id', 'status', 'metaConnectionId', 'authorizedByUserId', 'authorizedByName', 'authorizedByEmail', 'updated_at'].map(k => [k, assignment[k]])) : null }) };
  }
  async function read(req, mappings = false) {
    const before = await snapshot(req);
    const { connection, assignment, scope, source } = before.resolved;
    const rows = mappings && connection ? await loadMappings(connection.id, before.clinicIds, { scopeKey: scope?.scopeKey }) : [];
    if (!Array.isArray(rows) || rows.length > 1000) fail('meta_metadata_limit', 503);
    const after = await snapshot(req);
    if (before.signature !== after.signature) fail('meta_metadata_scope_changed', 409);
    // End with a fresh ACL and session check, after all metadata I/O.
    const finalAccess = await authorize(req);
    if (!finalAccess?.requested || signature([...new Set(finalAccess.clinicIds.map(Number))].sort((a,b) => a-b)) !== signature(before.clinicIds)) fail('meta_metadata_scope_changed', 409);
    const finalSession = await session(req);
    if (!finalSession || finalSession.sessionVersion !== 1 || signature({ userId: finalSession.userId, jti: finalSession.jti }) !== signature(before.session)) fail('meta_metadata_session_required', 401);
    const availability = { available: false, reason: 'meta_security_quarantine' };
    const status = { connected: false, connectionStored: !!connection, availability,
      reason: 'meta_security_quarantine', validationDeferred: true, reauthorizationRequired: false,
      scope: scopeResponse(scope, assignment), source,
      ...(connection ? { metaUserId: connection.metaUserId, userName: connection.userName, userEmail: connection.userEmail,
        authorizedByUserId: assignment?.authorizedByUserId || connection.userId || null,
        authorizedByName: assignment?.authorizedByName || connection.userName || null,
        authorizedByEmail: assignment?.authorizedByEmail || connection.userEmail || null } : {}) };
    if (!mappings) return status;
    const grouped = new Map(), coveredClinics = new Set(); let count = 0, groupCount = 0;
    for (const row of rows) {
      if (Number(row.metaConnectionId) !== Number(connection?.id) || !TYPES.includes(row.assetType)) fail('meta_metadata_invalid', 503);
      // Older group mappings were stored once per clinic. Preserve those local
      // cards; only canonical null-clinic rows represent the whole group here.
      const isGroup = row.assignmentScope === 'group' && row.clinicaId === null, id = Number(isGroup ? row.grupoClinicaId : row.clinicaId);
      if (isGroup ? row.clinicaId !== null || scope?.assignmentScope !== 'group' || scope.scopeKey !== 'group:' + id || Number(row.groupMetadata?.id) !== id
        : !before.clinicIds.includes(id) || !['clinic','group'].includes(row.assignmentScope)
          || row.assignmentScope === 'group' && (!row.grupoClinicaId || Number(row.grupoClinicaId) !== Number(row.clinica?.grupoClinicaId))) fail('meta_metadata_invalid', 503);
      const scopeKey = (isGroup ? 'group:' : 'clinic:') + id;
      if (!grouped.has(scopeKey)) {
        grouped.set(scopeKey, { scope: { type: isGroup ? 'group' : 'clinic', id, key: scopeKey, clinicCount: isGroup ? before.clinicIds.length : 1 },
          clinica: isGroup ? null : { id, nombre: row.clinica?.nombre_clinica || `Clínica ${id}`, avatar_url: row.clinica?.url_avatar || null },
          grupo: isGroup ? { id, nombre: row.groupMetadata.nombre } : null,
          assets: { facebook_pages: [], instagram_business: [], ad_accounts: [] }, totalAssets: 0 });
        if (isGroup) { groupCount++; for (const clinicId of before.clinicIds) coveredClinics.add(clinicId); }
        else coveredClinics.add(id);
      }
      const group = grouped.get(scopeKey);
      const key = { facebook_page: 'facebook_pages', instagram_business: 'instagram_business', ad_account: 'ad_accounts' }[row.assetType];
      group.assets[key].push({ ...Object.fromEntries(['id', 'metaAssetId', 'metaAssetName', 'assetType', 'createdAt', 'updatedAt'].map(k => [k, row[k]])),
        assignmentScope: row.assignmentScope, groupId: row.assignmentScope === 'group' ? Number(row.grupoClinicaId) : null, verificationAvailable: row.verificationAvailable === true });
      group.totalAssets++; count++;
    }
    return { success: true, availability, connectionStored: !!connection, mappings: [...grouped.values()], totalMappings: count, totalClinics: coveredClinics.size, totalGroups: groupCount };
  }
  return { read, handler: (mappings = false) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { return res.json(await read(req, mappings)); }
    catch (error) {
      const known = /^meta_metadata_|^marketing_connection_(?:scope_|group_not_found$)|^asset_mapping_scope_|^unauthenticated$/.test(error?.code || '');
      const status = known && [400, 401, 403, 409, 503].includes(error.httpStatus) ? error.httpStatus : 503;
      return res.status(status).json({ success: false, connected: false, error: known ? error.code : 'meta_metadata_unavailable' });
    }
  } };
}
function createMetaMetadataRepository(models) {
  return async (connectionId, clinicIds, { scopeKey } = {}) => {
    const groupId = /^group:[1-9]\d{0,9}$/.test(scopeKey || '') ? Number(scopeKey.split(':')[1]) : null;
    const rows = await models.ClinicMetaAsset.findAll({
    attributes: ASSET_FIELDS,
    where: { metaConnectionId: connectionId, isActive: true, assetType: { [Op.in]: TYPES },
      [Op.or]: [{ clinicaId: { [Op.in]: clinicIds } }, ...(groupId ? [{ assignmentScope: 'group', grupoClinicaId: groupId }] : [])] },
    include: [{ model: models.Clinica, as: 'clinica', attributes: ['nombre_clinica', 'url_avatar', 'grupoClinicaId'] }],
    order: [['clinicaId', 'ASC'], ['id', 'ASC']], limit: 1001, logging: false
    });
    if (groupId && rows.length <= 1000 && rows.some(row => row.assignmentScope === 'group' && row.clinicaId === null)) {
      const group = await models.GrupoClinica.findByPk(groupId, { attributes: ['id_grupo', 'nombre_grupo'], raw: true, logging: false });
      if (!group) fail('meta_metadata_scope_changed', 409);
      for (const row of rows) if (row.assignmentScope === 'group') row.groupMetadata = { id: Number(group.id_grupo), nombre: group.nombre_grupo || `Grupo ${groupId}` };
    }
    if (process.env.META_MARKETING_BROKER_ENABLED === 'true' && process.env.META_MARKETING_ACCESS_CHECK_ENABLED === 'true' && rows.length && rows.length <= 1000) {
      const bindings = await models.MetaMarketingBrokerBinding.findAll({ attributes: ['mapping_id'], raw: true, logging: false, limit: 1001,
        where: { mapping_id: { [Op.in]: rows.map(row => row.id) }, meta_connection_id: connectionId, scope_key: scopeKey, state: 'active' } });
      const ids = new Set(bindings.map(row => Number(row.mapping_id)));
      for (const row of rows) row.verificationAvailable = ids.has(Number(row.id));
    }
    return rows;
  };
}
module.exports = { createMetaConnectionMetadata, createMetaMetadataRepository, ASSET_FIELDS, TYPES };
