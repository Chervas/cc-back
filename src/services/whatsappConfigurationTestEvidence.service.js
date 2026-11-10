'use strict';

// A delivered manual template proves an outbound configuration, not a charge.
// Read-only, bounded projection: never backfill metadata or change payment state.
const { Op } = require('sequelize');
const plain = row => row?.get ? row.get({ plain: true }) : row;
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const time = value => new Date(value || '').getTime();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

function empty(asset) {
  return { verified: false, message_status: null, app_message_id: null,
    asset_id: Number(asset.id), phone_number_id: asset.phoneNumberId || null,
    waba_id: asset.wabaId || null, authorization_id: asset.whatsappAuthorizationId || null, observed_at: null };
}
function currentActivation(asset, binding, activation) {
  if (!binding || binding.sendEnabled !== true || Number(binding.assetId) !== Number(asset.id)
    || binding.phoneId !== asset.phoneNumberId || binding.wabaId !== asset.wabaId
    || binding.authorizationId !== asset.whatsappAuthorizationId || !uuid(asset.whatsappAuthorizationId)
    || !activation || activation.authorization_id !== asset.whatsappAuthorizationId
    || Number(activation.asset_id) !== Number(asset.id) || activation.state !== 'active'
    || activation.phone_id !== asset.phoneNumberId || activation.waba_id !== asset.wabaId
    || !Array.isArray(activation.clinic_ids) || !activation.clinic_ids.length
    || activation.clinic_ids.some(id => !positive(id))
    || !activation.clinic_ids.map(Number).includes(Number(binding.clinicId))
    || activation.scope_type !== asset.assignmentScope
    || Number(activation.scope_id) !== Number(asset.assignmentScope === 'group' ? asset.grupoClinicaId : asset.clinicaId)
    || !Number.isFinite(time(activation.created_at)) || !Number.isFinite(time(activation.message_not_before))) return null;
  const payment = asset.additionalData?.payment || {};
  if (payment.status === 'missing_payment_method' || Number(payment.last_error_code) === 131042
    || String(asset.additionalData?.whatsappHealth?.reason_code || '').includes('131042')) return null;
  // Renewal can deliberately retain message_not_before; created_at prevents
  // borrowing evidence from the preceding authorization after that renewal.
  return { ...activation, notBefore: Math.max(time(activation.created_at), time(activation.message_not_before)) };
}
function proof(asset, activation, message, template, now = new Date()) {
  const metadata = message?.metadata || {}, conversation = message?.conversation;
  const observed = time(message?.updatedAt || message?.createdAt);
  if (!activation || !message || !['delivered', 'read'].includes(message.status)
    || message.direction !== 'outbound' || message.message_type !== 'template'
    || !Number.isFinite(time(message.createdAt)) || time(message.createdAt) < activation.notBefore
    || time(message.createdAt) > time(now)
    || !positive(message.id) || !Number.isFinite(observed) || observed < time(message.createdAt) || observed > time(now)
    || metadata.kind !== 'mass_campaign_test' || metadata.source !== 'marketing_bulk_sends'
    || Number(metadata.sender_origin_id) !== Number(asset.id)
    || metadata.phoneNumberId !== asset.phoneNumberId || metadata.wabaId !== asset.wabaId
    || typeof metadata.wamid !== 'string' || !metadata.wamid.startsWith('wamid.')
    || !conversation || conversation.channel !== 'whatsapp'
    || !activation.clinic_ids.map(Number).includes(Number(conversation.clinic_id))
    || !template || Number(template.id) !== Number(metadata.template_id)
    || template.waba_id !== asset.wabaId || template.name !== metadata.template_name
    || template.status !== 'APPROVED' || template.is_active !== true && template.is_active !== 1
    || metadata.template_language !== template.language) return null;
  return { ...empty(asset), verified: true, message_status: message.status,
    app_message_id: Number(message.id), observed_at: new Date(observed).toISOString() };
}
function createService({ db = require('../../models'), now = () => new Date() } = {}) {
  async function forAssets(values, { bindings = new Map() } = {}) {
    const assets = values.map(plain), result = new Map(assets.map(a => [Number(a.id), empty(a)]));
    const eligible = assets.filter(a => a.isActive !== false && a.isActive !== 0 && uuid(a.whatsappAuthorizationId)
      && !a.additionalData?.whatsappArchive?.archivedAt && !a.additionalData?.whatsappManualDisconnect
      && !a.additionalData?.routing_disabled && bindings.get(Number(a.id))?.sendEnabled === true);
    if (!eligible.length || !db.WhatsappPhoneActivation?.findAll || !db.Message?.findAll || !db.Conversation
      || !db.WhatsappTemplate?.findAll) return result;
    const activations = await db.WhatsappPhoneActivation.findAll({ where: {
      authorization_id: { [Op.in]: eligible.map(a => a.whatsappAuthorizationId) }, state: 'active' },
      attributes: ['authorization_id', 'asset_id', 'scope_type', 'scope_id', 'clinic_ids', 'phone_id', 'waba_id', 'state', 'created_at', 'message_not_before'], raw: true });
    const byAuth = new Map(activations.map(a => [a.authorization_id, a]));
    const selected = eligible.map(asset => ({ asset, activation: currentActivation(asset,
      bindings.get(Number(asset.id)), byAuth.get(asset.whatsappAuthorizationId)) })).filter(a => a.activation);
    if (!selected.length) return result;
    const messages = (await db.Message.findAll({ where: { direction: 'outbound', message_type: 'template',
      status: { [Op.in]: ['delivered', 'read'] }, 'metadata.kind': 'mass_campaign_test', 'metadata.source': 'marketing_bulk_sends',
      [Op.or]: selected.map(({ asset, activation }) => ({ 'metadata.sender_origin_id': Number(asset.id),
        'metadata.phoneNumberId': asset.phoneNumberId, 'metadata.wabaId': asset.wabaId,
        createdAt: { [Op.gte]: new Date(activation.notBefore), [Op.lte]: now() } })) },
      attributes: ['id', 'direction', 'message_type', 'status', 'metadata', 'createdAt', 'updatedAt'],
      include: [{ model: db.Conversation, as: 'conversation', attributes: ['clinic_id', 'channel'], required: true,
        where: { channel: 'whatsapp', clinic_id: { [Op.in]: [...new Set(selected.flatMap(a => a.activation.clinic_ids.map(Number)))] } } }],
      order: [['id', 'DESC']], limit: Math.min(4096, Math.max(64, selected.length * 32)) })).map(plain);
    const templateIds = [...new Set(messages.map(m => Number(m.metadata?.template_id)).filter(positive))];
    if (!templateIds.length) return result;
    const templates = await db.WhatsappTemplate.findAll({ where: { id: { [Op.in]: templateIds },
      waba_id: { [Op.in]: selected.map(a => a.asset.wabaId) }, status: 'APPROVED', is_active: true },
      attributes: ['id', 'waba_id', 'name', 'language', 'status', 'is_active'], raw: true });
    const byTemplate = new Map(templates.map(t => [Number(t.id), t]));
    const byAsset = new Map(selected.map(a => [Number(a.asset.id), a]));
    for (const message of messages) {
      const selected = byAsset.get(Number(message.metadata?.sender_origin_id));
      if (!selected || result.get(Number(selected.asset.id)).verified) continue;
      const evidence = proof(selected.asset, selected.activation, message, byTemplate.get(Number(message.metadata.template_id)), now());
      if (evidence) result.set(Number(selected.asset.id), evidence);
    }
    return result;
  }
  async function read(asset, binding) { return (await forAssets([asset], { bindings: new Map([[Number(asset.id), binding]]) })).get(Number(asset.id)); }
  return { forAssets, read };
}
module.exports = { createService, empty, currentActivation, proof,
  forAssets: (...args) => createService().forAssets(...args), read: (...args) => createService().read(...args) };
