'use strict';

const path = require('path');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const { Op } = require('sequelize');
// El bootstrap histórico de modelos enumera todos los modelos por consola.
// Este canario debe emitir únicamente su JSON seguro y parseable.
const originalConsoleLog = console.log;
console.log = () => undefined;
const db = require('../../../models');
console.log = originalConsoleLog;
const jobRequestsService = require('../../services/jobRequests.service');
const whatsappService = require('../../services/whatsapp.service');
const { normalizeWhatsappLocale } = require('../../lib/whatsapp-template-locale');

const FLOW_PUBLIC_ID = 'flw_07fdece82b719509';
const CLINIC_ID = 66;
const NODE_ID = 'N3';
const LANGUAGE = 'ca';
const SEND_CONFIRMATION = 'SEND_ONE_LOCALIZED_WHATSAPP';

function fail(message) {
  const error = new Error(message);
  error.isCanaryError = true;
  throw error;
}

function cleanString(value) {
  return String(value || '').trim();
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${label}_required`);
  return parsed;
}

function maskPhone(value) {
  const normalized = cleanString(value).replace(/\D/g, '');
  return normalized ? `***${normalized.slice(-4)}` : null;
}

function getMode() {
  const requested = process.argv.slice(2).find((arg) => arg.startsWith('--mode='));
  return cleanString(requested?.split('=')[1] || 'preflight').toLowerCase();
}

function madridHour() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    hour12: false,
  }).format(new Date()));
}

async function loadPreflight() {
  const runtimeNamespace = cleanString(
    process.env.JOB_RUNTIME_NAMESPACE || process.env.RUNTIME_NAMESPACE
  );
  if (runtimeNamespace !== 'staging') fail(`runtime_namespace_must_be_staging:${runtimeNamespace || 'missing'}`);

  const patientId = parsePositiveInt(process.env.QA_WHATSAPP_PATIENT_ID, 'qa_whatsapp_patient_id');
  const requestedRecipient = whatsappService.normalizePhoneNumber(
    cleanString(process.env.QA_WHATSAPP_RECIPIENT)
  );
  if (!requestedRecipient) fail('qa_whatsapp_recipient_required');

  const [patient, clinic, flow, clinicConfig] = await Promise.all([
    db.Paciente.findByPk(patientId, {
      attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil'],
      raw: true,
    }),
    db.Clinica.findByPk(CLINIC_ID, {
      attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica', 'direccion'],
      raw: true,
    }),
    db.AutomationFlowTemplateV2.findOne({
      where: {
        public_id: FLOW_PUBLIC_ID,
        is_active: true,
        published_at: { [Op.ne]: null },
      },
      order: [['version', 'DESC'], ['id', 'DESC']],
    }),
    whatsappService.getClinicConfig(CLINIC_ID),
  ]);

  if (!patient) fail('qa_patient_not_found');
  if (Number(patient.clinica_id) !== CLINIC_ID) fail('qa_patient_clinic_mismatch');
  const patientRecipient = whatsappService.normalizePhoneNumber(patient.telefono_movil);
  if (!patientRecipient || patientRecipient !== requestedRecipient) {
    fail('qa_recipient_does_not_match_patient');
  }
  if (!clinic) fail('qa_clinic_not_found');
  if (!flow) fail('qa_active_flow_not_found');
  if (Number(flow.clinic_id) !== CLINIC_ID) fail('qa_flow_clinic_mismatch');
  if (!clinicConfig?.accessToken || !clinicConfig?.phoneNumberId || !clinicConfig?.wabaId) {
    fail('qa_whatsapp_sender_not_operational');
  }

  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const node = nodes.find((candidate) => cleanString(candidate?.id) === NODE_ID);
  if (!node || cleanString(node.type) !== 'action/send_whatsapp') {
    fail('qa_whatsapp_node_not_found');
  }

  const routing = node?.config?.language_routing;
  const variant = routing?.variants?.[LANGUAGE];
  if (routing?.enabled !== true || cleanString(routing?.source) !== 'patient_preferred_language') {
    fail('qa_language_routing_not_published');
  }
  if (!variant || !variant.template_id || !variant.catalog_template_id) {
    fail('qa_catalan_variant_missing');
  }

  const template = await db.WhatsappTemplate.findByPk(Number(variant.template_id), {
    include: [{ model: db.WhatsappTemplateCatalog, as: 'catalog', required: false }],
  });
  const templateLocale = normalizeWhatsappLocale(template?.language || template?.catalog?.locale);
  if (!template || cleanString(template.status).toUpperCase() !== 'APPROVED') {
    fail('qa_catalan_template_not_approved');
  }
  if (!cleanString(template.meta_template_id)) fail('qa_catalan_template_missing_meta_id');
  if (templateLocale !== LANGUAGE) fail(`qa_catalan_template_locale_mismatch:${templateLocale || 'missing'}`);
  if (cleanString(template.waba_id) !== cleanString(clinicConfig.wabaId)) {
    fail('qa_catalan_template_waba_mismatch');
  }

  const hour = madridHour();
  if (!Number.isInteger(hour) || hour < 7 || hour >= 22) {
    fail(`qa_outside_madrid_delivery_window:${hour}`);
  }

  const idempotencyKey = `qa:whatsapp-language:v1:${requestedRecipient}:${LANGUAGE}`;
  const existingExecution = await db.FlowExecutionV2.findOne({
    where: { idempotency_key: idempotencyKey },
  });

  return {
    runtimeNamespace,
    patientId,
    requestedRecipient,
    patient,
    clinic,
    flow,
    node,
    template,
    clinicConfig,
    idempotencyKey,
    existingExecution,
  };
}

function safePreflightSummary(preflight) {
  return {
    ok: true,
    runtime_namespace: preflight.runtimeNamespace,
    clinic_id: CLINIC_ID,
    patient_id: preflight.patientId,
    recipient: maskPhone(preflight.requestedRecipient),
    flow_id: Number(preflight.flow.id),
    flow_version: Number(preflight.flow.version),
    node_id: NODE_ID,
    language: LANGUAGE,
    template_id: Number(preflight.template.id),
    template_status: cleanString(preflight.template.status).toUpperCase(),
    existing_execution_id: preflight.existingExecution?.id || null,
    existing_execution_status: preflight.existingExecution?.status || null,
  };
}

function buildContext(preflight) {
  const patient = {
    id: preflight.patientId,
    id_paciente: preflight.patientId,
    clinic_id: CLINIC_ID,
    clinica_id: CLINIC_ID,
    nombre: cleanString(preflight.patient.nombre) || 'Carlos',
    apellidos: cleanString(preflight.patient.apellidos),
    telefono: preflight.requestedRecipient,
    telefono_movil: preflight.requestedRecipient,
    idioma_preferido: LANGUAGE,
    preferred_language: LANGUAGE,
  };
  const clinic = {
    id: CLINIC_ID,
    id_clinica: CLINIC_ID,
    clinic_id: CLINIC_ID,
    clinica_id: CLINIC_ID,
    group_id: Number(preflight.clinic.grupoClinicaId) || null,
    grupo_id: Number(preflight.clinic.grupoClinicaId) || null,
    nombre: cleanString(preflight.clinic.nombre_clinica),
    nombre_clinica: cleanString(preflight.clinic.nombre_clinica),
    direccion: cleanString(preflight.clinic.direccion),
    timezone: 'Europe/Madrid',
  };
  const appointment = {
    id: null,
    id_cita: null,
    clinic_id: CLINIC_ID,
    clinica_id: CLINIC_ID,
    patient_id: preflight.patientId,
    paciente_id: preflight.patientId,
    hora: '12:00',
    tipo_cita: 'seguimiento',
    origin: 'qa',
  };

  return {
    communication_language: LANGUAGE,
    qa_marker: 'whatsapp_language_canary_v1',
    outputs: {},
    trigger: {
      type: 'qa_whatsapp_language',
      data: {
        clinic_id: CLINIC_ID,
        clinica_id: CLINIC_ID,
        patient_id: preflight.patientId,
        paciente_id: preflight.patientId,
        qa_marker: 'whatsapp_language_canary_v1',
      },
    },
    patient,
    paciente: { ...patient },
    clinic,
    clinica: { ...clinic },
    appointment,
    cita: { ...appointment },
    usuario: {
      nombre: 'Equip Clinicaclick',
      apellidos: '',
    },
  };
}

async function enqueueCanary(preflight) {
  if (cleanString(process.env.QA_WHATSAPP_CONFIRM) !== SEND_CONFIRMATION) {
    fail('qa_send_confirmation_missing');
  }
  if (preflight.existingExecution) {
    return {
      deduplicated: true,
      execution_id: preflight.existingExecution.id,
      status: preflight.existingExecution.status,
    };
  }

  return db.sequelize.transaction(async (transaction) => {
    const existing = await db.FlowExecutionV2.findOne({
      where: { idempotency_key: preflight.idempotencyKey },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existing) {
      return { deduplicated: true, execution_id: existing.id, status: existing.status };
    }

    const execution = await db.FlowExecutionV2.create({
      idempotency_key: preflight.idempotencyKey,
      template_version_id: preflight.flow.id,
      engine_version: preflight.flow.engine_version || 'v2',
      status: 'running',
      context: buildContext(preflight),
      current_node_id: NODE_ID,
      trigger_type: 'qa_whatsapp_language',
      trigger_entity_type: 'patient',
      trigger_entity_id: preflight.patientId,
      clinic_id: CLINIC_ID,
      group_id: Number(preflight.clinic.grupoClinicaId) || null,
      created_by: 1,
    }, { transaction });

    const job = await jobRequestsService.enqueueJobRequest({
      type: 'automations_v2_execute',
      priority: 'critical',
      origin: 'qa_whatsapp_language',
      payload: { execution_id: execution.id },
      requestedBy: 1,
      requestedByName: 'Clinicaclick QA',
      requestedByRole: 'admin',
      maxAttempts: 1,
    }, { transaction });

    return {
      deduplicated: false,
      execution_id: execution.id,
      job_request_id: job.id,
      status: execution.status,
    };
  });
}

async function readStatus(preflight) {
  const execution = preflight.existingExecution || await db.FlowExecutionV2.findOne({
    where: { idempotency_key: preflight.idempotencyKey },
  });
  if (!execution) return { exists: false };

  const deliveryKey = `flow:${execution.id}:node:${NODE_ID}:outbound`;
  const messages = await db.Message.findAll({
    where: { automation_delivery_key: deliveryKey },
    order: [['id', 'ASC']],
  });
  const message = messages[0] || null;
  const metadata = message?.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};

  return {
    exists: true,
    execution_id: execution.id,
    execution_status: execution.status,
    current_node_id: execution.current_node_id,
    last_error: execution.last_error,
    patient_visible_messages: messages.length,
    message_id: message?.id || null,
    message_status: message?.status || null,
    recipient: maskPhone(metadata.recipient),
    patient_language: metadata.patient_language || null,
    selected_language: metadata.selected_language || null,
    template_language: metadata.template_language || null,
    template_name: metadata.template_name || null,
    has_wamid: !!cleanString(metadata.wamid || message?.wamid),
  };
}

async function cancelFollowup(preflight) {
  const execution = preflight.existingExecution || await db.FlowExecutionV2.findOne({
    where: { idempotency_key: preflight.idempotencyKey },
  });
  if (!execution) return { cancelled: false, reason: 'execution_not_found' };

  const deliveryKey = `flow:${execution.id}:node:${NODE_ID}:outbound`;
  const message = await db.Message.findOne({ where: { automation_delivery_key: deliveryKey } });
  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  if (!message || !cleanString(metadata.wamid || message.wamid)) {
    fail('qa_cannot_cancel_before_wamid');
  }

  return db.sequelize.transaction(async (transaction) => {
    const [executionRows] = await db.FlowExecutionV2.update({
      status: 'cancelled',
      wait_until: null,
      waiting_meta: null,
      last_error: execution.last_error || 'qa_canary_completed',
    }, {
      where: {
        id: execution.id,
        status: { [Op.in]: ['running', 'waiting', 'paused'] },
      },
      transaction,
    });

    const [jobRows] = await db.sequelize.query(
      `UPDATE JobRequests
       SET status='cancelled', updated_at=NOW()
       WHERE type='automations_v2_execute'
         AND status IN ('pending','queued','waiting')
         AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.execution_id')) = :executionId`,
      {
        replacements: { executionId: String(execution.id) },
        transaction,
      }
    );

    return {
      cancelled: true,
      execution_id: execution.id,
      execution_rows: executionRows,
      job_rows: Number(jobRows?.affectedRows || jobRows || 0),
    };
  });
}

async function main() {
  const mode = getMode();
  if (!['preflight', 'send', 'status', 'cancel'].includes(mode)) {
    fail(`unsupported_mode:${mode}`);
  }

  const preflight = await loadPreflight();
  let result = safePreflightSummary(preflight);
  if (mode === 'send') result = { ...result, send: await enqueueCanary(preflight) };
  if (mode === 'status') result = { ...result, status: await readStatus(preflight) };
  if (mode === 'cancel') result = { ...result, cancel: await cancelFollowup(preflight) };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: cleanString(error?.message) || 'unknown_error',
    })}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close().catch(() => undefined);
  });
