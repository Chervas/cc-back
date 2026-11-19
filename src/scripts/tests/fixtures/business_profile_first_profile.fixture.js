'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Op } = require('sequelize');
const { createFirstProfileService } = require('../../../services/businessProfileFirstProfile.service');
const { createClient } = require('../../../services/businessProfileAssociationClient.service');
const clone = value => structuredClone(value);
function matches(row, where = {}) {
  return Reflect.ownKeys(where).every(key => key === Op.or ? where[key].some(item => matches(row, item))
    : key === Op.and ? where[key].every(item => matches(row, item))
      : where[key] && typeof where[key] === 'object' && !Array.isArray(where[key])
        ? Reflect.ownKeys(where[key]).every(op => op === Op.in ? where[key][op].includes(row[key])
          : op === Op.like ? new RegExp('^' + where[key][op].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$').test(row[key]) : false)
        : row[key] === where[key]);
}
function fixture({ transport } = {}) {
  const clock = { at: Date.now() }, input = { clinicId: 123, scopeKey: 'clinic:123', connectionId: 81,
    actorId: 9, sessionRef: randomUUID(), sessionExpiresAt: clock.at + 3600000 };
  const state = {
    Clinica: [{ id_clinica: 123, grupoClinicaId: 9 }],
    GrupoClinica: [{ id_grupo: 9, business_profile_assignment_mode: 'clinic', business_profile_primary_location_id: null }],
    GoogleConnection: [{ id: 81, googleUserId: '113861427645841982815', credentials_external: 1 }],
    GoogleOAuthBrokerBinding: [{ google_user_id: '113861427645841982815', cohort: 'business_profile', google_connection_id: 81,
      connection_ref: 'connection:test', asset_ref: 'gbp:100:200', clinica_id: 999, scope_key: 'connection:81',
      policy_version: 'google-oauth-cohorts-v1', confirmed_at: new Date(clock.at - 1000) }],
    GoogleConnectionAssignment: [{ scopeKey: 'group:9', assignmentScope: 'group', clinicaId: null, grupoClinicaId: 9, googleConnectionId: 81, status: 'active' }],
    UsuarioClinica: [{ id_usuario: 9, id_clinica: 123, rol_clinica: 'propietario', estado_invitacion: 'aceptada' }],
    BusinessProfileAssociationScope: [], GroupAssetClinicAssignment: [], ClinicBusinessLocation: [],
    BusinessProfileBrokerBinding: [], BusinessProfileBrokerBindingGeneration: [], BusinessProfileBrokerRevocation: [], BusinessProfileAssociationRequest: [],
  };
  const calls = [], commands = [], models = {}, control = { enabled: true, session: true, after: null, reply: null };
  for (const name of Object.keys(state)) {
    const project = (row, options) => options.attributes ? Object.fromEntries(options.attributes.map(key => [key, row[key] ?? null])) : clone(row);
    const read = (method, options, id) => {
      assert(options.transaction); assert.equal(options.logging, false); calls.push({ name, method, options, id });
      return state[name].filter(row => matches(row, options.where)).slice(0, options.limit || Infinity).map(row => project(row, options));
    };
    models[name] = {
      async findAll(options = {}) { return read('findAll', options); },
      async findOne(options = {}) { return read('findOne', { ...options, limit: 1 })[0] || null; },
      async findByPk(id, options = {}) {
        const key = name === 'Clinica' ? 'id_clinica' : name === 'GrupoClinica' ? 'id_grupo' : name === 'BusinessProfileAssociationScope' ? 'scope_key' : 'id';
        return read('findByPk', { ...options, where: { [key]: id }, limit: 1 }, id)[0] || null;
      },
      create() { assert.fail('no business writes'); }, update() { assert.fail('no business writes'); }, destroy() { assert.fail('no business writes'); },
    };
  }
  models.sequelize = {
    async transaction(work) { return work({ LOCK: { UPDATE: 'UPDATE' }, finished: false }); },
    async query(sql, options) {
      assert.match(sql, /^SELECT id, googleUserId, \(accessToken IS NULL AND refreshToken IS NULL\) AS credentials_external /);
      assert.equal(options.logging, false); assert(options.transaction); calls.push({ name: 'connectionCustody', sql, options });
      return [clone(state.GoogleConnection.filter(row => row.id === options.replacements.id || row.googleUserId === options.replacements.subject))];
    },
  };
  const row = id => ({ accountId: '100', accountName: 'accounts/100', accountDisplayName: 'FICTITIOUS_ACCOUNT',
    locationId: id, name: 'locations/' + id, title: 'FICTITIOUS_PROFILE_' + id,
    storefrontAddress: { addressLines: ['FICTITIOUS_ADDRESS'] }, metadata: { hasVoiceOfMerchant: true } });
  const client = createClient({ client: { async execute(command, options) {
    commands.push(clone(command)); let result;
    if (transport) result = await transport.execute(command, options);
    else result = { requestId: command.requestId, replayed: false, data: { locations: [row('300')], nextPageToken: null } };
    if (control.reply) result = await control.reply(result, command);
    await control.after?.(command); return result;
  } }, controlClient: { execute() { assert.fail('no control command'); } } });
  const sessions = { async verifyReference(value, options) {
    assert(options.transaction);
    if (!control.session || value.userId !== input.actorId || value.sessionRef !== input.sessionRef || +value.expiresAt !== input.sessionExpiresAt) throw Object.assign(Error('auth_invalid'), { code: 'auth_invalid' });
    return true;
  } };
  const service = createFirstProfileService({ models, sessions, client, enabled: () => control.enabled, now: () => clock.at });
  return { state, input, clock, control, calls, commands, models, client, service, row };
}
module.exports = { fixture };
