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

async function attributeCampaignInfoReply({ db, message, conversation, binding, transaction }) {
  if (message.direction !== 'inbound' || message.metadata?.provider_type !== 'text' || !asksForCommercialInformation(message.content)
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
    attributes: ['id', 'status', 'metadata'], order: [['id', 'DESC']], limit: quoted ? 2 : 25, raw: true, transaction,
  });
  if ((quoted && outbound.length !== 1) || (!quoted && outbound.length === 25)) return null;
  const delivered = outbound.filter(row => {
    const meta = row.metadata || {};
    return !!meta.wamid && normalizePhoneDigits(meta.recipient) === phone && id(meta.list_id) && id(meta.item_id)
      && (['sent', 'delivered', 'read'].includes(row.status)
        || (row.status === 'pending' && meta.provider_acceptance_status === 'accepted'));
  });
  const valid = delivered.filter(({ metadata }) => metadata.kind === 'mass_campaign_send' && metadata.dispatch_context === 'campaign');
  if (!valid.length || new Set(valid.map(row => id(row.metadata.list_id))).size !== 1) return null;
  const original = valid[0];
  if (!quoted && delivered[0].id !== original.id) return null;
  const campaignId = id(original.metadata.list_id);
  if (original.metadata.capture_whatsapp_info_leads !== true) return null;
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
    || campaign.criteria?.review_request || campaign.criteria?.capture_whatsapp_info_leads !== true
    || !(campaignClinic === clinicId || clinicIds.includes(clinicId))
    || !recipient || (id(recipient.clinica_id) || campaignClinic || sentClinic) !== clinicId
    || normalizePhoneDigits(recipient.phone) !== phone) return null;
  const name = String(campaign.criteria.campaign_name || campaign.name || '').trim().slice(0, 128);
  if (!name) return null;

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
  if (created) {
    await db.LeadAttributionAudit.create({
      lead_intake_id: lead.id, raw_payload: { message_id: message.id },
      attribution_steps: { whatsapp_bulk_send: { campaign_id: campaignId, outbound_message_id: original.id } },
    }, { transaction });
  }
  if (!conversation.lead_id) {
    await db.Conversation.update({ lead_id: lead.id },
      { where: { id: conversation.id, clinic_id: clinicId, lead_id: null }, transaction });
  }
  return { lead, duplicate: !created, attribution: { lead_id: lead.id, campaign_id: campaignId } };
}

module.exports = { SOURCE, attributeCampaignInfoReply, isInfoReply };
