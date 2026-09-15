'use strict';
// Local display metadata only. Never fetch the full JSON document, credentials,
// provider clients or operational sender configuration to render a receipt.
const { fn, col, literal } = require('sequelize');
const { createHash } = require('node:crypto');
const ROOT_ATTRIBUTES = Object.freeze(['id', 'assetType', 'phoneNumberId', 'wabaId',
  'assignmentScope', 'clinicaId', 'grupoClinicaId', 'metaAssetName', 'waVerifiedName',
  'quality_rating', 'messaging_limit', 'meta_billed_by', 'createdAt', 'updatedAt']);
const JSON_FIELDS = Object.freeze({
  name_status: 'nameStatus',
  requested_display_name: 'requestedDisplayName', new_display_name: 'newDisplayName',
  new_name_status: 'newNameStatus', display_name_requested_at: 'requestedDisplayNameAt',
  profile_picture_url: 'profilePictureUrl', profile_description: 'profileDescription',
  profile_category: 'profileCategory', profile_email: 'profileEmail',
  profile_website: 'profileWebsite', profile_address: 'profileAddress',
  registration_status: 'registration.status', registration_requires_pin: 'registration.requiresPin',
  registration_phone_status: 'registration.phoneStatus',
  registration_code_verification_status: 'registration.codeVerificationStatus',
  registration_blocked_until: 'registration.blockedUntil',
  platform_type: 'platformType', is_on_biz_app: 'isOnBizApp',
  connection_mode: 'whatsappConnectionMode', legacy_connection_mode: 'connectionMode',
  coexistence_status: 'coexistence.status', coexistence_can_send_api: 'coexistence.canSendApi',
  coexistence_initial_sync_status: 'coexistence.initial_sync_status',
  coexistence_contacts_sync_status: 'coexistence.contacts_sync_status',
  coexistence_contacts_sync_last_at: 'coexistence.contacts_sync_last_at',
  coexistence_history_sync_status: 'coexistence.history_sync_status',
  coexistence_history_sync_last_at: 'coexistence.history_sync_last_at',
  channel_role: 'whatsapp_channel_role', legacy_channel_role: 'whatsappChannelRole',
  routing_role: 'routing.whatsapp_channel_role', legacy_routing_role: 'routing.role',
  routing_purposes: 'routing.secondary_purposes', legacy_routing_purposes: 'routing.purposes',
  secondary_unavailable_action: 'routing.secondary_unavailable_action',
  health_state: 'whatsappHealth.state', health_can_send: 'whatsappHealth.can_send',
  health_reason_code: 'whatsappHealth.reason_code', health_provider_status: 'whatsappHealth.provider_status',
  health_observed_at: 'whatsappHealth.observed_at',
  compliance_incident_id: 'whatsappCompliance.incident_id',
  compliance_status: 'whatsappCompliance.status', compliance_violation_label: 'whatsappCompliance.violation_label',
  compliance_review_status: 'whatsappCompliance.review_status',
  compliance_appealable: 'whatsappCompliance.appealable', compliance_occurred_at: 'whatsappCompliance.occurred_at',
  business_verification_status: 'whatsappBusinessHealth.business_verification_status',
  legacy_business_verification_status: 'businessVerificationStatus',
  username: 'businessUsername.username', username_status: 'businessUsername.status',
  username_received_at: 'businessUsername.received_at',
  is_test_number: 'isTestNumber', account_mode: 'accountMode', is_preverified: 'isPreverified',
  verification_expiry_time: 'verificationExpiryTime',
});
const positive = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const providerId = value => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
const fail = () => { throw Object.assign(Error('whatsapp_authorization_metadata_unavailable'), { code: 'whatsapp_authorization_metadata_unavailable' }); };
function attributes() {
  return [...ROOT_ATTRIBUTES, ...Object.entries(JSON_FIELDS).map(([alias, leaf]) => {
    // Sequelize 6 doubles dollar signs in string fn arguments, producing an
    // invalid MySQL JSON path ($$.leaf). Only these static allowlisted leaves
    // become SQL literals; no request or stored value can enter this expression.
    if (!/^[A-Za-z_]+(?:\.[A-Za-z_]+)*$/.test(leaf)) fail();
    return [fn('JSON_EXTRACT', col('additionalData'), literal("'$." + leaf + "'")), 'wa_local_' + alias];
  })];
}
function value(row, field) {
  const raw = row['wa_local_' + field];
  // mysql2 can return a decoded JSON scalar or its JSON representation.
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}
function text(raw, max = 2000) {
  return typeof raw === 'string' && raw.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)
    ? raw : null;
}
const boolean = raw => typeof raw === 'boolean' ? raw : null;
function timestamp(raw) {
  if (!(raw instanceof Date) && typeof raw !== 'string' && typeof raw !== 'number') return null;
  const date = new Date(raw); return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.toISOString() : null;
}
function url(raw) {
  const candidate = text(raw, 2048); if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const sensitive = key => /(?:token|secret|signature|credential|password|authorization|appsecret_proof|api[_-]?key|key[_-]?pair[_-]?id)/i.test(key)
      || ['sig', 'policy', 'oh'].includes(key.toLowerCase());
    if ([...parsed.searchParams.keys()].some(sensitive)) return null;
    // Public anchors are retained; OAuth/signed values hidden in a fragment are not.
    const fragment = decodeURIComponent(parsed.hash.slice(1));
    if ([...new URLSearchParams(fragment).keys()].some(sensitive)
      || /(?:^|[?&#])[^=]*(?:token|secret|signature|credential|password|authorization)[^=]*=/i.test(fragment)) return null;
    return candidate;
  }
  catch { return null; }
}
function role(raw) { return ['primary', 'secondary'].includes(raw) ? raw : null; }
function project(row, authorization, now, { clinic = null, group = null, routing = null } = {}) {
  const v = field => value(row, field);
  const storedRole = role(v('channel_role')) || role(v('legacy_channel_role')) || role(v('routing_role')) || role(v('legacy_routing_role'));
  const channelRole = role(routing?.role) || storedRole || role(authorization.channelRole) || 'primary';
  const purposes = routing?.purposes ?? v('routing_purposes') ?? v('legacy_routing_purposes');
  const observed = timestamp(v('health_observed_at'));
  const healthState = text(v('health_state'), 64);
  const complianceStatus = text(v('compliance_status'), 64);
  const result = {
    id: row.id, phoneNumberId: row.phoneNumberId, wabaId: row.wabaId,
    phoneNumber: text(row.metaAssetName, 255), waVerifiedName: text(row.waVerifiedName, 255),
    quality_rating: text(row.quality_rating, 64), messaging_limit: text(row.messaging_limit, 64),
    assignmentScope: row.assignmentScope, clinic_id: row.clinicaId ?? null, group_id: group?.id_grupo ?? row.grupoClinicaId ?? null,
    clinic_name: text(clinic?.nombre_clinica, 255), clinic_avatar: url(clinic?.url_avatar), group_name: text(group?.nombre_grupo, 255),
    whatsapp_channel_role: channelRole, base_whatsapp_channel_role: role(routing?.role) || storedRole,
    routing_purposes: channelRole === 'secondary' && Array.isArray(purposes)
      ? [...new Set(purposes.filter(p => ['bulk_campaigns', 'review_requests', 'lead_first_contact'].includes(p)))].slice(0, 3) : [],
    secondary_unavailable_action: (routing?.unavailable_action ?? v('secondary_unavailable_action')) === 'fallback_primary' ? 'fallback_primary' : 'pause',
    routing_binding: routing ? { id: routing.id, clinic_id: routing.clinic_id, role: routing.role } : null,
    metadata_source: 'local', metadata_observed_at: timestamp(row.updatedAt), sending_enabled: false,
    createdAt: timestamp(row.createdAt),
    health: healthState ? { state: healthState, can_send: boolean(v('health_can_send')),
      reason_code: text(v('health_reason_code'), 128), provider_status: text(v('health_provider_status'), 64),
      observed_at: observed, is_stale: !observed || now.getTime() - Date.parse(observed) > 1800000 } : null,
    compliance: complianceStatus ? { incident_id: positive(v('compliance_incident_id')) ? v('compliance_incident_id') : null,
      status: complianceStatus, violation_label: text(v('compliance_violation_label'), 500),
      review_status: text(v('compliance_review_status'), 64), appealable: boolean(v('compliance_appealable')),
      occurred_at: timestamp(v('compliance_occurred_at')) } : null,
    business_username: text(v('username'), 255) ? { username: text(v('username'), 255),
      status: text(v('username_status'), 64), received_at: timestamp(v('username_received_at')) } : null,
    meta_billed_by: boolean(row.meta_billed_by),
  };
  for (const field of ['name_status', 'requested_display_name', 'new_display_name', 'new_name_status',
    'profile_description', 'profile_category', 'profile_email', 'profile_address', 'registration_status',
    'registration_phone_status', 'registration_code_verification_status',
    'platform_type', 'coexistence_status', 'coexistence_initial_sync_status', 'coexistence_contacts_sync_status',
    'coexistence_history_sync_status', 'account_mode']) result[field] = text(v(field));
  for (const field of ['display_name_requested_at', 'registration_blocked_until', 'coexistence_contacts_sync_last_at',
    'coexistence_history_sync_last_at', 'verification_expiry_time']) result[field] = timestamp(v(field));
  for (const field of ['registration_requires_pin', 'is_on_biz_app', 'coexistence_can_send_api', 'is_test_number', 'is_preverified']) result[field] = boolean(v(field));
  result.profile_picture_url = url(v('profile_picture_url')); result.profile_website = url(v('profile_website'));
  result.connection_mode = text(v('connection_mode') ?? v('legacy_connection_mode'), 64);
  result.business_verification_status = text(v('business_verification_status') ?? v('legacy_business_verification_status'), 64);
  return result;
}
async function read({ models, authorization, now = new Date() }) {
  if (authorization.authorizationStatus !== 'awaiting_activation') return { phone: null, digest: null };
  const scope = authorization.scope, selected = authorization.selected;
  if (!scope || !['clinic', 'group'].includes(scope.type) || !positive(scope.id)
    || !selected || !providerId(selected.phoneId) || !providerId(selected.wabaId)) fail();
  const where = { assetType: 'whatsapp_phone_number', phoneNumberId: selected.phoneId, wabaId: selected.wabaId,
    assignmentScope: scope.type, ...(scope.type === 'clinic' ? { clinicaId: scope.id } : { grupoClinicaId: scope.id }) };
  const rows = await models.ClinicMetaAsset.findAll({ where, attributes: attributes(), limit: 2, order: [['id', 'ASC']], raw: true });
  if (!Array.isArray(rows) || rows.length > 1) fail();
  if (!rows.length) return { phone: null, digest: null };
  const row = rows[0];
  if (!positive(row.id) || Object.entries(where).some(([key, expected]) => row[key] !== expected)
    || !(row.clinicaId == null || positive(row.clinicaId)) || !(row.grupoClinicaId == null || positive(row.grupoClinicaId))) fail();
  let clinic = null, group = null, routing = null;
  if (scope.type === 'clinic') {
    const clinics = await models.Clinica.findAll({ where: { id_clinica: scope.id },
      attributes: ['id_clinica', 'nombre_clinica', 'url_avatar', 'grupoClinicaId'], limit: 1, raw: true });
    if (clinics.length !== 1 || clinics[0].id_clinica !== scope.id) fail();
    clinic = clinics[0];
    const bindings = await models.WhatsappChannelBinding.findAll({ where: { clinic_id: scope.id, asset_id: row.id, is_active: true },
      attributes: ['id', 'clinic_id', 'asset_id', 'role', 'purposes', 'unavailable_action'], limit: 2, raw: true });
    if (!Array.isArray(bindings) || bindings.length > 1) fail();
    if (bindings.length) {
      routing = bindings[0];
      if (!positive(routing.id) || routing.clinic_id !== scope.id || routing.asset_id !== row.id || !role(routing.role)) fail();
    }
  }
  const groupId = scope.type === 'group' ? scope.id : clinic?.grupoClinicaId;
  if (groupId != null) {
    if (!positive(groupId)) fail();
    const groups = await models.GrupoClinica.findAll({ where: { id_grupo: groupId }, attributes: ['id_grupo', 'nombre_grupo'], limit: 1, raw: true });
    if (groups.length !== 1 || groups[0].id_grupo !== groupId) fail();
    group = groups[0];
  }
  const phone = project(row, authorization, now, { clinic, group, routing });
  return { phone, digest: createHash('sha256').update(JSON.stringify(phone)).digest('hex') };
}
module.exports = { attributes, read, project };
