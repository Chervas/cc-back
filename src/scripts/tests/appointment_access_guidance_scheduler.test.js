#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const db = require('../../../models');
const appointmentRuntime = require('../../services/appointmentAutomationV2Runtime.service');
const jobRequestsService = require('../../services/jobRequests.service');
const jobScheduler = require('../../services/jobScheduler.service');
const { queues } = require('../../services/queue.service');

const DAY_MS = 24 * 60 * 60 * 1000;

test.after(async () => {
  jobScheduler.stop();
  const queueList = Object.values(queues || {});
  await Promise.all(queueList.map((queue) => queue.waitUntilReady()));
  await Promise.all(queueList.map((queue) => queue.close()));
  await db.sequelize.close();
});

function futureAppointment({ days = 3, status = 'info_confirmada' } = {}) {
  const start = new Date(Date.now() + (days * DAY_MS));
  start.setUTCHours(12, 0, 0, 0);
  if (start.getTime() <= Date.now() + DAY_MS) {
    start.setUTCDate(start.getUTCDate() + 2);
  }
  const end = new Date(start.getTime() + (45 * 60 * 1000));
  const createdAt = new Date(start.getTime() - (3 * DAY_MS));
  createdAt.setUTCHours(10, 0, 0, 0);
  return {
    id_cita: 8801,
    clinica_id: 66,
    paciente_id: 7701,
    tipo_cita: 'primera_sin_trat',
    estado: status,
    inicio: start,
    fin: end,
    created_at: createdAt,
  };
}

function reminderTemplate(config = {}) {
  return {
    id: 9901,
    template_key: 'recordatorio_mismo_dia_primera_visita',
    trigger_type: 'appointment_reminder_window',
    trigger_config: {
      schedule_moment: 'same_day',
      schedule_time_mode: 'custom',
      custom_time: '08:00',
      exclude_if_booked_same_day: true,
      exclude_if_not_confirmed: true,
      ...config,
    },
    entry_node_id: 'trigger',
    nodes: [],
    clinic_id: 66,
    group_id: null,
    is_system: false,
    is_active: true,
    published_at: new Date('2026-07-01T00:00:00.000Z'),
    version: 1,
    engine_version: 'v2',
    created_by: 1,
  };
}

test('la ventana del recordatorio excluye reservas del mismo día y genera una clave estable', () => {
  const cita = futureAppointment();
  const sameDayCreatedAt = new Date(cita.inicio);
  sameDayCreatedAt.setUTCHours(7, 15, 0, 0);
  const triggerConfig = appointmentRuntime.getTemplateTriggerConfig(reminderTemplate());

  const excluded = appointmentRuntime.computeScheduledRunAt({
    cita: { ...cita, created_at: sameDayCreatedAt },
    triggerType: 'appointment_reminder_window',
    triggerConfig,
    timeZone: 'UTC',
  });
  assert.equal(excluded, null);

  const eligibleConfig = { ...triggerConfig, exclude_if_booked_same_day: false };
  const scheduledFor = appointmentRuntime.computeScheduledRunAt({
    cita,
    triggerType: 'appointment_reminder_window',
    triggerConfig: eligibleConfig,
    timeZone: 'UTC',
  });
  const expected = new Date(cita.inicio);
  expected.setUTCHours(8, 0, 0, 0);
  assert.equal(scheduledFor.toISOString(), expected.toISOString());

  const windowIdentifier = appointmentRuntime.buildScheduledWindowIdentifier({
    triggerType: 'appointment_reminder_window',
    triggerConfig: eligibleConfig,
    scheduledFor,
  });
  const key = appointmentRuntime.buildIdempotencyKey({
    triggerType: 'appointment_reminder_window',
    citaId: cita.id_cita,
    templateVersionId: 9901,
    windowIdentifier,
  });
  assert.equal(
    key,
    appointmentRuntime.buildIdempotencyKey({
      triggerType: 'appointment_reminder_window',
      citaId: cita.id_cita,
      templateVersionId: 9901,
      windowIdentifier,
    })
  );
  assert.match(key, /schedule:appointment_reminder_window:same_day:custom:08:00:/);
});

test('enqueueExecutionForTemplate deduplica por cita, versión y ventana', async () => {
  const originals = {
    executionFind: db.FlowExecutionV2.findOne,
    executionCreate: db.FlowExecutionV2.create,
    clinicFind: db.Clinica.findByPk,
    enqueueUnique: jobRequestsService.enqueueUniqueJobRequest,
    triggerImmediate: jobScheduler.triggerImmediate,
  };
  const cita = futureAppointment();
  const template = reminderTemplate({ exclude_if_booked_same_day: false });
  const executions = new Map();
  const queued = [];
  let creates = 0;
  let failFirstDispatch = true;

  try {
    db.FlowExecutionV2.findOne = async ({ where }) => executions.get(where.idempotency_key) || null;
    db.FlowExecutionV2.create = async (values) => {
      creates += 1;
      const created = { id: 12001, created_at: new Date(), ...values };
      executions.set(values.idempotency_key, created);
      return created;
    };
    db.Clinica.findByPk = async () => ({ id_clinica: 66, grupoClinicaId: 29 });
    jobRequestsService.enqueueUniqueJobRequest = async (options) => {
      if (failFirstDispatch) {
        failFirstDispatch = false;
        throw new Error('simulated_handoff_failure');
      }
      queued.push(options);
      return { job: { id: 13001 }, created: true };
    };
    jobScheduler.triggerImmediate = async () => true;

    const options = {
      event_name: 'appointment_reminder_window',
      window_identifier: 'schedule:appointment_reminder_window:same_day:custom:08:00:2026-07-20T06:00:00.000Z',
    };
    await assert.rejects(
      () => appointmentRuntime.enqueueExecutionForTemplate(cita, template, options),
      /simulated_handoff_failure/
    );
    const repeated = await appointmentRuntime.enqueueExecutionForTemplate(cita, template, options);

    assert.equal(repeated.deduplicated, true);
    assert.equal(repeated.execution.id, 12001);
    assert.equal(creates, 1);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].payload, { execution_id: 12001 });
    assert.equal(queued[0].dedupeScope, 'flow_execution:12001');
  } finally {
    db.FlowExecutionV2.findOne = originals.executionFind;
    db.FlowExecutionV2.create = originals.executionCreate;
    db.Clinica.findByPk = originals.clinicFind;
    jobRequestsService.enqueueUniqueJobRequest = originals.enqueueUnique;
    jobScheduler.triggerImmediate = originals.triggerImmediate;
  }
});

test('la resincronización conserva el job idéntico, sustituye el reprogramado y cancela la cita', async () => {
  const originals = {
    clinicFind: db.Clinica.findByPk,
    templateFindAll: db.AutomationFlowTemplateV2.findAll,
    jobFindAll: db.JobRequest.findAll,
    enqueue: jobRequestsService.enqueueJobRequest,
    markCancelled: jobRequestsService.markCancelled,
  };
  const template = reminderTemplate({ exclude_if_booked_same_day: false });
  const jobs = [];
  const cancellations = [];
  let nextId = 14001;

  try {
    db.Clinica.findByPk = async () => ({
      id_clinica: 66,
      grupoClinicaId: 29,
      configuracion: { timezone: 'UTC' },
    });
    db.AutomationFlowTemplateV2.findAll = async ({ where }) => (
      where?.trigger_type === 'appointment_reminder_window' ? [template] : []
    );
    db.JobRequest.findAll = async () => jobs.filter((job) => ['pending', 'waiting'].includes(job.status));
    jobRequestsService.enqueueJobRequest = async (options) => {
      const job = {
        id: nextId++,
        status: options.status,
        ...options,
        payload: {
          ...options.payload,
          __runtime_namespace: jobRequestsService.getCurrentRuntimeNamespace(),
        },
      };
      jobs.push(job);
      return job;
    };
    jobRequestsService.markCancelled = async (id, options) => {
      const job = jobs.find((item) => item.id === id);
      assert.ok(job);
      job.status = 'cancelled';
      cancellations.push({ id, errorMessage: options?.errorMessage });
      return job;
    };

    const cita = futureAppointment();
    const first = await appointmentRuntime.syncScheduledTriggersForCita(cita);
    assert.equal(first.scheduled_jobs.length, 1);
    assert.equal(first.cancelled_jobs.length, 0);

    const repeated = await appointmentRuntime.syncScheduledTriggersForCita(cita);
    assert.deepEqual(repeated.scheduled_jobs, []);
    assert.deepEqual(repeated.cancelled_jobs, []);
    assert.equal(jobs.length, 1);

    const rescheduled = {
      ...cita,
      inicio: new Date(cita.inicio.getTime() + DAY_MS),
      fin: new Date(cita.fin.getTime() + DAY_MS),
    };
    const changed = await appointmentRuntime.syncScheduledTriggersForCita(rescheduled);
    assert.equal(changed.cancelled_jobs.length, 1);
    assert.equal(changed.scheduled_jobs.length, 1);
    assert.equal(jobs.length, 2);
    assert.notEqual(jobs[0].payload.window_identifier, jobs[1].payload.window_identifier);
    assert.equal(cancellations[0].errorMessage, 'superseded_by_appointment_resync');

    const cancelled = await appointmentRuntime.syncScheduledTriggersForCita({
      ...rescheduled,
      estado: 'cancelada',
    });
    assert.equal(cancelled.reason, 'inactive_appointment_status');
    assert.deepEqual(cancelled.scheduled_jobs, []);
    assert.deepEqual(cancelled.cancelled_jobs, [jobs[1].id]);
    assert.equal(jobs.filter((job) => ['pending', 'waiting'].includes(job.status)).length, 0);
  } finally {
    db.Clinica.findByPk = originals.clinicFind;
    db.AutomationFlowTemplateV2.findAll = originals.templateFindAll;
    db.JobRequest.findAll = originals.jobFindAll;
    jobRequestsService.enqueueJobRequest = originals.enqueue;
    jobRequestsService.markCancelled = originals.markCancelled;
  }
});

test('el disparo omite citas canceladas y recordatorios que siguen sin confirmar', async () => {
  const originals = {
    appointmentFind: db.CitaPaciente.findByPk,
    clinicFind: db.Clinica.findByPk,
    templateFind: db.AutomationFlowTemplateV2.findOne,
    executionCreate: db.FlowExecutionV2.create,
  };
  let currentAppointment = futureAppointment({ status: 'cancelada' });
  let executionCreates = 0;

  try {
    db.CitaPaciente.findByPk = async () => currentAppointment;
    db.Clinica.findByPk = async () => ({ id_clinica: 66, configuracion: { timezone: 'UTC' } });
    db.AutomationFlowTemplateV2.findOne = async () => reminderTemplate({
      exclude_if_booked_same_day: false,
      exclude_if_not_confirmed: true,
    });
    db.FlowExecutionV2.create = async () => {
      executionCreates += 1;
      throw new Error('execution_must_not_be_created');
    };

    const payload = {
      appointment_id: currentAppointment.id_cita,
      trigger_type: 'appointment_reminder_window',
      template_key: 'recordatorio_mismo_dia_primera_visita',
    };
    const cancelled = await appointmentRuntime.fireScheduledTrigger(payload);
    assert.equal(cancelled.reason, 'appointment_cancelada');

    currentAppointment = { ...currentAppointment, estado: 'pendiente' };
    const notConfirmed = await appointmentRuntime.fireScheduledTrigger(payload);
    assert.equal(notConfirmed.reason, 'appointment_not_confirmed');
    assert.equal(executionCreates, 0);
    assert.equal(appointmentRuntime.isAppointmentConfirmedForReminder(currentAppointment), false);
    assert.equal(
      appointmentRuntime.isAppointmentConfirmedForReminder({ ...currentAppointment, estado: 'info_confirmada' }),
      true
    );
  } finally {
    db.CitaPaciente.findByPk = originals.appointmentFind;
    db.Clinica.findByPk = originals.clinicFind;
    db.AutomationFlowTemplateV2.findOne = originals.templateFind;
    db.FlowExecutionV2.create = originals.executionCreate;
  }
});
