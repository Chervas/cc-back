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
          : op === Op.notIn ? !where[key][op].includes(row[key])
            : op === Op.like ? new RegExp('^' + where[key][op].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$').test(row[key]) : false)
        : row[key] === where[key]);
}
function fixture({ transport, writable = false } = {}) {
  const clock = { at: Date.now() }, input = { clinicId: 123, scopeKey: 'clinic:123', connectionId: 81,
    actorId: 9, sessionRef: randomUUID(), sessionExpiresAt: clock.at + 3600000 };
  const state = {
    Clinica: [{ id_clinica: 123, grupoClinicaId: 9, nombre_clinica: 'FICTITIOUS_CLINIC' }],
    GrupoClinica: [{ id_grupo: 9, business_profile_assignment_mode: 'clinic', business_profile_primary_location_id: null }],
    GoogleConnection: [{ id: 81, googleUserId: '113861427645841982815', credentials_external: 1 }],
    GoogleOAuthBrokerBinding: [{ google_user_id: '113861427645841982815', cohort: 'business_profile', google_connection_id: 81,
      connection_ref: 'connection:test', asset_ref: 'gbp:100:200', clinica_id: 999, scope_key: 'connection:81',
      policy_version: 'google-oauth-cohorts-v1', confirmed_at: new Date(clock.at - 1000) }],
    GoogleConnectionAssignment: [{ scopeKey: 'group:9', assignmentScope: 'group', clinicaId: null, grupoClinicaId: 9, googleConnectionId: 81, status: 'active' }],
    UsuarioClinica: [{ id_usuario: 9, id_clinica: 123, rol_clinica: 'propietario', estado_invitacion: 'aceptada' }],
    BusinessProfileAssociationScope: [], GroupAssetClinicAssignment: [], ClinicBusinessLocation: [],
    BusinessProfileBrokerBinding: [], BusinessProfileBrokerBindingGeneration: [], BusinessProfileBrokerRevocation: [], BusinessProfileAssociationRequest: [],
    MarketingPatientList: [],
  };
  const calls = [], commands = [], models = {}, writes = [], control = { enabled: true, session: true, after: null, reply: null, failCreate: null, failAudit: false };
  const keyFor = name => name === 'Clinica' ? 'id_clinica' : name === 'GrupoClinica' ? 'id_grupo'
    : name === 'BusinessProfileAssociationScope' ? 'scope_key' : name === 'BusinessProfileAssociationRequest' ? 'attempt_id'
      : name === 'BusinessProfileBrokerBinding' || name === 'BusinessProfileBrokerRevocation' ? 'external_location_id'
        : name === 'BusinessProfileBrokerBindingGeneration' ? 'generation_id' : 'id';
  for (const name of Object.keys(state)) {
    const instance = row => ({ ...clone(row), get: () => clone(row), async update(patch, options) {
      assert(writable, 'no business writes'); assert(options.transaction); Object.assign(row, clone(patch)); Object.assign(this, clone(row));
      writes.push({ name, operation: 'update', transaction: options.transaction }); return this;
    } });
    const project = (row, options) => options.raw ? options.attributes ? Object.fromEntries(options.attributes.map(key => [key, row[key] ?? null])) : clone(row) : instance(row);
    const read = (method, options, id) => {
      assert(options.transaction); assert.equal(options.logging, false); calls.push({ name, method, options, id });
      return state[name].filter(row => matches(row, options.where)).slice(0, options.limit || Infinity).map(row => project(row, options));
    };
    models[name] = {
      async findAll(options = {}) { return read('findAll', options); },
      async findOne(options = {}) { return read('findOne', { ...options, limit: 1 })[0] || null; },
      async findByPk(id, options = {}) {
        const key = keyFor(name);
        return read('findByPk', { ...options, where: { [key]: id }, limit: 1 }, id)[0] || null;
      },
      async create(value, options) {
        assert(writable, 'no business writes'); assert(options.transaction); assert.equal(options.logging, false);
        if (control.failCreate === name) throw Error('FICTITIOUS_INSERT_FAILURE');
        const row = clone(value), key = keyFor(name); if (row[key] == null) row[key] = Math.max(0, ...state[name].map(item => Number(item[key]) || 0)) + 1;
        assert(!state[name].some(item => item[key] === row[key]), 'duplicate fixture key'); state[name].push(row);
        writes.push({ name, operation: 'create', transaction: options.transaction }); return instance(row);
      },
      async update(patch, options) {
        assert(writable, 'no business writes'); assert(options.transaction); let changed = 0;
        for (const row of state[name]) if (matches(row, options.where)) { Object.assign(row, clone(patch)); changed++; }
        writes.push({ name, operation: 'update', transaction: options.transaction }); return [changed];
      }, destroy() { assert.fail('no business deletes'); },
    };
  }
  models.sequelize = {
    async transaction(work) {
      const before = clone(state), tx = { LOCK: { UPDATE: 'UPDATE' }, finished: false };
      try { const result = await work(tx); tx.finished = 'commit'; return result; }
      catch (error) { for (const key of Object.keys(state)) state[key] = before[key]; tx.finished = 'rollback'; throw error; }
    },
    async query(sql, options) {
      assert.match(sql, /^SELECT id, googleUserId, \(accessToken IS NULL AND refreshToken IS NULL\) AS credentials_external /);
      assert.equal(options.logging, false); assert(options.transaction); calls.push({ name: 'connectionCustody', sql, options });
      return [clone(state.GoogleConnection.filter(row => row.id === options.replacements.id || row.googleUserId === options.replacements.subject))];
    },
  };
  const row = id => ({ accountId: '100', accountName: 'accounts/100', accountDisplayName: 'FICTITIOUS_ACCOUNT',
    locationId: id, name: 'locations/' + id, title: 'FICTITIOUS_PROFILE_' + id,
    storefrontAddress: { addressLines: ['FICTITIOUS_ADDRESS'] }, metadata: { hasVoiceOfMerchant: true } });
  const adapter = { async execute(command, options) {
    commands.push(clone(command)); let result;
    if (transport) result = await transport.execute(command, options);
    else result = { requestId: command.requestId, replayed: false, data: { locations: [row('300')], nextPageToken: null } };
    if (control.reply) result = await control.reply(result, command);
    await control.after?.(command); return result;
  } };
  const client = createClient({ client: adapter, controlClient: writable ? adapter : { execute() { assert.fail('no control command'); } } });
  const sessions = { async verifyReference(value, options) {
    assert(options.transaction);
    if (!control.session || value.userId !== input.actorId || value.sessionRef !== input.sessionRef || +value.expiresAt !== input.sessionExpiresAt) throw Object.assign(Error('auth_invalid'), { code: 'auth_invalid' });
    return true;
  } };
  const audit = { async health() { return { pending: 0, oldestAgeSeconds: 0 }; }, async append(event, options) {
    assert(writable, 'no business audit writes'); assert(options.transaction);
    if (control.failAudit) throw Object.assign(Error('audit_unavailable'), { code: 'audit_unavailable' });
    writes.push({ name: 'PlatformAuditEvent', operation: 'append', event, transaction: options.transaction });
  } };
  const service = createFirstProfileService({ models, sessions, client, audit, enabled: () => control.enabled, now: () => clock.at });
  const ordinary = require('../../../services/businessProfileAssociation.service').createAssociationService({ models, sessions, client, audit,
    enabled: () => true, now: () => new Date(clock.at) });
  return { state, input, clock, control, calls, commands, writes, models, client, sessions, audit, service, ordinary, row };
}
module.exports = { fixture };
