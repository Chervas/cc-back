'use strict';

const NAME_GENERIC_WORDS = new Set([
  'clinica',
  'clinic',
  'dental',
  'centro',
  'centre',
]);

const ADDRESS_GENERIC_WORDS = new Set([
  'av',
  'avenida',
  'avinguda',
  'c',
  'calle',
  'carrer',
  'carretera',
  'paseo',
  'passeig',
  'plaza',
  'placa',
  'via',
  'de',
  'del',
  'la',
  'las',
  'los',
  'el',
]);

const COUNTRY_ALIASES = Object.freeze({
  ES: ['espana', 'spain'],
  AD: ['andorra'],
  AR: ['argentina'],
  BO: ['bolivia'],
  BR: ['brasil', 'brazil'],
  CL: ['chile'],
  CO: ['colombia'],
  CR: ['costa rica'],
  DE: ['alemania', 'germany'],
  EC: ['ecuador'],
  FR: ['francia', 'france'],
  GB: ['reino unido', 'united kingdom', 'great britain'],
  IT: ['italia', 'italy'],
  MX: ['mexico'],
  PE: ['peru'],
  PT: ['portugal'],
  UY: ['uruguay'],
  VE: ['venezuela'],
});

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeText(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueTokens(value, excluded = new Set()) {
  return [...new Set(
    normalizeText(value)
      .split(' ')
      .filter((token) => token && !excluded.has(token) && !/^\d+$/.test(token))
  )];
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token));
}

function isSubset(left, right) {
  const rightSet = new Set(right);
  return left.every((token) => rightSet.has(token));
}

function isCompoundTokenMatch(left, right) {
  const compoundMatch = (singleSide, multiSide) => {
    if (singleSide.length !== 1 || multiSide.length < 2) return false;
    const compound = singleSide[0];
    return multiSide.reduce((total, token) => total + token.length, 0) === compound.length
      && multiSide.every((token) => compound.includes(token));
  };
  return compoundMatch(left, right) || compoundMatch(right, left);
}

function compareDisplayName(clinicName, metaName) {
  const clinicNormalized = normalizeText(clinicName);
  const metaNormalized = normalizeText(metaName);
  if (!clinicNormalized || !metaNormalized) {
    return {
      status: 'missing',
      risk: false,
      reason_code: !clinicNormalized ? 'clinic_name_missing' : 'meta_name_missing',
    };
  }
  if (clinicNormalized === metaNormalized) {
    return { status: 'aligned', risk: false, reason_code: 'exact_match' };
  }

  const clinicTokens = uniqueTokens(clinicName, NAME_GENERIC_WORDS);
  const metaTokens = uniqueTokens(metaName, NAME_GENERIC_WORDS);
  if (!clinicTokens.length || !metaTokens.length) {
    return { status: 'review', risk: true, reason_code: 'insufficient_name_tokens' };
  }
  if (isSubset(clinicTokens, metaTokens) || isSubset(metaTokens, clinicTokens)) {
    return { status: 'aligned', risk: false, reason_code: 'compatible_short_name' };
  }
  if (isCompoundTokenMatch(clinicTokens, metaTokens)) {
    return { status: 'aligned', risk: false, reason_code: 'compatible_compound_name' };
  }

  const shared = intersection(clinicTokens, metaTokens);
  if (!shared.length) {
    return { status: 'mismatch', risk: true, reason_code: 'name_tokens_conflict' };
  }
  return {
    status: 'review',
    risk: true,
    reason_code: 'branch_qualifier_differs',
  };
}

function detectCountryCode(value) {
  const normalized = ` ${normalizeText(value)} `;
  if (!normalized.trim()) return null;
  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(` ${alias} `))) return code;
  }
  return null;
}

function extractPostalCodes(value) {
  return normalizeText(value).match(/\b\d{5}\b/g) || [];
}

function extractStreetNumbers(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => /^\d{1,4}[a-z]?$/.test(token));
}

function buildCanonicalClinicIdentity(clinic = null) {
  const row = clinic?.get ? clinic.get({ plain: true }) : (clinic || {});
  const cleanPart = (value) => clean(value).replace(/^[,\s]+|[,\s]+$/g, '');
  const street = cleanPart(row.direccion);
  const postalCode = cleanPart(row.codigo_postal);
  const city = cleanPart(row.ciudad);
  const province = cleanPart(row.provincia);
  const country = cleanPart(row.pais);
  const locality = [postalCode, city].filter(Boolean).join(' ');
  const parts = [street, locality];
  if (province && normalizeText(province) !== normalizeText(city)) parts.push(province);
  if (country) parts.push(country);
  return {
    name: clean(row.nombre_clinica) || null,
    address: parts.filter(Boolean).join(', ') || null,
    address_parts: {
      street: street || null,
      postal_code: postalCode || null,
      city: city || null,
      province: province || null,
      country: country || null,
    },
  };
}

function compareAddress(clinicIdentity, metaAddress) {
  const canonical = clean(clinicIdentity?.address);
  const profile = clean(metaAddress);
  if (!canonical || !profile) {
    return {
      status: 'missing',
      risk: false,
      reason_codes: [!canonical ? 'clinic_address_missing' : 'meta_address_missing'],
    };
  }
  if (normalizeText(canonical) === normalizeText(profile)) {
    return { status: 'aligned', risk: false, reason_codes: ['exact_match'] };
  }

  const conflicts = [];
  const canonicalCountry = detectCountryCode(clinicIdentity?.address_parts?.country);
  const profileCountry = detectCountryCode(profile);
  if (canonicalCountry && profileCountry && canonicalCountry !== profileCountry) {
    conflicts.push('country_conflict');
  }

  const canonicalPostal = clean(clinicIdentity?.address_parts?.postal_code);
  const profilePostalCodes = extractPostalCodes(profile);
  if (canonicalPostal && profilePostalCodes.length && !profilePostalCodes.includes(canonicalPostal)) {
    conflicts.push('postal_code_conflict');
  }

  const canonicalStreet = clean(clinicIdentity?.address_parts?.street);
  const canonicalNumbers = extractStreetNumbers(canonicalStreet);
  const profileNumbers = extractStreetNumbers(profile).filter((number) => !profilePostalCodes.includes(number));
  if (canonicalNumbers.length && profileNumbers.length && !canonicalNumbers.some((number) => profileNumbers.includes(number))) {
    conflicts.push('street_number_conflict');
  }

  const canonicalStreetTokens = uniqueTokens(canonicalStreet, ADDRESS_GENERIC_WORDS);
  const profileTokens = uniqueTokens(profile, ADDRESS_GENERIC_WORDS);
  const sharedStreetTokens = intersection(canonicalStreetTokens, profileTokens);
  if (canonicalStreetTokens.length && profileTokens.length && !sharedStreetTokens.length) {
    conflicts.push('street_name_conflict');
  }

  if (conflicts.length) {
    return { status: 'mismatch', risk: true, reason_codes: conflicts };
  }

  const numberCompatible = !canonicalNumbers.length
    || !profileNumbers.length
    || canonicalNumbers.some((number) => profileNumbers.includes(number));
  if (sharedStreetTokens.length && numberCompatible) {
    return { status: 'aligned', risk: false, reason_codes: ['street_match'] };
  }
  return { status: 'review', risk: true, reason_codes: ['address_similarity_inconclusive'] };
}

function buildWhatsappProfileAlignment({ clinic = null, verifiedName = null, additionalData = {} } = {}) {
  const data = additionalData && typeof additionalData === 'object' && !Array.isArray(additionalData)
    ? additionalData
    : {};
  const clinicIdentity = buildCanonicalClinicIdentity(clinic);
  const metaName = clean(verifiedName) || null;
  const metaAddress = clean(data.profileAddress) || null;
  const displayName = compareDisplayName(clinicIdentity.name, metaName);
  const address = compareAddress(clinicIdentity, metaAddress);
  const riskCodes = [];
  if (displayName.risk) riskCodes.push(`display_name:${displayName.reason_code}`);
  if (address.risk) riskCodes.push(...address.reason_codes.map((code) => `address:${code}`));

  const hasMismatch = displayName.status === 'mismatch' || address.status === 'mismatch';
  const hasReview = displayName.status === 'review' || address.status === 'review';
  return {
    meta: {
      name: metaName,
      requested_name: clean(data.newDisplayName || data.new_display_name || data.requestedDisplayName) || null,
      address: metaAddress,
      category: clean(data.profileCategory) || null,
      description: clean(data.profileDescription) || null,
      email: clean(data.profileEmail) || null,
      website: clean(data.profileWebsite) || null,
      observed_at: clean(data.profileObservedAt || data.whatsappPhoneSync?.last_full_sync_at) || null,
    },
    clinic: clinicIdentity,
    comparisons: {
      display_name: displayName,
      address,
    },
    risk_level: hasMismatch ? 'warning' : (hasReview ? 'review' : 'none'),
    risk_codes: riskCodes,
  };
}

module.exports = {
  buildCanonicalClinicIdentity,
  buildWhatsappProfileAlignment,
  compareAddress,
  compareDisplayName,
  normalizeText,
};
