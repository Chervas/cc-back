'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire, Module } = require('node:module');
const test = require('node:test');
const Sequelize = require('sequelize');

const controllerPath = require.resolve('../../controllers/intake.controller');
const readModule = createRequire(controllerPath);
const createdAt = '2026-11-23T14:53:50.000Z';
const contactedAt = '2026-11-23T15:06:17.000Z';

function fixture({ history = [], attempts = [], audits = [] } = {}) {
  let readCount = 0;
  const models = {
    Sequelize,
    LeadIntake: { findByPk: async () => ({ id: 7, clinica_id: 8, created_at: createdAt,
      historial_contactos: history, formSubmissionEvents: [] }) },
    FormSubmissionEvent: {},
    LeadContactAttempt: { findAll: async ({ where }) => {
      assert.equal(where.lead_intake_id, 7);
      readCount++;
      return attempts;
    } },
    LeadAttributionAudit: { findAll: async ({ where }) => {
      assert.equal(where.lead_intake_id, 7);
      readCount++;
      return audits;
    } },
    Conversation: { findAll: async () => [] },
    CitaPaciente: { findAll: async () => [] },
    Usuario: { findAll: async () => [{ id_usuario: 44, nombre: 'Ana', apellidos: 'Ejemplo', email_usuario: 'staff@example.test' }] },
  };
  const dependencies = {
    '../../models': models,
    'express-async-handler': readModule('express-async-handler'),
    '../lib/intakeLocations': readModule('../lib/intakeLocations'),
    '../lib/lead-attribution-view': readModule('../lib/lead-attribution-view'),
    '../lib/role-helpers': readModule('../lib/role-helpers'),
    '../lib/marketingScopeAccess': { getAccessibleMarketingClinicIds: async () => [] },
    '../lib/access-policy': { getAccessibleClinicIdsForFeature: async () => [] },
    '../services/leadContactSummary.service': readModule('../services/leadContactSummary.service'),
    '../services/metaLeadWebhook.service': { createMetaLeadWebhookHandlers: () => ({}) },
  };
  const controller = new Module(controllerPath, module);
  controller.require = name => dependencies[name] || {};
  controller._compile(fs.readFileSync(controllerPath, 'utf8'), controllerPath);

  return async (userId = 1) => {
    const result = { status: null, body: null };
    await controller.exports.getLeadActivity({ params: { id: '7' }, userData: { userId } }, {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    }, error => { throw error; });
    return { ...result, readCount };
  };
}

const attempt = { id: 1776, created_at: contactedAt, usuario_id: 44, canal: 'llamada', motivo: 'no_contesta' };

test('activity recovers the recorded call when the legacy history is empty', async () => {
  const { status, body } = await fixture({ attempts: [attempt] })();
  assert.equal(status, 200);
  const [call] = body.filter(item => item.tipo === 'lead_contact_attempt');
  assert.equal(call.titulo, 'Llamada');
  assert.equal(call.descripcion, 'No contesta');
  assert.equal(call.fecha, contactedAt);
  assert.equal(call.usuarioNombre, 'Ana Ejemplo');
});

test('activity keeps one entry for mirrored attempts, includes the note, and preserves old contacts and note edits', async () => {
  const history = [
    { fecha: '2026-11-23T15:06:17.433Z', usuario_id: 44, canal: 'llamada', motivo: 'no_contesta', notas: 'Segundo intento' },
    { fecha: '2026-11-23T15:08:00.000Z', usuario_id: 44, canal: 'email', notas: 'Propuesta enviada' },
  ];
  const audits = [
    { id: 9, created_at: '2026-11-23T15:06:20.000Z', attribution_steps: { action: 'status_update', userId: 44 },
      raw_payload: { notas_internas: 'Volver a intentar mañana' } },
    { id: 10, created_at: '2026-11-23T15:09:00.000Z', attribution_steps: { action: 'call_outcome', userId: 44 },
      raw_payload: { outcome: 'informacion' } },
    { id: 11, created_at: '2026-11-23T15:10:00.000Z', attribution_steps: { action: 'status_update', userId: 44 },
      raw_payload: { notas_internas: '' } },
  ];
  const { body } = await fixture({ history, attempts: [attempt], audits })();
  assert.deepEqual(body.slice(1).map(({ titulo, descripcion, usuarioNombre }) => [titulo, descripcion, usuarioNombre]), [
    ['Llamada', 'No contesta · Segundo intento', 'Ana Ejemplo'],
    ['Nota interna guardada', 'Volver a intentar mañana', 'Ana Ejemplo'],
    ['Correo electrónico', 'Propuesta enviada', 'Ana Ejemplo'],
    ['Llamada', 'Solo pidió información', 'Ana Ejemplo'],
    ['Nota interna eliminada', null, 'Ana Ejemplo'],
  ]);
});

test('activity never reads notes or attempts for users outside the lead scope', async () => {
  const { status, readCount } = await fixture()(null);
  assert.equal(status, 403);
  assert.equal(readCount, 0);
});
