'use strict';

const crypto = require('node:crypto');
const db = require('../../models');
const { trustedRuntime } = require('../lib/webMeasurementRuntime');
const {
  UUID_V4,
  pathMatchesPublication,
  publishedPagePath,
  resolveAuthorizedGoogleAttribution,
  safePageUrl,
} = require('./webLandingAttribution.service');
const { intakeConfigForAttribution } = require('./webLandingSubmission.service');
const {
  installationApiBase,
  measurementFromIntake,
} = require('./webWordpressInstallations.service');

const ENDPOINTS = new Set(['leads', 'events', 'whatsapp-origin']);
const WRAPPER_FIELDS = new Set([
  'schema_version', 'endpoint', 'payload', 'web_project_id', 'web_revision_id', 'web_page_id',
]);
const MAX_CANONICAL_BYTES = 64 * 1024;

class WebLandingEventBridgeError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'WebLandingEventBridgeError';
    this.code = code;
    this.status = status;
  }
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function requiredUuid(value, field) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_V4.test(normalized)) {
    throw new WebLandingEventBridgeError('web_event_bridge_identity_invalid', 'La página publicada no es válida.', 422, { field });
  }
  return normalized;
}

function assertWrapper(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WebLandingEventBridgeError('web_event_bridge_body_invalid', 'La medición no es válida.');
  }
  if (Object.keys(body).some((key) => !WRAPPER_FIELDS.has(key)) || body.schema_version !== 1) {
    throw new WebLandingEventBridgeError('web_event_bridge_contract_invalid', 'La medición no es válida.');
  }
  if (!ENDPOINTS.has(String(body.endpoint || ''))) {
    throw new WebLandingEventBridgeError('web_event_bridge_endpoint_invalid', 'El tipo de medición no es válido.');
  }
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    throw new WebLandingEventBridgeError('web_event_bridge_payload_invalid', 'La medición no es válida.');
  }
}

function sameOrigin(left, right) {
  return left.protocol === right.protocol && left.host.toLowerCase() === right.host.toLowerCase();
}

function selectedClinic(publication) {
  return publication.scopeType === 'clinic'
    ? Number(publication.clinicaId)
    : Number(publication.configuration?.clinic_id);
}

function canonicalPayload(input, context) {
  const payload = { ...input };
  for (const field of [
    'clinic_id', 'clinica_id', 'clinicId', 'clinicaId',
    'group_id', 'grupo_clinica_id', 'groupId', 'grupoClinicaId',
    'domain', 'page_url', 'pageUrl', 'event_source_url', 'eventSourceUrl',
    'web_project_id', 'web_revision_id', 'web_page_id', 'web_form_id',
  ]) delete payload[field];
  payload.clinic_id = context.clinicId;
  if (context.groupId) payload.group_id = context.groupId;
  payload.domain = context.pageUrl.hostname.toLowerCase();
  payload.page_url = context.pageUrl.toString();
  if (context.endpoint === 'events') payload.event_source_url = context.pageUrl.toString();
  return payload;
}

function removeGoogleCampaignAliases(payload) {
  for (const field of [
    'cc_gads_customer_id', 'cc_gads_campaign_id', 'google_ads_customer_id',
    'google_ads_campaign_id', 'google_campaign_id', 'gad_campaignid', 'gadCampaignId',
  ]) delete payload[field];
  if (payload.attribution && typeof payload.attribution === 'object' && !Array.isArray(payload.attribution)) {
    payload.attribution = { ...payload.attribution };
    for (const field of [
      'cc_gads_customer_id', 'cc_gads_campaign_id', 'google_ads_customer_id',
      'google_ads_campaign_id', 'google_campaign_id', 'gad_campaignid', 'gadCampaignId',
    ]) delete payload.attribution[field];
  }
  if (payload.event_data && typeof payload.event_data === 'object' && !Array.isArray(payload.event_data)) {
    payload.event_data = { ...payload.event_data };
    delete payload.event_data.google_ads_customer_id;
    delete payload.event_data.google_ads_campaign_id;
  }
}

async function resolveContext({ body, headers, models, env }) {
  const projectId = requiredUuid(body.web_project_id, 'web_project_id');
  const revisionId = requiredUuid(body.web_revision_id, 'web_revision_id');
  const pageId = requiredUuid(body.web_page_id, 'web_page_id');
  const pageUrl = safePageUrl(headers.referer);
  if (headers.origin) {
    const origin = safePageUrl(headers.origin);
    if (!sameOrigin(origin, pageUrl)) {
      throw new WebLandingEventBridgeError('web_event_bridge_origin_mismatch', 'La medición no procede de la página publicada.', 403);
    }
  }
  const revision = await models.WebRevision.findByPk(revisionId);
  const document = revision?.document;
  const page = Array.isArray(document?.pages)
    ? document.pages.find((candidate) => String(candidate?.id) === pageId)
    : null;
  if (!revision || String(revision.projectId) !== projectId || !page) {
    throw new WebLandingEventBridgeError('web_event_bridge_revision_not_active', 'La versión publicada ya no está activa.', 409);
  }
  const pageProjection = plain(await models.WebPage.findOne({
    where: { projectId, pageKey: pageId },
    attributes: ['id', 'projectId', 'pageKey', 'slug'],
  }));
  if (
    !pageProjection
    || !UUID_V4.test(String(pageProjection.id || ''))
    || String(pageProjection.projectId) !== projectId
    || String(pageProjection.pageKey) !== pageId
    || String(pageProjection.slug) !== String(page.slug)
  ) {
    throw new WebLandingEventBridgeError('web_event_bridge_page_projection_invalid', 'La página publicada no coincide con su proyección activa.', 409);
  }
  const publications = await models.WebPublication.findAll({
    where: { projectId, activeRevisionId: revisionId, status: 'published' },
    order: [['published_at', 'DESC'], ['id', 'ASC']],
    limit: 20,
  });
  const matches = publications.map(plain).filter((publication) => (
    String(publication.host || '').toLowerCase() === pageUrl.hostname.toLowerCase()
    && pathMatchesPublication(pageUrl.pathname, publication.path)
  ));
  if (matches.length !== 1) {
    throw new WebLandingEventBridgeError('web_event_bridge_publication_not_active', 'No existe una publicación activa única para esta página.', 409);
  }
  const publication = matches[0];
  const artifact = plain(await models.WebArtifact.findByPk(publication.activeArtifactId));
  const manifest = artifact?.manifest;
  const pageRoute = manifest?.page_routes?.[pageId];
  const expectedRelativePath = page.slug === 'inicio' ? '/' : `/${page.slug}/`;
  if (
    !artifact
    || String(artifact.projectId) !== projectId
    || String(artifact.revisionId) !== revisionId
    || artifact.environment !== 'production'
    || artifact.status !== 'ready'
    || manifest?.project_id !== projectId
    || manifest?.revision_id !== revisionId
    || manifest?.artifact_hash !== artifact.artifactHash
    || String(pageRoute?.page_path || '') !== expectedRelativePath
    || publishedPagePath(publication.path, expectedRelativePath) !== publishedPagePath('/', pageUrl.pathname)
  ) {
    throw new WebLandingEventBridgeError('web_event_bridge_artifact_not_active', 'La página publicada no coincide con su artefacto activo.', 409);
  }
  const clinicId = selectedClinic(publication);
  let groupId = publication.scopeType === 'group' ? Number(publication.grupoClinicaId) : null;
  if (!Number.isSafeInteger(clinicId) || clinicId < 1) {
    throw new WebLandingEventBridgeError('web_event_bridge_clinic_missing', 'La publicación no tiene una clínica de destino.', 409);
  }
  const clinic = plain(await models.Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'],
    raw: true,
  }));
  if (!clinic || (clinic.estado_clinica !== undefined && Number(clinic.estado_clinica) !== 1)) {
    throw new WebLandingEventBridgeError('web_event_bridge_clinic_inactive', 'La clínica de destino no está activa.', 409);
  }
  if (publication.scopeType === 'group') {
    if (Number(clinic.grupoClinicaId) !== groupId) {
      throw new WebLandingEventBridgeError('web_event_bridge_scope_mismatch', 'La clínica no pertenece a la publicación.', 409);
    }
  } else {
    groupId = Number(clinic.grupoClinicaId) || null;
  }
  const attribution = { scope_type: publication.scopeType, clinic_id: clinicId, group_id: groupId };
  const intake = await intakeConfigForAttribution(attribution, { models });
  const measurement = measurementFromIntake(intake);
  const runtime = trustedRuntime({
    measurement: measurement.enabled
      ? { ...measurement, api_url: installationApiBase(env) }
      : measurement,
  }, { environment: 'production' });
  if (!measurement.enabled || runtime.runtime_config_hash !== manifest.runtime_config_hash) {
    throw new WebLandingEventBridgeError('web_event_bridge_runtime_drift', 'La medición publicada necesita actualizarse.', 409);
  }
  return { artifact, clinicId, groupId, intake, pageUrl, pageProjection, projectId, publication, revisionId, pageId };
}

async function prepareWebLandingEventBridge({
  body,
  headers = {},
  models = db,
  env = process.env,
} = {}) {
  assertWrapper(body);
  const endpoint = String(body.endpoint);
  const context = await resolveContext({ body, headers, models, env });
  const supplied = { ...body.payload };
  const googleAttribution = await resolveAuthorizedGoogleAttribution({
    body: supplied,
    clinicId: context.clinicId,
    groupId: context.groupId,
    projectId: context.projectId,
    models,
  });
  const payload = canonicalPayload(supplied, { ...context, endpoint });
  removeGoogleCampaignAliases(payload);
  if (googleAttribution) {
    payload.cc_gads_customer_id = googleAttribution.customer_id;
    payload.cc_gads_campaign_id = googleAttribution.campaign_id;
    payload.google_ads_customer_id = googleAttribution.customer_id;
    payload.google_ads_campaign_id = googleAttribution.campaign_id;
    payload.attribution = {
      ...(payload.attribution && typeof payload.attribution === 'object' && !Array.isArray(payload.attribution)
        ? payload.attribution
        : {}),
      google_ads_customer_id: googleAttribution.customer_id,
      google_ads_campaign_id: googleAttribution.campaign_id,
      google_ads_assignment_id: googleAttribution.assignment_id,
    };
  }
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  if (rawBody.length < 2 || rawBody.length > MAX_CANONICAL_BYTES) {
    throw new WebLandingEventBridgeError('web_event_bridge_payload_too_large', 'La medición supera el tamaño permitido.', 413);
  }
  const secret = String(context.intake?.hmac_key || '');
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return {
    endpoint,
    payload,
    raw_body: rawBody,
    signature,
    artifact_hash: context.artifact.artifactHash,
    publication_id: context.publication.id,
    attribution: {
      project_id: context.projectId,
      revision_id: context.revisionId,
      page_id: context.pageProjection.id,
      document_page_id: context.pageId,
      publication_id: context.publication.id,
      artifact_id: context.artifact.id,
      artifact_hash: context.artifact.artifactHash,
      form_id: null,
      scope_type: context.publication.scopeType,
      clinic_id: context.clinicId,
      group_id: context.groupId,
      ...(googleAttribution ? {
        google_ads_customer_id: googleAttribution.customer_id,
        google_ads_campaign_id: googleAttribution.campaign_id,
        google_ads_assignment_id: googleAttribution.assignment_id,
        strategy_campaign_id: googleAttribution.strategy_campaign_id,
        campaign_request_id: googleAttribution.campaign_request_id,
        target_kind: googleAttribution.target_kind,
        target_treatment_id: googleAttribution.target_treatment_id,
      } : {}),
    },
  };
}

module.exports = {
  ENDPOINTS,
  MAX_CANONICAL_BYTES,
  WebLandingEventBridgeError,
  prepareWebLandingEventBridge,
};
