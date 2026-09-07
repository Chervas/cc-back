'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  materializeLeadAutoReplyProviderStatus,
} = require('../../services/leadAutoReplyContactStatus.service');

function buildModels({ lead, attempts = [], execution = null }) {
  const state = {
    attempts: attempts.map((attempt) => ({ ...attempt })),
    created: 0,
    destroyed: 0,
  };
  return {
    state,
    models: {
      sequelize: {
        transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }),
      },
      LeadIntake: {
        findByPk: async () => lead,
      },
      FlowExecutionV2: {
        findByPk: async () => execution,
      },
      LeadContactAttempt: {
        findOne: async ({ where, order }) => {
          const matches = state.attempts.filter((attempt) => (
            Number(attempt.lead_intake_id) === Number(where.lead_intake_id)
            && (!where.canal || attempt.canal === where.canal)
            && (!where.motivo || attempt.motivo === where.motivo)
          ));
          if (order) {
            return matches.sort((left, right) => (
              new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
            ))[0] || null;
          }
          return matches[0] || null;
        },
        create: async (payload) => {
          state.created += 1;
          const row = { id: 100 + state.created, created_at: new Date(), ...payload };
          state.attempts.push(row);
          return row;
        },
        destroy: async ({ where }) => {
          const before = state.attempts.length;
          state.attempts = state.attempts.filter((attempt) => !(
            Number(attempt.lead_intake_id) === Number(where.lead_intake_id)
            && attempt.canal === where.canal
            && attempt.motivo === where.motivo
          ));
          const removed = before - state.attempts.length;
          state.destroyed += removed;
          return removed;
        },
      },
    },
  };
}

function buildLead(overrides = {}) {
  return {
    id: 10,
    status_lead: 'nuevo',
    num_contactos: 0,
    ultimo_contacto: null,
    historial_contactos: [],
    async update(payload) {
      Object.assign(this, payload);
      return this;
    },
    ...overrides,
  };
}

function buildMessage(overrides = {}) {
  return {
    id: 50,
    direction: 'outbound',
    content: 'Hola, ¿quieres una cita?',
    metadata: {
      template_usage: 'lead_auto_reply',
      lead_intake_id: 10,
      execution_id: 90,
    },
    ...overrides,
  };
}

test('solo registra el contacto cuando Meta confirma el envío y lo hace una vez', async () => {
  const lead = buildLead();
  const { models, state } = buildModels({ lead });
  const message = buildMessage();

  const accepted = await materializeLeadAutoReplyProviderStatus({
    message,
    providerStatus: 'accepted',
    models,
  });
  assert.equal(accepted.handled, false);
  assert.equal(state.created, 0);
  assert.equal(lead.status_lead, 'nuevo');

  await materializeLeadAutoReplyProviderStatus({
    message,
    providerStatus: 'sent',
    providerTimestamp: '1788771600',
    models,
  });
  await materializeLeadAutoReplyProviderStatus({
    message,
    providerStatus: 'delivered',
    providerTimestamp: '1788771602',
    models,
  });

  assert.equal(state.created, 1);
  assert.equal(lead.status_lead, 'contactado');
  assert.equal(lead.num_contactos, 1);
  assert.equal(lead.historial_contactos.length, 1);
  assert.equal(lead.historial_contactos[0].message_id, 50);
});

test('un fallo asíncrono revierte solo el contacto automático asociado', async () => {
  const humanDate = '2026-09-07T08:00:00.000Z';
  const laterHumanAttemptDate = '2026-09-07T08:03:00.000Z';
  const lead = buildLead({
    status_lead: 'contactado',
    num_contactos: 2,
    ultimo_contacto: new Date('2026-09-07T08:05:00.000Z'),
    historial_contactos: [
      { fecha: humanDate, motivo: 'manual', canal: 'whatsapp', message_id: 40 },
      { fecha: '2026-09-07T08:05:00.000Z', motivo: 'lead_auto_reply', canal: 'whatsapp', message_id: 50 },
    ],
  });
  const { models, state } = buildModels({
    lead,
    attempts: [
      { id: 1, lead_intake_id: 10, canal: 'whatsapp', motivo: 'whatsapp_message_sent', created_at: laterHumanAttemptDate },
      { id: 2, lead_intake_id: 10, canal: 'whatsapp', motivo: 'lead_auto_reply:50', created_at: '2026-09-07T08:05:00.000Z' },
    ],
  });

  await materializeLeadAutoReplyProviderStatus({
    message: buildMessage(),
    providerStatus: 'failed',
    models,
  });
  await materializeLeadAutoReplyProviderStatus({
    message: buildMessage(),
    providerStatus: 'failed',
    models,
  });

  assert.equal(state.destroyed, 1);
  assert.equal(lead.num_contactos, 1);
  assert.equal(lead.status_lead, 'contactado');
  assert.equal(lead.historial_contactos.length, 1);
  assert.equal(new Date(lead.ultimo_contacto).toISOString(), laterHumanAttemptDate);
});

test('un fallo deja el lead como nuevo si no existió ningún otro contacto real', async () => {
  const lead = buildLead({
    status_lead: 'contactado',
    num_contactos: 1,
    historial_contactos: [
      { fecha: '2026-09-07T08:05:00.000Z', motivo: 'lead_auto_reply', canal: 'whatsapp', message_id: 50 },
    ],
  });
  const { models } = buildModels({
    lead,
    attempts: [
      { id: 2, lead_intake_id: 10, canal: 'whatsapp', motivo: 'lead_auto_reply:50', created_at: '2026-09-07T08:05:00.000Z' },
    ],
  });

  await materializeLeadAutoReplyProviderStatus({
    message: buildMessage(),
    providerStatus: 'failed',
    models,
  });

  assert.equal(lead.status_lead, 'nuevo');
  assert.equal(lead.num_contactos, 0);
  assert.equal(lead.ultimo_contacto, null);
});

test('puede resolver el lead desde la ejecución antigua sin metadata directa', async () => {
  const lead = buildLead({ status_lead: 'cualificado' });
  const execution = {
    trigger_entity_type: 'lead_nuevo',
    trigger_entity_id: 10,
    context: {},
  };
  const { models } = buildModels({ lead, execution });
  const message = buildMessage({
    metadata: { template_usage: 'lead_auto_reply', execution_id: 90 },
  });

  await materializeLeadAutoReplyProviderStatus({
    message,
    providerStatus: 'read',
    models,
  });

  assert.equal(lead.status_lead, 'cualificado');
  assert.equal(lead.num_contactos, 1);
});

test('el flujo no registra contactos al programar o aceptar y el webhook sí los concilia', () => {
  const repositoryRoot = path.resolve(__dirname, '../../..');
  const flowSource = fs.readFileSync(path.join(repositoryRoot, 'src/services/flowEngineV2.service.js'), 'utf8');
  const workerSource = fs.readFileSync(path.join(repositoryRoot, 'src/workers/queue.workers.js'), 'utf8');
  assert.doesNotMatch(flowSource, /registerLeadAutoReplyContactAttempt/);
  assert.match(flowSource, /lead_intake_id: toIntOrNull\(targets\.lead_intake_id\)/);
  assert.match(workerSource, /materializeLeadAutoReplyProviderStatus/);
});
