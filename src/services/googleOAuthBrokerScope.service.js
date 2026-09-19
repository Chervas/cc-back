'use strict';
const { createHash } = require('node:crypto');
const { Op } = require('sequelize');
const { isGlobalAdmin, MARKETING_WRITE_ROLES } = require('../lib/role-helpers');
const { positive } = require('../../services/platform-audit/src/integration-disconnect-event');
const cohortContract = require('./googleOAuthCohort.contract');
const fail = (code = 'google_oauth_scope_conflict', httpStatus = 409) => { throw Object.assign(Error(code), { code, httpStatus }); };
const FIELDS = ['google_user_id', 'google_connection_id', 'connection_ref', 'asset_ref', 'clinica_id', 'scope_key', 'policy_version'];
function validate(binding) {
  if (!binding || typeof binding.google_user_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(binding.google_user_id)
    || binding.google_user_id === 'unknown' || !positive(String(binding.google_connection_id)) || !positive(String(binding.clinica_id))
    || typeof binding.connection_ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(binding.connection_ref)
    || typeof binding.asset_ref !== 'string' || !/^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/.test(binding.asset_ref)
    || typeof binding.scope_key !== 'string' || !/^(clinic|group):[1-9]\d{0,9}$/.test(binding.scope_key)
    || !positive(binding.scope_key.split(':')[1]) || binding.policy_version !== 'google-oauth-pinned-v1') fail();
  return binding;
}
const digest = binding => createHash('sha256').update(JSON.stringify(FIELDS.map(k => validate(binding)[k]))).digest('hex');
async function authorize({ models, binding, requestScopeKey, actorId, sessionRef, expiresAt, expectedClinicIds, transaction, sessions }) {
  if (binding?.policy_version === cohortContract.POLICY) return require('./googleOAuthCohortScope.service').authorize({
    models, binding, requestScopeKey, actorId, sessionRef, expiresAt, expectedClinicIds, transaction, sessions });
  validate(binding);
  if (!transaction || !positive(String(actorId))) fail();
  await sessions.verifyReference({ userId: Number(actorId), sessionRef, expiresAt }, { transaction });
  const options = { transaction, lock: transaction.LOCK.UPDATE, raw: true };
  const fresh = await models.GoogleOAuthBrokerBinding.findOne({ ...options, where: cohortContract.keyFor(binding) });
  if (!fresh || digest(fresh) !== digest(binding)) fail();
  // Never select token values, even to check that an approved migration removed them.
  const [connections] = await models.sequelize.query('SELECT id, googleUserId, '
    + '(accessToken IS NULL AND refreshToken IS NULL) AS credentials_external FROM GoogleConnections '
    + 'WHERE googleUserId=:subject OR id=:id FOR UPDATE',
  { replacements: { subject: binding.google_user_id, id: Number(binding.google_connection_id) }, transaction, logging: false });
  if (connections.length !== 1 || Number(connections[0].id) !== Number(binding.google_connection_id)
    || connections[0].googleUserId !== binding.google_user_id || Number(connections[0].credentials_external) !== 1) fail();
  const [type, id] = binding.scope_key.split(':');
  const clinics = await models.Clinica.findAll({ ...options, attributes: ['id_clinica'],
    where: type === 'group' ? { grupoClinicaId: Number(id) } : { id_clinica: Number(id) }, order: [['id_clinica', 'ASC']], limit: 1001 });
  const clinicIds = clinics.map(c => Number(c.id_clinica));
  if (!clinicIds.length || clinicIds.length > 1000 || !clinicIds.includes(Number(binding.clinica_id))
    || expectedClinicIds && JSON.stringify(clinicIds) !== JSON.stringify(expectedClinicIds)) fail();
  if (!isGlobalAdmin(actorId)) {
    const rows = await models.UsuarioClinica.findAll({ ...options, attributes: ['id_clinica'], where: {
      id_usuario: Number(actorId), id_clinica: { [Op.in]: clinicIds }, rol_clinica: { [Op.in]: MARKETING_WRITE_ROLES },
      [Op.or]: [{ estado_invitacion: null }, { estado_invitacion: 'aceptada' }],
    } });
    if (clinicIds.some(id => !rows.some(r => Number(r.id_clinica) === id))) fail('google_oauth_scope_forbidden', 403);
  }
  // A pinned reauthorization cannot silently affect another assignment or
  // restore a disconnected one. Multi-assignment migration needs its own cut.
  const assignments = await models.GoogleConnectionAssignment.findAll({ ...options,
    attributes: ['scopeKey', 'status', 'assignmentScope', 'clinicaId', 'grupoClinicaId'],
    where: { googleConnectionId: Number(binding.google_connection_id) }, limit: 2 });
  if (assignments.length !== 1 || assignments[0].scopeKey !== binding.scope_key
    || assignments[0].assignmentScope !== type || !['active', 'reauthorization_required'].includes(assignments[0].status)
    || Number(type === 'clinic' ? assignments[0].clinicaId : assignments[0].grupoClinicaId) !== Number(id)) fail();
  // These consumers are still legacy. Reject the cohort instead of obtaining
  // or copying their credentials through the general API.
  for (const name of ['ClinicWebAsset', 'ClinicAnalyticsProperty', 'ClinicGoogleAdsAccount']) {
    if (await models[name].findOne({ ...options, attributes: ['id'],
      where: { googleConnectionId: Number(binding.google_connection_id), isActive: true } })) fail('google_oauth_consumers_pending');
  }
  const locations = await models.ClinicBusinessLocation.findAll({ ...options, attributes: ['id', 'clinica_id', 'location_id',
    'broker_read_connection_ref', 'broker_read_asset_ref'],
  where: { google_connection_id: Number(binding.google_connection_id), is_active: true }, limit: 1001 });
  if (!locations.length || locations.length > 1000) fail();
  let controlling = false;
  for (const location of locations) {
    const match = /^(?:accounts\/[1-9]\d{0,29}\/)?(?:locations\/)?([1-9]\d{0,29})$/.exec(String(location.location_id));
    if (!match || !clinicIds.includes(Number(location.clinica_id)) || location.broker_read_connection_ref !== binding.connection_ref
      || typeof location.broker_read_asset_ref !== 'string' || location.broker_read_asset_ref.split(':')[2] !== match[1]) fail();
    const record = await models.BusinessProfileBrokerBinding.findByPk(match[1], options);
    if (!record || record.connection_ref !== binding.connection_ref || record.asset_ref !== location.broker_read_asset_ref
      || Number(record.google_connection_id) !== Number(binding.google_connection_id) || Number(record.clinica_id) !== Number(location.clinica_id)) fail();
    if (location.broker_read_asset_ref === binding.asset_ref && Number(location.clinica_id) === Number(binding.clinica_id)) {
      if (await models.BusinessProfileBrokerRevocation.findByPk(match[1], { ...options, attributes: ['external_location_id'] })) fail();
      controlling = true;
    }
  }
  if (!controlling) fail();
  return { binding: fresh, clinicIds };
}
module.exports = { authorize, digest, validate, fail, FIELDS };
