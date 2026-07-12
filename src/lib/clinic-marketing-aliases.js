'use strict';

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function configuredClinicMarketingAliases(clinic) {
  const config = asObject(clinic?.configuracion ?? clinic?.configuration);
  return Array.from(new Set([
    ...(Array.isArray(config.marketing_aliases) ? config.marketing_aliases : []),
    ...(Array.isArray(config.campaign_aliases) ? config.campaign_aliases : []),
  ]
    .map((value) => String(value ?? '').normalize('NFC').trim())
    .filter(Boolean)));
}

module.exports = { configuredClinicMarketingAliases };
