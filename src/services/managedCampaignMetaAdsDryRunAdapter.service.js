'use strict';

const crypto = require('node:crypto');
const { publicHttpUrl } = require('../lib/safeHttpTarget');

const ADAPTER_SCHEMA_VERSION = 'managed-meta-ads-dry-run-adapter/v1';
const ADAPTER_VERSION = '1.0.0';
const MONTHLY_BUDGET_DAYS = 30.4;
const SUPPORTED_FAMILIES = Object.freeze(['meta_reach', 'meta_instant_form']);
const SUPPORTED_OPERATIONS = Object.freeze(['create_new', 'update_existing']);
const TRACKING_READY_STATUSES = Object.freeze(['ready', 'configured']);
const META_CTA_TYPES = Object.freeze({
  meta_reach: Object.freeze([
    'BOOK_NOW', 'CONTACT_US', 'GET_QUOTE', 'LEARN_MORE', 'SIGN_UP',
  ]),
  meta_instant_form: Object.freeze([
    'APPLY_NOW', 'BOOK_NOW', 'DOWNLOAD', 'GET_OFFER', 'GET_QUOTE',
    'LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE',
  ]),
});
const META_LIMITS = Object.freeze({
  primary_texts: Object.freeze({ min: 1, max: 1, text: 2200 }),
  headlines: Object.freeze({ min: 0, max: 1, text: 255 }),
  descriptions: Object.freeze({ min: 0, max: 1, text: 255 }),
  media: Object.freeze({ min: 1, max: 1, text: 2048 }),
});

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, max = 2048) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  const clean = String(value).trim();
  return clean ? clean.slice(0, max) : null;
}

function positiveNumber(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function moneyCents(value) {
  const parsed = nonNegativeNumber(value);
  return parsed === null ? null : Math.round(parsed * 100);
}

function normalizedKey(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase();
}

const SAFE_TRACKING_QUERY_KEYS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
]);

function isSecretKey(key) {
  return /(^|_)(access_token|refresh_token|client_secret|api_key|private_key|password|passwd|authorization|cookie|session|hmac_key|credentials?|secret|token|appsecret_proof|signed_request|signature)($|_)/.test(normalizedKey(key));
}

function isSensitiveQueryKey(key) {
  const normalized = normalizedKey(key);
  return isSecretKey(normalized)
    || /^(sig|key|auth|code|proof|aws_access_key_id)$/i.test(normalized)
    || !SAFE_TRACKING_QUERY_KEYS.has(normalized);
}

function decodedSensitiveText(value) {
  let current = String(value || '').replace(/\+/g, ' ');
  for (let pass = 0; pass < 4; pass += 1) {
    if (/(?:^|[?&#\s])(access_token|refresh_token|client_secret|api_key|private_key|password|authorization|cookie|session|credential|secret|token|appsecret_proof|signed_request|signature|awsaccesskeyid|aws_access_key_id)=/i.test(current)) return true;
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch (_error) {
      return false;
    }
    if (decoded === current) break;
    current = decoded.replace(/\+/g, ' ');
  }
  return false;
}

function sensitiveUrl(value) {
  if (typeof value !== 'string') return false;
  const clean = value.trim();
  if (/(?:^|[?&#\s])(access_token|refresh_token|client_secret|api_key|private_key|password|authorization|cookie|session|credential|secret|token|appsecret_proof|signed_request|signature|awsaccesskeyid|aws_access_key_id)=/i.test(clean)) return true;
  if (!/^(?:https?:)?\/\//i.test(clean)) return false;
  if (decodedSensitiveText(clean)) return true;
  if (!/^https?:\/\//i.test(clean)) return false;
  let parsed;
  try {
    parsed = new URL(clean);
  } catch (_error) {
    return false;
  }
  if (Array.from(parsed.searchParams.keys()).some(isSensitiveQueryKey)) return true;
  if (Array.from(parsed.searchParams.values()).some(decodedSensitiveText)) return true;
  return decodedSensitiveText(parsed.hash.slice(1));
}

function containsSensitiveUrl(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (typeof value === 'string') return sensitiveUrl(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitiveUrl(item, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.values(value).some((item) => containsSensitiveUrl(item, depth + 1));
}

function sanitize(value, depth = 0) {
  if (depth > 12 || value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sensitiveUrl(value) ? null : value.slice(0, 10000);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (typeof value !== 'object') return null;

  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (isSecretKey(key)) continue;
    output[key] = sanitize(value[key], depth + 1);
  }
  return output;
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalStringify(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function issue(code, field, message) {
  return { code, field, message };
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
}

function strictText(value, max) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return { value: null, reason: 'type' };
  const clean = String(value).trim();
  if (!clean) return { value: null, reason: 'empty' };
  if (clean.length > max) return { value: null, reason: 'length' };
  return { value: clean, reason: null };
}

function normalizeTextList(value, {
  field,
  code,
  label,
  min,
  max,
  text: maxTextLength,
}, blockers) {
  const source = list(value);
  const normalized = [];
  const seen = new Set();
  let invalidCount = 0;
  let tooLongCount = 0;
  let duplicateCount = 0;

  for (const item of source) {
    const parsed = strictText(item, maxTextLength);
    if (!parsed.value) {
      if (parsed.reason === 'length') tooLongCount += 1;
      else invalidCount += 1;
      continue;
    }
    if (seen.has(parsed.value)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(parsed.value);
    normalized.push(parsed.value);
  }

  if (invalidCount) {
    blockers.push(issue(`${code}_invalid`, field, `${label}: ${invalidCount} elemento(s) no son referencias escalares válidas.`));
  }
  if (tooLongCount) {
    blockers.push(issue(`${code}_too_long`, field, `${label}: ${tooLongCount} elemento(s) superan ${maxTextLength} caracteres.`));
  }
  if (duplicateCount) {
    blockers.push(issue(`${code}_duplicate`, field, `${label}: elimina ${duplicateCount} duplicado(s) antes de preparar el manifiesto.`));
  }
  if (normalized.length < min) {
    blockers.push(issue(`${code}_required`, field, `${label}: se requieren al menos ${min} valor(es) válidos y únicos.`));
  }
  if (normalized.length > max) {
    blockers.push(issue(`${code}_too_many`, field, `${label}: el adaptador admite como máximo ${max} valor(es) revisables.`));
  }
  return normalized.slice(0, max);
}

function normalizeMediaReferences(value, blockers) {
  const source = list(value);
  const normalized = [];
  const seen = new Set();
  let invalidCount = 0;
  let tooLongCount = 0;
  let unsupportedCount = 0;
  let duplicateCount = 0;

  for (const item of source) {
    const parsed = strictText(item, META_LIMITS.media.text);
    if (!parsed.value) {
      if (parsed.reason === 'length') tooLongCount += 1;
      else invalidCount += 1;
      continue;
    }
    const internalAsset = parsed.value.match(/^asset:(image|video):([a-z0-9][a-z0-9._:-]{0,240})$/i);
    const descriptor = internalAsset
      ? {
          reference: parsed.value,
          asset_type: internalAsset[1].toUpperCase(),
          resolution_source: 'INTERNAL_ASSET',
        }
      : /^[1-9]\d{0,31}$/.test(parsed.value)
        ? { reference: parsed.value, asset_type: 'VIDEO', resolution_source: 'META_VIDEO_ID' }
        : /^[a-f0-9]{32,128}$/i.test(parsed.value)
          ? { reference: parsed.value, asset_type: 'IMAGE', resolution_source: 'META_IMAGE_HASH' }
          : null;
    if (!descriptor) {
      unsupportedCount += 1;
      continue;
    }
    if (seen.has(parsed.value)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(parsed.value);
    normalized.push(descriptor);
  }

  if (invalidCount) blockers.push(issue('adapter_meta_media_invalid', 'specification.creative.media', `Referencias de imagen o vídeo de Meta: ${invalidCount} elemento(s) no son escalares válidos.`));
  if (tooLongCount) blockers.push(issue('adapter_meta_media_too_long', 'specification.creative.media', `Referencias de imagen o vídeo de Meta: ${tooLongCount} elemento(s) superan ${META_LIMITS.media.text} caracteres.`));
  if (unsupportedCount) blockers.push(issue('adapter_meta_media_reference_invalid', 'specification.creative.media', `Referencias de imagen o vídeo de Meta: ${unsupportedCount} elemento(s) no son refs asset:image/video:, IDs de vídeo numéricos ni hashes de imagen Meta explícitos.`));
  if (duplicateCount) blockers.push(issue('adapter_meta_media_duplicate', 'specification.creative.media', `Elimina ${duplicateCount} referencia(s) de creatividad duplicada(s).`));
  if (normalized.length < META_LIMITS.media.min) blockers.push(issue('adapter_meta_media_required', 'specification.creative.media', 'Se requiere al menos una referencia de creatividad Meta válida y revisada.'));
  if (normalized.length > META_LIMITS.media.max) blockers.push(issue('adapter_meta_media_too_many', 'specification.creative.media', `El adaptador admite como máximo ${META_LIMITS.media.max} referencias de creatividad.`));
  return normalized.slice(0, META_LIMITS.media.max);
}

function normalizedTargetStrings(value) {
  if (value === undefined || value === null || value === '') return { values: [], provided: false, valid: true };
  const source = Array.isArray(value) ? value : [value];
  if (!source.length) return { values: [], provided: true, valid: false };
  const values = [];
  const seen = new Set();
  for (const item of source) {
    if (typeof item !== 'string') return { values: [], provided: true, valid: false };
    const parsed = strictText(item, 128);
    if (!parsed.value) return { values: [], provided: true, valid: false };
    if (!seen.has(parsed.value)) {
      seen.add(parsed.value);
      values.push(parsed.value);
    }
  }
  return { values, provided: true, valid: values.length > 0 };
}

function normalizeGeoTargeting(targeting, blockers) {
  const source = safeObject(targeting);
  const geo = safeObject(source.geo);
  const geoLocations = safeObject(source.geo_locations);
  const selections = [
    ['cities', geo.cities ?? geo.city ?? geoLocations.cities],
    ['locations', geo.locations ?? geo.location],
    ['countries', geo.countries ?? geo.country ?? geoLocations.countries],
    ['postal_codes', geo.postal_codes ?? geo.postal_code ?? geoLocations.zips],
    ['regions', geoLocations.regions],
  ];
  const normalized = {};
  let invalidSelection = false;
  for (const [key, value] of selections) {
    const parsed = normalizedTargetStrings(value);
    if (parsed.provided && !parsed.valid) invalidSelection = true;
    if (parsed.values.length) normalized[key] = parsed.values;
  }

  const coordinateValues = [geo.latitude, geo.longitude, geo.radius_km];
  const coordinatesProvided = coordinateValues.some((value) => value !== undefined && value !== null && value !== '');
  if (coordinatesProvided) {
    const latitude = typeof geo.latitude === 'number' ? geo.latitude : Number.NaN;
    const longitude = typeof geo.longitude === 'number' ? geo.longitude : Number.NaN;
    const radiusKm = typeof geo.radius_km === 'number' ? geo.radius_km : Number.NaN;
    if (Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      && Number.isFinite(radiusKm) && radiusKm > 0 && radiusKm <= 80) {
      normalized.custom_location = { latitude, longitude, radius_km: radiusKm };
    } else {
      invalidSelection = true;
    }
  }

  if (invalidSelection) {
    blockers.push(issue('adapter_meta_geo_targeting_invalid', 'specification.targeting', 'La geografía Meta contiene tipos o rangos no válidos; usa nombres/códigos de texto o coordenadas con radio entre 0 y 80 km.'));
  }
  if (!Object.keys(normalized).length) {
    blockers.push(issue('adapter_meta_geo_targeting_required', 'specification.targeting', 'El targeting Meta debe incluir una geografía local reconocible; el adaptador no inventa una audiencia amplia.'));
  }
  return { geo: normalized };
}

function normalizedScheduleDate(value, boundary) {
  const raw = strictText(value, 64);
  if (!raw.value) return { value: null, reason: raw.reason };
  let candidate = raw.value;
  const datePart = candidate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return { value: null, reason: 'format' };
  const calendarCheck = new Date(`${datePart}T00:00:00.000Z`);
  if (Number.isNaN(calendarCheck.getTime()) || calendarCheck.toISOString().slice(0, 10) !== datePart) {
    return { value: null, reason: 'format' };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    candidate = `${candidate}T${boundary === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`;
  } else {
    const dateTime = candidate.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/);
    if (!dateTime) return { value: null, reason: 'format' };
    const hour = Number(dateTime[1]);
    const minute = Number(dateTime[2]);
    const second = Number(dateTime[3] || 0);
    const offsetHour = Number(dateTime[6] || 0);
    const offsetMinute = Number(dateTime[7] || 0);
    if (hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59
      || (offsetHour === 14 && offsetMinute > 0)) {
      return { value: null, reason: 'format' };
    }
  }
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) return { value: null, reason: 'format' };
  return { value: parsed.toISOString(), reason: null };
}

function normalizeSchedule(schedule, blockers) {
  const source = safeObject(schedule);
  const hasStartTime = source.start_time !== undefined && source.start_time !== null && source.start_time !== '';
  const hasStartDate = source.start_date !== undefined && source.start_date !== null && source.start_date !== '';
  const hasEndTime = source.end_time !== undefined && source.end_time !== null && source.end_time !== '';
  const hasEndDate = source.end_date !== undefined && source.end_date !== null && source.end_date !== '';
  const startTime = normalizedScheduleDate(source.start_time, 'start');
  const startDate = normalizedScheduleDate(source.start_date, 'start');
  const endTime = normalizedScheduleDate(source.end_time, 'end');
  const endDate = normalizedScheduleDate(source.end_date, 'end');
  const start = hasStartTime ? startTime : startDate;
  const end = hasEndTime ? endTime : endDate;
  if (hasStartTime && hasStartDate && (!startTime.value || !startDate.value || startTime.value !== startDate.value)) {
    blockers.push(issue('adapter_meta_schedule_start_alias_conflict', 'specification.schedule', 'start_time y start_date no pueden expresar inicios distintos.'));
  }
  if (hasEndTime && hasEndDate && (!endTime.value || !endDate.value || endTime.value !== endDate.value)) {
    blockers.push(issue('adapter_meta_schedule_end_alias_conflict', 'specification.schedule', 'end_time y end_date no pueden expresar finales distintos.'));
  }
  if (!start.value) {
    blockers.push(issue(
      start.reason === 'empty' || start.reason === 'type' ? 'adapter_meta_schedule_start_required' : 'adapter_meta_schedule_start_invalid',
      'specification.schedule.start_date',
      'El presupuesto prepago Meta requiere una fecha de inicio ISO explícita.',
    ));
  }
  if (!end.value) {
    blockers.push(issue(
      end.reason === 'empty' || end.reason === 'type' ? 'adapter_meta_schedule_end_required' : 'adapter_meta_schedule_end_invalid',
      'specification.schedule.end_date',
      'El presupuesto prepago Meta requiere una fecha de fin ISO explícita para impedir gasto indefinido.',
    ));
  }
  if (start.value && end.value && Date.parse(end.value) <= Date.parse(start.value)) {
    blockers.push(issue('adapter_meta_schedule_range_invalid', 'specification.schedule', 'La fecha de fin Meta debe ser posterior a la fecha de inicio.'));
  } else if (start.value && end.value) {
    const durationMs = Date.parse(end.value) - Date.parse(start.value);
    if (durationMs < (28 * 24 * 60 * 60 * 1000) - 1 || durationMs > 31 * 24 * 60 * 60 * 1000) {
      blockers.push(issue('adapter_meta_schedule_monthly_window_invalid', 'specification.schedule', 'El periodo mensual Meta debe abarcar entre 28 y 31 días para mantener el pacing del prepago.'));
    }
  }
  return { start_time: start.value, end_time: end.value };
}

function normalizePublicUrl(value, blockers) {
  const candidate = strictText(value, 2048);
  if (!candidate.value) {
    if (candidate.reason === 'type' || candidate.reason === 'length') {
      blockers.push(issue(
        'adapter_meta_destination_invalid',
        'specification.destination.final_url',
        'El destino Meta debe ser una URL HTTP(S) pública escalar y sin credenciales.',
      ));
    }
    return null;
  }
  const normalized = sensitiveUrl(candidate.value) ? null : publicHttpUrl(candidate.value);
  if (!normalized) {
    blockers.push(issue(
      'adapter_meta_destination_invalid',
      'specification.destination.final_url',
      'El destino Meta debe ser una URL HTTP(S) pública y sin credenciales.',
    ));
  }
  return normalized;
}

function planningBudget(specification, blockers, warnings) {
  const budget = safeObject(specification.budget);
  const requestedAmount = positiveNumber(budget.provider_media_budget_amount);
  const approvedClientGrossAmount = positiveNumber(budget.approved_client_gross_amount);
  const fundedClientGrossAmount = positiveNumber(budget.funded_client_gross_amount);
  const commissionAmount = nonNegativeNumber(budget.commission_amount);
  const mediaBudgetTotal = positiveNumber(budget.media_budget_total);
  const mediaBudgetAvailable = positiveNumber(budget.media_budget_available);
  const declaredApprovedMediaBudgetCap = positiveNumber(budget.approved_media_budget_cap);
  const expectedApprovedMediaBudgetCap = approvedClientGrossAmount && fundedClientGrossAmount && mediaBudgetTotal
    ? Math.round(((approvedClientGrossAmount * mediaBudgetTotal / fundedClientGrossAmount) + Number.EPSILON) * 100) / 100
    : null;
  const amount = requestedAmount && mediaBudgetTotal && mediaBudgetAvailable && expectedApprovedMediaBudgetCap
    ? Math.min(requestedAmount, mediaBudgetTotal, mediaBudgetAvailable, expectedApprovedMediaBudgetCap)
    : null;
  const period = text(budget.period, 32)?.toLowerCase();
  const parsedCurrency = strictText(budget.currency, 3);
  const currency = parsedCurrency.value?.toUpperCase() || null;

  if (!requestedAmount) blockers.push(issue('adapter_provider_budget_required', 'specification.budget.provider_media_budget_amount', 'El adaptador Meta requiere un presupuesto neto disponible para medios.'));
  if (!approvedClientGrossAmount) blockers.push(issue('adapter_approved_gross_budget_required', 'specification.budget.approved_client_gross_amount', 'Falta el total bruto aprobado por el cliente.'));
  if (!fundedClientGrossAmount) blockers.push(issue('adapter_funded_gross_budget_required', 'specification.budget.funded_client_gross_amount', 'Falta el total bruto realmente cobrado.'));
  if (commissionAmount === null) blockers.push(issue('adapter_commission_snapshot_required', 'specification.budget.commission_amount', 'Falta el snapshot de comisión del prepago.'));
  if (!mediaBudgetTotal) blockers.push(issue('adapter_media_budget_total_required', 'specification.budget.media_budget_total', 'Falta el presupuesto neto total después de comisión.'));
  if (!mediaBudgetAvailable) blockers.push(issue('adapter_media_budget_available_required', 'specification.budget.media_budget_available', 'Falta el saldo neto todavía disponible para medios.'));
  if (!declaredApprovedMediaBudgetCap) blockers.push(issue('adapter_approved_media_cap_required', 'specification.budget.approved_media_budget_cap', 'Falta la asignación neta del periodo aprobado.'));
  if (declaredApprovedMediaBudgetCap && expectedApprovedMediaBudgetCap
    && moneyCents(declaredApprovedMediaBudgetCap) !== moneyCents(expectedApprovedMediaBudgetCap)) {
    blockers.push(issue('adapter_approved_media_cap_inconsistent', 'specification.budget.approved_media_budget_cap', 'La asignación neta declarada no coincide con el presupuesto aprobado y el desglose financiado.'));
  }
  if (requestedAmount && mediaBudgetTotal && requestedAmount > mediaBudgetTotal) {
    blockers.push(issue('adapter_provider_budget_exceeds_net', 'specification.budget.provider_media_budget_amount', 'El presupuesto Meta no puede superar el neto destinado a publicidad.'));
  }
  if (requestedAmount && mediaBudgetAvailable && requestedAmount > mediaBudgetAvailable) {
    blockers.push(issue('adapter_provider_budget_exceeds_available', 'specification.budget.provider_media_budget_amount', 'El presupuesto Meta no puede superar el saldo neto disponible.'));
  }
  if (requestedAmount && expectedApprovedMediaBudgetCap && requestedAmount > expectedApprovedMediaBudgetCap) {
    blockers.push(issue('adapter_provider_budget_exceeds_approved_cap', 'specification.budget.provider_media_budget_amount', 'El presupuesto Meta no puede superar la asignación neta del periodo aprobado.'));
  }
  if (mediaBudgetTotal && fundedClientGrossAmount && mediaBudgetTotal > fundedClientGrossAmount) {
    blockers.push(issue('adapter_media_budget_exceeds_gross', 'specification.budget.media_budget_total', 'El presupuesto neto de medios no puede superar el total bruto del cliente.'));
  }
  if (mediaBudgetAvailable && mediaBudgetTotal && mediaBudgetAvailable > mediaBudgetTotal) {
    blockers.push(issue('adapter_available_media_exceeds_net', 'specification.budget.media_budget_available', 'El saldo neto disponible no puede superar el neto total de medios.'));
  }
  const fundedCents = moneyCents(fundedClientGrossAmount);
  const commissionCents = moneyCents(commissionAmount);
  const mediaBudgetCents = moneyCents(mediaBudgetTotal);
  if (fundedCents !== null && commissionCents !== null && mediaBudgetCents !== null
    && fundedCents - commissionCents !== mediaBudgetCents) {
    blockers.push(issue('adapter_funding_breakdown_inconsistent', 'specification.budget', 'El bruto cobrado menos la comisión no coincide con el neto de medios.'));
  }
  if (fundedClientGrossAmount && approvedClientGrossAmount && fundedClientGrossAmount < approvedClientGrossAmount) {
    blockers.push(issue('adapter_funding_below_approved_budget', 'specification.budget.funded_client_gross_amount', 'El prepago no cubre el presupuesto bruto aprobado.'));
  }
  if (period !== 'monthly') {
    blockers.push(issue('adapter_budget_period_unsupported', 'specification.budget.period', 'El piloto Meta solo admite presupuesto mensual prepago con límite total; el modo diario requiere modelar duración y cap antes de habilitarse.'));
  }
  if (currency !== 'EUR') {
    blockers.push(issue('adapter_budget_currency_unsupported', 'specification.budget.currency', 'El piloto Meta dry-run solo admite EUR; no se asumirá el exponente de unidades menores de otra moneda.'));
  }

  const divisor = period === 'monthly' ? MONTHLY_BUDGET_DAYS : 1;
  const amountMinorUnits = amount === null ? null : Math.floor((amount + Number.EPSILON) * 100);
  const validLifetimeMinorUnits = Number.isSafeInteger(amountMinorUnits) && amountMinorUnits > 0;
  const flooredMinorUnits = validLifetimeMinorUnits && period === 'monthly'
    ? Math.floor(amountMinorUnits / divisor)
    : null;
  const validMinorUnits = Number.isSafeInteger(flooredMinorUnits) && flooredMinorUnits > 0;
  const dailyAmount = validMinorUnits ? flooredMinorUnits / 100 : null;
  if (requestedAmount && !validLifetimeMinorUnits) {
    blockers.push(issue(
      'adapter_budget_minor_units_invalid',
      'specification.budget.provider_media_budget_amount',
      'El presupuesto Meta convertido a unidades menores debe producir un límite total positivo y seguro.',
    ));
  }
  if (requestedAmount && period === 'monthly') {
    warnings.push(issue(
      'adapter_monthly_budget_normalized',
      'specification.budget',
      `La simulación divide el presupuesto mensual entre ${MONTHLY_BUDGET_DAYS} días solo como referencia; el AdSet queda limitado por el presupuesto total prepago.`,
    ));
  }
  warnings.push(issue(
    'adapter_meta_minimum_budget_not_verified',
    'specification.budget',
    'El dry-run no consulta los mínimos dinámicos de presupuesto de la cuenta Meta; deberán verificarse antes de cualquier ejecución futura.',
  ));

  return {
    client_period: period || null,
    approved_client_gross_amount: approvedClientGrossAmount,
    funded_client_gross_amount: fundedClientGrossAmount,
    media_budget_total: mediaBudgetTotal,
    media_budget_available: mediaBudgetAvailable,
    approved_media_budget_cap: expectedApprovedMediaBudgetCap,
    declared_approved_media_budget_cap: declaredApprovedMediaBudgetCap,
    requested_provider_media_budget_amount: requestedAmount,
    provider_media_budget_amount: amount,
    planning_lifetime_amount: validLifetimeMinorUnits ? amountMinorUnits / 100 : null,
    planning_lifetime_amount_minor_units: validLifetimeMinorUnits ? amountMinorUnits : null,
    planning_daily_amount: dailyAmount,
    planning_daily_amount_minor_units: validMinorUnits ? flooredMinorUnits : null,
    currency,
    divisor_days: period === 'monthly' ? MONTHLY_BUDGET_DAYS : null,
  };
}

function normalizeOperation(specification, blockers) {
  const operation = text(specification.operation, 32);
  const rawCampaignId = text(specification.existing_campaign_id, 256);
  const campaignId = rawCampaignId && /^[1-9]\d{0,31}$/.test(rawCampaignId) ? rawCampaignId : null;
  if (!SUPPORTED_OPERATIONS.includes(operation)) {
    blockers.push(issue(
      'adapter_operation_unsupported',
      'specification.operation',
      'La operación debe ser create_new o update_existing; no se aplicará un default implícito.',
    ));
    return { operation: null, existingCampaignId: null, ready: false };
  }
  if (operation === 'update_existing' && !campaignId) {
    blockers.push(issue(
      'adapter_existing_campaign_id_required',
      'specification.existing_campaign_id',
      'update_existing requiere un campaign ID Meta numérico explícito.',
    ));
    return { operation, existingCampaignId: null, ready: false };
  }
  if (operation === 'create_new' && rawCampaignId) {
    blockers.push(issue(
      'adapter_existing_campaign_id_conflict',
      'specification.existing_campaign_id',
      'create_new no puede incluir un campaign ID existente.',
    ));
    return { operation, existingCampaignId: null, ready: false };
  }
  return { operation, existingCampaignId: campaignId, ready: true };
}

function normalizedNumericId(value, { code, field, label, required = false }, blockers) {
  const raw = text(value, 128);
  if (!raw) {
    if (required) blockers.push(issue(`${code}_required`, field, `${label} es obligatorio.`));
    return null;
  }
  if (!/^[1-9]\d{0,31}$/.test(raw)) {
    blockers.push(issue(`${code}_invalid`, field, `${label} debe ser un ID numérico.`));
    return null;
  }
  return raw;
}

function normalizeSpecification(specification, family, blockers, warnings) {
  const operation = normalizeOperation(specification, blockers);
  const rawAccountId = text(specification.account_id, 128);
  const accountDigits = rawAccountId?.replace(/^act_/, '') || null;
  const accountId = accountDigits && /^[1-9]\d{0,31}$/.test(accountDigits) ? `act_${accountDigits}` : null;
  if (!accountId) {
    blockers.push(issue('adapter_meta_account_required', 'specification.account_id', 'El adaptador dry-run requiere un ad account Meta numérico, con prefijo act_ opcional.'));
  } else {
    warnings.push(issue('adapter_meta_account_access_not_verified', 'specification.account_id', 'El dry-run valida el formato, pero no consulta en Meta el acceso ni la propiedad de la cuenta publicitaria.'));
  }

  const campaignName = strictText(specification.name, 255);
  if (!campaignName.value) {
    blockers.push(issue(
      campaignName.reason === 'length' ? 'adapter_campaign_name_too_long' : 'adapter_campaign_name_required',
      'specification.name',
      campaignName.reason === 'length'
        ? 'El nombre de campaña supera 255 caracteres.'
        : 'El adaptador dry-run requiere un nombre de campaña.',
    ));
  }

  const expectedObjective = family === 'meta_instant_form' ? 'OUTCOME_LEADS' : 'OUTCOME_AWARENESS';
  const suppliedObjective = text(specification.provider_objective, 64);
  if (suppliedObjective !== expectedObjective) {
    blockers.push(issue(
      'adapter_meta_objective_invalid',
      'specification.provider_objective',
      `La familia ${family || 'desconocida'} requiere el objetivo ${expectedObjective}.`,
    ));
  }

  const identity = safeObject(specification.identity);
  const pageId = normalizedNumericId(identity.page_id, {
    code: 'adapter_meta_page', field: 'specification.identity.page_id', label: 'La página Meta', required: true,
  }, blockers);
  const instagramActorId = normalizedNumericId(identity.instagram_actor_id, {
    code: 'adapter_meta_instagram_actor', field: 'specification.identity.instagram_actor_id', label: 'La identidad de Instagram', required: false,
  }, blockers);
  if (pageId) {
    warnings.push(issue('adapter_meta_page_access_not_verified', 'specification.identity.page_id', 'El dry-run valida el ID, pero no consulta en Meta la propiedad ni los permisos de la página.'));
  }
  if (operation.existingCampaignId) {
    warnings.push(issue('adapter_meta_existing_campaign_not_verified', 'specification.existing_campaign_id', 'El dry-run no consulta si la campaña existente pertenece a la cuenta indicada ni si admite nuevos objetos.'));
  }

  const compliance = safeObject(specification.compliance);
  const dsaBeneficiary = strictText(compliance.dsa_beneficiary, 255);
  const dsaPayor = strictText(compliance.dsa_payor, 255);
  if (!dsaBeneficiary.value) {
    blockers.push(issue(
      dsaBeneficiary.reason === 'length' ? 'adapter_meta_dsa_beneficiary_too_long' : 'adapter_meta_dsa_beneficiary_required',
      'specification.compliance.dsa_beneficiary',
      'La publicación Meta dirigida a la UE requiere identificar al beneficiario DSA.',
    ));
  }
  if (!dsaPayor.value) {
    blockers.push(issue(
      dsaPayor.reason === 'length' ? 'adapter_meta_dsa_payor_too_long' : 'adapter_meta_dsa_payor_required',
      'specification.compliance.dsa_payor',
      'La publicación Meta dirigida a la UE requiere identificar al pagador DSA.',
    ));
  }

  const creative = safeObject(specification.creative);
  const primaryTexts = normalizeTextList(creative.primary_texts, {
    field: 'specification.creative.primary_texts', code: 'adapter_meta_primary_texts', label: 'Textos principales de Meta', ...META_LIMITS.primary_texts,
  }, blockers);
  const headlines = normalizeTextList(creative.headlines, {
    field: 'specification.creative.headlines', code: 'adapter_meta_headlines', label: 'Titulares de Meta', ...META_LIMITS.headlines,
  }, blockers);
  const descriptions = normalizeTextList(creative.descriptions, {
    field: 'specification.creative.descriptions', code: 'adapter_meta_descriptions', label: 'Descripciones de Meta', ...META_LIMITS.descriptions,
  }, blockers);
  const media = normalizeMediaReferences(creative.media, blockers);
  if (media.length) {
    warnings.push(issue(
      'adapter_meta_media_resolution_not_verified',
      'specification.creative.media',
      'El dry-run conserva referencias sanitizadas, pero no consulta Meta ni sube archivos; resolución, formato y disponibilidad deberán verificarse antes de ejecutar.',
    ));
  }
  const callToAction = strictText(creative.call_to_action, 64);
  const validCallToAction = callToAction.value && (META_CTA_TYPES[family] || []).includes(callToAction.value)
    ? callToAction.value
    : null;
  if (callToAction.reason === 'length' || (callToAction.value && !validCallToAction)) {
    blockers.push(issue('adapter_meta_cta_invalid', 'specification.creative.call_to_action', `El CTA no pertenece a la lista admitida para ${family || 'esta familia'}; usa un valor revisado como LEARN_MORE.`));
  }

  const destination = safeObject(specification.destination);
  const destinationAliases = [destination.final_url, destination.landing_url, destination.url, destination.effective_url]
    .filter((value) => value !== undefined && value !== null && value !== '');
  const normalizedDestinationAliases = destinationAliases.map((value) => normalizePublicUrl(value, blockers));
  if (destinationAliases.length > 1
    && (normalizedDestinationAliases.some((value) => !value)
      || new Set(normalizedDestinationAliases).size > 1)) {
    blockers.push(issue('adapter_meta_destination_alias_conflict', 'specification.destination', 'Los aliases de destino Meta contienen URLs distintas; conserva una única URL final.'));
  }
  const finalUrl = normalizedDestinationAliases[0] || null;
  const instantFormAliases = [
    specification.instant_form_id,
    destination.instant_form_id,
    destination.form_id,
  ].filter((value) => value !== undefined && value !== null && value !== '');
  const normalizedInstantFormAliases = instantFormAliases.map((value) => {
    const candidate = text(value, 128);
    return candidate && /^[1-9]\d{0,31}$/.test(candidate) ? candidate : null;
  });
  if (instantFormAliases.length > 1
    && (normalizedInstantFormAliases.some((value) => !value)
      || new Set(normalizedInstantFormAliases).size > 1)) {
    blockers.push(issue('adapter_meta_instant_form_alias_conflict', 'specification.instant_form_id', 'Los aliases de formulario instantáneo contienen IDs distintos; conserva una única referencia explícita.'));
  }
  const instantFormId = normalizedNumericId(
    instantFormAliases[0],
    {
      code: 'adapter_meta_instant_form',
      field: 'specification.instant_form_id',
      label: 'El formulario instantáneo Meta',
      required: family === 'meta_instant_form',
    },
    blockers,
  );

  if (family === 'meta_instant_form') {
    if (!validCallToAction) {
      blockers.push(issue('adapter_meta_cta_required', 'specification.creative.call_to_action', 'El anuncio de formulario instantáneo requiere un CTA explícito.'));
    }
    if (!headlines.length) {
      blockers.push(issue('adapter_meta_form_headline_required', 'specification.creative.headlines', 'El anuncio de formulario instantáneo requiere al menos un titular revisado.'));
    }
    if (instantFormId) {
      warnings.push(issue(
        'adapter_meta_instant_form_not_verified',
        'specification.instant_form_id',
        'El ID del formulario es válido, pero el dry-run no consulta su existencia, propiedad ni estado publicado en Meta.',
      ));
    }
  } else if (family === 'meta_reach') {
    if (finalUrl && !validCallToAction) {
      blockers.push(issue('adapter_meta_cta_required', 'specification.creative.call_to_action', 'El anuncio de alcance con destino web requiere un CTA explícito.'));
    }
    if (!finalUrl && validCallToAction) {
      blockers.push(issue('adapter_meta_cta_destination_required', 'specification.destination.final_url', 'No se puede preparar un CTA de alcance sin una URL pública de destino.'));
    }
    if (!finalUrl && !validCallToAction) {
      warnings.push(issue('adapter_meta_native_reach_only', 'specification.destination', 'Sin URL ni CTA, el manifiesto queda limitado a una creatividad nativa de alcance.'));
    }
  }

  const rawTargeting = sanitize(safeObject(specification.targeting));
  if (!Object.keys(rawTargeting).length) {
    blockers.push(issue('adapter_meta_targeting_required', 'specification.targeting', 'Meta requiere un targeting revisado; el adaptador no inventa una audiencia amplia por defecto.'));
  }
  const targeting = normalizeGeoTargeting(rawTargeting, blockers);
  const schedule = normalizeSchedule(specification.schedule, blockers);
  const rawAudience = safeObject(specification.audience);
  const audienceStatus = text(rawAudience.eligibility_status ?? rawAudience.status, 32)?.toLowerCase() || null;
  if (!['ready', 'configured', 'approved'].includes(audienceStatus)) {
    blockers.push(issue('adapter_meta_audience_not_ready', 'specification.audience.eligibility_status', 'La elegibilidad de audiencia Meta debe estar revisada y marcada como ready, configured o approved.'));
  }
  const audience = { eligibility_status: audienceStatus };

  const tracking = safeObject(specification.tracking);
  const trackingStatus = text(tracking.status, 32)?.toLowerCase() || null;
  const conversionActionsReady = tracking.conversion_actions_ready === true;
  const pixelId = normalizedNumericId(tracking.pixel_id, {
    code: 'adapter_meta_pixel', field: 'specification.tracking.pixel_id', label: 'El píxel Meta', required: false,
  }, blockers);
  if ((trackingStatus && !TRACKING_READY_STATUSES.includes(trackingStatus))
    || (!trackingStatus && !conversionActionsReady)) {
    blockers.push(issue('adapter_meta_tracking_not_ready', 'specification.tracking', 'El tracking debe estar configurado o tener las acciones de conversión verificadas.'));
  }
  if (family === 'meta_reach' && finalUrl && !pixelId) {
    warnings.push(issue('adapter_meta_pixel_not_configured', 'specification.tracking.pixel_id', 'No hay píxel Meta asignado; el alcance web solo podrá conciliar métricas nativas y contactos medidos por otros canales.'));
  } else if (pixelId) {
    warnings.push(issue('adapter_meta_pixel_not_verified', 'specification.tracking.pixel_id', 'El dry-run valida el formato del píxel, pero no consulta en Meta su propiedad, acceso ni actividad.'));
  }

  return {
    provider: 'meta_ads',
    family,
    operation: operation.operation,
    existing_campaign_id: operation.existingCampaignId,
    account_id: accountId,
    name: campaignName.value,
    objective_id: text(specification.objective_id, 64),
    provider_objective: expectedObjective,
    budget: sanitize(safeObject(specification.budget)),
    targeting,
    audience,
    schedule,
    destination: {
      final_url: family === 'meta_reach' ? finalUrl : null,
      instant_form_id: family === 'meta_instant_form' ? instantFormId : null,
    },
    identity: { page_id: pageId, instagram_actor_id: instagramActorId },
    compliance: { dsa_beneficiary: dsaBeneficiary.value, dsa_payor: dsaPayor.value },
    instant_form_id: family === 'meta_instant_form' ? instantFormId : null,
    tracking: {
      status: trackingStatus,
      conversion_actions_ready: conversionActionsReady,
      pixel_id: pixelId,
      measurement_mode: family === 'meta_instant_form'
        ? 'instant_form_native_lead'
        : pixelId ? 'meta_pixel_and_native_delivery' : 'native_delivery_only',
    },
    creative: {
      primary_texts: primaryTexts,
      headlines,
      descriptions,
      media,
      call_to_action: validCallToAction,
    },
    operation_ready: operation.ready,
  };
}

function operation(order, key, resourceType, action, label, payloadPreview, dependsOn = []) {
  return {
    order,
    key,
    resource_type: resourceType,
    action,
    label,
    depends_on: dependsOn,
    payload_preview: sanitize(payloadPreview),
    provider_call_performed: false,
  };
}

function metaOperations(specification, budget, warnings) {
  const updateExisting = specification.operation === 'update_existing';
  const campaignName = text(specification.name, 255);
  const instantForm = specification.family === 'meta_instant_form';
  const creative = safeObject(specification.creative);

  warnings.push(issue(
    'adapter_meta_defaults_applied',
    'dry_run_adapter.operations',
    updateExisting
      ? 'La simulación conserva el estado de la campaña existente y prepara AdSet y anuncio nuevos en pausa; ningún objeto se crea ni publica en Meta.'
      : 'La simulación prepara campaña, AdSet y anuncio en pausa, además de una creatividad no publicada; ningún objeto se crea ni publica en Meta.',
  ));

  return [
    operation(1, 'campaign', 'Campaign', updateExisting ? 'resolve' : 'create', updateExisting ? 'Resolver campaña Meta sin cambiar su estado' : 'Preparar campaña Meta en pausa', {
      existing_campaign_id: specification.existing_campaign_id,
      name: campaignName,
      objective: specification.provider_objective,
      buying_type: 'AUCTION',
      special_ad_categories: [],
      ...(!updateExisting ? { status: 'PAUSED' } : { preserve_existing_status: true }),
    }),
    operation(2, 'ad_set', 'AdSet', 'create', 'Preparar conjunto de anuncios en pausa', {
      name: campaignName ? `${campaignName} · Audiencia principal` : null,
      campaign_ref: '$campaign',
      status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      optimization_goal: instantForm ? 'LEAD_GENERATION' : 'REACH',
      destination_type: instantForm ? 'ON_AD' : (specification.destination.final_url ? 'WEBSITE' : null),
      lifetime_budget_minor_units: budget.planning_lifetime_amount_minor_units,
      currency: budget.currency,
      targeting_review_snapshot: specification.targeting,
      audience_review_snapshot: specification.audience,
      start_time: specification.schedule.start_time,
      end_time: specification.schedule.end_time,
      dsa_beneficiary: specification.compliance.dsa_beneficiary,
      dsa_payor: specification.compliance.dsa_payor,
      promoted_object: instantForm ? { page_id: specification.identity.page_id } : null,
    }, ['campaign']),
    operation(3, 'creative_assets', 'AdCreativeAsset', 'resolve', 'Resolver creatividades aportadas sin subir archivos', {
      media_references: list(creative.media),
      upload_allowed: false,
      generated_assets_allowed: false,
      rights_confirmation_required: true,
    }, ['ad_set']),
    operation(4, 'ad_creative', 'AdCreative', 'prepare_unpublished', 'Preparar creatividad no publicada', {
      name: campaignName ? `${campaignName} · Creatividad principal` : null,
      published: false,
      creative_format: 'SINGLE_MEDIA',
      variation_strategy: 'NONE',
      identity: specification.identity,
      media_refs: '$creative_assets',
      primary_texts: list(creative.primary_texts),
      headlines: list(creative.headlines),
      descriptions: list(creative.descriptions),
      call_to_action: creative.call_to_action,
      destination_url: specification.destination.final_url,
      instant_form_id: specification.instant_form_id,
      tracking: specification.tracking,
    }, ['creative_assets']),
    operation(5, 'ad', 'Ad', 'create', 'Preparar anuncio en pausa', {
      name: campaignName ? `${campaignName} · Anuncio principal` : null,
      ad_set_ref: '$ad_set',
      creative_ref: '$ad_creative',
      status: 'PAUSED',
    }, ['ad_set', 'ad_creative']),
  ];
}

function buildMetaAdsDryRunAdapter({ family, specification } = {}) {
  const normalizedFamily = text(family, 64);
  const rawSpecification = safeObject(specification);
  const sensitiveUrlRemoved = containsSensitiveUrl(rawSpecification);
  const cleanSpecification = sanitize(rawSpecification);
  const blockers = [];
  const warnings = [];

  if (!SUPPORTED_FAMILIES.includes(normalizedFamily)) {
    blockers.push(issue('adapter_family_unsupported', 'family', 'El adaptador Meta dry-run solo admite Alcance y Formulario instantáneo.'));
  }
  if (sensitiveUrlRemoved) {
    blockers.push(issue(
      'adapter_meta_sensitive_url_forbidden',
      'specification',
      'La especificación contiene una URL con credenciales, tokens o firma; se ha eliminado del manifiesto y debe sustituirse por una referencia segura.',
    ));
  }
  const normalizedSpecification = normalizeSpecification(cleanSpecification, normalizedFamily, blockers, warnings);
  const budget = planningBudget(normalizedSpecification, blockers, warnings);
  const operations = normalizedSpecification.operation_ready && SUPPORTED_FAMILIES.includes(normalizedFamily)
    ? metaOperations(normalizedSpecification, budget, warnings)
    : [];
  delete normalizedSpecification.operation_ready;

  const idempotencyFingerprint = sha256(canonicalStringify({
    schema_version: ADAPTER_SCHEMA_VERSION,
    adapter_version: ADAPTER_VERSION,
    provider: 'meta_ads',
    family: normalizedFamily,
    account_id: normalizedSpecification.account_id,
    operation_mode: normalizedSpecification.operation,
    operations,
  }));
  const manifest = {
    schema_version: ADAPTER_SCHEMA_VERSION,
    adapter_version: ADAPTER_VERSION,
    provider: 'meta_ads',
    family: normalizedFamily,
    mode: 'dry_run',
    dry_run_adapter_available: SUPPORTED_FAMILIES.includes(normalizedFamily),
    execution_adapter_available: false,
    provider_call_performed: false,
    network_calls_performed: 0,
    account_id: normalizedSpecification.account_id,
    operation_mode: SUPPORTED_OPERATIONS.includes(normalizedSpecification.operation) ? normalizedSpecification.operation : null,
    budget,
    readiness: {
      ready: blockers.length === 0,
      blockers,
      warnings,
    },
    operations,
    idempotency: {
      fingerprint: idempotencyFingerprint,
      persisted_audit_key_required: true,
      provider_request_id_generated: false,
    },
    safety: {
      initial_campaign_status: normalizedSpecification.operation === 'create_new' ? 'PAUSED' : null,
      existing_campaign_status_preserved: normalizedSpecification.operation === 'update_existing',
      initial_ad_set_status: 'PAUSED',
      initial_ad_status: 'PAUSED',
      creative_published: false,
      provider_objects_created: false,
      maximum_planned_spend_minor_units: budget.planning_lifetime_amount_minor_units,
      generated_assets_allowed: false,
      destructive_replace: false,
      requires_future_explicit_execution_authorization: true,
    },
  };

  return {
    ...manifest,
    manifest_hash: sha256(canonicalStringify(manifest)),
  };
}

module.exports = {
  ADAPTER_SCHEMA_VERSION,
  ADAPTER_VERSION,
  MONTHLY_BUDGET_DAYS,
  SUPPORTED_FAMILIES,
  buildMetaAdsDryRunAdapter,
  canonicalStringify,
  sanitize,
};
