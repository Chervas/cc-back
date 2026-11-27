'use strict';

const { createHash } = require('node:crypto');
const { Op, json, where } = require('sequelize');
const { normalizePhoneDigits } = require('../lib/phone');

const { asksForCommercialInformation } = require('./socialLeadInterestClassification.service');

const SOURCE = 'bulk_whatsapp_reply';
const UNQUOTED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

function isInfoReply(content) {
  return /^[¡¿\s]*info[.!?\s]*$/iu.test(String(content || '').trim());
}

async function resolveCampaignReply({ db, message, conversation, binding, transaction }) {
  if (message.direction !== 'inbound' || message.metadata?.provider_type !== 'text'
    || conversation.channel !== 'whatsapp' || Number(message.conversation_id) !== Number(conversation.id)
    || Number(conversation.clinic_id) !== Number(binding.clinicId)) return null;
  const clinicId = Number(conversation.clinic_id);
  const contact = String(conversation.contact_id || '');
  const phone = /^\+?[0-9]+$/.test(contact) ? normalizePhoneDigits(contact) : '';
  const receivedAt = new Date(message.sent_at || '').getTime();
  if (!clinicId || !phone || !binding.phoneId || !binding.wabaId || !Number.isFinite(receivedAt)) return null;

  const quoted = String(message.metadata?.context?.id || '').trim();
  const metadataEquals = (key, value) => where(json(`metadata.${key}`), value);
  const outbound = await db.Message.findAll({
    where: {
      conversation_id: conversation.id,
      direction: 'outbound',
      createdAt: { [Op.lte]: new Date(receivedAt + 999), ...(!quoted ? { [Op.gte]: new Date(receivedAt - UNQUOTED_LOOKBACK_MS) } : {}) },
      [Op.and]: [
        metadataEquals('source', 'marketing_bulk_sends'),
        metadataEquals('phoneNumberId', String(binding.phoneId)),
        metadataEquals('wabaId', String(binding.wabaId)),
        ...(quoted ? [metadataEquals('wamid', quoted)] : []),
      ],
    },
    attributes: ['id', 'status', 'metadata', 'createdAt'], order: [['id', 'DESC']], limit: quoted ? 2 : 25, raw: true, transaction,
  });
  if (!outbound.length) return null;
  const excluded = { excluded: true, reason: 'campaign_excluded' };
  const ambiguous = { excluded: true, reason: 'attribution_ambiguous' };
  if ((quoted && outbound.length !== 1) || (!quoted && outbound.length === 25)) return ambiguous;
  const delivered = outbound.filter(row => {
    const meta = row.metadata || {};
    return !!meta.wamid && normalizePhoneDigits(meta.recipient) === phone && id(meta.list_id) && id(meta.item_id)
      && (['sent', 'delivered', 'read'].includes(row.status)
        || (row.status === 'pending' && meta.provider_acceptance_status === 'accepted'));
  });
  const valid = delivered.filter(({ metadata }) => metadata.kind === 'mass_campaign_send' && metadata.dispatch_context === 'campaign');
  if (!valid.length) return excluded;
  if (new Set(valid.map(row => id(row.metadata.list_id))).size !== 1) return ambiguous;
  const original = valid[0];
  if (!quoted && delivered[0].id !== original.id) return ambiguous;
  if (!quoted) {
    // A reply without provider context cannot be assigned to an earlier offer when
    // a certified booking/identity request on the same line intervened.
    const careRequest = await db.Message.findOne({
      where: {
        conversation_id: conversation.id, direction: 'outbound',
        status: { [Op.in]: ['sent','delivered','read'] },
        createdAt: { [Op.lte]: new Date(receivedAt + 999) },
        [Op.or]: [
          {createdAt: {[Op.gt]: original.createdAt}},
          {createdAt: original.createdAt, id: {[Op.gt]: original.id}},
        ],
        [Op.and]: [
          metadataEquals('phoneNumberId', String(binding.phoneId)),
          metadataEquals('wabaId', String(binding.wabaId)),
          where(json('metadata.kind'), {[Op.in]: ['patient_program_booking_notice','patient_mobile_verification']}),
          where(json('metadata.wamid'), {[Op.like]: 'wamid.%'}),
        ],
      },
      attributes: ['id'], transaction, raw: true,
    });
    if (careRequest) return ambiguous;
  }
  const campaignId = id(original.metadata.list_id);
  const [campaign, recipient] = await Promise.all([
    db.MarketingPatientList.findByPk(campaignId, { transaction, raw: true }),
    db.MarketingPatientListItem.findOne({
      where: { id: id(original.metadata.item_id), list_id: campaignId }, transaction, raw: true,
    }),
  ]);
  const clinicIds = Array.isArray(campaign?.clinic_ids) ? campaign.clinic_ids.map(Number) : [];
  const campaignClinic = id(campaign?.clinica_id);
  const sentClinic = id(original.metadata.delivery_clinic_id);
  if (!campaign || campaign.objective_id !== 'mass_sends' || (campaign.criteria?.record_kind || 'campaign') !== 'campaign'
    || campaign.criteria?.review_request
    || !(campaignClinic === clinicId || clinicIds.includes(clinicId))
    || (sentClinic && sentClinic !== clinicId) || !recipient || (id(recipient.clinica_id) || campaignClinic || sentClinic) !== clinicId
    || normalizePhoneDigits(recipient.phone) !== phone) return excluded;
  const name = String(campaign.criteria.campaign_name || campaign.name || '').trim().slice(0, 128);
  if (!name) return excluded;
  const legacyEnabled = original.metadata.capture_whatsapp_info_leads === true && campaign.criteria?.capture_whatsapp_info_leads === true;
  const policy = original.metadata.whatsapp_lead_capture_policy || 'inherit';
  const commercial = original.metadata.template_commercial === true || legacyEnabled;
  const isExcluded = !commercial || policy === 'disabled';
  return { excluded: isExcluded, ...(isExcluded ? {reason:'campaign_excluded'} : {}), commercial, legacyEnabled, policy, sentAt: new Date(original.createdAt).getTime(),
    campaign, recipient, phone, name, campaignId, originalId: original.id, clinicId };
}

async function attributeCampaignInfoReply({ db, message, conversation, binding, transaction, captureFrom = null, match = null, verifiedInterest = false, freshDispatch = false }) {
  if (!verifiedInterest && !asksForCommercialInformation(message.content)) return null;
  const origin = match || await resolveCampaignReply({db,message,conversation,binding,transaction});
  if (!origin || origin.excluded || !(origin.legacyEnabled || origin.policy === 'enabled' ||
    (Number.isFinite(captureFrom) && origin.sentAt >= captureFrom))) return null;
  if (freshDispatch) {
    const capture = require('./inboundLeadCaptureConfig.service');
    const flow = await capture.current(db,origin.clinicId,'whatsapp',transaction);
    if (capture.effective(flow,new Date(message.metadata?.provider_sent_at || message.sent_at).getTime())) return null;
  }
  const { clinicId, phone, name, campaign, recipient, campaignId, originalId } = origin;

  const [lead, created] = await db.LeadIntake.findOrCreate({
    where: { external_source: SOURCE, external_id: hash(JSON.stringify([clinicId, campaignId, phone])) },
    defaults: {
      clinica_id: clinicId, grupo_clinica_id: campaign.grupo_clinica_id || null,
      source: 'whatsapp', source_detail: SOURCE, channel: 'unknown', status_lead: 'nuevo',
      telefono: phone, phone_hash: hash(phone), nombre: recipient.name || null,
      es_paciente: !!id(conversation.patient_id),
      utm_source: 'envios_masivos', utm_medium: 'whatsapp', utm_campaign: name,
    },
    transaction,
  });
  if (Number(lead.clinica_id) !== clinicId || lead.archived_at) return null;
  const captureOrigin = verifiedInterest ? 'inbound_lead_capture' : 'campaign_send_configuration';
  if (created) {
    await db.LeadAttributionAudit.create({
      lead_intake_id: lead.id, raw_payload: { message_id: message.id },
      attribution_steps: { whatsapp_bulk_send: { campaign_id: campaignId, outbound_message_id: originalId, capture_origin: captureOrigin } },
    }, { transaction });
  }
  if (!conversation.lead_id) {
    await db.Conversation.update({ lead_id: lead.id },
      { where: { id: conversation.id, clinic_id: clinicId, lead_id: null }, transaction });
  }
  return { lead, duplicate: !created, attribution: { lead_id: lead.id, campaign_id: campaignId, capture_origin: captureOrigin, outcome: created ? 'created' : 'linked' } };
}

module.exports = { SOURCE, attributeCampaignInfoReply, resolveCampaignReply, isInfoReply };
