'use strict';

const { createHash, createHmac } = require('node:crypto');
const { parseDocument, DomUtils } = require('htmlparser2');
const { Op } = require('sequelize');
const { normalizePhoneDigits } = require('../lib/phone');
const { resolvePublicWhatsapp } = require('../lib/intakePublicWhatsapp');

const REFERENCE_PREFIX = 'email-';
const CONTACT_SOURCE = 'marketing_email_whatsapp';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REFERENCE = /^Ref\. CC-([a-f0-9]{20})[ \t]*\r?$/gim;
const digits = (value) => /^[1-9]\d{8,14}$/.test(value ?? '') ? String(value) : null;
const providerId = (value) => /^\d{1,30}$/.test(value ?? '') ? String(value) : null;
const hash = (value) => createHash('sha256').update(value).digest('hex');

function commercialEmailCampaign(list) {
  const criteria = list?.criteria;
  return criteria?.record_kind === 'campaign' && criteria.template_commercial === true
    && criteria.review_request !== true && Array.isArray(criteria.channels) && criteria.channels.includes('email');
}

function scopeIncludesClinic(list, clinicId, groupId) {
  if (list.scope_type === 'clinic') return Number(list.clinica_id) === clinicId;
  return list.scope_type === 'group' && groupId > 0 && Number(list.grupo_clinica_id) === groupId
    && Array.isArray(list.clinic_ids) && list.clinic_ids.some(id => Number(id) === clinicId);
}

function directWhatsappLink(anchor) {
  try {
    const url = new URL(anchor.attribs.href);
    const number = digits(url.pathname.slice(1).replace(/\/$/, ''));
    if (url.origin === 'https://wa.me' && !url.username && !url.password && number) return { anchor, url, number };
  } catch { /* Other valid email anchors do not participate. */ }
  return null;
}

async function decorateEmailWhatsappLinks({ db, body, list, clinic, transaction, now = new Date() }) {
  const { html } = body;
  let { text } = body;
  const clinicId = Number(clinic?.id_clinica);
  const groupId = Number(clinic?.grupoClinicaId) || null;
  const campaignId = Number(list?.id);
  if (!commercialEmailCampaign(list) || !clinicId || !Number.isSafeInteger(campaignId) || campaignId <= 0
    || !scopeIncludesClinic(list, clinicId, groupId)
    || !html?.includes('https://wa.me/')) return body;
  const document = parseDocument(html);
  const links = DomUtils.findAll(node => node.name === 'a' && node.attribs?.href, document.children)
    .map(directWhatsappLink).filter(Boolean);
  if (!links.length) return body;

  const [assets, bindings] = await Promise.all([
    db.ClinicMetaAsset.findAll({ where: { assetType: 'whatsapp_phone_number', isActive: true,
      [Op.or]: [{ clinicaId: clinicId }, ...(groupId ? [{ assignmentScope: 'group', grupoClinicaId: groupId }] : [])] },
    attributes: ['id', 'clinicaId', 'grupoClinicaId', 'assignmentScope', 'assetType', 'isActive', 'metaAssetId', 'metaAssetName', 'additionalData'],
    raw: true, transaction }),
    db.WhatsappChannelBinding.findAll({ where: { clinic_id: clinicId, is_active: true },
      attributes: ['clinic_id', 'asset_id', 'role', 'is_active'], raw: true, transaction }),
  ]);
  const { whatsapp_aliases: aliases } = resolvePublicWhatsapp({ clinic, assets, bindings });
  // A manual phone or duplicated provider identity cannot receive a trusted reference.
  if (!assets.length) return body;
  const key = String(process.env.EMAIL_DATA_ENCRYPTION_KEY || '').trim();
  const campaignName = String(list.criteria.campaign_name || list.name || '').trim().slice(0, 128);
  if (key.length < 16 || !campaignName) return body;
  const references = [];
  for (const [index, link] of links.entries()) {
    if (!aliases.includes(link.number)) continue;
    const matchingAssets = assets.filter(asset => normalizePhoneDigits(asset.additionalData?.displayPhoneNumber
      || asset.additionalData?.display_phone_number || asset.metaAssetName) === link.number);
    if (matchingAssets.length !== 1) continue;
    const assetId = Number(matchingAssets[0].id);
    const phoneId = providerId(matchingAssets[0].metaAssetId);
    if (!phoneId || !Number.isSafeInteger(assetId) || assetId <= 0) continue;
    const button = `boton_${index + 1}`;
    // One opaque ref per campaign, scoped number, button, and day of composition.
    // No recipient identifiers enter the ref or its stored context.
    const code = createHmac('sha256', key).update(JSON.stringify([
      'marketing-email-whatsapp:v1', campaignId, clinicId, assetId, phoneId, button, now.toISOString().slice(0, 10),
    ])).digest('hex').slice(0, 20);
    references.push({ code, link, origin: {
      ref: REFERENCE_PREFIX + code, clinic_id: clinicId, group_id: groupId, phone_number_id: phoneId,
      utm_source: 'envios_masivos', utm_medium: 'email', utm_campaign: campaignName, utm_content: button,
      expires_at: new Date(now.getTime() + MAX_AGE_MS), metadata: { campaign_id: campaignId, asset_id: assetId },
    } });
  }
  if (!references.length) return body;

  // All recipients of this campaign/day share link refs. Avoid updating those
  // rows for each email. Upsert converges concurrent first compositions.
  const stored = await db.WhatsAppWebOrigin.findAll({
    where: { ref: references.map(({ origin }) => origin.ref) }, attributes: ['ref'], raw: true, transaction,
  });
  const existing = new Set(stored.map(({ ref }) => ref));
  const replacements = new Map();
  for (const { code, link, origin } of references) {
    if (!existing.has(origin.ref)) await db.WhatsAppWebOrigin.upsert(origin, { transaction });
    const messageText = (link.url.searchParams.get('text') || '').trim().replace(REFERENCE, '').trim()
      || 'Hola, me gustaría recibir más información.';
    link.url.searchParams.set('text', `${messageText}\n\nRef. CC-${code.toUpperCase()}`);
    if (!replacements.has(link.anchor.attribs.href)) {
      replacements.set(link.anchor.attribs.href, {
        href: link.url.href, label: DomUtils.textContent(link.anchor).replace(/\s+/g, ' ').trim() || 'WhatsApp',
      });
    }
    link.anchor.attribs.href = link.url.href;
  }
  const replaced = new Set();
  text = (text || '').replace(/https:\/\/wa\.me\/[^\s<>")]+/g, href => {
    const next = replacements.get(href);
    if (!next) return href;
    replaced.add(href);
    return next.href;
  });
  for (const [previous, next] of replacements) {
    if (!replaced.has(previous)) text = `${text}\n\n${next.label}: ${next.href}`.trim();
  }
  return { html: DomUtils.getOuterHTML(document), text };
}

async function attributeEmailWhatsappReply({ db, message, conversation, binding, transaction }) {
  if (message.direction !== 'inbound' || message.metadata?.provider_type !== 'text'
    || conversation.channel !== 'whatsapp' || Number(message.conversation_id) !== Number(conversation.id)
    || Number(conversation.clinic_id) !== Number(binding.clinicId)) return null;
  const references = new Set([...(message.content || '').matchAll(REFERENCE)].map(match => match[1].toLowerCase()));
  if (references.size !== 1) return null;
  const [code] = references;
  const clinicId = Number(conversation.clinic_id);
  const phone = digits(String(conversation.contact_id || '').replace(/^\+/, ''));
  if (!phone) return null;

  const origin = await db.WhatsAppWebOrigin.findOne({ where: { ref: REFERENCE_PREFIX + code,
    clinic_id: clinicId, phone_number_id: binding.phoneId }, transaction, raw: true });
  if (!origin || Number(origin.metadata?.asset_id) !== Number(binding.assetId)) return null;
  const receivedAt = new Date(message.sent_at || '').getTime();
  const issuedAt = Math.floor(new Date(origin.createdAt || '').getTime() / 1000) * 1000;
  if (!(receivedAt >= issuedAt && receivedAt < new Date(origin.expires_at || '').getTime())) return null;
  const campaignId = Number(origin.metadata?.campaign_id);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) return null;
  const campaign = await db.MarketingPatientList.findByPk(campaignId, { transaction });
  if (!commercialEmailCampaign(campaign) || !scopeIncludesClinic(campaign, clinicId, Number(origin.group_id))) return null;

  const [lead, created] = await db.LeadIntake.findOrCreate({
    where: { external_source: CONTACT_SOURCE, external_id: hash(JSON.stringify([clinicId, campaignId, phone])) },
    defaults: { clinica_id: clinicId, grupo_clinica_id: origin.group_id, source: 'whatsapp', channel: 'unknown',
      source_detail: CONTACT_SOURCE, status_lead: 'nuevo', telefono: phone, phone_hash: hash(phone),
      utm_source: origin.utm_source, utm_medium: origin.utm_medium, utm_campaign: origin.utm_campaign, utm_content: origin.utm_content },
    transaction,
  });
  if (Number(lead.clinica_id) !== clinicId || lead.archived_at) return null;
  if (created) {
    await db.LeadAttributionAudit.create({ lead_intake_id: lead.id, raw_payload: { message_id: message.id },
      attribution_steps: { email_bulk_send: { campaign_id: campaignId, button: origin.utm_content } } }, { transaction });
  }
  if (!conversation.lead_id) {
    await db.Conversation.update({ lead_id: lead.id }, { where: { id: conversation.id, clinic_id: clinicId, lead_id: null }, transaction });
  }
  return { lead, duplicate: !created, attribution: { lead_id: lead.id, campaign_id: campaignId, button: origin.utm_content } };
}

module.exports = { REFERENCE_PREFIX, decorateEmailWhatsappLinks, attributeEmailWhatsappReply };
