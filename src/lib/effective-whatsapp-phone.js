'use strict';

function filterEffectiveWhatsappPhoneAssets(phones = [], effectiveConfig = {}) {
  const effectiveOriginId = Number(effectiveConfig?.originId || 0) || null;
  const effectivePhoneNumberId = String(effectiveConfig?.phoneNumberId || '').trim();

  if (!effectiveOriginId && !effectivePhoneNumberId) {
    return [];
  }

  return phones.filter((phone) => (
    (effectiveOriginId && Number(phone?.id) === effectiveOriginId)
    || (
      effectivePhoneNumberId
      && String(phone?.phoneNumberId || '').trim() === effectivePhoneNumberId
    )
  ));
}

module.exports = {
  filterEffectiveWhatsappPhoneAssets,
};
