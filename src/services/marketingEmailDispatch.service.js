'use strict';

const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const db = require('../../models');
const emailDelivery = require('./emailDelivery.service');
const emailTemplates = require('./emailTemplates.service');
const emailProvider = require('./emailProvider.service');
const marketingEmail = require('./marketingEmail.service');
const jobRequests = require('./jobRequests.service');
const { resolveLastAttendedAppointmentDate } = require('../lib/marketing-template-variables');
const publicLinks = require('../lib/marketingEmailPublicLinks');
const channelSchedules = require('../lib/marketing-channel-schedules');

const JOB_TYPE = 'marketing_bulk_email_dispatch';
const DEFAULT_BATCH_SIZE = Math.max(1, Number.parseInt(process.env.MARKETING_EMAIL_BATCH_SIZE || '100', 10) || 100);
const DEFAULT_BATCH_DELAY_MS = Math.max(60 * 1000, Number.parseInt(process.env.MARKETING_EMAIL_BATCH_DELAY_MS || '120000', 10) || 120000);
const EMAIL_DELIVERY_TERMINAL = new Set(['sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed', 'rejected', 'cancelled']);

function fail(code, status, message) {
  const error = new Error(message || code);
  error.code = code;
  error.status = status;
  throw error;
}

// Shared purpose gate derives the recipient's clinic from persisted campaign
// records, not the caller's group sender. Lazy require avoids the existing
// bulk-sends/email service dependency cycle.
async function assertReviewAllowed(list, item, forceReview = false) {
  return require('./marketingBulkSends.service').assertReviewRequestCommunicationAllowed({
    list, item, forceReview, channel: 'email',
  });
}
function denyUnverifiedReviewScope(message) {
  throw Object.assign(new Error(message || 'review_communication_scope_unverified'), {
    code: 'review_communication_scope_unverified', reason: 'review_communication_scope_unverified',
    status: 403, statusCode: 403, retryable: false,
  });
}

/** Called again at the actual email transport boundary, including old queued
 * messages which predate explicit purpose metadata. This is read-only. */
async function assertEmailReviewCanDispatch(message, { recipientEmail = null } = {}) {
  const current = message?.id ? await db.EmailMessage.findByPk(message.id, {
    attributes: ['id', 'clinica_id', 'paciente_id', 'stream', 'template_key', 'related_type', 'related_id', 'metadata'],
  }) : null;
  if (!current) fail('email_outbox_no_longer_available', 409, 'El mensaje de email ya no está disponible.');
  const metadata = current.metadata && typeof current.metadata === 'object' ? current.metadata : {};
  const eligibility = require('../lib/whatsappAppointmentEligibility');
  const communication = { metadata, templateName: current.template_key };
  const explicitReview = eligibility.nonOperationalClinicCommunication(communication);
  if (explicitReview) eligibility.assertClinicNonOperationalAllowed(Number(current.clinica_id), communication);
  const relatedCampaign = ['marketing_bulk_send', 'marketing_bulk_send_test'].includes(current.related_type);
  const checkPrivacyRefusal = async (clinicId, patientId) => {
    if (![66, 72].includes(Number(clinicId))) return;
    await require('../lib/bs-privacy-commercial-preferences').assertCommercialAllowed({ db, clinicIds: [Number(clinicId)],
      patientIds: Number(patientId) > 0 ? [Number(patientId)] : null, email: recipientEmail });
  };
  if (current.stream === 'marketing' || relatedCampaign) await checkPrivacyRefusal(current.clinica_id, current.paciente_id);
  // Other domains may legitimately use a list_id; it is not campaign authority
  // without the actual marketing stream/relation. Purpose-only review emails
  // have already passed the clinic-wide gate above.
  if (!relatedCampaign && current.stream !== 'marketing') return true;
  const relatedIds = relatedCampaign ? /^(\d+):(\d+)$/.exec(String(current.related_id || '')) : null;
  const listId = Number(relatedIds?.[1] || metadata.list_id || 0);
  if (!listId) {
    if (relatedCampaign) denyUnverifiedReviewScope('El email de campaña no conserva su lista de destinatarios.');
    return true;
  }
  const itemId = Number((current.related_type === 'marketing_bulk_send' ? relatedIds?.[2] : 0) || metadata.item_id || 0);
  const list = await db.MarketingPatientList.findByPk(listId);
  const item = itemId ? await db.MarketingPatientListItem.findOne({ where: { id: itemId, list_id: listId } }) : null;
  // A deleted campaign/recipient cannot turn an unclassifiable old outbox into
  // ordinary marketing permission, including old campaign test messages.
  if (!list || itemId && !item) denyUnverifiedReviewScope('El email de campaña no conserva su lista o destinatario verificados.');
  await checkPrivacyRefusal(item?.clinica_id || list.clinica_id, item?.paciente_id || current.paciente_id);
  const decision = await assertReviewAllowed(list, item, explicitReview);
  if (decision.review) {
    eligibility.assertClinicNonOperationalAllowed(Number(current.clinica_id), {
      metadata: { communication_purpose: 'review_request' },
    });
    if (Number(current.clinica_id) !== decision.clinicId || metadata.list_id && Number(metadata.list_id) !== listId
      || current.related_type === 'marketing_bulk_send' && metadata.item_id && Number(metadata.item_id) !== itemId) {
      denyUnverifiedReviewScope('La clínica de la solicitud de reseña no coincide con su destinatario.');
    }
  }
  return true;
}

function plain(value) {
  return value?.get ? value.get({ plain: true }) : value;
}

function scopeKeyForList(list) {
  if (list.scope_type === 'group' && list.grupo_clinica_id) return `group:${list.grupo_clinica_id}`;
  if (list.clinica_id) return `clinic:${list.clinica_id}`;
  fail('marketing_email_scope_missing', 409, 'La campaña no tiene un ámbito válido para email.');
}

async function assetsForList(list) {
  const criteria = list.criteria || {};
  const senderId = Number(list.email_sender_identity_id || criteria.email_sender_identity_id || 0);
  const templateId = Number(list.email_template_id || criteria.email_template_id || 0);
  const scopeKey = scopeKeyForList(list);
  const [sender, template] = await Promise.all([
    db.EmailSenderIdentity.findOne({ where: { id: senderId, scope_key: scopeKey }, include: [{ model: db.EmailSendingDomain, as: 'domain' }] }),
    db.MarketingEmailTemplate.findOne({ where: { id: templateId, scope_key: scopeKey, status: 'ready' } }),
  ]);
  if (!sender || sender.status !== 'active' || sender.verification_status !== 'verified'
    || sender.domain?.verification_status !== 'verified' || sender.domain?.dkim_status !== 'verified') {
    fail('marketing_email_sender_not_ready', 409, 'El remitente de email o su firma DKIM todavía no están verificados.');
  }
  if (!template) fail('marketing_email_template_not_ready', 409, 'Selecciona una plantilla de email válida.');
  return { sender, template: marketingEmail.compileStoredTemplate(template), scopeKey };
}

async function assertReady(list, { validateRecipients = false } = {}) {
  const provider = emailProvider.publicConfig();
  if (provider.enabled !== true || provider.marketingEnabled !== true
    || (provider.provider === 'ses' && (provider.brokerEnabled !== true || provider.brokerConfigured !== true))) {
    fail('marketing_email_provider_not_ready', 503, 'El proveedor de email comercial todavía no está operativo.');
  }
  const assets = await assetsForList(list);
  const itemWhere = { list_id: list.id, status: 'ready', selected: true, email: { [Op.ne]: null } };
  const eligible = await db.MarketingPatientListItem.count({
    where: itemWhere,
  });
  if (!eligible) fail('marketing_email_no_recipients', 409, 'No hay destinatarios con email válido en esta campaña.');
  if (validateRecipients) {
    const rows = await db.MarketingPatientListItem.findAll({ where: itemWhere, order: [['id', 'ASC']] });
    const clinics = new Map();
    const missingCounts = new Map();
    for (const item of rows) {
      if (list.scope_type === 'group' && !item.clinica_id) {
        fail('marketing_email_recipient_clinic_missing', 409, 'Hay contactos sin una clínica asignada dentro del grupo.');
      }
      const clinicId = Number(item.clinica_id || list.clinica_id || 0);
      if (!clinics.has(clinicId)) clinics.set(clinicId, clinicId ? await db.Clinica.findByPk(clinicId) : null);
      const context = { ...templateContext({ list, item, clinic: clinics.get(clinicId) }), ...publicLinks.systemVariables() };
      const missing = emailTemplates.missingTemplateVariables(
        context,
        campaignSubject(list, assets.template),
        campaignPreheader(list, assets.template),
        assets.template.rendered_html,
        assets.template.rendered_text
      );
      for (const variable of missing) missingCounts.set(variable, (missingCounts.get(variable) || 0) + 1);
    }
    if (missingCounts.size) {
      const details = [...missingCounts.entries()].map(([variable, count]) => ({ variable, count }));
      const error = new Error(`Faltan datos para completar ${details.length} variable(s) de la plantilla de email.`);
      error.code = 'marketing_email_template_variables_missing';
      error.status = 409;
      error.details = { missing_variables: details };
      throw error;
    }
  }
  return { ...assets, eligible };
}

function emailStatus(item) {
  const value = plain(item)?.channel_status;
  return value && typeof value === 'object' ? value.email || {} : {};
}

function emailPending(item) {
  const status = String(emailStatus(item).status || 'pending').toLowerCase();
  return !['queued', 'sending', 'accepted', ...EMAIL_DELIVERY_TERMINAL].includes(status);
}

function emailDeliveryPending(item) {
  const status = String(emailStatus(item).status || 'pending').toLowerCase();
  return !EMAIL_DELIVERY_TERMINAL.has(status);
}

async function getEmailDispatchProgress(list) {
  const [counts] = await db.sequelize.query(`
    SELECT COUNT(*) AS total_to_send,
      SUM(status IN ('accepted', 'sent', 'delivered', 'bounced', 'complained') OR sent_at IS NOT NULL OR delivered_at IS NOT NULL) AS sent,
      SUM(status = 'delivered' OR delivered_at IS NOT NULL) AS delivered,
      SUM(status IN ('bounced', 'complained', 'suppressed', 'failed', 'rejected', 'cancelled')) AS failed
    FROM (
      SELECT COALESCE(LOWER(JSON_UNQUOTE(JSON_EXTRACT(channel_status, '$.email.status'))), '') AS status,
        NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(channel_status, '$.email.sent_at')), 'null'), '') AS sent_at,
        NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(channel_status, '$.email.delivered_at')), 'null'), '') AS delivered_at
      FROM MarketingPatientListItems
      WHERE list_id = :listId AND selected = 1 AND status = 'ready' AND email IS NOT NULL
    ) AS recipients
  `, { replacements: { listId: list.id }, type: QueryTypes.SELECT });
  const sent = Number(counts?.sent || 0);
  const total = Number(counts?.total_to_send || 0);
  return {
    ...list.email_dispatch,
    channel: 'email',
    total_to_send: total,
    sent,
    delivered: Number(counts?.delivered || 0),
    failed: Number(counts?.failed || 0),
    progress_percent: total ? Math.round(sent / total * 100) : 0,
  };
}

function mergeEmailStatus(item, patch) {
  const current = plain(item)?.channel_status;
  return { ...(current && typeof current === 'object' ? current : {}), email: { ...emailStatus(item), ...patch } };
}

async function cancelPendingJob(dispatch, reason) {
  if (!dispatch?.job_id || !db.JobRequest) return false;
  const [count] = await db.JobRequest.update({
    status: 'cancelled',
    next_run_at: null,
    error_message: reason,
  }, {
    where: {
      id: dispatch.job_id,
      status: { [Op.in]: ['pending', 'queued', 'waiting'] },
    },
  });
  return Number(count || 0) > 0;
}

async function setDispatchState(list, status, patch = {}) {
  const current = list.email_dispatch || {};
  const next = { ...current, ...patch, status };
  await list.update({ email_dispatch: next });
  return next;
}

async function cancelDispatch(list, { userId = null, reason = 'Cancelado por el usuario' } = {}) {
  const current = list.email_dispatch || {};
  if (!current.status || ['completed', 'cancelled'].includes(String(current.status))) return current;
  await cancelPendingJob(current, reason);
  return setDispatchState(list, 'cancelled', {
    cancel_requested: true,
    next_allowed_at: null,
    cancelled_at: new Date().toISOString(),
    cancelled_by: userId,
    cancel_reason: reason,
  });
}

async function pauseDispatch(list, { userId = null, reason = 'paused_by_user' } = {}) {
  const current = list.email_dispatch || {};
  if (!current.status || ['completed', 'cancelled', 'paused'].includes(String(current.status))) return current;
  await cancelPendingJob(current, 'Cola de email pausada manualmente');
  return setDispatchState(list, 'paused', {
    cancel_requested: false,
    next_allowed_at: null,
    paused_at: new Date().toISOString(),
    paused_by: userId,
    paused_reason: reason,
  });
}

async function resumeDispatch(list, { userId = null } = {}) {
  const current = list.email_dispatch || {};
  if (!['paused', 'cancelled', 'failed'].includes(String(current.status || ''))) return current;
  await setDispatchState(list, 'ready', {
    cancel_requested: false,
    paused_reason: null,
    next_allowed_at: null,
    resumed_at: new Date().toISOString(),
    resumed_by: userId,
    job_id: null,
  });
  await list.reload();
  return enqueueDispatch(list, { userId, resume: true });
}

async function enqueueDispatch(list, { userId = null, scheduledAt = undefined, resume = false } = {}) {
  const current = list.email_dispatch || {};
  if (['queued', 'sending', 'waiting_next_batch', 'scheduled'].includes(String(current.status || ''))) {
    return current;
  }
  if (scheduledAt === undefined) {
    const channels = Array.isArray(list.criteria?.channels) ? list.criteria.channels : ['email'];
    scheduledAt = channelSchedules.scheduledAtFor(channelSchedules.resolveSchedules(list.criteria || {}, {}, channels), 'email', { resume });
  }
  const nextRunAt = scheduledAt && new Date(scheduledAt).getTime() > Date.now() ? new Date(scheduledAt) : null;
  const job = await jobRequests.enqueueJobRequest({
    type: JOB_TYPE,
    payload: { list_id: list.id },
    priority: 'normal',
    status: nextRunAt ? 'waiting' : 'pending',
    origin: 'marketing_bulk_email',
    requestedBy: userId,
    maxAttempts: 1,
    nextRunAt,
  });
  const dispatch = {
    status: nextRunAt ? 'scheduled' : 'queued',
    job_id: job.id,
    batch_size: Number(current.batch_size || DEFAULT_BATCH_SIZE),
    delay_ms: Number(current.delay_ms || DEFAULT_BATCH_DELAY_MS),
    queued_at: new Date().toISOString(),
    next_allowed_at: nextRunAt?.toISOString() || null,
    cancel_requested: false,
  };
  await list.update({ email_dispatch: dispatch });
  if (!nextRunAt) {
    try { await require('./jobScheduler.service').triggerImmediate(job.id); } catch (_) { /* scheduler polling remains the owner */ }
  }
  await db.MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_email_dispatch_queued',
    channel: 'email',
    payload: { job_id: job.id, scheduled_at: nextRunAt?.toISOString() || null },
    occurred_at: new Date(),
  });
  return dispatch;
}

function clinicName(clinic) {
  return String(clinic?.nombre_clinica || clinic?.nombre || 'tu clínica').trim();
}

function templateContext({ list, item, clinic }) {
  const value = plain(item);
  const fullName = String(value.name || '').trim();
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  const resolvedClinicName = clinicName(clinic);
  const reviewSenderName = String(
    list?.criteria?.review_sender_name
    || list?.criteria?.firma_resenas
    || ''
  ).trim();
  return {
    ...(value.custom_fields && typeof value.custom_fields === 'object' ? value.custom_fields : {}),
    nombre: nameParts[0] || 'Hola',
    nombre_paciente: nameParts[0] || 'Hola',
    apellido: nameParts.slice(1).join(' '),
    nombre_completo: fullName,
    email: value.email,
    telefono: value.phone || '',
    clinica: resolvedClinicName,
    nombre_clinica: resolvedClinicName,
    firma_resenas: reviewSenderName,
    fecha_ultima_cita_asistida: resolveLastAttendedAppointmentDate(value),
  };
}

function campaignSubject(list, template) {
  return String(list.criteria?.email_subject || template.subject || '').trim();
}

function campaignPreheader(list, template) {
  return String(list.criteria?.email_preheader ?? template.preheader ?? '').trim();
}

function assertTemplateVariables(template, variables, list) {
  const missing = emailTemplates.missingTemplateVariables(
    { ...variables, ...publicLinks.systemVariables() },
    campaignSubject(list, template),
    campaignPreheader(list, template),
    template.rendered_html,
    template.rendered_text
  );
  if (!missing.length) return;
  const error = new Error(`Faltan datos para completar la plantilla de email: ${missing.join(', ')}.`);
  error.code = 'marketing_email_template_variables_missing';
  error.status = 409;
  error.details = { missing_variables: missing.map(variable => ({ variable, count: 1 })) };
  throw error;
}

function composeCampaignContext({ list, item, clinic, template, links = publicLinks.PREVIEW_LINKS }) {
  const variables = { ...templateContext({ list, item, clinic }), ...publicLinks.systemVariables(links) };
  assertTemplateVariables(template, variables, list);
  return {
    composer_version: 2,
    subject: emailTemplates.assertSafeSubject(emailTemplates.replaceVars(campaignSubject(list, template), variables)),
    preheader: emailTemplates.replaceVars(campaignPreheader(list, template), variables),
    body_html: emailTemplates.replaceVars(template.rendered_html, variables, { html: true }),
    body_text: emailTemplates.replaceVars(template.rendered_text, variables),
    ...links,
    show_clinicaclick_branding: template.design?.show_clinicaclick_branding !== false,
  };
}

function prepareMessageContext({ list, item, clinic, template, scopeKey, unsubscribeUrl }) {
  return async ({ publicId, recipientHash, transaction }) => {
    const links = publicLinks.messageLinks({ publicId, recipientHash, scopeKey, unsubscribeUrl });
    const context = composeCampaignContext({ list, item, clinic, template, links });
    const rendered = emailTemplates.renderMarketingCampaign(context);
    const group = scopeKey.startsWith('group:')
      ? await db.GrupoClinica.findByPk(Number(scopeKey.slice(6)), { transaction, attributes: ['nombre_grupo'] }) : null;
    const scopeLabel = group ? `Grupo ${group.nombre_grupo}` : (scopeKey.startsWith('group:') ? 'el grupo de clínicas' : clinicName(clinic));
    return {
      composer_version: 2,
      unsubscribe_url: links.unsubscribe_url,
      browser_view_url: links.browser_view_url,
      preferences_url: links.preferences_url,
      marketing_email_snapshot: publicLinks.sealSnapshot({ publicId, recipientHash, scopeKey, scopeLabel, expiresAt: links.expires_at, rendered }),
    };
  };
}

async function queueItem({ list, item, sender, template, scopeKey }) {
  const reviewScope = await assertReviewAllowed(list, item);
  if (list.scope_type === 'group' && !item.clinica_id) {
    fail('marketing_email_recipient_clinic_missing', 409, 'El contacto no está asignado a una clínica del grupo.');
  }
  const recipientEmail = emailDelivery.normalizeEmail(item.email);
  const unsubscribeUrl = await marketingEmail.issueUnsubscribe({
    scopeKey,
    clinicaId: item.clinica_id || list.clinica_id,
    groupId: list.grupo_clinica_id,
    listId: list.id,
    itemId: item.id,
    recipientEmail,
  });
  const clinic = item.clinica_id ? await db.Clinica.findByPk(item.clinica_id) : (list.clinica_id ? await db.Clinica.findByPk(list.clinica_id) : null);
  const variables = templateContext({ list, item, clinic });
  assertTemplateVariables(template, variables, list);
  const result = await emailDelivery.queueEmail({
    stream: 'marketing',
    templateKey: 'marketing.campaign',
    templateVersion: String(template.version || 1),
    subjectKey: `marketing.template.${template.id}`,
    recipientEmail,
    recipientKind: 'marketing_contact',
    clinicaId: item.clinica_id || list.clinica_id,
    pacienteId: item.paciente_id,
    relatedType: 'marketing_bulk_send',
    relatedId: `${list.id}:${item.id}`,
    dedupeKey: `marketing-email:${list.id}:${item.id}:${template.id}:${template.version}`,
    priority: 'normal',
    origin: 'marketing_bulk_email',
    fromEmail: `${sender.display_name} <${sender.email}>`,
    replyTo: sender.reply_to || sender.email,
    groupId: list.grupo_clinica_id || null,
    marketingConsent: true,
    templateContext: composeCampaignContext({ list, item, clinic, template, links: { ...publicLinks.PREVIEW_LINKS, unsubscribe_url: unsubscribeUrl } }),
    metadata: {
      ...(reviewScope.review ? { communication_purpose: 'review_request' } : {}),
      list_id: list.id,
      item_id: item.id,
      grupo_clinica_id: list.grupo_clinica_id || null,
      email_template_id: template.id,
      sender_identity_id: sender.id,
      contains_clinical_data: false,
    },
  }, { prepareTemplateContext: prepareMessageContext({ list, item, clinic, template, scopeKey, unsubscribeUrl }) });
  await item.update({
    email_message_id: result.emailMessage.id,
    channel_status: mergeEmailStatus(item, { status: 'queued', email_message_id: result.emailMessage.id, queued_at: new Date().toISOString() }),
  });
  return result;
}

async function runDispatchJob(payload = {}, jobRequest = null) {
  const listId = Number(payload.list_id || 0);
  if (!listId) throw new Error('marketing_bulk_email_dispatch requires payload.list_id');
  const list = await db.MarketingPatientList.findByPk(listId);
  if (!list || list.status === 'archived') return { status: 'completed', result: { skipped: true, reason: 'campaign_unavailable' } };
  const dispatch = list.email_dispatch || {};
  if (dispatch.cancel_requested === true) return { status: 'completed', result: { cancelled: true, list_id: list.id } };
  const { sender, template, scopeKey } = await assertReady(list);
  const rows = await db.MarketingPatientListItem.findAll({
    where: { list_id: list.id, status: 'ready', selected: true, email: { [Op.ne]: null } },
    order: [['id', 'ASC']],
  });
  const batch = rows.filter(emailPending).slice(0, Math.max(1, Number(dispatch.batch_size || DEFAULT_BATCH_SIZE)));
  if (!batch.length) {
    await list.reload();
    const latestDispatch = list.email_dispatch || {};
    if (latestDispatch.cancel_requested === true || ['paused', 'cancelled'].includes(String(latestDispatch.status || ''))) {
      return { status: 'completed', result: { list_id: list.id, interrupted: latestDispatch.status } };
    }
    const channels = Array.isArray(list.criteria?.channels) ? list.criteria.channels : [];
    const awaitingDelivery = rows.some(emailDeliveryPending);
    const completedAt = new Date();
    await list.update({
      status: channelSchedules.campaignStatus(list, { email: awaitingDelivery ? 'awaiting_delivery' : 'completed' }, channels.length === 1 && channels[0] === 'email' ? (awaitingDelivery ? 'sending' : 'completed') : list.status),
      ...(!awaitingDelivery ? { last_sent_at: completedAt } : {}),
      email_dispatch: {
        ...latestDispatch,
        status: awaitingDelivery ? 'awaiting_delivery' : 'completed',
        ...(!awaitingDelivery ? { completed_at: completedAt.toISOString() } : {}),
        next_allowed_at: null,
      },
    });
    return { status: 'completed', result: { completed: !awaitingDelivery, awaiting_delivery: awaitingDelivery, list_id: list.id } };
  }
  await list.update({ email_dispatch: { ...dispatch, status: 'sending', job_id: jobRequest?.id || dispatch.job_id } });
  let queued = 0;
  let failed = 0;
  for (const item of batch) {
    await list.reload();
    const liveDispatch = list.email_dispatch || {};
    if (liveDispatch.cancel_requested === true || ['paused', 'cancelled'].includes(String(liveDispatch.status || ''))) break;
    try {
      await queueItem({ list, item, sender, template, scopeKey });
      queued += 1;
    } catch (error) {
      failed += 1;
      await item.update({ channel_status: mergeEmailStatus(item, { status: 'failed', error_code: error.code || 'email_queue_failed', failed_at: new Date().toISOString() }) });
    }
  }
  await db.MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_email_batch_processed',
    channel: 'email',
    payload: { attempted: batch.length, queued, failed },
    occurred_at: new Date(),
  });
  const remainingRows = await db.MarketingPatientListItem.findAll({
    where: { list_id: list.id, status: 'ready', selected: true, email: { [Op.ne]: null } },
    attributes: ['id', 'channel_status'],
  });
  const remaining = remainingRows.filter(emailPending).length;
  await list.reload();
  const liveDispatch = list.email_dispatch || {};
  if (liveDispatch.cancel_requested === true || ['paused', 'cancelled'].includes(String(liveDispatch.status || ''))) {
    return { status: 'completed', result: { list_id: list.id, queued, failed, remaining, interrupted: liveDispatch.status } };
  }
  if (!remaining) {
    const channels = Array.isArray(list.criteria?.channels) ? list.criteria.channels : [];
    const awaitingDelivery = remainingRows.some(emailDeliveryPending);
    const completedAt = new Date();
    await list.update({
      status: channelSchedules.campaignStatus(list, { email: awaitingDelivery ? 'awaiting_delivery' : 'completed' }, channels.length === 1 && channels[0] === 'email' ? (awaitingDelivery ? 'sending' : 'completed') : list.status),
      ...(!awaitingDelivery ? { last_sent_at: completedAt } : {}),
      email_dispatch: {
        ...liveDispatch,
        status: awaitingDelivery ? 'awaiting_delivery' : 'completed',
        ...(!awaitingDelivery ? { completed_at: completedAt.toISOString() } : {}),
        next_allowed_at: null,
      },
    });
    return { status: 'completed', result: { completed: !awaitingDelivery, awaiting_delivery: awaitingDelivery, list_id: list.id, queued, failed } };
  }
  const next = new Date(Date.now() + Math.max(60 * 1000, Number(dispatch.delay_ms || DEFAULT_BATCH_DELAY_MS)));
  await list.update({ email_dispatch: { ...dispatch, status: 'waiting_next_batch', next_allowed_at: next.toISOString() } });
  return { status: 'waiting', nextRunAt: next, nextAllowedAt: next, result: { list_id: list.id, queued, failed, remaining } };
}

function testConfiguration(list, body) {
  const stored = plain(list);
  const draft = { ...stored, criteria: { ...(stored.criteria || {}) } };
  for (const key of ['email_template_id', 'email_sender_identity_id']) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const id = Number(body[key]);
    if (!Number.isSafeInteger(id) || id <= 0 || !/^\d+$/.test(String(body[key]))) {
      fail('marketing_email_test_asset_invalid', 400, 'Selecciona una plantilla y un remitente válidos para la prueba.');
    }
    draft[key] = id;
    draft.criteria[key] = id;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'email_subject')) {
    if (body.email_subject !== null && typeof body.email_subject !== 'string') fail('email_subject_invalid', 400);
    const subject = String(body.email_subject || '').trim();
    emailTemplates.assertSafeSubject(subject);
    draft.criteria.email_subject = subject;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'email_preheader')) {
    if (body.email_preheader !== null && typeof body.email_preheader !== 'string') fail('email_preheader_invalid', 400);
    const preheader = String(body.email_preheader || '').trim();
    if (preheader.length > 255) fail('email_template_preheader_too_long', 400);
    draft.criteria.email_preheader = preheader;
  }
  return draft;
}

async function sendTest(list, body = {}) {
  // Draft-only overrides go through the same scoped asset lookup and recipient
  // gates, and never modify the persisted campaign or affect real dispatch.
  list = testConfiguration(list, body);
  const { sender, template, scopeKey } = await assertReady(list);
  const recipientEmail = emailDelivery.normalizeEmail(body.to || body.email);
  const item = body.item_id
    ? await db.MarketingPatientListItem.findOne({ where: { id: body.item_id, list_id: list.id } })
    : await db.MarketingPatientListItem.findOne({ where: { list_id: list.id, status: 'ready', selected: true }, order: [['id', 'ASC']] });
  if (!item) fail('marketing_email_test_item_missing', 409, 'La campaña necesita un contacto de ejemplo para completar variables.');
  const reviewScope = await assertReviewAllowed(list, item);
  const clinic = item.clinica_id ? await db.Clinica.findByPk(item.clinica_id) : (list.clinica_id ? await db.Clinica.findByPk(list.clinica_id) : null);
  const variables = templateContext({ list, item, clinic });
  assertTemplateVariables(template, variables, list);
  const unsubscribeUrl = await marketingEmail.issueUnsubscribe({ scopeKey, clinicaId: item.clinica_id || list.clinica_id,
    groupId: list.grupo_clinica_id, listId: list.id, itemId: null, recipientEmail });
  const result = await emailDelivery.queueEmail({
    stream: 'marketing', templateKey: 'marketing.campaign', templateVersion: String(template.version || 1),
    subjectKey: `marketing.template.${template.id}`, recipientEmail, recipientKind: 'marketing_test',
    clinicaId: item.clinica_id || list.clinica_id, relatedType: 'marketing_bulk_send_test', relatedId: `${list.id}:${Date.now()}`,
    dedupeKey: `marketing-email-test:${list.id}:${recipientEmail}:${crypto.randomUUID()}`,
    origin: 'marketing_bulk_email_test', fromEmail: `${sender.display_name} <${sender.email}>`, replyTo: sender.reply_to || sender.email,
    groupId: list.grupo_clinica_id || null,
    marketingConsent: true,
    templateContext: composeCampaignContext({ list, item, clinic, template, links: { ...publicLinks.PREVIEW_LINKS, unsubscribe_url: unsubscribeUrl } }),
    metadata: {
      ...(reviewScope.review ? { communication_purpose: 'review_request' } : {}),
      list_id: list.id,
      item_id: item.id,
      grupo_clinica_id: list.grupo_clinica_id || null,
      test: true,
      contains_clinical_data: false,
    },
  }, { prepareTemplateContext: prepareMessageContext({ list, item, clinic, template, scopeKey, unsubscribeUrl }) });
  return { success: true, channel: 'email', to: recipientEmail, email_message_id: result.emailMessage.public_id, status: result.emailMessage.status };
}

async function materializeEmailMessage(message, options = {}) {
  const metadata = message?.metadata || {};
  if (message?.related_type !== 'marketing_bulk_send' || !metadata.list_id || !metadata.item_id) {
    return { applied: false };
  }
  const transaction = options.transaction || null;
  const item = await db.MarketingPatientListItem.findOne({
    where: { id: Number(metadata.item_id), list_id: Number(metadata.list_id) },
    transaction,
  });
  if (!item) return { applied: false };
  const status = String(message.status || 'queued').toLowerCase();
  const current = emailStatus(item);
  const changed = String(current.status || '').toLowerCase() !== status
    || Number(current.email_message_id || 0) !== Number(message.id || 0)
    || String(current.provider_message_id || '') !== String(message.provider_message_id || '');
  if (changed) {
    await item.update({
      email_message_id: message.id,
      channel_status: mergeEmailStatus(item, {
        status,
        email_message_id: message.id,
        provider_message_id: message.provider_message_id || null,
        sent_at: message.sent_at || null,
        delivered_at: message.delivered_at || null,
        failed_at: message.bounced_at || message.complained_at || message.rejected_at || null,
        error_code: message.last_error_code || null,
      }),
    }, { transaction });
    await db.MarketingPatientContactEvent.create({
      list_id: item.list_id,
      item_id: item.id,
      paciente_id: item.paciente_id || null,
      event_type: `mass_campaign_email_${status}`,
      channel: 'email',
      payload: { email_message_id: message.id, provider_message_id: message.provider_message_id || null },
      occurred_at: new Date(),
    }, { transaction });
  }
  await reconcileEmailDispatchCompletion(item.list_id, { transaction });
  return { applied: changed, list_id: item.list_id, item_id: item.id, status };
}

async function reconcileEmailDispatchCompletion(listId, { transaction = null } = {}) {
  const list = await db.MarketingPatientList.findByPk(listId, { transaction });
  if (!list || ['paused', 'cancelled'].includes(String(list.email_dispatch?.status || '').toLowerCase())) return false;
  const rows = await db.MarketingPatientListItem.findAll({
    where: { list_id: list.id, status: 'ready', selected: true, email: { [Op.ne]: null } },
    attributes: ['id', 'channel_status'],
    transaction,
  });
  if (!rows.length || rows.some(emailDeliveryPending)) return false;
  const completedAt = new Date();
  const channels = Array.isArray(list.criteria?.channels) ? list.criteria.channels : [];
  await list.update({
    status: channelSchedules.campaignStatus(list, { email: 'completed' }, channels.length === 1 && channels[0] === 'email' ? 'completed' : list.status),
    last_sent_at: completedAt,
    email_dispatch: {
      ...(list.email_dispatch || {}),
      status: 'completed',
      completed_at: completedAt.toISOString(),
      next_allowed_at: null,
    },
  }, { transaction });
  return true;
}

module.exports = {
  assertEmailReviewCanDispatch,
  JOB_TYPE,
  assertReady,
  enqueueDispatch,
  cancelDispatch,
  pauseDispatch,
  resumeDispatch,
  getEmailDispatchProgress,
  runDispatchJob,
  sendTest,
  materializeEmailMessage,
  reconcileEmailDispatchCompletion,
  __testing: {
    templateContext,
    testConfiguration,
  },
};
