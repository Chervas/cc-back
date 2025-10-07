'use strict';

const DEFAULT_DELIMITER = '**';

const removeDiacritics = (value = '') => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const normalizeWhitespace = (value = '') => value.replace(/[^a-z0-9]+/gi, ' ').trim().replace(/\s+/g, ' ');
const toLower = (value = '') => value.toLowerCase();

const sanitize = (value = '') => normalizeWhitespace(toLower(removeDiacritics(value)));
const compact = (value = '') => sanitize(value).replace(/\s+/g, '');

const extractTokens = (text = '', delimiter = DEFAULT_DELIMITER) => {
  if (!text || !delimiter) {
    return [];
  }
  const escaped = delimiter.replace(/([.*+?^${}()|[\]\\])/g, '\\$1');
  const regex = new RegExp(`${escaped}([^${escaped}]+?)${escaped}`, 'gi');
  const tokens = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const rawToken = (match[1] || '').trim();
    if (!rawToken) continue;
    const normalized = sanitize(rawToken);
    if (!normalized) continue;
    tokens.push({
      raw: rawToken,
      normalized,
      compact: compact(rawToken)
    });
  }
  return tokens;
};

const buildClinicIndex = (clinics = []) => clinics
  .map((clinic) => {
    const name = clinic?.nombre_clinica || clinic?.name || '';
    const id = clinic?.id_clinica || clinic?.id || clinic?.clinicaId;
    if (!id || !name) {
      return null;
    }
    const displayName = name.trim();
    return {
      id,
      displayName,
      normalized: sanitize(displayName),
      compact: compact(displayName),
      raw: clinic
    };
  })
  .filter(Boolean);

const matchClinic = (tokens = [], clinicIndex = []) => {
  if (!tokens.length || !clinicIndex.length) {
    return { match: null, candidates: [] };
  }

  const candidates = [];
  for (const token of tokens) {
    for (const clinic of clinicIndex) {
      if (token.normalized === clinic.normalized || token.compact === clinic.compact) {
        candidates.push({ clinic, token });
      }
    }
  }

  if (!candidates.length) {
    return { match: null, candidates: [] };
  }

  const uniqueClinicIds = Array.from(new Set(candidates.map((item) => item.clinic.id)));
  if (uniqueClinicIds.length === 1) {
    const clinicId = uniqueClinicIds[0];
    const winner = candidates.find((item) => item.clinic.id === clinicId) || null;
    return { match: winner, candidates };
  }

  return { match: null, candidates };
};

const buildClinicMatcher = (clinics = [], options = {}) => {
  const config = {
    delimiter: options.delimiter || DEFAULT_DELIMITER,
    requireDelimiter: options.requireDelimiter !== false,
    allowFallback: options.allowFallback || false
  };

  const clinicIndex = buildClinicIndex(clinics);

  const matchFromText = (text, meta = {}) => {
    if (!text) {
      return { match: null, candidates: [], tokens: [], meta };
    }

    const tokens = extractTokens(text, config.delimiter);

    if (config.requireDelimiter && tokens.length === 0) {
      return { match: null, candidates: [], tokens, meta };
    }

    let result = matchClinic(tokens, clinicIndex);

    if (!result.match && config.allowFallback && !config.requireDelimiter) {
      const fallbackToken = { raw: text, normalized: sanitize(text), compact: compact(text) };
      result = matchClinic([fallbackToken], clinicIndex);
      result.tokens = tokens.length ? tokens : [fallbackToken];
    }

    return { ...result, tokens, meta };
  };

  return {
    config,
    clinicIndex,
    matchFromText
  };
};

module.exports = {
  DEFAULT_DELIMITER,
  sanitize,
  extractTokens,
  buildClinicMatcher
};
