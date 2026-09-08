'use strict';

const db = require('../../models');
const { isGlobalAdmin, STAFF_ROLES } = require('../lib/role-helpers');

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
    || ['waiting_approval', 'waiting_template_approval', 'blocked', 'held_meta', 'paused_review'].includes(normalized)
  ) return 'paused';
  if (['completed', 'delivered', 'sent', 'cancelled', 'archived'].includes(normalized)) return 'history';
  return 'active';
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
    const total = numberValue(counters.total ?? counters.eligible ?? counters.selected);
    const sent = numberValue(counters.sent ?? counters.processed);
    const failed = numberValue(counters.failed ?? counters.errors);
    const group = statusGroup(effectiveStatus);
    return [{
      id: `marketing:${row.id}`,
      source_id: row.id,
      source_type: 'marketing_list',
      title: dispatch.label || row.name || 'Envío de marketing',
      channel: String(row.channel || row.criteria?.channels?.[0] || 'whatsapp').toLowerCase(),
      status: effectiveStatus,
      status_group: group,
      clinic_ids: scopedClinicIds,
      clinic_name: scopedClinicIds.length === 1 ? clinicNameById.get(scopedClinicIds[0]) : `${scopedClinicIds.length} clínicas`,
      total,
      processed: group === 'history' ? total : sent + failed,
      pending: group === 'history' ? 0 : Math.max(0, total - sent - failed),
      failed,
      next_at: dispatch.next_allowed_at || null,
      cadence: dispatch.delay_ms ? `Un envío cada ${Math.round(numberValue(dispatch.delay_ms) / 60000)} minutos` : null,
      sender: dispatch.account_quality?.phone_number_id || null,
      error: dispatch.paused_reason || row.safety_gates?.reason || null,
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
        attributes: ['id', 'status', 'wait_until', 'context', 'last_error'],
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
    const clinicId = toInt(job.payload?.clinic_id);
    return {
      id: `lead:${job.id}`,
      source_id: job.id,
      source_type: 'lead_backfill',
      title: 'Primer contacto con leads que ya estaban pendientes',
      channel: 'whatsapp',
      status: effectiveStatus,
      status_group: statusGroup(effectiveStatus),
      clinic_ids: clinicId ? [clinicId] : [],
      clinic_name: clinicNameById.get(clinicId) || null,
      total,
      processed: sent + failed,
      pending: Math.max(waiting, total - sent - failed),
      failed,
      next_at: nextDates[0]?.toISOString() || null,
      cadence: 'Un envío cada 30 minutos por número emisor',
      sender: null,
      error: job.error_message || related.find((execution) => execution.last_error)?.last_error || null,
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
  return rows.map((row) => ({
    id: `email:${row.id}`,
    source_id: row.id,
    source_type: 'email',
    title: row.subject_key || row.template_key || 'Correo electrónico',
    channel: 'email',
    status: row.status,
    status_group: statusGroup(row.status),
    clinic_ids: [Number(row.clinica_id)],
    clinic_name: clinicNameById.get(Number(row.clinica_id)) || null,
    total: 1,
    processed: ['queued', 'sending'].includes(String(row.status)) ? 0 : 1,
    pending: ['queued', 'sending'].includes(String(row.status)) ? 1 : 0,
    failed: statusGroup(row.status) === 'error' ? 1 : 0,
    next_at: row.queued_at || null,
    cadence: null,
    sender: row.from_email || null,
    error: row.last_error_message || row.last_error_code || null,
    updated_at: row.updated_at,
  }));
}

async function listSendQueues({ userId }) {
  const clinics = await accessibleClinics(userId);
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
    summary: {
      active: items.filter((item) => item.status_group === 'active').length,
      paused: items.filter((item) => item.status_group === 'paused').length,
      error: items.filter((item) => item.status_group === 'error').length,
      history: items.filter((item) => item.status_group === 'history').length,
      pending_messages: items.reduce((sum, item) => sum + numberValue(item.pending), 0),
    },
  };
}

module.exports = { listSendQueues, statusGroup };
