'use strict';

// The permit only admits a new, exact first enrollment. The durable certificate
// is purpose-specific Marketing authority; it is not Recovery/Business proof,
// never removes tombstones, and supplies no WhatsApp or generic connection grant.
const C = require('./metaMarketingEnrollment.contract');
const Admission = require('../../services/integrations-broker/src/meta-marketing-admission-contract');
const M = require('../../services/integrations-broker/src/meta-marketing-contract');

const SETTING = 'META_MARKETING_FIRST_ENROLLMENT_COEXISTENCE';
const DOMAIN = 'clinicaclick-meta-marketing-first-enrollment-authority/1';
const CONFIG_KEYS = 'clinicId,legacyGrantId,legacyConnectionId,canonicalConnectionId,appId,adAccountId,pageId';
const CERTIFICATE_FIELDS = Object.freeze(['flow_id', 'flow_digest', 'candidate_digest', 'scope_key', 'clinic_ids',
  'connection_ref', 'scope_digest', 'app_id', 'meta_user_id', 'meta_connection_id', 'assets', 'actor_user_id']);
const invalid = () => C.fail('meta_enrollment_assignment_review', 409);

function setting(env) {
  const text = env?.[SETTING];
  if (text === undefined || text === '') return null;
  if (typeof text !== 'string' || text.length > 2048) invalid();
  let value;
  try { value = JSON.parse(text); } catch { invalid(); }
  // Even a malformed advertised permit must close its clinic instead of
  // falling through to the old generic-grant writer.
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || !C.positive(value.clinicId)) invalid();
  return value;
}

function configuredFor(flow, env = process.env) {
  const config = setting(env);
  return !!config && flow?.scope_key === 'clinic:' + config.clinicId;
}

function permitFor({ flow, clinics, grants, connectionId } = {}, env = process.env) {
  const config = setting(env);
  if (!config || !configuredFor(flow, env)) return null;
  if (!C.exact(config, CONFIG_KEYS)
    || !['legacyGrantId', 'legacyConnectionId', 'canonicalConnectionId'].every(key => C.positive(config[key]))
    || config.legacyConnectionId === config.canonicalConnectionId
    || !['appId', 'adAccountId', 'pageId'].every(key => M.graphId(config[key]))
    || flow.connection_ref !== Admission.connectionRef(flow.scope_key)
    || flow.asset_ref !== 'meta-enroll:' + flow.scope_key || flow.app_id !== config.appId
    || flow.clinic_ids !== JSON.stringify([config.clinicId])
    || Number(connectionId) !== config.canonicalConnectionId
    || !Array.isArray(clinics) || clinics.length !== 1
    || Number(clinics[0]?.id_clinica) !== config.clinicId || clinics[0].grupoClinicaId !== null
    || !Array.isArray(grants) || grants.length !== 1) return null;
  const grant = grants[0];
  if (Number(grant?.id) !== config.legacyGrantId || grant.scopeKey !== flow.scope_key
    || grant.assignmentScope !== 'clinic' || Number(grant.clinicaId) !== config.clinicId
    || grant.grupoClinicaId !== null || Number(grant.metaConnectionId) !== config.legacyConnectionId
    || grant.status !== 'active') return null;
  return Object.freeze({ clinicId: config.clinicId, legacyConnectionId: config.legacyConnectionId,
    assetRefs: Object.freeze(['meta-ad_account:' + config.adAccountId, 'meta-facebook_page:' + config.pageId].sort()) });
}

function assetRefs(assets) {
  if (!Array.isArray(assets) || assets.length !== 2) return null;
  const refs = assets.map(value => typeof value === 'string' ? value : value?.assetRef);
  if (refs.some(value => typeof value !== 'string') || new Set(refs).size !== 2
    || refs.filter(value => /^meta-ad_account:[1-9][0-9]{0,29}$/.test(value)).length !== 1
    || refs.filter(value => /^meta-facebook_page:[1-9][0-9]{0,29}$/.test(value)).length !== 1) return null;
  return refs.sort();
}

function eligibleAssets(permit, assets) {
  const expected = assetRefs(permit?.assetRefs), selected = assetRefs(assets);
  return !!expected && !!selected && JSON.stringify(expected) === JSON.stringify(selected);
}

function certificate(row) {
  if (!row || !C.UUID.test(row.flow_id) || !['flow_digest', 'candidate_digest', 'scope_digest'].every(key => C.HASH.test(row[key]))
    || !M.graphId(row.app_id) || !M.graphId(row.meta_user_id)
    || !C.positive(Number(row.meta_connection_id)) || !C.positive(Number(row.actor_user_id))) invalid();
  const clinics = C.clinics(row.clinic_ids);
  if (clinics.length !== 1 || row.scope_key !== 'clinic:' + clinics[0]
    || row.connection_ref !== Admission.connectionRef(row.scope_key)) invalid();
  let selected;
  try { selected = C.assets(JSON.parse(row.assets)); } catch { invalid(); }
  if (JSON.stringify(selected) !== row.assets || !assetRefs(selected)) invalid();
  const values = CERTIFICATE_FIELDS.map(key => ['meta_connection_id', 'actor_user_id'].includes(key) ? Number(row[key]) : row[key]);
  return C.hash(JSON.stringify([DOMAIN, ...values]));
}

function isCertified(row) {
  if (!C.HASH.test(row?.assignment_digest)) return false;
  try { return row.assignment_digest === certificate(row); } catch { return false; }
}

async function legacyScopeIntact({ models, flow, permit, options } = {}) {
  if (!permit || !C.positive(permit.clinicId) || !C.positive(permit.legacyConnectionId)
    || flow?.scope_key !== 'clinic:' + permit.clinicId || !eligibleAssets(permit, permit.assetRefs)) return false;
  if (!models?.ClinicMetaAsset?.findAll || !models?.MetaMarketingBrokerBinding?.findOne
    || !options?.transaction || options.transaction.finished
    || Object.keys(options).some(key => !['transaction', 'lock', 'logging', 'raw'].includes(key))) C.fail('meta_enrollment_unavailable', 503);
  const rows = await models.ClinicMetaAsset.findAll({ ...options, raw: true, logging: false,
    attributes: ['id', 'metaConnectionId', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'assetType', 'isActive'],
    where: { clinicaId: permit.clinicId }, order: [['id', 'ASC']], limit: 1001 });
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000
    || rows.some(row => !C.positive(Number(row.id)) || row.assignmentScope !== 'clinic'
      || Number(row.clinicaId) !== permit.clinicId || row.grupoClinicaId !== null
      || Number(row.metaConnectionId) !== permit.legacyConnectionId
      || !['whatsapp_business_account', 'whatsapp_phone_number'].includes(row.assetType)
      || ![true, false, 0, 1].includes(row.isActive))
    || !rows.some(row => row.assetType === 'whatsapp_phone_number' && [true, 1].includes(row.isActive))) return false;
  // Own pending Enrollment/Claims already exist during assertPending. Do not
  // reject them here. The ordinary physical guard validates every selected
  // claim; only an independently existing Marketing binding closes this scope.
  return !await models.MetaMarketingBrokerBinding.findOne({ ...options, raw: true, logging: false,
    attributes: ['mapping_id'], where: { scope_key: flow.scope_key }, limit: 1 });
}

module.exports = { configuredFor, permitFor, eligibleAssets, certificate, isCertified, legacyScopeIntact,
  SETTING, DOMAIN, CERTIFICATE_FIELDS };
