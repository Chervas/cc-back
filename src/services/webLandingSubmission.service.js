'use strict';

const crypto = require('node:crypto');
const db = require('../../models');
const { resolveWebLandingAttribution } = require('./webLandingAttribution.service');
const {
  runtimeCandidateForPublicationArtifact,
} = require('./webIntakeRuntimeReconciliation.service');
const {
  effectiveIntakeConfigForScope,
} = require('./webEffectiveIntakeConfig.service');
const {
  webLandingInternalContext,
} = require('./webArtifactMetadata.service');

const BROWSER_FIELDS = new Set([
  'first_name', 'last_name', 'email', 'phone', 'message', 'preferred_contact',
  'privacy_consent', '_cc_company', 'web_project_id', 'web_revision_id',
  'web_page_id', 'web_form_id', 'web_artifact_input_hash',
  '_cc_ad_user_data', '_cc_ad_personalization',
  '_cc_attr_gclid', '_cc_attr_gbraid', '_cc_attr_wbraid', '_cc_attr_fbclid',
  '_cc_attr_ttclid', '_cc_attr_utm_source', '_cc_attr_utm_medium',
  '_cc_attr_utm_campaign', '_cc_attr_utm_content', '_cc_attr_utm_term',
  '_cc_attr_cc_gads_customer_id', '_cc_attr_cc_gads_campaign_id',
  '_cc_attr_landing_path',
]);
const ATTRIBUTION_FIELDS = new Set([
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'utm_source', 'utm_medium',
  'utm_campaign', 'utm_content', 'utm_term', 'google_ads_customer_id',
  'google_ads_campaign_id',
]);
const PREFERRED_CONTACT = new Set(['telefono', 'whatsapp', 'email']);
const PAID_MEDIA = /^(?:cpc|ppc|paid|paid_search|paid_social|display|social_paid)$/i;
const BROWSER_ATTRIBUTION_FIELDS = Object.freeze({
  _cc_attr_gclid: 'gclid',
  _cc_attr_gbraid: 'gbraid',
  _cc_attr_wbraid: 'wbraid',
  _cc_attr_fbclid: 'fbclid',
  _cc_attr_ttclid: 'ttclid',
  _cc_attr_utm_source: 'utm_source',
  _cc_attr_utm_medium: 'utm_medium',
  _cc_attr_utm_campaign: 'utm_campaign',
  _cc_attr_utm_content: 'utm_content',
  _cc_attr_utm_term: 'utm_term',
  _cc_attr_cc_gads_customer_id: 'google_ads_customer_id',
  _cc_attr_cc_gads_campaign_id: 'google_ads_campaign_id',
});
const URL_ATTRIBUTION_FIELDS = Object.freeze({
  gclid: 'gclid',
  gbraid: 'gbraid',
  wbraid: 'wbraid',
  fbclid: 'fbclid',
  ttclid: 'ttclid',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_content: 'utm_content',
  utm_term: 'utm_term',
  cc_gads_customer_id: 'google_ads_customer_id',
  cc_gads_campaign_id: 'google_ads_campaign_id',
});
const ATTRIBUTION_URL_KEYS = Object.freeze(Object.fromEntries(
  Object.entries(URL_ATTRIBUTION_FIELDS).map(([queryKey, canonicalKey]) => [canonicalKey, queryKey])
));
const ATTRIBUTION_LIMITS = Object.freeze({
  gclid: 256,
  gbraid: 256,
  wbraid: 256,
  fbclid: 512,
  ttclid: 512,
  utm_source: 200,
  utm_medium: 200,
  utm_campaign: 300,
  utm_content: 300,
  utm_term: 300,
  google_ads_customer_id: 10,
  google_ads_campaign_id: 32,
});
const CLICK_ID_FIELDS = new Set(['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid']);

class WebLandingSubmissionError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'WebLandingSubmissionError';
    this.code = code;
    this.status = status;
  }
}

function scalar(body, name, maximum, { required = false } = {}) {
  const value = body?.[name];
  if (value === undefined || value === null || value === '') {
    if (required) throw new WebLandingSubmissionError('web_landing_field_required', 'Falta un campo obligatorio.');
    return '';
  }
  if (typeof value !== 'string') {
    throw new WebLandingSubmissionError('web_landing_field_invalid', 'El formulario no es válido.');
  }
  const normalized = value.normalize('NFC').trim();
  if (Buffer.byteLength(normalized, 'utf8') > maximum) {
    throw new WebLandingSubmissionError('web_landing_field_too_long', 'Uno de los campos es demasiado largo.');
  }
  return normalized;
}

function safeRequestUrl(value, field) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe');
    url.hash = '';
    return url;
  } catch {
    throw new WebLandingSubmissionError(
      `web_landing_${field}_invalid`,
      'No se ha podido verificar la página que envía el formulario.',
      400
    );
  }
}

function assertBrowserContract(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WebLandingSubmissionError('web_landing_body_invalid', 'El formulario no es válido.');
  }
  const unknown = Object.keys(body).filter((key) => !BROWSER_FIELDS.has(key));
  if (unknown.length) {
    throw new WebLandingSubmissionError('web_landing_field_unknown', 'El formulario contiene campos no permitidos.');
  }
}

function optionalConsentChoice(body, name) {
  const value = scalar(body, name, 7);
  if (!value) return null;
  if (!['granted', 'denied'].includes(value)) {
    throw new WebLandingSubmissionError('web_landing_consent_invalid', 'El estado de consentimiento no es válido.');
  }
  return value;
}

function canonicalAttributionValue(key, input, { reject = false } = {}) {
  const invalid = () => {
    if (reject) throw new WebLandingSubmissionError('web_landing_attribution_invalid', 'La atribución publicitaria no es válida.');
    return '';
  };
  if (typeof input !== 'string') return invalid();
  const value = input.normalize('NFC').trim();
  const maximum = ATTRIBUTION_LIMITS[key];
  if (!maximum || !value || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) return invalid();
  if (CLICK_ID_FIELDS.has(key) && !/^[A-Za-z0-9._~-]+$/.test(value)) return invalid();
  if (key === 'google_ads_customer_id' && !/^\d{10}$/.test(value)) return invalid();
  if (key === 'google_ads_campaign_id' && !/^[1-9]\d{0,31}$/.test(value)) return invalid();
  return value;
}

function attributionFromUrl(url) {
  const result = {};
  for (const [queryKey, canonicalKey] of Object.entries(URL_ATTRIBUTION_FIELDS)) {
    const values = url.searchParams.getAll(queryKey);
    if (values.length !== 1) continue;
    const value = canonicalAttributionValue(canonicalKey, values[0]);
    if (!value) continue;
    result[canonicalKey] = value;
  }
  return result;
}

function attributionFromBody(body) {
  const result = {};
  for (const [browserField, canonicalField] of Object.entries(BROWSER_ATTRIBUTION_FIELDS)) {
    if (body?.[browserField] === undefined || body[browserField] === null || body[browserField] === '') continue;
    result[canonicalField] = canonicalAttributionValue(canonicalField, body[browserField], { reject: true });
  }
  return result;
}

function canonicalLandingPath(input) {
  if (typeof input !== 'string' || input.length > 512 || !input.startsWith('/') || /[?#\\\x00-\x1f\x7f]/.test(input)) {
    throw new WebLandingSubmissionError('web_landing_attribution_landing_invalid', 'La página inicial de la atribución no es válida.');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    throw new WebLandingSubmissionError('web_landing_attribution_landing_invalid', 'La página inicial de la atribución no es válida.');
  }
  if (/\\/.test(decoded) || /(^|\/)\.{1,2}(\/|$)/.test(decoded) || /\/{2,}/.test(decoded)) {
    throw new WebLandingSubmissionError('web_landing_attribution_landing_invalid', 'La página inicial de la atribución no es válida.');
  }
  const path = `/${input.replace(/^\/+|\/+$/g, '')}`;
  return path === '/' ? '/' : `${path}/`;
}

function canonicalAttributionUrl(pageUrl, pathname, attribution) {
  const result = new URL(pageUrl.origin);
  result.pathname = pathname;
  for (const key of [...ATTRIBUTION_FIELDS].sort()) {
    if (attribution[key]) result.searchParams.set(ATTRIBUTION_URL_KEYS[key] || key, attribution[key]);
  }
  return result.toString();
}

function sourceFromAttribution(attribution) {
  if (attribution.gclid || attribution.gbraid || attribution.wbraid) return 'google_ads';
  if (attribution.fbclid) return 'meta_ads';
  if (attribution.ttclid) return 'tiktok_ads';
  const source = String(attribution.utm_source || '').toLowerCase();
  if (/^(?:google|googleads|google_ads)$/.test(source)) return 'google_ads';
  if (/^(?:facebook|instagram|meta|meta_ads)$/.test(source)) return 'meta_ads';
  if (/^(?:tiktok|tiktok_ads)$/.test(source)) return 'tiktok_ads';
  return 'web';
}

function normalizedRedirectUrl(pageUrl, anchor, attribution = attributionFromUrl(pageUrl)) {
  const redirect = new URL(pageUrl.toString());
  redirect.search = '';
  for (const key of [...ATTRIBUTION_FIELDS].sort()) {
    if (attribution[key]) redirect.searchParams.set(ATTRIBUTION_URL_KEYS[key] || key, attribution[key]);
  }
  redirect.hash = anchor;
  return redirect.toString();
}

async function intakeConfigForAttribution(attribution, { models = db } = {}) {
  return effectiveIntakeConfigForScope({
    scopeType: attribution.scope_type,
    clinicId: attribution.clinic_id,
    groupId: attribution.group_id,
    groupIdHint: attribution.group_id,
    models,
  });
}

function observedIp(headers, remoteAddress) {
  // `remoteAddress` ya es `req.ip`, calculado por Express con una lista de
  // proxies explícitamente confiables. Nunca se confía aquí en un XFF crudo.
  const candidate = String(remoteAddress || '').trim();
  return candidate.slice(0, 64) || null;
}

function assertRequiredFormFields(formFields, values) {
  const missing = (Array.isArray(formFields) ? formFields : [])
    .filter((field) => field?.required === true)
    .map((field) => String(field.name || ''))
    .filter((name) => !values[name]);
  if (missing.length) {
    throw new WebLandingSubmissionError(
      'web_landing_field_required',
      'Falta un campo obligatorio del formulario publicado.'
    );
  }
}

async function prepareWebLandingSubmission({
  body,
  headers = {},
  remoteAddress = null,
  models = db,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
} = {}) {
  assertBrowserContract(body);
  const pageUrl = safeRequestUrl(headers.referer, 'referer');
  if (headers.origin) {
    const origin = safeRequestUrl(headers.origin, 'origin');
    if (origin.origin !== pageUrl.origin) {
      throw new WebLandingSubmissionError('web_landing_origin_mismatch', 'El formulario no procede de esta página.', 403);
    }
  }

  const firstName = scalar(body, 'first_name', 120);
  const lastName = scalar(body, 'last_name', 120);
  const email = scalar(body, 'email', 254).toLowerCase();
  const phone = scalar(body, 'phone', 40);
  const message = scalar(body, 'message', 4000);
  const preferredContact = scalar(body, 'preferred_contact', 24);
  const privacyConsent = scalar(body, 'privacy_consent', 1, { required: true });
  const honeypot = scalar(body, '_cc_company', 256);
  const adUserData = optionalConsentChoice(body, '_cc_ad_user_data');
  const adPersonalization = optionalConsentChoice(body, '_cc_ad_personalization');
  if (privacyConsent !== '1') {
    throw new WebLandingSubmissionError('web_landing_privacy_consent_required', 'Debes aceptar la política de privacidad.');
  }
  if (!email && !phone) {
    throw new WebLandingSubmissionError('web_landing_contact_required', 'Indica un email o un teléfono.');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new WebLandingSubmissionError('web_landing_email_invalid', 'El email no es válido.');
  }
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      throw new WebLandingSubmissionError('web_landing_phone_invalid', 'El teléfono no es válido.');
    }
  }
  if (preferredContact && !PREFERRED_CONTACT.has(preferredContact)) {
    throw new WebLandingSubmissionError('web_landing_preferred_contact_invalid', 'La preferencia de contacto no es válida.');
  }

  const queryAttribution = {
    ...attributionFromBody(body),
    ...attributionFromUrl(pageUrl),
  };
  const artifactInputHash = scalar(body, 'web_artifact_input_hash', 64, { required: true }).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(artifactInputHash)) {
    throw new WebLandingSubmissionError(
      'web_landing_artifact_identity_invalid',
      'La versión publicada del formulario no es válida.',
      409
    );
  }
  const attribution = await resolveWebLandingAttribution({
    body: {
      external_source: 'clinicaclick_web_landing',
      web_project_id: scalar(body, 'web_project_id', 36, { required: true }),
      web_revision_id: scalar(body, 'web_revision_id', 36, { required: true }),
      web_page_id: scalar(body, 'web_page_id', 36, { required: true }),
      web_form_id: scalar(body, 'web_form_id', 64, { required: true }),
      web_artifact_input_hash: artifactInputHash,
      page_url: pageUrl.toString(),
      google_ads_customer_id: queryAttribution.google_ads_customer_id,
      google_ads_campaign_id: queryAttribution.google_ads_campaign_id,
    },
    models,
  });
  assertRequiredFormFields(attribution.form_fields, {
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    message,
    preferred_contact: preferredContact,
    privacy_consent: privacyConsent === '1' ? '1' : '',
  });
  const requestedLandingPath = body._cc_attr_landing_path
    ? canonicalLandingPath(body._cc_attr_landing_path)
    : canonicalLandingPath(pageUrl.pathname);
  const allowedLandingPaths = new Set(attribution.published_page_paths || []);
  if (!allowedLandingPaths.has(requestedLandingPath)) {
    throw new WebLandingSubmissionError(
      'web_landing_attribution_landing_mismatch',
      'La página inicial no pertenece a esta publicación.',
      409
    );
  }
  const canonicalPagePath = canonicalLandingPath(pageUrl.pathname);
  const canonicalPageUrl = canonicalAttributionUrl(pageUrl, canonicalPagePath, queryAttribution);
  const canonicalLandingUrl = canonicalAttributionUrl(pageUrl, requestedLandingPath, queryAttribution);
  const successUrl = normalizedRedirectUrl(pageUrl, attribution.success_anchor, queryAttribution);
  const errorUrl = normalizedRedirectUrl(pageUrl, attribution.error_anchor, queryAttribution);
  if (honeypot) return { spam: true, success_url: successUrl, error_url: errorUrl, attribution };

  const committedIntake = await intakeConfigForAttribution(attribution, { models });
  const internalContext = webLandingInternalContext(attribution);
  const publication = internalContext?.publication || null;
  const artifact = internalContext?.artifact || null;
  if (
    !publication
    || !artifact
    || String(publication.id || '') !== String(attribution.publication_id || '')
    || String(artifact.id || '') !== String(attribution.artifact_id || '')
  ) {
    throw new WebLandingSubmissionError(
      'web_landing_runtime_identity_mismatch',
      'La versión del formulario ya no está autorizada para enviar contactos.',
      409
    );
  }
  const selectedRuntime = await runtimeCandidateForPublicationArtifact({
    intake: committedIntake,
    publication,
    artifact,
    models,
  });
  if (!selectedRuntime) {
    const committedHmac = String(committedIntake?.hmac_key || '').trim();
    if (
      !committedIntake
      || committedHmac.length < 16
      || committedHmac.length > 512
      || /[\x00-\x20\x7f]/.test(committedHmac)
    ) {
      throw new WebLandingSubmissionError(
        'web_landing_intake_not_configured',
        'La landing todavía no tiene preparada la recepción de contactos.',
        503
      );
    }
    throw new WebLandingSubmissionError(
      'web_landing_runtime_identity_mismatch',
      'La versión del formulario ya no está autorizada para enviar contactos.',
      409
    );
  }
  const intake = selectedRuntime?.intake || null;
  const hmacKey = String(intake?.hmac_key || '').trim();
  if (hmacKey.length < 16 || hmacKey.length > 512 || /[\x00-\x20\x7f]/.test(hmacKey)) {
    throw new WebLandingSubmissionError(
      'web_landing_intake_not_configured',
      'La landing todavía no tiene preparada la recepción de contactos.',
      503
    );
  }

  const source = sourceFromAttribution(queryAttribution);
  const paid = source !== 'web' || PAID_MEDIA.test(queryAttribution.utm_medium || '');
  const capturedAt = now().toISOString();
  const eventId = `ccweb_${randomUUID().replace(/-/g, '')}`;
  const visibleFields = {
    ...(firstName ? { first_name: firstName } : {}),
    ...(lastName ? { last_name: lastName } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(message ? { message } : {}),
    ...(preferredContact ? { preferred_contact: preferredContact } : {}),
    privacy_consent: '1',
  };
  const payload = {
    event_id: eventId,
    source,
    source_detail: 'clinicaclick_web_landing',
    channel: paid ? 'paid' : 'organic',
    clinic_id: attribution.clinic_id,
    ...(attribution.group_id ? { group_id: attribution.group_id } : {}),
    external_source: 'clinicaclick_web_landing',
    external_id: eventId,
    web_project_id: attribution.project_id,
    web_revision_id: attribution.revision_id,
    web_page_id: attribution.page_id,
    web_form_id: attribution.form_id,
    page_url: canonicalPageUrl,
    landing_url: canonicalLandingUrl,
    user_agent: String(headers['user-agent'] || '').slice(0, 1000) || null,
    ip: observedIp(headers, remoteAddress),
    nombre: [firstName, lastName].filter(Boolean).join(' ') || null,
    email: email || null,
    telefono: phone || null,
    notas: message || null,
    consent: {
      contact: 'granted',
      ...(adUserData ? { ad_user_data: adUserData } : {}),
      ...(adPersonalization ? { ad_personalization: adPersonalization } : {}),
      captured_at: capturedAt,
      source: canonicalPageUrl,
      version: `web-revision:${attribution.revision_id}`,
    },
    form_submission: {
      page_url: canonicalPageUrl,
      form_id: attribution.form_id,
      form_name: 'clinicaclick_web_landing',
      submitted_at: capturedAt,
      fields: visibleFields,
    },
    attribution: {
      ...queryAttribution,
      ...(attribution.google_ads_assignment_id ? {
        google_ads_assignment_id: attribution.google_ads_assignment_id,
        strategy_campaign_id: attribution.strategy_campaign_id,
        campaign_request_id: attribution.campaign_request_id,
        target_kind: attribution.target_kind,
        target_treatment_id: attribution.target_treatment_id,
      } : {}),
      page_url: canonicalPageUrl,
      landing_url: canonicalLandingUrl,
    },
    ...queryAttribution,
  };
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.createHmac('sha256', hmacKey).update(rawBody).digest('hex');
  return {
    spam: false,
    payload,
    raw_body: rawBody,
    signature,
    event_id: eventId,
    success_url: successUrl,
    error_url: errorUrl,
    attribution,
  };
}

module.exports = {
  ATTRIBUTION_FIELDS,
  BROWSER_ATTRIBUTION_FIELDS,
  BROWSER_FIELDS,
  WebLandingSubmissionError,
  attributionFromUrl,
  attributionFromBody,
  canonicalAttributionUrl,
  canonicalLandingPath,
  assertRequiredFormFields,
  intakeConfigForAttribution,
  normalizedRedirectUrl,
  prepareWebLandingSubmission,
  sourceFromAttribution,
};
