'use strict';
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const sequelize = require('sequelize'); const assert = require('node:assert/strict');
const { pack } = require('../../../../services/platform-audit/src/event');
// Executes the actual CommonJS sources with an explicit dependency boundary in
// the same realm (closed event codecs deliberately reject foreign prototypes).
function source(relative, dependencies, state) {
  const module = { exports: {} }; const filename = path.resolve(__dirname, '../../..', relative);
  const blocked = new Proxy({}, { get: (_, key) => () => { state.unexpected.push(String(key)); throw Error('UNEXPECTED_PATIENT_QA_DEPENDENCY'); } });
  const requireLocal = name => Object.hasOwn(dependencies, name) ? dependencies[name] : blocked;
  const consoleLocal = Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => state.logs.push(args)]));
  new Function('require', 'module', 'exports', 'process', 'console', fs.readFileSync(filename, 'utf8'))(
    requireLocal, module, module.exports, { env: state.env }, consoleLocal);
  return module.exports;
}
const clone = value => JSON.parse(JSON.stringify(value));
function patientFixture(options = {}) {
  const state = { rows: [], logs: [], unexpected: [], writes: 0, sessionChecks: 0, memberChecks: 0, queries: [],
    allowed: [71], sensitive: true, members: [71], revoked: false,
    env: { PLATFORM_AUDIT_PATIENT_READS_ENABLED: 'true' }, ...options };
  const patient = () => ({ id_paciente: 901, public_id: state.missingPublicId ? null : 'pac_fictitious', clinica_id: 71,
    nombre: 'FICTITIOUS_CLINICAL_NAME', alergias: 'FICTITIOUS_HEALTH', telefono_movil: '34600000000',
    clinicasVinculadas: [{ clinica_id: 71 }, { clinica_id: 72, clinica: { id_clinica: 72, nombre_clinica: 'FICTITIOUS_FOREIGN_CLINIC' } }],
    ...state.patient, toJSON() { const { toJSON, save, ...row } = this; return clone(row); },
    async save() { state.writes++; } });
  const empty = { findAll: async () => [], findOne: async () => null, count: async () => 0 };
  const models = { PacienteClinica: {}, PacienteRelacion: {}, PacienteConsentimiento: { findAll: async () => [{ id: 41, content: 'FICTITIOUS_CONSENT' }] },
    Clinica: { findOne: async () => ({ id_clinica: 71, grupoClinicaId: 9 }), findAll: async () => [{ id_clinica: 71 }, { id_clinica: 72 }] },
    CitaPaciente: empty, Usuario: empty, PatientOperationalEvent: empty, EconomicBudget: empty, EconomicBudgetSignatureRequest: empty,
    PatientNutritionReport: empty, PatientNutritionMeasurement: {},
    Paciente: { sequelize: { escape: s => "'" + s.replaceAll("'", "''") + "'" },
      findByPk: async () => { if (state.readFailure) throw Error('FICTITIOUS_SQL_SECRET'); return state.missing ? null : patient(); },
      findOne: async query => { if (state.readFailure) throw Error('FICTITIOUS_SQL_SECRET'); return query.where.public_id ? null : state.missing ? null : patient(); },
      findAndCountAll: async () => ({ count: 1, rows: [{ id_paciente: 901 }] }),
      findAll: async query => {
        state.queries.push(query);
        if (query.attributes) {
          state.memberChecks++; await state.onMembership?.(state.memberChecks);
          return state.deleted ? [] : [{ id_paciente: 901, clinica_id: state.members[0], clinicasVinculadas: state.members.map(clinica_id => ({ clinica_id })) }];
        }
        if (state.readFailure) throw Error('FICTITIOUS_SQL_SECRET');
        return state.empty ? [] : [patient()];
      } },
    sequelize: { query: async () => [], transaction: async fn => { const rows = []; await fn(rows); state.rows.push(...rows); await state.afterCommit?.(); } },
    ...options.models };
  const repository = options.repository || { health: async () => ({ pending: 0, oldestAgeSeconds: 0 }),
    append: async (event, opts = {}) => { pack(event); if (state.auditFailure) throw Error('FICTITIOUS_SQL_SECRET'); (opts.transaction || state.rows).push(event); } };
  const sessions = { bearer: header => header,
    verify: async header => { state.sessionChecks++; if (!header || state.revoked) throw Object.assign(Error('FICTITIOUS_TOKEN'), { name: 'JsonWebTokenError' });
      return { userId: 501, sessionVersion: 1, jti: '545aef07-91c3-4fbc-8ce4-75135575fd7e', exp: 1800000000 }; } };
  const audit = source('services/platformAudit.patientReads.js', {
    'node:crypto': crypto, '../../services/platform-audit/src/event': require('../../../../services/platform-audit/src/event'),
    '../../services/platform-audit/src/patient-read-contract': require('../../../../services/platform-audit/src/patient-read-contract'),
    './platformAudit.repository': { createRepository: () => repository }, '../../models': models, './accessSession.service': sessions,
  }, state);
  const permissions = {
    canUserAccessFeature: async ({ clinicId }) => state.sensitive && state.allowed.includes(clinicId),
    getAccessibleClinicIdsForFeature: async ({ featureKey, clinicIds }) => {
      if (featureKey === 'patients.sensitive.view' && !state.sensitive) return [];
      return (clinicIds || state.allowed).filter(id => state.allowed.includes(id));
    },
    assertUserCanAccessFeature: async ({ clinicId }) => { if (!state.allowed.includes(clinicId)) throw Object.assign(Error('access_policy_forbidden'), { status: 403 }); },
  };
  const controller = source('controllers/paciente.controller.js', { '../../models': models, sequelize, crypto,
    '../services/platformAudit.patientReads': audit, '../lib/phone': require('../../../lib/phone'), '../lib/access-policy': permissions,
    '../services/patientContact.service': { PATIENT_EVENT_TYPES: { created: 'created' }, findPatientContactTargets: async () => {
      if (state.readFailure) throw Error('FICTITIOUS_SQL_SECRET');
      return { query: 'FICTITIOUS_SEARCH', query_type: 'name', normalized_phone: null, items: [{ patient: patient().toJSON(), conversation_id: 81 }] };
    } },
    '../services/appointmentActivity.service': { APPOINTMENT_STATUS_EVENT_TYPE: 'status' },
    '../services/marketingOptOut.service': { getActiveContactRestrictionsForPatient: async () => [] },
  }, state);
  const auth = source('routes/auth.middleware.js', { '../services/accessSession.service': sessions }, state);
  const router = source('routes/paciente.routes.js', { express: require('express'), '../controllers/paciente.controller': controller, './auth.middleware': auth }, state);
  const req = () => ({ userData: { userId: 501 }, authSession: { id: '545aef07-91c3-4fbc-8ce4-75135575fd7e' }, headers: { authorization: 'FICTITIOUS_TOKEN' },
    params: { id: '901' }, query: { clinica_id: '71' } });
  const invoke = async (name, changes = {}) => {
    const request = { ...req(), ...changes }; let status = 200; let response;
    const res = { set: () => res, status: n => { status = n; return res; }, json: body => { response = { status, body: clone(body) }; return res; } };
    await controller[name](request, res); assert.deepEqual(state.unexpected, []); return response;
  };
  return { state, controller, router, invoke, audit, models, patient };
}
module.exports = { patientFixture };
