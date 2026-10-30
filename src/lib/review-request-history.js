'use strict';

const { normalizePhoneDigits } = require('./phone');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const yes = value => value === true || value === 1 || value === '1' || value === 'true';
const completed = new Set(['sent', 'delivered', 'read', 'replied']);
const inFlight = new Set(['queued', 'sending', 'accepted', 'held_quality']);
const reservedLists = new Set(['ready', 'sending', 'sent', 'completed', 'scheduled', 'paused']);
const reviewTag = value => /(?:^|[_\s-])reviews?(?:$|[_\s-])|rese[n\u00f1]a|solicitud_de_opinion|solicitud_de_valoracion|opinion_tras_visita/i.test(String(value || ''));

function isReviewTestMessage(message = {}) {
  const metadata = parse(message.metadata);
  return yes(metadata.test_send) || /^mass_campaign_test(?:_|$)/.test(String(metadata.kind || ''))
    || !!metadata.qa_variant;
}

function isRecordedReviewMessage(message = {}) {
  const metadata = parse(message.metadata);
  if (isReviewTestMessage(message)) return false;
  if (Number(message.catalog_template_id || metadata.catalog_template_id) === 9
    || [metadata.template_usage, metadata.dispatch_context, metadata.kind, metadata.template_name, message.template_name]
      .some(reviewTag)) return true;
  // Coexistence echoes have no campaign/template IDs. Only an explicit invitation
  // or Google review URL counts; a generic mention of Google is not evidence.
  return metadata.origin === 'mobile_app' && (
    /(?:deja(?:r|nos)?|escrib(?:e|ir)|public(?:a|ar)).{0,60}(?:rese[n\u00f1]a|valoraci[o\u00f3]n)|(?:leave|write|post).{0,40}(?:review)|(?:deixa|escriu).{0,40}(?:ressenya)/iu.test(message.content || '')
    || /https?:\/\/(?:search\.google\.com\/local\/writereview\b|g\.page\/\S+\/review\b)/iu.test(message.content || '')
  );
}

function reviewItemBlocksRepeat(item = {}) {
  const hasCurrentMessage = !!item.app_message_id;
  if (isReviewTestMessage({ metadata: item.message_metadata })) return false;
  // Old tests sometimes wrote sent_at/paciente_id on the sample item itself.
  if (yes(item.has_test_event) && !yes(item.has_real_event) && !hasCurrentMessage) return false;
  if (item.sent_at || item.provider_message_id || completed.has(item.dispatch_status) || inFlight.has(item.dispatch_status)) return true;
  return item.list_status !== 'archived' && yes(item.selected) && item.status === 'ready'
    && reservedLists.has(item.list_status) && (!item.dispatch_status || item.dispatch_status === 'pending');
}

function buildReviewRequestHistory(items = [], messages = []) {
  const patientIds = new Set(), phoneKeys = new Set();
  const remember = (patientId, phone) => {
    const id = Number(patientId), key = normalizePhoneDigits(phone);
    if (Number.isSafeInteger(id) && id > 0) patientIds.add(id);
    if (key) phoneKeys.add(key);
  };
  for (const item of items) if (reviewItemBlocksRepeat(item)) remember(item.paciente_id, item.phone);
  for (const message of messages) {
    if (!isRecordedReviewMessage(message)) continue;
    const metadata = parse(message.metadata);
    if (!completed.has(message.status) && !metadata.wamid && !metadata.provider_acceptance_at
      && !['pending', 'sending'].includes(message.status)) continue;
    remember(message.patient_id, metadata.recipient || message.contact_id);
  }
  return { patientIds, phoneKeys };
}

function hasPriorReviewRequest(history, item = {}) {
  const id = Number(item.paciente_id || item.id_paciente), phone = normalizePhoneDigits(item.phone || item.telefono_movil);
  return history.patientIds.has(id) || !!phone && history.phoneKeys.has(phone);
}

async function readReviewRequestHistory({ query, clinicIds = [], byClinic = false }) {
  const ids = [...new Set(clinicIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return buildReviewRequestHistory();
  const replacements = { clinicIds: ids };
  const items = await query(`WITH review_scope_items AS (
      SELECT id FROM MarketingPatientListItems WHERE clinica_id IN (:clinicIds)
      UNION ALL SELECT i.id FROM MarketingPatientLists l JOIN MarketingPatientListItems i ON i.list_id=l.id
        WHERE l.clinica_id IN (:clinicIds) AND i.clinica_id IS NULL
    ) SELECT COALESCE(i.clinica_id,l.clinica_id) history_clinic_id,i.paciente_id,i.phone,i.status,i.selected,i.dispatch_status,i.sent_at,i.provider_message_id,i.app_message_id,
      l.status AS list_status,m.metadata AS message_metadata,
      EXISTS(SELECT 1 FROM MarketingPatientContactEvents e WHERE e.list_id=i.list_id AND e.item_id=i.id
        AND e.event_type LIKE 'mass_campaign_test_%') AS has_test_event,
      EXISTS(SELECT 1 FROM MarketingPatientContactEvents e WHERE e.list_id=i.list_id AND e.item_id=i.id
        AND e.event_type IN ('mass_campaign_message_accepted','mass_campaign_message_held','mass_campaign_message_sent',
          'mass_campaign_message_delivered','mass_campaign_message_read','mass_campaign_message_replied')) AS has_real_event
    FROM review_scope_items s JOIN MarketingPatientListItems i ON i.id=s.id JOIN MarketingPatientLists l ON l.id=i.list_id
    LEFT JOIN Messages m ON m.id=i.app_message_id
    WHERE l.objective_id='mass_sends' AND (
      JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.review_request')) IN ('true','1')
      OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.template_usage')) IN ('solicitud_resena','resena','review_request','reviews')
    ) AND (i.sent_at IS NOT NULL OR i.provider_message_id IS NOT NULL
      OR i.dispatch_status IN ('queued','sending','accepted','held_quality','sent','delivered','read','replied')
      OR (l.status IN ('ready','sending','sent','completed','scheduled','paused') AND i.selected=TRUE AND i.status='ready'
        AND (i.dispatch_status IS NULL OR i.dispatch_status='pending')))`, replacements);
  const messages = await query(`SELECT c.clinic_id history_clinic_id,m.status,m.metadata,m.content,c.patient_id,c.contact_id,
      t.catalog_template_id,t.name AS template_name
    FROM Conversations c JOIN Messages m ON m.conversation_id=c.id
    LEFT JOIN WhatsappTemplates t ON t.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.template_id')) AS UNSIGNED)
    WHERE c.clinic_id IN (:clinicIds) AND c.channel='whatsapp' AND m.direction='outbound' AND m.message_type<>'event'
      AND (t.catalog_template_id=9 OR t.name REGEXP 'review|rese[n\u00f1]a|solicitud_de_opinion|solicitud_de_valoracion|opinion_tras_visita'
        OR JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.template_usage')) REGEXP 'review|rese[n\u00f1]a'
        OR JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.dispatch_context')) REGEXP 'review|rese[n\u00f1]a'
        OR JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.kind')) REGEXP 'review|rese[n\u00f1]a'
        OR JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.template_name')) REGEXP 'review|rese[n\u00f1]a|solicitud_de_opinion|solicitud_de_valoracion|opinion_tras_visita'
        OR JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.catalog_template_id'))='9'
        OR (JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.origin'))='mobile_app' AND m.content REGEXP 'rese[n\u00f1]a|ressenya|review|valoraci[o\u00f3]n|g.page|writereview'))`, replacements);
  return byClinic ? new Map(ids.map(id => [id, buildReviewRequestHistory(items.filter(r => Number(r.history_clinic_id) === id),
    messages.filter(r => Number(r.history_clinic_id) === id))])) : buildReviewRequestHistory(items, messages);
}

module.exports = { buildReviewRequestHistory, readReviewRequestHistory, hasPriorReviewRequest,
  reviewItemBlocksRepeat, isRecordedReviewMessage, isReviewTestMessage };
