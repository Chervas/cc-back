'use strict';
const { Op } = require('sequelize');
const fail = code => { throw Object.assign(Error(code), { code }); };
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const FIELDS = {
  search_console: ['id', 'clinicaId', 'googleConnectionId', 'siteUrl', 'propertyType', 'permissionLevel', 'verified', 'updated_at'],
  analytics: ['id', 'clinicaId', 'googleConnectionId', 'propertyName', 'propertyDisplayName', 'measurementId', 'updated_at'],
};
// Use the established Google property selection rules, without the broader
// marketing resolver (which also loads intake/Meta configuration).
function createGooglePropertyInventoryScope({ models, normalizeScope, listProperties }) {
  const bounded = async fn => { const rows = await fn(); if (!Array.isArray(rows) || rows.length > 1000) fail('broker_discovery_limit'); return rows; };
  return {
    async resolve({ kind, scopeInput, clinicIds, connectionId }) {
      if (!Object.hasOwn(FIELDS, kind) || !Array.isArray(clinicIds) || !clinicIds.length || clinicIds.length > 1000
        || clinicIds.some(id => !positive(id)) || new Set(clinicIds).size !== clinicIds.length || !positive(connectionId)) fail('broker_binding_invalid');
      const scope = await normalizeScope(scopeInput);
      if (!['clinic', 'group'].includes(scope.assignmentScope) || (scope.assignmentScope === 'clinic'
        ? !positive(scope.clinicId) || clinicIds.length !== 1 || clinicIds[0] !== scope.clinicId : !positive(scope.groupId))) fail('broker_binding_invalid');
      const m = models(); const empty = { findAll: async () => [] };
      const propertyModel = m[kind === 'search_console' ? 'ClinicWebAsset' : 'ClinicAnalyticsProperty'];
      const properties = await listProperties({ assignment_scope: scope.assignmentScope, clinic_id: scope.clinicId,
        group_id: scope.groupId, clinic_ids: clinicIds }, {
        groupModel: m.GrupoClinica,
        assignmentModel: { findAll: options => bounded(() => m.GroupAssetClinicAssignment.findAll({ ...options,
          where: { ...options.where, assetType: 'google.' + kind },
          attributes: ['grupoClinicaId', 'clinicaId', 'assetType', 'assetId'], limit: 1001, raw: true, logging: false })) },
        propertyModels: { search_console: empty, analytics: empty, business_profile: empty,
          [kind]: { findAll: options => bounded(() => propertyModel.findAll({ ...options,
            where: { ...options.where, googleConnectionId: connectionId }, attributes: FIELDS[kind], limit: 1001, raw: true, logging: false })) } },
      });
      const rows = properties?.[kind];
      if (!Array.isArray(rows) || rows.length > 1000) fail('broker_discovery_limit');
      const result = []; const seen = new Set();
      for (const row of rows) {
        const resource = kind === 'search_console' ? row.site_url : row.property_name;
        if (!positive(row.mapping_id) || !positive(row.clinic_id) || row.connection_id !== connectionId || seen.has(row.mapping_id)
          || typeof resource !== 'string' || !resource || resource.length > 512 || !['clinic', 'group', 'shared'].includes(row.assignment_origin)) fail('broker_binding_invalid');
        seen.add(row.mapping_id); result.push({ mapping_id: row.mapping_id, clinic_id: row.clinic_id, connection_id: connectionId, resource });
      }
      const external = [...new Set(result.filter(row => !clinicIds.includes(row.clinic_id)).map(row => row.clinic_id))];
      if (external.length) {
        if (!positive(scope.groupId)) fail('google_discovery_scope_forbidden');
        const owners = await bounded(() => m.Clinica.findAll({ where: { id_clinica: { [Op.in]: external } },
          attributes: ['id_clinica', 'grupoClinicaId'], limit: 1001, raw: true, logging: false }));
        if (owners.length !== external.length || external.some(id => !owners.some(row => Number(row.id_clinica) === id
          && Number(row.grupoClinicaId) === scope.groupId))) fail('google_discovery_scope_forbidden');
      }
      return result;
    },
  };
}
let singleton;
module.exports = { createGooglePropertyInventoryScope, resolve: (...args) => {
  singleton ||= createGooglePropertyInventoryScope({ models: () => require('../../models'),
    normalizeScope: require('./scopeConnectionResolver.service').normalizeScope,
    listProperties: require('./effectiveMarketingAssets.service').listScopedGoogleProperties });
  return singleton.resolve(...args);
} };
