'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const db = require('../../../models');
const inbound = require('../../services/automationInboundMessage.service');
const flowEngine = require('../../services/flowEngineV2.service');
const {
  markCanonicalConfirmationReplySuppression,
} = require('../../lib/automation-intent-migration');

const RESPONSE_MATRIX_SCENARIO_COUNT = 16;

function appointmentReplyContext(patientText) {
  return {
    conversation_today: [
      '[03/09/2026, 09:00] Clínica: ¿Me confirmas tu asistencia mañana?',
      `[03/09/2026, 09:10] Paciente: ${patientText}`,
    ].join('\n'),
    last_response: patientText,
    last_response_context: {
      response_text: patientText,
      response_lines: [patientText],
      response_message_type: 'text',
    },
    trigger: {
      type: 'appointment_reminder_window',
      data: { appointment_candidate_count: 1 },
    },
    appointment: { estado: 'recordatorio_enviado' },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyContextPatch(context, patch) {
  if (!patch || typeof patch !== 'object') return context;
  const next = { ...context, ...patch };
  for (const key of ['appointment', 'cita', 'trigger', 'clinica', 'clinic']) {
    if (context?.[key] || patch?.[key]) {
      next[key] = { ...(context?.[key] || {}), ...(patch?.[key] || {}) };
    }
  }
  next.outputs = { ...(context?.outputs || {}), ...(patch?.outputs || {}) };
  return next;
}

function buildWorkflowContext(template, patientText, options = {}) {
  const appointmentStart = options.appointmentStart || '2026-09-10T10:00:00.000Z';
  const bookingReference = options.bookingReference || '2026-09-07T10:00:00.000Z';
  const clinicText = options.clinicText || '¿Nos confirmas tu asistencia a la cita?';
  const triggerType = template.trigger_type;
  const createdAt = triggerType === 'appointment_rescheduled'
    ? '2026-09-01T10:00:00.000Z'
    : bookingReference;
  const updatedAt = triggerType === 'appointment_rescheduled'
    ? bookingReference
    : createdAt;
  return {
    conversation_today: [
      `[09/09/2026, 09:00] Clínica: ${clinicText}`,
      `[09/09/2026, 09:10] Paciente: ${patientText}`,
    ].join('\n'),
    last_prompt: clinicText,
    last_response: patientText,
    last_response_context: {
      response_text: patientText,
      response_lines: [patientText],
      response_message_type: 'text',
      response_message_id: 900001,
      responded_at: '2026-09-09T07:10:00.000Z',
      ...(options.responseContextPatch || {}),
    },
    trigger: {
      type: triggerType,
      data: {
        appointment_id: 910001,
        appointment_candidate_count: 1,
        appointment_created_at: createdAt,
        created_at: createdAt,
        appointment_updated_at: updatedAt,
        updated_at: updatedAt,
        appointment_start: appointmentStart,
        inicio: appointmentStart,
      },
    },
    appointment: {
      id: 910001,
      id_cita: 910001,
      estado: options.initialStatus || 'pendiente',
      status: options.initialStatus || 'pendiente',
      inicio: appointmentStart,
      created_at: createdAt,
      updated_at: updatedAt,
    },
    clinica: {
      timezone: 'Europe/Madrid',
      access_guidance_reminder_enabled: false,
    },
    paciente: { nombre: 'Paciente QA' },
    usuario: { nombre: 'Recepción QA' },
    outputs: {},
  };
}

async function simulatePublishedWorkflow(template, baseContext, waitModes = [], options = {}) {
  const nodes = Array.isArray(template.nodes)
    ? template.nodes
    : JSON.parse(template.nodes || '[]');
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const context = clone(baseContext);
  const events = [];
  let nodeId = template.entry_node_id;
  let waitIndex = 0;
  let afterResponse = options.responseAlreadyReceived === true;

  for (let step = 0; nodeId && step < 180; step += 1) {
    const node = nodeMap.get(nodeId);
    assert.ok(node, `${template.public_id}: missing node ${nodeId}`);

    if (node.type === 'control/join') {
      events.push({ node, afterResponse, result: { kind: 'success', output: { joined: true } } });
      nodeId = node.outputs?.on_joined || null;
      continue;
    }

    const result = await flowEngine._processNode(node, context, { simulation: true });
    context.outputs[node.id] = result.output || null;
    const event = { node, afterResponse, result };
    events.push(event);

    if (node.type === 'delay/wait_response') {
      assert.equal(result.kind, 'waiting', `${template.public_id}:${node.id} must wait durably`);
      const mode = waitModes[waitIndex++] || 'timeout';
      if (mode === 'response') afterResponse = true;
      nodeId = mode === 'response'
        ? node.outputs?.on_response || null
        : node.outputs?.on_timeout || null;
      continue;
    }

    assert.equal(result.kind, 'success', `${template.public_id}:${node.id} did not succeed in simulation`);
    const patched = applyContextPatch(context, result.context_patch);
    Object.assign(context, patched);
    nodeId = result.next_node_id || null;

    if (step === 179 && nodeId) {
      assert.fail(`${template.public_id}: graph exceeded 180 simulated steps`);
    }
  }

  return { context, events, waitsConsumed: waitIndex };
}

function workflowStatus(run) {
  return run.context?.appointment?.estado || null;
}

function responseEvents(run, nodeTypes) {
  const types = new Set(nodeTypes);
  return run.events.filter((event) => event.afterResponse && types.has(event.node.type));
}

async function assertResponseMatrix(template, contextOptions, waitModes, expectedConfirmationStatus, options = {}) {
  const prompt = options.clinicText || '¿Nos confirmas tu asistencia a la cita?';
  const baselineStatus = options.baselineStatus || contextOptions.initialStatus;
  const scenarios = [
    {
      key: 'plain_confirmation',
      text: options.confirmationText || 'Sí, confirmo',
      expectedIntent: 'confirmar_cita',
      expectedStatus: expectedConfirmationStatus,
      expectAcknowledgement: true,
    },
    {
      key: 'short_ok',
      text: 'ok',
      expectedIntent: options.shortAcknowledgementIntent || 'confirmar_cita',
      expectedStatus: options.shortAcknowledgementStatus || expectedConfirmationStatus,
      expectAcknowledgement: options.shortAcknowledgementAcknowledgement !== false,
      expectNoAutomaticReply: options.shortAcknowledgementAcknowledgement === false,
    },
    {
      key: 'short_vale',
      text: 'vale',
      expectedIntent: options.shortAcknowledgementIntent || 'confirmar_cita',
      expectedStatus: options.shortAcknowledgementStatus || expectedConfirmationStatus,
      expectAcknowledgement: options.shortAcknowledgementAcknowledgement !== false,
      expectNoAutomaticReply: options.shortAcknowledgementAcknowledgement === false,
    },
    {
      key: 'buffered_final_acknowledgement',
      text: 'espera un segundo\nok',
      responseContextPatch: {
        response_lines: ['espera un segundo', 'ok'],
        listened_message_preview: prompt,
      },
      expectedIntent: options.shortAcknowledgementIntent || 'confirmar_cita',
      expectedStatus: options.shortAcknowledgementStatus || expectedConfirmationStatus,
      expectAcknowledgement: options.shortAcknowledgementAcknowledgement !== false,
      expectNoAutomaticReply: options.shortAcknowledgementAcknowledgement === false,
    },
    {
      key: 'written_positive_emoji',
      text: '👍🏽',
      expectedIntent: options.shortAcknowledgementIntent || 'confirmar_cita',
      expectedStatus: options.shortAcknowledgementStatus || expectedConfirmationStatus,
      expectAcknowledgement: options.shortAcknowledgementAcknowledgement !== false,
      expectNoAutomaticReply: options.shortAcknowledgementAcknowledgement === false,
    },
    {
      key: 'positive_reaction',
      text: '',
      responseContextPatch: {
        response_text: null,
        response_lines: [],
        response_message_type: 'reaction',
        reaction_emoji: '✅',
        reaction_target_message_preview: prompt,
      },
      expectedIntent: options.shortAcknowledgementIntent || 'confirmar_cita',
      expectedStatus: options.shortAcknowledgementStatus || expectedConfirmationStatus,
      expectAcknowledgement: options.shortAcknowledgementAcknowledgement !== false,
      expectNoAutomaticReply: options.shortAcknowledgementAcknowledgement === false,
    },
    {
      key: 'confirmation_with_question',
      text: 'Confirmado. ¿Podéis darme la dirección?',
      expectedIntent: 'confirmar_cita',
      expectedStatus: expectedConfirmationStatus,
      expectSuppression: options.expectMixedSuppression !== false,
    },
    {
      key: 'contextual_thanks',
      text: 'Gracias',
      expectedIntent: options.thanksIntent || 'confirmar_cita',
      expectedStatus: options.thanksStatus || expectedConfirmationStatus,
      expectAcknowledgement: options.thanksAcknowledgement !== false,
      expectNoAutomaticReply: options.thanksAcknowledgement === false,
    },
    {
      key: 'cancellation',
      text: 'No puedo asistir, cancelad la cita por favor.',
      expectedIntent: 'cancelar_cita',
      expectedStatus: 'cancelada',
      expectAcknowledgement: true,
    },
    {
      key: 'reschedule',
      text: 'No puedo asistir, ¿podemos cambiarla al martes?',
      expectedIntent: 'solicitar_cambio_cita',
      expectedStatus: 'cambio_solicitado',
      expectAcknowledgement: true,
      expectNotification: true,
    },
    {
      key: 'question_only',
      text: '¿Podéis darme la dirección?',
      expectedIntent: 'pregunta',
      expectedStatus: baselineStatus,
      expectNotification: true,
    },
    {
      key: 'possible_urgency',
      text: 'Tengo un sangrado intenso y quiero cancelar la cita.',
      expectedIntent: 'urgencia_posible',
      expectedStatus: baselineStatus,
      expectNotification: true,
    },
    {
      key: 'negative_reaction',
      text: '',
      responseContextPatch: {
        response_text: null,
        response_lines: [],
        response_message_type: 'reaction',
        reaction_emoji: '👎',
        reaction_target_message_preview: prompt,
      },
      expectedIntent: 'otra',
      expectedStatus: baselineStatus,
      expectNoAutomaticReply: options.allowReviewReply !== true,
    },
    {
      key: 'unreadable_sticker',
      text: '',
      responseContextPatch: {
        response_text: null,
        response_lines: [],
        response_message_type: 'image',
        response_media_kind: 'sticker',
      },
      expectedIntent: 'otra',
      expectedStatus: baselineStatus,
      expectNoAutomaticReply: options.allowReviewReply !== true,
    },
    {
      key: 'negated_confirmation',
      text: 'Todavía no puedo confirmar.',
      expectedIntent: 'otra',
      expectedStatus: baselineStatus,
      expectNoAutomaticReply: options.allowReviewReply !== true,
    },
    {
      key: 'questioned_ok',
      text: 'ok?',
      expectedIntent: 'pregunta',
      expectedStatus: baselineStatus,
      expectNoAutomaticReply: options.allowReviewReply !== true,
    },
  ];

  for (const scenario of scenarios) {
    const context = buildWorkflowContext(template, scenario.text, {
      ...contextOptions,
      clinicText: prompt,
      responseContextPatch: scenario.responseContextPatch,
    });
    const run = await simulatePublishedWorkflow(template, context, waitModes, {
      responseAlreadyReceived: options.responseAlreadyReceived,
    });
    assert.equal(
      workflowStatus(run),
      scenario.expectedStatus,
      `${template.public_id}:${options.pathName}:${scenario.key}: final appointment status`,
    );

    const aiEvents = responseEvents(run, ['condition/ai_analysis']);
    assert.equal(aiEvents.length, 1, `${template.public_id}:${options.pathName}:${scenario.key}: AI count`);
    assert.equal(
      aiEvents[0].result.output?.intencion_principal,
      scenario.expectedIntent,
      `${template.public_id}:${options.pathName}:${scenario.key}: intent`,
    );
    assert.equal(
      aiEvents[0].result.output?._ai_provider,
      'deterministic_rule',
      `${template.public_id}:${options.pathName}:${scenario.key}: external AI must not run`,
    );

    const communications = responseEvents(run, ['action/send_whatsapp', 'action/reply_message']);
    const suppressed = communications.filter(
      (event) => event.result.output?.status === 'suppressed_pending_response',
    );
    const simulated = communications.filter(
      (event) => event.result.output?.status === 'simulated',
    );
    if (scenario.expectSuppression) {
      assert.equal(suppressed.length, 1, `${template.public_id}:${options.pathName}:${scenario.key}: suppression`);
      assert.equal(
        simulated.length,
        0,
        `${template.public_id}:${options.pathName}:${scenario.key}: generic acknowledgement must not be sent`,
      );
    }
    if (scenario.expectAcknowledgement) {
      assert.equal(
        simulated.length >= 1,
        true,
        `${template.public_id}:${options.pathName}:${scenario.key}: acknowledgement must be sent`,
      );
      assert.equal(suppressed.length, 0, `${template.public_id}:${options.pathName}:${scenario.key}: acknowledgement suppression`);
    }
    if (scenario.expectNoAutomaticReply) {
      assert.equal(
        communications.length,
        0,
        `${template.public_id}:${options.pathName}:${scenario.key}: no automatic reply expected`,
      );
    }
    if (scenario.expectNotification) {
      assert.equal(
        responseEvents(run, ['action/send_system_notification']).length >= 1,
        true,
        `${template.public_id}:${options.pathName}:${scenario.key}: operator notification`,
      );
    }
  }

  return scenarios.length;
}

async function assertBookingTimingTimezoneBoundaries(template, bookingSwitch) {
  const cases = [
    {
      name: 'same_local_day_across_utc_dates',
      appointmentStart: '2026-09-10T00:30:00.000Z',
      bookingReference: '2026-09-09T23:30:00.000Z',
      expectedWindow: 'same_day',
    },
    {
      name: 'previous_local_day_with_same_utc_date',
      appointmentStart: '2026-09-10T22:30:00.000Z',
      bookingReference: '2026-09-10T20:30:00.000Z',
      expectedWindow: 'day_before',
    },
    {
      name: 'more_than_one_local_day_before',
      appointmentStart: '2026-09-10T10:00:00.000Z',
      bookingReference: '2026-09-07T22:30:00.000Z',
      expectedWindow: 'more_than_day_before',
    },
  ];

  for (const boundary of cases) {
    const result = await flowEngine._processNode(
      bookingSwitch,
      buildWorkflowContext(template, 'Sin respuesta', boundary),
      { simulation: true },
    );
    assert.equal(result.kind, 'success', `${template.public_id}:${boundary.name}`);
    assert.equal(
      result.output?.matched_window,
      boundary.expectedWindow,
      `${template.public_id}:${boundary.name}: Europe/Madrid window`,
    );
  }
  return cases.length;
}

async function testAtomicOutboxAndDuplicateClaim() {
  const clinic = await db.Clinica.findOne({
    attributes: ['id_clinica'],
    order: [['id_clinica', 'ASC']],
    raw: true,
  });
  assert.ok(clinic?.id_clinica, 'DEV needs at least one clinic for the transactional fixture');

  const transaction = await db.sequelize.transaction();
  try {
    const fixtureKey = `qa-automation-outbox-${Date.now()}`;
    const conversation = await db.Conversation.create({
      clinic_id: clinic.id_clinica,
      channel: 'whatsapp',
      contact_id: fixtureKey,
      patient_id: null,
      lead_id: null,
      last_message_at: new Date(),
      last_inbound_at: new Date(),
      unread_count: 1,
    }, { transaction });
    const message = await db.Message.create({
      conversation_id: conversation.id,
      direction: 'inbound',
      content: 'QA synthetic inbound message',
      message_type: 'text',
      status: 'delivered',
      metadata: { wamid: fixtureKey },
      sent_at: new Date(),
    }, { transaction });

    const input = {
      inboundMessage: message,
      conversation,
      clinicId: clinic.id_clinica,
      channel: 'whatsapp',
      providerMessageId: fixtureKey,
    };
    const first = await inbound.enqueueInboundDispatch(input, { transaction });
    const duplicate = await inbound.enqueueInboundDispatch(input, { transaction });

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.already_dispatched, true);
    assert.equal(Number(duplicate.claim.id), Number(first.claim.id));

    const claims = await db.AutomationInboundMessageClaim.findAll({
      where: { message_id: message.id },
      transaction,
    });
    const jobs = await db.JobRequest.findAll({
      where: { type: 'automation_inbound_dispatch', origin: 'inbound_message_outbox' },
      transaction,
    });
    const fixtureJobs = jobs.filter((job) => Number(job.payload?.message_id) === Number(message.id));
    assert.equal(claims.length, 1);
    assert.equal(fixtureJobs.length, 1);
    assert.equal(claims[0].status, 'queued');
    assert.equal(Number(claims[0].owner_reference_id), Number(fixtureJobs[0].id));
    assert.deepEqual(
      Object.keys(fixtureJobs[0].payload)
        .filter((key) => !key.startsWith('_'))
        .sort(),
      ['channel', 'claim_id', 'clinic_id', 'conversation_id', 'message_id'],
    );
    assert.equal(Object.prototype.hasOwnProperty.call(fixtureJobs[0].payload, 'content'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(fixtureJobs[0].payload, 'patient'), false);
  } finally {
    await transaction.rollback();
  }
}

async function testEveryPublishedCanonicalAiNodeRunsRealPatientRegressions() {
  const published = await db.AutomationFlowTemplateV2.findAll({
    where: { published_at: { [db.Sequelize.Op.ne]: null } },
    attributes: ['id', 'public_id', 'version', 'nodes'],
    order: [['public_id', 'ASC'], ['version', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
  const latest = new Map();
  for (const template of published) {
    if (!latest.has(template.public_id)) latest.set(template.public_id, template);
  }

  const canonicalNodes = [];
  for (const template of latest.values()) {
    const nodes = Array.isArray(template.nodes)
      ? template.nodes
      : JSON.parse(template.nodes || '[]');
    assert.equal(
      nodes.some((node) => ['confirm_appointment', 'appointment_unconfirmed_reply'].includes(node?.config?.preset_key)),
      false,
      `latest published template ${template.public_id} still uses a legacy appointment preset`
    );
    const templateCanonicalNodes = nodes.filter(
      (node) => node?.type === 'condition/ai_analysis' && node?.config?.preset_key === 'classify_intent'
    );
    if (templateCanonicalNodes.length) {
      assert.equal(
        markCanonicalConfirmationReplySuppression(nodes).changed,
        false,
        `latest published template ${template.public_id} can still send a generic confirmation while a reply is pending`
      );
    }
    for (const node of templateCanonicalNodes) {
      const legacyReaders = nodes.filter((candidate) => (
        candidate?.config?.left_ref?.source === 'node_output'
        && candidate?.config?.left_ref?.node_id === node.id
        && ['decision', 'confirmado'].includes(candidate?.config?.left_ref?.path)
      ));
      assert.equal(
        legacyReaders.length,
        0,
        `latest published template ${template.public_id} still reads a legacy AI output`
      );
      canonicalNodes.push({ template, node });
    }
  }
  assert.ok(canonicalNodes.length > 0, 'DEV must expose published canonical appointment AI nodes');

  const regressions = [
    'Buenos dias, si confirmo la asistencia',
    'Hola! No es molestia, gracias por el recordatorio. Mañana estaré allí. Gracias!',
  ];
  for (const { template, node } of canonicalNodes) {
    for (const text of regressions) {
      const result = await flowEngine._processNode(
        node,
        appointmentReplyContext(text),
        { simulation: true }
      );
      assert.equal(result.kind, 'success', `template ${template.public_id} did not complete its AI node`);
      assert.equal(result.next_node_id, node.outputs?.on_success || null);
      assert.equal(result.output?.intencion_principal, 'confirmar_cita');
      assert.equal(result.output?.accion_inequivoca, true);
    }
  }

  const representativesByConfig = new Map();
  for (const entry of canonicalNodes) {
    const signature = JSON.stringify(entry.node.config || {});
    if (!representativesByConfig.has(signature)) representativesByConfig.set(signature, entry);
  }
  const intentMatrix = [
    {
      name: 'confirmation with a pending question',
      text: 'Confirmado. ¿Podéis darme la dirección?',
      intent: 'confirmar_cita',
      secondary: 'pregunta',
      unambiguous: true,
      needsResponse: true,
    },
    {
      name: 'contextual thanks',
      text: 'Gracias',
      intent: 'confirmar_cita',
      secondary: '',
      unambiguous: true,
      needsResponse: false,
    },
    {
      name: 'cancellation',
      text: 'No puedo asistir, cancelad la cita por favor.',
      intent: 'cancelar_cita',
      secondary: '',
      unambiguous: true,
      needsResponse: false,
    },
    {
      name: 'reschedule request',
      text: 'No puedo asistir, ¿podemos cambiarla al martes?',
      intent: 'solicitar_cambio_cita',
      secondary: 'pregunta',
      unambiguous: true,
      needsResponse: true,
    },
    {
      name: 'possible urgency',
      text: 'Tengo un sangrado intenso y quiero cancelar la cita.',
      intent: 'urgencia_posible',
      secondary: '',
      unambiguous: false,
      needsResponse: true,
    },
    {
      name: 'question without appointment action',
      text: '¿Podéis darme la dirección?',
      intent: 'pregunta',
      secondary: '',
      unambiguous: false,
      needsResponse: true,
    },
  ];
  for (const { template, node } of representativesByConfig.values()) {
    for (const scenario of intentMatrix) {
      const result = await flowEngine._processNode(
        node,
        appointmentReplyContext(scenario.text),
        { simulation: true }
      );
      assert.equal(result.kind, 'success', `${template.public_id}: ${scenario.name}`);
      assert.equal(result.next_node_id, node.outputs?.on_success || null, `${template.public_id}: ${scenario.name}`);
      assert.equal(result.output?.intencion_principal, scenario.intent, `${template.public_id}: ${scenario.name}`);
      assert.equal(result.output?.intencion_secundaria, scenario.secondary, `${template.public_id}: ${scenario.name}`);
      assert.equal(result.output?.accion_inequivoca, scenario.unambiguous, `${template.public_id}: ${scenario.name}`);
      assert.equal(result.output?.necesita_respuesta, scenario.needsResponse, `${template.public_id}: ${scenario.name}`);
    }
  }

  return {
    canonicalNodeCount: canonicalNodes.length,
    canonicalConfigCount: representativesByConfig.size,
    matrixScenarioCount: intentMatrix.length,
  };
}

async function testEveryPublishedAppointmentWorkflowPath() {
  const published = await db.AutomationFlowTemplateV2.findAll({
    where: { published_at: { [db.Sequelize.Op.ne]: null } },
    attributes: [
      'id',
      'public_id',
      'version',
      'name',
      'trigger_type',
      'entry_node_id',
      'nodes',
    ],
    order: [['public_id', 'ASC'], ['version', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
  const latest = new Map();
  for (const template of published) {
    if (!latest.has(template.public_id)) latest.set(template.public_id, template);
  }

  const openExecutions = await db.FlowExecutionV2.findAll({
    where: { status: { [db.Sequelize.Op.in]: ['running', 'waiting'] } },
    include: [{
      model: db.AutomationFlowTemplateV2,
      as: 'templateVersion',
      attributes: ['nodes'],
      required: true,
    }],
  });
  const retiredOpen = openExecutions.filter((execution) => {
    const nodes = execution.templateVersion?.nodes || [];
    return nodes.some((node) => (
      node?.type === 'condition/ai_analysis'
      && ['confirm_appointment', 'appointment_unconfirmed_reply'].includes(node?.config?.preset_key)
    ));
  });
  assert.equal(retiredOpen.length, 0, 'open executions must not depend on retired appointment presets');

  const appointmentStart = '2026-09-10T10:00:00.000Z';
  const bookingReferences = {
    same_day: '2026-09-10T06:00:00.000Z',
    day_before: '2026-09-09T10:00:00.000Z',
    more_than_day_before: '2026-09-07T10:00:00.000Z',
  };
  let workflowTemplateCount = 0;
  let responsePathCount = 0;
  let responseScenarioCount = 0;
  let noResponsePathCount = 0;
  let bookingTimezoneBoundaryCount = 0;
  const unsupported = [];

  for (const template of latest.values()) {
    const nodes = Array.isArray(template.nodes)
      ? template.nodes
      : JSON.parse(template.nodes || '[]');
    if (!nodes.some((node) => (
      node?.type === 'condition/ai_analysis'
      && node?.config?.preset_key === 'classify_intent'
    ))) continue;

    workflowTemplateCount += 1;
    const name = String(template.name || '');
    const bookingSwitch = nodes.find((node) => node?.config?.mode === 'appointment_booking_timing');

    if (
      name.includes('datos de la cita tras agendar')
      || name.includes('datos de la cita tras reprogramar')
      || name === 'Enviar datos de cita tras agendarla'
      || name === 'Confirmar cambio solicitado por el paciente'
    ) {
      const windows = bookingSwitch
        ? ['same_day', 'day_before', 'more_than_day_before']
        : ['more_than_day_before'];
      if (bookingSwitch) {
        assert.deepEqual(
          bookingSwitch.config.switch_rules.map((rule) => rule.match_window),
          ['same_day', 'day_before', 'more_than_day_before'],
          `${template.public_id}: booking windows`,
        );
        bookingTimezoneBoundaryCount += await assertBookingTimingTimezoneBoundaries(template, bookingSwitch);
      }
      for (const window of windows) {
        const contextOptions = {
          appointmentStart,
          bookingReference: bookingReferences[window],
          initialStatus: template.trigger_type === 'appointment_rescheduled' ? 'reprogramada' : 'pendiente',
        };
        const expectedConfirmationStatus = window === 'more_than_day_before'
          ? 'info_confirmada'
          : 'recordatorio_confirmado';
        const clinicText = window === 'more_than_day_before'
          ? '¿Nos confirmas que has recibido correctamente los datos de tu cita?'
          : '¿Nos confirmas tu asistencia a la cita?';
        responseScenarioCount += await assertResponseMatrix(
          template,
          contextOptions,
          ['response'],
          expectedConfirmationStatus,
          {
            pathName: `${window}:first_request`,
            clinicText,
            baselineStatus: 'info_enviada',
          },
        );
        responsePathCount += 1;
        responseScenarioCount += await assertResponseMatrix(
          template,
          contextOptions,
          ['timeout', 'response'],
          expectedConfirmationStatus,
          {
            pathName: `${window}:follow_up`,
            clinicText,
            baselineStatus: 'info_enviada',
          },
        );
        responsePathCount += 1;
        const noResponse = await simulatePublishedWorkflow(
          template,
          buildWorkflowContext(template, 'Sin respuesta', { ...contextOptions, clinicText }),
          ['timeout', 'timeout'],
        );
        assert.equal(workflowStatus(noResponse), 'info_enviada', `${template.public_id}:${window}:no_response`);
        assert.equal(responseEvents(noResponse, ['condition/ai_analysis']).length, 0);
        noResponsePathCount += 1;
      }
      continue;
    }

    if (name.includes('Recordatorio y confirm')) {
      const contextOptions = {
        appointmentStart,
        bookingReference: bookingReferences.more_than_day_before,
        initialStatus: 'info_confirmada',
      };
      responseScenarioCount += await assertResponseMatrix(
        template,
        contextOptions,
        ['response'],
        'recordatorio_confirmado',
        {
          pathName: 'day_before:first_reminder',
          clinicText: '¿Me confirmas tu asistencia mañana?',
          baselineStatus: 'recordatorio_enviado',
        },
      );
      responsePathCount += 1;
      responseScenarioCount += await assertResponseMatrix(
        template,
        contextOptions,
        ['timeout', 'response'],
        'recordatorio_confirmado',
        {
          pathName: 'day_before:second_reminder',
          clinicText: '¿Me confirmas tu asistencia mañana?',
          baselineStatus: 'recordatorio_enviado',
        },
      );
      responsePathCount += 1;
      const noResponse = await simulatePublishedWorkflow(
        template,
        buildWorkflowContext(template, 'Sin respuesta', {
          ...contextOptions,
          clinicText: '¿Me confirmas tu asistencia mañana?',
        }),
        ['timeout', 'timeout'],
      );
      assert.equal(workflowStatus(noResponse), 'recordatorio_enviado', `${template.public_id}:reminders:no_response`);
      noResponsePathCount += 1;
      continue;
    }

    if (name === 'Recordatorio mismo día a las 8 ¿Sabes llegar?') {
      const contextOptions = {
        appointmentStart,
        bookingReference: bookingReferences.more_than_day_before,
        initialStatus: 'recordatorio_confirmado',
      };
      responseScenarioCount += await assertResponseMatrix(
        template,
        contextOptions,
        ['response'],
        'recordatorio_confirmado',
        {
          pathName: 'same_day:access_notice',
          clinicText: '¿Sabes llegar a la clínica para tu cita de hoy?',
          confirmationText: 'Sí, confirmo que sé llegar',
          baselineStatus: 'recordatorio_confirmado',
          thanksIntent: 'agradecimiento',
          thanksStatus: 'recordatorio_confirmado',
          thanksAcknowledgement: false,
          shortAcknowledgementIntent: 'agradecimiento',
          shortAcknowledgementStatus: 'recordatorio_confirmado',
          shortAcknowledgementAcknowledgement: false,
        },
      );
      responsePathCount += 1;
      const noResponse = await simulatePublishedWorkflow(
        template,
        buildWorkflowContext(template, 'Sin respuesta', {
          ...contextOptions,
          clinicText: '¿Sabes llegar a la clínica para tu cita de hoy?',
        }),
        ['timeout'],
      );
      assert.equal(workflowStatus(noResponse), 'recordatorio_confirmado', `${template.public_id}:access:no_response`);
      noResponsePathCount += 1;
      continue;
    }

    if (name === 'Cancelar cita sin confirmar la noche anterior') {
      const contextOptions = {
        appointmentStart,
        bookingReference: bookingReferences.more_than_day_before,
        initialStatus: 'recordatorio_enviado',
      };
      responseScenarioCount += await assertResponseMatrix(
        template,
        contextOptions,
        ['response'],
        'recordatorio_confirmado',
        {
          pathName: 'night_notice:response',
          clinicText: 'Necesitamos tu confirmación para mantener la cita de mañana. ¿Nos confirmas?',
          baselineStatus: 'recordatorio_enviado',
        },
      );
      responsePathCount += 1;
      const noResponse = await simulatePublishedWorkflow(
        template,
        buildWorkflowContext(template, 'Sin respuesta', {
          ...contextOptions,
          clinicText: 'Necesitamos tu confirmación para mantener la cita de mañana. ¿Nos confirmas?',
        }),
        ['timeout'],
      );
      assert.equal(workflowStatus(noResponse), 'cancelada', `${template.public_id}:night_notice:no_response`);
      noResponsePathCount += 1;
      continue;
    }

    if (template.trigger_type === 'message_received') {
      responseScenarioCount += await assertResponseMatrix(
        template,
        {
          appointmentStart,
          bookingReference: bookingReferences.more_than_day_before,
          initialStatus: 'recordatorio_enviado',
        },
        [],
        'recordatorio_confirmado',
        {
          pathName: 'unclaimed_inbound',
          clinicText: '¿Nos confirmas tu asistencia a la cita?',
          baselineStatus: 'recordatorio_enviado',
          responseAlreadyReceived: true,
          expectMixedSuppression: false,
          allowReviewReply: true,
        },
      );
      responsePathCount += 1;
      continue;
    }

    unsupported.push({ public_id: template.public_id, name, trigger_type: template.trigger_type });
  }

  assert.deepEqual(unsupported, [], `uncovered canonical workflow families: ${JSON.stringify(unsupported)}`);
  const canonicalAiNodeCount = Array.from(latest.values()).reduce((total, template) => {
    const nodes = Array.isArray(template.nodes) ? template.nodes : JSON.parse(template.nodes || '[]');
    return total + nodes.filter((node) => (
      node?.type === 'condition/ai_analysis'
      && node?.config?.preset_key === 'classify_intent'
    )).length;
  }, 0);
  assert.equal(responsePathCount, canonicalAiNodeCount, 'every canonical AI path must have a workflow contract');
  assert.equal(
    responseScenarioCount,
    responsePathCount * RESPONSE_MATRIX_SCENARIO_COUNT,
    `every response path must run all ${RESPONSE_MATRIX_SCENARIO_COUNT} scenarios`,
  );
  return {
    workflowTemplateCount,
    responsePathCount,
    responseScenarioCount,
    noResponsePathCount,
    bookingTimezoneBoundaryCount,
  };
}

Promise.all([
  testAtomicOutboxAndDuplicateClaim(),
  testEveryPublishedCanonicalAiNodeRunsRealPatientRegressions(),
  testEveryPublishedAppointmentWorkflowPath(),
])
  .then(async ([, coverage, workflowCoverage]) => {
    console.log(
      'inbound_appointment_intent_integration.test.js OK '
      + `(${coverage.canonicalNodeCount} canonical nodes, `
      + `${coverage.canonicalConfigCount} configurations x ${coverage.matrixScenarioCount} intent scenarios; `
      + `${workflowCoverage.workflowTemplateCount} workflows, `
      + `${workflowCoverage.responsePathCount} response paths x ${RESPONSE_MATRIX_SCENARIO_COUNT} = `
      + `${workflowCoverage.responseScenarioCount} scenarios, `
      + `${workflowCoverage.noResponsePathCount} no-response paths, `
      + `${workflowCoverage.bookingTimezoneBoundaryCount} Europe/Madrid boundary checks)`
    );
    await db.sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    try { await db.sequelize.close(); } catch (_closeError) {}
    process.exit(1);
  });
