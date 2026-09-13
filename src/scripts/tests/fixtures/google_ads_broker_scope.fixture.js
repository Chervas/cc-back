'use strict';
const { createGoogleAdsBrokerScope } = require('../../../services/googleAdsBrokerScope.service');
function scopeFixture() {
  const mapping = { id: 11, customerId: '1234567890', googleConnectionId: 2, assignmentScope: 'group',
    clinicaId: 999, grupoClinicaId: 5, isActive: true, loginCustomerId: '9876543210', managerCustomerId: null,
    broker_read_connection_ref: 'connection:ads-fictitious', broker_read_asset_ref: 'ads:1234567890' };
  const binding = { customer_id: mapping.customerId, mapping_id: 11, google_connection_id: 2, google_user_id: 'fictitious-subject',
    connection_ref: mapping.broker_read_connection_ref, asset_ref: mapping.broker_read_asset_ref, scope_key: 'group:5',
    tenant_clinic_id: 59, login_customer_id: mapping.loginCustomerId, state: 'active' };
  const state = { mappings: [mapping], bindings: [binding], enabled: true, calls: [],
    clinics: [{ id_clinica: 59, grupoClinicaId: 5 }, { id_clinica: 71, grupoClinicaId: 5 }], shared: [],
    grants: [{ id: 100, assignmentScope: 'group', grupoClinicaId: 5, clinicaId: null, googleConnectionId: 2, status: 'active' }],
    connection: { id: 2, googleUserId: 'fictitious-subject', credentials_external: 1 } };
  const read = (kind, fn) => async (...args) => { state.calls.push({ kind, args }); await state.onRead?.(kind); return structuredClone(fn(...args)); };
  const options = { enabled: () => state.enabled,
    loadMapping: read('mapping', id => state.mappings.find(row => row.id === id)),
    loadBindings: read('bindings', (id, mappingId) => state.bindings.filter(row => row.customer_id === id || row.mapping_id === mappingId)),
    loadMappings: read('mappings', id => state.mappings.filter(row => row.customerId.replace(/-/g, '') === id)),
    loadClinics: read('clinics', owner => state.clinics.filter(row => owner.scopeKey.startsWith('group:') ? row.grupoClinicaId === owner.groupId : row.id_clinica === owner.clinicId)),
    loadShared: read('shared', ids => state.shared.filter(row => ids.includes(row.assetId))),
    loadGrants: read('grants', () => state.grants), loadConnection: read('connection', () => state.connection) };
  return { state, mapping, binding, options, create: () => createGoogleAdsBrokerScope(options), service: createGoogleAdsBrokerScope(options) };
}
module.exports = { scopeFixture };
