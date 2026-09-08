'use strict';

const db = require('../../models');
const { isGlobalAdmin, STAFF_ROLES } = require('../lib/role-helpers');
const { resolveClinicScope } = require('../lib/clinicScope');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');

const { Op } = db.Sequelize;
const ACTIVE_MEMBERSHIP_WHERE = {
  [Op.or]: [{ estado_invitacion: 'aceptada' }, { estado_invitacion: null }],
};

function toInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function statusGroup(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (['failed', 'rejected', 'bounced', 'complained', 'suppressed', 'dead_letter'].includes(normalized)) return 'error';
  if (
    normalized.startsWith('paused')
    || ['pause_requested', 'waiting_approval', 'waiting_template_approval', 'blocked', 'held_meta', 'paused_review'].includes(normalized)
  ) return 'paused';
  if (['completed', 'delivered', 'sent', 'cancelled', 'archived'].includes(normalized)) return 'history';
  return 'active';
}

function statusPresentation(status) {
  const normalized = String(status || '').trim().toLowerCase();
  const presentations = {
    queued: {
      label: 'En cola',
      explanation: 'La cola está preparada y comenzará cuando le corresponda según su horario y dosificación.',
    },
    sending: {
      label: 'Enviando',
      explanation: 'Clinicaclick está enviando la tanda actual.',
    },
    scheduled: {
      label: 'Programada',
      explanation: 'La cola comenzará en la fecha indicada.',
    },
    waiting: {
      label: 'En espera',
      explanation: 'La cola espera a que llegue el momento del siguiente envío.',
    },
    waiting_next_batch: {
      label: 'Esperando siguiente tanda',
      explanation: 'La tanda actual ha terminado y la cola espera el intervalo configurado antes de continuar.',
    },
    waiting_template_approval: {
      label: 'Esperando aprobación de WhatsApp',
      explanation: 'La cola no enviará hasta que WhatsApp apruebe la plantilla necesaria.',
    },
    waiting_approval: {
      label: 'Pendiente de aprobación',
      explanation: 'La cola necesita una aprobación antes de poder comenzar.',
    },
    awaiting_delivery: {
      label: 'Esperando confirmación de WhatsApp',
      explanation: 'WhatsApp ha aceptado los mensajes. Clinicaclick espera sus confirmaciones de entrega o error antes de cerrar la cola.',
    },
    held_meta: {
      label: 'En revisión por WhatsApp',
      explanation: 'WhatsApp ha detenido temporalmente el envío mientras revisa la plantilla o la calidad del número.',
    },
    pause_requested: {
      label: 'Pausando',
      explanation: 'La pausa está solicitada y se aplicará antes de iniciar una nueva tanda.',
    },
    paused: {
      label: 'Pausada',
      explanation: 'La cola está pausada y no realizará nuevos envíos.',
    },
    paused_quality: {
      label: 'Pausada por calidad',
      explanation: 'La cola está pausada para proteger la calidad del número de WhatsApp.',
    },
    paused_limit: {
      label: 'Pausada por límite',
      explanation: 'La cola está pausada porque se ha alcanzado un límite de envío.',
    },
    paused_template: {
      label: 'Pausada por plantilla',
      explanation: 'La cola necesita una plantilla válida y aprobada antes de continuar.',
    },
    paused_config: {
      label: 'Pausada por configuración',
      explanation: 'La cola necesita completar su configuración antes de continuar.',
    },
    paused_review: {
      label: 'Pendiente de revisión',
      explanation: 'La cola necesita una revisión manual antes de poder continuar.',
    },
    blocked: {
      label: 'Bloqueada',
      explanation: 'La cola no puede continuar hasta que se resuelva el motivo indicado.',
    },
    failed: {
      label: 'Error',
      explanation: 'La cola se ha detenido por un error. Revisa el detalle antes de reanudarla.',
    },
    rejected: {
      label: 'Rechazado',
      explanation: 'El proveedor ha rechazado este envío.',
    },
    bounced: {
      label: 'Correo devuelto',
      explanation: 'El servidor de destino ha devuelto el correo.',
    },
    complained: {
      label: 'Marcado como no deseado',
      explanation: 'La persona destinataria ha marcado el correo como no deseado.',
    },
    suppressed: {
      label: 'Suprimido',
      explanation: 'El envío se ha detenido para proteger la reputación del remitente.',
    },
    dead_letter: {
      label: 'Error definitivo',
      explanation: 'El envío agotó sus reintentos y necesita revisión manual.',
    },
    completed: {
      label: 'Finalizada',
      explanation: 'La cola ha terminado y no quedan mensajes pendientes.',
    },
    delivered: {
      label: 'Entregado',
      explanation: 'El proveedor ha confirmado la entrega del mensaje.',
    },
    sent: {
      label: 'Enviado',
      explanation: 'El mensaje fue enviado correctamente.',
    },
    cancelled: {
      label: 'Cancelada',
      explanation: 'La cola fue cancelada y no realizará más envíos.',
    },
    archived: {
      label: 'Archivada',
      explanation: 'La cola está cerrada y archivada.',
    },
  };
  return presentations[normalized] || {
    label: normalized ? normalized.replace(/_/g, ' ') : 'Sin estado',
    explanation: null,
  };
}

function normalizeSearchText(...values) {
  return values
    .filter((value) => value !== null && value !== undefined)
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function marketingQueuePresentation(row = {}, dispatch = {}) {
  const criteria = row.criteria || {};
  const objectiveId = String(row.objective_id || '').trim().toLowerCase();
  const searchable = normalizeSearchText(
    dispatch.context,
    dispatch.label,
    row.name,
    row.source,
  );
  const isReviewRequest = [true, 1, '1', 'true'].includes(criteria.review_request)
    || searchable.includes('review_request')
    || searchable.includes('resena');

  if (isReviewRequest) {
    return {
      type: 'review_request',
      type_label: 'Solicitud de reseña',
      configuration_url: '/marketing/objetivos?objective=get_reviews',
      configuration_label: 'Abrir reseñas',
    };
  }
  if (objectiveId === 'mass_sends') {
    return {
      type: 'mass_send',
      type_label: 'Envío masivo',
      configuration_url: '/marketing/objetivos?objective=mass_sends&mass_send_view=campaigns',
      configuration_label: 'Abrir envíos masivos',
    };
  }
  if (objectiveId === 'reactivate_patients') {
    return {
      type: 'patient_reactivation',
      type_label: 'Reactivación de pacientes',
      configuration_url: '/marketing/objetivos?objective=reactivate_patients',
      configuration_label: 'Abrir reactivación',
    };
  }
  return {
    type: 'marketing_campaign',
    type_label: 'Campaña',
    configuration_url: objectiveId
      ? `/marketing/objetivos?objective=${encodeURIComponent(objectiveId)}`
      : '/marketing/objetivos',
    configuration_label: 'Abrir campaña',
  };
}

function latestDate(...values) {
  const dates = values
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()))
    .sort((left, right) => right.getTime() - left.getTime());
  return dates[0]?.toISOString() || null;
}

function formatDuration(milliseconds) {
  const minutes = Math.max(1, Math.round(numberValue(milliseconds) / 60000));
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? 'día' : 'días'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  }
  return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
}

function describeDispatchCadence(dispatch = {}) {
  const governance = dispatch.delivery_governance || {};
  const configuredBatch = Math.max(1, numberValue(dispatch.batch_size, 1));
  const effectiveBatch = Math.max(1, numberValue(governance.effective_batch_size, configuredBatch));
  const configuredDelay = numberValue(dispatch.delay_ms, 0);
  const effectiveDelay = numberValue(governance.effective_delay_ms, configuredDelay);
  if (!effectiveDelay) {
    return { cadence: `${effectiveBatch} ${effectiveBatch === 1 ? 'mensaje' : 'mensajes'} por tanda`, cadence_note: null };
  }
  const cadence = `Hasta ${effectiveBatch} ${effectiveBatch === 1 ? 'mensaje' : 'mensajes'} por tanda · siguiente tanda tras ${formatDuration(effectiveDelay)}`;
  const cadenceNote = effectiveBatch < configuredBatch
    ? `La tanda configurada es de ${configuredBatch}; se ha reducido temporalmente a ${effectiveBatch} para proteger el número.`
    : null;
  return { cadence, cadence_note: cadenceNote };
}

function humanizeQueueReason(reason) {
  const normalized = String(reason || '').trim();
  if (!normalized) return null;
  const labels = {
    outside_business_hours: 'Esperando al próximo horario de atención.',
    paused_by_user: 'Pausada manualmente.',
    cancelled_by_user: 'Cancelada manualmente.',
    legacy_messaging_limit_review: 'Detenida hasta revisar el límite de envío anterior.',
    read_rate_low: 'Pausada porque la tasa de lectura es baja.',
    early_warmup_opt_out: 'Pausada por una baja durante el calentamiento del número.',
    opt_out_rate_high: 'Pausada porque varias personas han solicitado la baja.',
    template_not_approved: 'La plantilla de WhatsApp todavía no está aprobada.',
    template_quality_assessment: 'WhatsApp está evaluando la calidad de la plantilla.',
  };
  return labels[normalized] || normalized.replace(/_/g, ' ');
}

async function accessibleClinics(userId) {
  const clinicRows = await db.Clinica.findAll({
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
    order: [['nombre_clinica', 'ASC']],
    raw: true,
  });
  if (isGlobalAdmin(Number(userId))) return clinicRows;
  const memberships = await db.UsuarioClinica.findAll({
    where: {
      id_usuario: Number(userId),
      rol_clinica: { [Op.in]: STAFF_ROLES },
      ...ACTIVE_MEMBERSHIP_WHERE,
    },
    attributes: ['id_clinica'],
    raw: true,
  });
  const allowed = new Set(memberships.map((row) => Number(row.id_clinica)));
  return clinicRows.filter((clinic) => allowed.has(Number(clinic.id_clinica)));
}

function listClinicIds(row) {
  return Array.from(new Set([
    toInt(row?.clinica_id),
    ...(Array.isArray(row?.clinic_ids) ? row.clinic_ids.map(toInt) : []),
  ].filter(Boolean)));
}

async function marketingQueues({ clinicIds, clinicNameById, clinicsByGroupId }) {
  if (!clinicIds.length) return [];
  const groupIds = Array.from(clinicsByGroupId.keys());
  const rows = await db.MarketingPatientList.findAll({
    where: {
      [Op.or]: [
        { clinica_id: { [Op.in]: clinicIds } },
        ...(groupIds.length ? [{ grupo_clinica_id: { [Op.in]: groupIds } }] : []),
      ],
    },
    order: [['updated_at', 'DESC']],
    limit: 250,
    raw: true,
  });
  const rowIds = rows.map((row) => Number(row.id)).filter(Number.isInteger);
  const itemStats = rowIds.length
    ? await db.sequelize.query(
        `
          SELECT
            list_id,
            SUM(CASE WHEN selected = 1 AND status = 'ready' THEN 1 ELSE 0 END) AS eligible,
            SUM(CASE WHEN dispatch_status IN ('sent','delivered','read','replied','failed') THEN 1 ELSE 0 END) AS processed,
            SUM(CASE WHEN selected = 1 AND status = 'ready' AND (dispatch_status IS NULL OR dispatch_status IN ('pending','queued','sending','accepted','held_quality')) THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN dispatch_status = 'failed' OR failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed,
            MAX(sent_at) AS last_sent_at
          FROM MarketingPatientListItems
          WHERE list_id IN (:rowIds)
          GROUP BY list_id
        `,
        { replacements: { rowIds }, type: db.Sequelize.QueryTypes.SELECT },
      )
    : [];
  const itemStatsByListId = new Map(itemStats.map((item) => [Number(item.list_id), item]));

  return rows.flatMap((row) => {
    const directClinicIds = listClinicIds(row).filter((id) => clinicIds.includes(id));
    const groupClinicIds = clinicsByGroupId.get(toInt(row.grupo_clinica_id)) || [];
    const scopedClinicIds = Array.from(new Set([...directClinicIds, ...groupClinicIds]));
    if (!scopedClinicIds.length) return [];
    const dispatch = row.criteria?.dispatch || {};
    const effectiveStatus = String(dispatch.status || row.status || '').toLowerCase();
    const visibleStatuses = new Set([
      'queued', 'sending', 'scheduled', 'waiting', 'waiting_next_batch',
      'waiting_template_approval', 'held_meta', 'awaiting_delivery',
      'paused', 'paused_quality', 'paused_limit', 'paused_template', 'paused_config', 'paused_review',
      'failed', 'completed', 'cancelled',
    ]);
    if (!visibleStatuses.has(effectiveStatus)) return [];
    const counters = row.counters || {};
    const stats = itemStatsByListId.get(Number(row.id)) || {};
    const total = numberValue(stats.eligible, counters.ready_total ?? counters.selected ?? counters.total);
    const processed = numberValue(stats.processed, counters.sent ?? counters.processed);
    const failed = numberValue(stats.failed, counters.failed ?? counters.errors);
    const pending = numberValue(stats.pending, Math.max(0, total - processed));
    const group = statusGroup(effectiveStatus);
    const statusCopy = statusPresentation(effectiveStatus);
    const cadence = describeDispatchCadence(dispatch);
    const presentation = marketingQueuePresentation(row, dispatch);
    const templateSnapshot = dispatch.template_snapshot || row.template_snapshot || {};
    const businessHours = dispatch.business_hours || {};
    const actionScope = toInt(row.grupo_clinica_id)
      ? `group:${toInt(row.grupo_clinica_id)}`
      : scopedClinicIds.join(',');
    const adminDecision = String(dispatch.admin_resolution?.decision || '').toLowerCase();
    const cannotResume = ['pause_requested', 'held_meta', 'paused_review', 'awaiting_delivery'].includes(effectiveStatus)
      || ['cancelled', 'changes_required'].includes(adminDecision);
    return [{
      id: `marketing:${row.id}`,
      source_id: row.id,
      source_type: 'marketing_list',
      ...presentation,
      title: dispatch.label || row.name || 'Envío de marketing',
      channel: String(row.channel || row.criteria?.channels?.[0] || 'whatsapp').toLowerCase(),
      status: effectiveStatus,
      status_group: group,
      status_label: statusCopy.label,
      status_explanation: statusCopy.explanation,
      clinic_ids: scopedClinicIds,
      clinic_name: scopedClinicIds.length === 1 ? clinicNameById.get(scopedClinicIds[0]) : `${scopedClinicIds.length} clínicas`,
      total,
      processed: group === 'history' ? total : Math.min(total, processed),
      pending: group === 'history' ? 0 : pending,
      failed,
      next_at: dispatch.next_allowed_at || null,
      cadence: cadence.cadence,
      cadence_note: cadence.cadence_note,
      batch_size: numberValue(dispatch.delivery_governance?.effective_batch_size, dispatch.batch_size || 1),
      configured_batch_size: numberValue(dispatch.batch_size, 1),
      schedule: businessHours.label || (
        businessHours.start_time && businessHours.end_time
          ? `${businessHours.start_time}-${businessHours.end_time}`
          : null
      ),
      template_name: templateSnapshot.display_name || templateSnapshot.name || null,
      message_preview: templateSnapshot.body || null,
      sender: dispatch.account_quality?.phone_number_id || null,
      error: humanizeQueueReason(dispatch.paused_reason || dispatch.last_error || row.safety_gates?.reason),
      can_pause: group === 'active' && pending > 0,
      can_resume: group === 'paused' && pending > 0 && !cannotResume,
      action_scope: actionScope,
      created_at: row.created_at,
      last_sent_at: latestDate(row.last_sent_at, stats.last_sent_at),
      updated_at: row.updated_at,
    }];
  });
}

async function leadBackfillQueues({ clinicIds, clinicNameById }) {
  if (!clinicIds.length) return [];
  const jobs = await db.JobRequest.findAll({
    where: { type: 'lead_auto_reply_backfill' },
    order: [['created_at', 'DESC']],
    limit: 100,
    raw: true,
  });
  const scopedJobs = jobs.filter((job) => clinicIds.includes(toInt(job.payload?.clinic_id)));
  const executionIds = scopedJobs.flatMap((job) => {
    const summary = job.result_summary?.result || job.result_summary || {};
    return Array.isArray(summary.execution_ids) ? summary.execution_ids.map(toInt).filter(Boolean) : [];
  });
  const executions = executionIds.length
    ? await db.FlowExecutionV2.findAll({
        where: { id: { [Op.in]: executionIds } },
        attributes: ['id', 'status', 'wait_until', 'context', 'last_error', 'created_at', 'updated_at'],
        raw: true,
      })
    : [];
  const executionById = new Map(executions.map((execution) => [Number(execution.id), execution]));

  return scopedJobs.map((job) => {
    const summary = job.result_summary?.result || job.result_summary || {};
    const ids = Array.isArray(summary.execution_ids) ? summary.execution_ids.map(toInt).filter(Boolean) : [];
    const related = ids.map((id) => executionById.get(id)).filter(Boolean);
    const sent = related.filter((execution) => execution.context?.outputs?.N9?.message_id || execution.context?.outputs?.N7?.message_id).length;
    const failed = related.filter((execution) => ['failed', 'dead_letter'].includes(String(execution.status)) || execution.last_error).length;
    const waiting = related.filter((execution) => ['waiting', 'running'].includes(String(execution.status))).length;
    const nextDates = related.map((execution) => execution.wait_until ? new Date(execution.wait_until) : null)
      .filter((date) => date && Number.isFinite(date.getTime()) && date.getTime() >= Date.now())
      .sort((left, right) => left.getTime() - right.getTime());
    const total = numberValue(summary.total, ids.length);
    const effectiveStatus = failed > 0 && waiting === 0
      ? 'failed'
      : waiting > 0
        ? 'waiting'
        : String(job.status || 'completed');
    const group = statusGroup(effectiveStatus);
    const statusCopy = statusPresentation(effectiveStatus);
    const clinicId = toInt(job.payload?.clinic_id);
    const lastSentAt = latestDate(...related.flatMap((execution) => [
      execution.context?.outputs?.N9?.at,
      execution.context?.outputs?.N7?.at,
    ]));
    return {
      id: `lead:${job.id}`,
      source_id: job.id,
      source_type: 'lead_backfill',
      type: 'lead_first_contact',
      type_label: 'Primer contacto con leads',
      configuration_url: '/marketing/leads',
      configuration_label: 'Abrir configuración de leads',
      title: 'Primer contacto con leads que ya estaban pendientes',
      channel: 'whatsapp',
      status: effectiveStatus,
      status_group: group,
      status_label: statusCopy.label,
      status_explanation: statusCopy.explanation,
      clinic_ids: clinicId ? [clinicId] : [],
      clinic_name: clinicNameById.get(clinicId) || null,
      total,
      processed: group === 'history' ? total : sent + failed,
      pending: group === 'history' ? 0 : Math.max(waiting, total - sent - failed),
      failed,
      next_at: nextDates[0]?.toISOString() || null,
      cadence: 'Un envío cada 30 minutos por número emisor',
      cadence_note: 'Solo se dosifican así los leads que ya estaban pendientes al activar la automatización.',
      message_preview: 'Primer mensaje automático de contacto configurado en la automatización de leads.',
      template_name: null,
      schedule: 'Dentro del horario de atención de la clínica',
      can_pause: false,
      can_resume: false,
      action_scope: clinicId ? String(clinicId) : null,
      sender: null,
      error: job.error_message || related.find((execution) => execution.last_error)?.last_error || null,
      created_at: job.created_at,
      last_sent_at: lastSentAt,
      updated_at: job.updated_at,
    };
  });
}

async function emailQueues({ clinicIds, clinicNameById }) {
  if (!clinicIds.length) return [];
  const rows = await db.EmailMessage.findAll({
    where: {
      clinica_id: { [Op.in]: clinicIds },
      status: { [Op.in]: ['queued', 'sending', 'failed', 'rejected', 'bounced', 'complained', 'suppressed'] },
    },
    order: [['updated_at', 'DESC']],
    limit: 100,
    raw: true,
  });
  return rows.map((row) => {
    const group = statusGroup(row.status);
    const statusCopy = statusPresentation(row.status);
    const isMarketing = String(row.stream || '').toLowerCase() === 'marketing';
    return {
      id: `email:${row.id}`,
      source_id: row.id,
      source_type: 'email',
      type: isMarketing ? 'marketing_email' : 'transactional_email',
      type_label: isMarketing ? 'Correo comercial' : 'Correo transaccional',
      configuration_url: null,
      configuration_label: null,
      title: row.subject_key || row.template_key || 'Correo electrónico',
      channel: 'email',
      status: row.status,
      status_group: group,
      status_label: statusCopy.label,
      status_explanation: statusCopy.explanation,
      clinic_ids: [Number(row.clinica_id)],
      clinic_name: clinicNameById.get(Number(row.clinica_id)) || null,
      total: 1,
      processed: ['queued', 'sending'].includes(String(row.status)) ? 0 : 1,
      pending: ['queued', 'sending'].includes(String(row.status)) ? 1 : 0,
      failed: group === 'error' ? 1 : 0,
      next_at: row.queued_at || null,
      cadence: null,
      cadence_note: null,
      message_preview: row.subject_key || row.template_key || null,
      template_name: row.template_key || null,
      schedule: null,
      can_pause: false,
      can_resume: false,
      action_scope: String(row.clinica_id),
      sender: row.from_email || null,
      error: row.last_error_message || row.last_error_code || null,
      created_at: row.created_at,
      last_sent_at: row.sent_at || null,
      updated_at: row.updated_at,
    };
  });
}

async function resolveScopedClinics({ userId, scopeRaw }) {
  const clinics = await accessibleClinics(userId);
  const normalizedScope = String(scopeRaw || '').trim();
  if (!normalizedScope || normalizedScope.toLowerCase() === 'all') return clinics;
  const requested = await resolveClinicScope(normalizedScope, { allowAll: false });
  if (!requested.isValid || requested.notFound) {
    const error = new Error('El ámbito de clínicas seleccionado no es válido.');
    error.status = 400;
    throw error;
  }
  const requestedIds = new Set(requested.clinicIds.map(Number));
  return clinics.filter((clinic) => requestedIds.has(Number(clinic.id_clinica)));
}

async function listSendQueues({ userId, scopeRaw }) {
  const clinics = await resolveScopedClinics({ userId, scopeRaw });
  const clinicIds = clinics.map((clinic) => Number(clinic.id_clinica));
  const clinicNameById = new Map(clinics.map((clinic) => [Number(clinic.id_clinica), clinic.nombre_clinica]));
  const clinicsByGroupId = new Map();
  for (const clinic of clinics) {
    const groupId = toInt(clinic.grupoClinicaId);
    if (!groupId) continue;
    clinicsByGroupId.set(groupId, [
      ...(clinicsByGroupId.get(groupId) || []),
      Number(clinic.id_clinica),
    ]);
  }
  const [marketing, leads, email] = await Promise.all([
    marketingQueues({ clinicIds, clinicNameById, clinicsByGroupId }),
    leadBackfillQueues({ clinicIds, clinicNameById }),
    emailQueues({ clinicIds, clinicNameById }),
  ]);
  const items = [...leads, ...marketing, ...email]
    .sort((left, right) => new Date(right.updated_at || 0).getTime() - new Date(left.updated_at || 0).getTime());
  return {
    items,
    clinics: clinics.map((clinic) => ({ id: clinic.id_clinica, name: clinic.nombre_clinica })),
    scope: {
      requested: String(scopeRaw || 'all'),
      clinic_ids: clinicIds,
      label: clinics.length === 1
        ? clinics[0].nombre_clinica
        : `${clinics.length} clínicas`,
    },
    summary: {
      total: items.length,
      active: items.filter((item) => item.status_group === 'active').length,
      paused: items.filter((item) => item.status_group === 'paused').length,
      error: items.filter((item) => item.status_group === 'error').length,
      history: items.filter((item) => item.status_group === 'history').length,
      pending_messages: items.reduce((sum, item) => sum + numberValue(item.pending), 0),
    },
  };
}

async function mutateSendQueue({ userId, queueId, action }) {
  const match = /^marketing:(\d+)$/.exec(String(queueId || '').trim());
  if (!match) {
    const error = new Error('Esta cola todavía no admite pausa manual.');
    error.status = 409;
    throw error;
  }
  const list = await db.MarketingPatientList.findByPk(Number(match[1]));
  if (!list) {
    const error = new Error('Cola de envío no encontrada.');
    error.status = 404;
    throw error;
  }
  const actionScopeRaw = toInt(list.grupo_clinica_id)
    ? `group:${toInt(list.grupo_clinica_id)}`
    : [toInt(list.clinica_id), ...(Array.isArray(list.clinic_ids) ? list.clinic_ids.map(toInt) : [])]
        .filter(Boolean)
        .join(',');
  const scope = await resolveClinicScope(actionScopeRaw, { allowAll: false });
  if (!scope.isValid || !(await hasMarketingClinicScopeAccess({
    userId,
    clinicIds: scope.clinicIds,
    access: 'write',
  }))) {
    const error = new Error('No tienes permiso para modificar esta cola.');
    error.status = 403;
    throw error;
  }
  const marketingBulkSendsService = require('./marketingBulkSends.service');
  if (action === 'pause') {
    return marketingBulkSendsService.pauseCampaignDispatch(
      scope,
      list.id,
      { reason: 'paused_by_user' },
      userId,
    );
  }
  if (action === 'resume') {
    return marketingBulkSendsService.resumeCampaignDispatch(
      scope,
      list.id,
      {},
      { userId },
    );
  }
  const error = new Error('Acción de cola no válida.');
  error.status = 400;
  throw error;
}

module.exports = {
  listSendQueues,
  mutateSendQueue,
  statusGroup,
  statusPresentation,
  describeDispatchCadence,
  humanizeQueueReason,
  marketingQueuePresentation,
};
