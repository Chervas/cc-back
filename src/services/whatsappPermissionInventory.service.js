'use strict';

const authorizedBroker = require('../lib/whatsappAuthorizedBrokerClient');

const validId = (value) => Number.isInteger(Number(value)) && Number(value) > 0;

async function read({ clinicId, phones, broker = authorizedBroker } = {}) {
  const safeClinicId = Number(clinicId);
  if (!validId(safeClinicId) || !Array.isArray(phones) || !phones.length) return new Map();

  let bindings;
  try {
    bindings = broker.bindingsForClinic(safeClinicId);
  } catch {
    return new Map();
  }
  const boundAssets = new Set(bindings.map((binding) => Number(binding.assetId)).filter(validId));
  const candidates = phones.filter((phone) => validId(phone?.id) && boundAssets.has(Number(phone.id)));
  const checked = await Promise.allSettled(candidates.map(async (phone) => ({
    assetId: Number(phone.id),
    status: await broker.permissionStatus(safeClinicId, Number(phone.id)),
  })));
  const statuses = new Map();
  for (const result of checked) {
    if (result.status === 'fulfilled' && ['connected', 'disconnected'].includes(result.value.status)) {
      statuses.set(result.value.assetId, result.value.status);
    }
  }
  return statuses;
}

module.exports = { read };
