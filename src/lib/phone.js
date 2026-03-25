'use strict';

const DEFAULT_COUNTRY_CODE = String(
  process.env.META_WHATSAPP_DEFAULT_COUNTRY_CODE || '+34'
).replace(/\D/g, '') || '34';

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function extractPhoneCandidates(raw, { defaultCountryCode = DEFAULT_COUNTRY_CODE } = {}) {
  const value = cleanString(raw);
  if (!value) return [];

  const matches = value.match(/(?:\+|00)?\d(?:[\s()./-]*\d){8,14}/g) || [];
  const seeds = matches.length ? matches : [value];
  const ordered = [];
  const seen = new Set();

  const pushCandidate = (digits, meta = {}) => {
    const normalizedDigits = String(digits || '').replace(/\D/g, '');
    if (!normalizedDigits || normalizedDigits.length < 9 || normalizedDigits.length > 15) {
      return;
    }
    if (seen.has(normalizedDigits)) {
      return;
    }
    seen.add(normalizedDigits);
    ordered.push({
      digits: normalizedDigits,
      explicitInternational: !!meta.explicitInternational,
      assumedLocal: !!meta.assumedLocal,
      sourceIndex: Number.isInteger(meta.sourceIndex) ? meta.sourceIndex : ordered.length,
    });
  };

  seeds.forEach((seed, sourceIndex) => {
    const trimmed = cleanString(seed);
    if (!trimmed) return;

    const explicitInternational = trimmed.startsWith('+') || trimmed.startsWith('00');
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return;

    const baseDigits = trimmed.startsWith('00') ? digits.slice(2) : digits;
    pushCandidate(baseDigits, { explicitInternational, sourceIndex });

    if (baseDigits.length >= 12 && baseDigits.slice(0, 2) === baseDigits.slice(2, 4)) {
      pushCandidate(baseDigits.slice(2), { explicitInternational, sourceIndex: sourceIndex + 1 });
    }

    if (baseDigits.length >= 14 && baseDigits.slice(0, 3) === baseDigits.slice(3, 6)) {
      pushCandidate(baseDigits.slice(3), { explicitInternational, sourceIndex: sourceIndex + 1 });
    }

    if (!explicitInternational && baseDigits.length === 9 && defaultCountryCode) {
      pushCandidate(`${defaultCountryCode}${baseDigits}`, {
        assumedLocal: true,
        sourceIndex: sourceIndex - 1,
      });
    }
  });

  return ordered;
}

function scorePhoneCandidate(candidate, { defaultCountryCode = DEFAULT_COUNTRY_CODE } = {}) {
  if (!candidate?.digits) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (candidate.assumedLocal) score += 140;
  if (candidate.explicitInternational) score += 100;
  if (candidate.digits.startsWith(defaultCountryCode) && candidate.digits.length > 9) score += 40;
  if (candidate.digits.length >= 10 && candidate.digits.length <= 15) score += 20;
  if (candidate.digits.length === 9) score -= 40;
  score -= Number(candidate.sourceIndex || 0);
  return score;
}

function normalizePhoneDigits(raw, options = {}) {
  const candidates = extractPhoneCandidates(raw, options);
  if (!candidates.length) return null;

  const best = [...candidates]
    .sort((left, right) => scorePhoneCandidate(right, options) - scorePhoneCandidate(left, options))[0];

  return best?.digits || null;
}

function normalizePhoneE164(raw, options = {}) {
  const digits = normalizePhoneDigits(raw, options);
  return digits ? `+${digits}` : null;
}

function getPhoneLookupCandidates(raw, options = {}) {
  const rawValue = cleanString(raw);
  const digitsOnly = rawValue ? rawValue.replace(/\D/g, '') : null;
  const normalizedDigits = normalizePhoneDigits(rawValue, options);
  const normalizedE164 = normalizePhoneE164(rawValue, options);
  const localDigits = normalizedDigits && normalizedDigits.length > 9
    ? normalizedDigits.slice(-9)
    : normalizedDigits;

  return Array.from(new Set([
    normalizedE164,
    normalizedDigits,
    rawValue,
    digitsOnly,
    digitsOnly ? `+${digitsOnly}` : null,
    localDigits,
    localDigits ? `+${localDigits}` : null,
  ].filter(Boolean)));
}

module.exports = {
  DEFAULT_COUNTRY_CODE,
  extractPhoneCandidates,
  normalizePhoneDigits,
  normalizePhoneE164,
  getPhoneLookupCandidates,
};
