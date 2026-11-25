'use strict';

function imageHeader(components) {
  let parsed = components;
  if (typeof components === 'string') {
    try { parsed = JSON.parse(components); } catch { return undefined; }
  }
  return (Array.isArray(parsed) ? parsed : []).find(isImageHeader);
}

function isImageHeader(component) {
  return String(component?.type || '').toUpperCase() === 'HEADER'
    && String(component?.format || '').toUpperCase() === 'IMAGE';
}

function withCampaignImage(components, image) {
  if (!image || !Array.isArray(components)) return components;
  return components.map(component => isImageHeader(component) ? { ...component, campaign_image: image } : component);
}

async function resolveCampaignImage(Model, assetId, { clinicIds = [], groupId = null } = {}) {
  const id = Number(assetId);
  const asset = Number.isSafeInteger(id) && id > 0 ? await Model.findOne({
    where: { id, purpose: 'whatsapp_image', sensitivity: 'public', status: 'active' },
  }) : null;
  const sameScope = asset?.scope_type === 'clinic'
    ? clinicIds.map(Number).includes(Number(asset.clinica_id))
    : asset?.scope_type === 'group' && !!groupId && Number(asset.grupo_clinica_id) === Number(groupId);
  if (!sameScope || !/^https:\/\//i.test(asset.public_url || '')
    || !['image/jpeg', 'image/png'].includes(asset.content_type)
    || !(Number(asset.size_bytes) > 0 && Number(asset.size_bytes) <= 5 * 1024 * 1024)) {
    throw Object.assign(new Error('Selecciona una imagen PNG o JPEG de hasta 5 MB de esta clínica o grupo.'), {
      status: 409, statusCode: 409, code: 'whatsapp_campaign_image_invalid',
    });
  }
  return { asset_id: id, url: asset.public_url };
}

module.exports = { imageHeader, withCampaignImage, resolveCampaignImage };
