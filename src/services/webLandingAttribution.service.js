'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const {
  transitionContextForPublication,
} = require('./webIntakeRuntimeReconciliation.service');
const {
  attachWebLandingInternalContext,
  findWebArtifactMetadataByPk,
} = require('./webArtifactMetadata.service');

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_FORM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const GOOGLE_CUSTOMER_ID = /^\d{10}$/;
const GOOGLE_CAMPAIGN_ID = /^[1-9]\d{0,31}$/;
const ARTIFACT_HASH = /^[a-f0-9]{64}$/;
const SERVED_PUBLICATION_STATUSES = Object.freeze([
  'pending', 'publishing', 'published', 'failed', 'rolling_back',
]);

class WebLandingAttributionError extends Error {
  constructor(code, message, status = 422, details = undefined) {
    super(message);
    this.name = 'WebLandingAttributionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function requiredUuid(value, field) {
  const normalized = String(value || '').trim();
  if (!UUID_V4.test(normalized)) {
    throw new WebLandingAttributionError(
      'web_landing_attribution_invalid',
      'La atribución de la landing no es válida.',
      422,
      { field }
    );
  }
  return normalized.toLowerCase();
}

function safePageUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe');
    url.hash = '';
    return url;
  } catch {
    throw new WebLandingAttributionError(
      'web_landing_page_url_invalid',
      'No se ha podido validar la página de origen de la landing.',
      422
    );
  }
}

function pathMatchesPublication(pathname, publicationPath) {
  const base = String(publicationPath || '/');
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return normalizedPath === normalizedBase || normalizedPath.startsWith(normalizedBase);
}

function longestPublicationMatch(publications, pageUrl) {
  const matches = (publications || []).map(plain).filter((candidate) => (
    String(candidate?.host || '').toLowerCase() === pageUrl.hostname.toLowerCase()
    && pathMatchesPublication(pageUrl.pathname, candidate?.path)
  ));
  if (matches.length < 1) return null;
  const longest = Math.max(...matches.map((candidate) => normalizedPath(candidate.path).length));
  const winners = matches.filter((candidate) => normalizedPath(candidate.path).length === longest);
  return winners.length === 1 ? winners[0] : null;
}

function normalizedPath(value) {
  const path = `/${String(value || '/').trim().replace(/^\/+|\/+$/g, '')}`;
  return path === '/' ? '/' : `${path}/`;
}

function publishedPagePath(publicationPath, pagePath) {
  const base = normalizedPath(publicationPath);
  const relative = normalizedPath(pagePath);
  if (relative === '/') return base;
  return normalizedPath(`${base.replace(/\/$/, '')}${relative}`);
}

function publishedPagePaths(manifest, publicationPath, document) {
  const routes = manifest?.page_routes;
  const pages = Array.isArray(document?.pages) ? document.pages : [];
  if (!routes || typeof routes !== 'object' || Array.isArray(routes) || pages.length < 1) return [];
  const routeIds = Object.keys(routes).sort();
  const pageIds = pages.map((page) => String(page?.id || '')).sort();
  if (routeIds.length !== pageIds.length || routeIds.some((id, index) => id !== pageIds[index])) return [];
  const paths = pages.map((page) => {
    const contract = routes[String(page.id)];
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;
    const keys = Object.keys(contract).sort();
    if (keys.length !== 1 || keys[0] !== 'page_path') return null;
    const raw = String(contract.page_path || '');
    const expected = page.slug === 'inicio' ? '/' : `/${page.slug}/`;
    if (raw !== expected) return null;
    return publishedPagePath(publicationPath, raw);
  });
  if (paths.some((path) => !path)) return [];
  if (new Set(paths).size !== paths.length) return [];
  return [...new Set(paths)].sort();
}

function pageContainsNode(document, pageId, nodeId) {
  const page = Array.isArray(document?.pages)
    ? document.pages.find((candidate) => String(candidate?.id) === String(pageId))
    : null;
  if (!page || !document?.nodes || typeof document.nodes !== 'object') return false;
  const pending = [
    document.globals?.header_node_id || null,
    ...(Array.isArray(page.root_node_ids) ? page.root_node_ids : []),
    document.globals?.footer_node_id || null,
  ].filter(Boolean);
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    if (String(current) === String(nodeId)) return true;
    const node = document.nodes[current];
    if (Array.isArray(node?.children)) pending.push(...node.children);
    if (visited.size > 1000) return false;
  }
  return false;
}

function intakeFormContractForPage(manifest, formId, pageId) {
  const contract = manifest?.intake_forms?.[formId];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;
  if (contract.scope !== 'global') return contract;
  const pageContracts = contract.page_contracts;
  if (!pageContracts || typeof pageContracts !== 'object' || Array.isArray(pageContracts)) return null;
  const pageContract = pageContracts[pageId];
  return pageContract && typeof pageContract === 'object' && !Array.isArray(pageContract)
    ? pageContract
    : null;
}

function intakeFieldContract(form) {
  return Array.isArray(form?.props?.fields)
    ? form.props.fields.map((field) => ({
        name: String(field?.name || ''),
        type: String(field?.type || ''),
        required: field?.required === true,
      }))
    : [];
}

function exactIntakeFieldContract(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((field, index) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
    const keys = Object.keys(field).sort();
    return keys.length === 3
      && keys[0] === 'name'
      && keys[1] === 'required'
      && keys[2] === 'type'
      && field.name === expected[index].name
      && field.type === expected[index].type
      && field.required === expected[index].required;
  });
}

function positiveInteger(value) {
  const normalized = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function googleIdentifier(body, aliases, pattern, field) {
  const attribution = body?.attribution && typeof body.attribution === 'object' && !Array.isArray(body.attribution)
    ? body.attribution
    : {};
  const values = [];
  for (const alias of aliases) {
    for (const source of [body, attribution]) {
      const raw = source?.[alias];
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw !== 'string') {
        throw new WebLandingAttributionError(
          'web_landing_google_attribution_invalid',
          'La atribución de Google Ads no es válida.',
          422,
          { field }
        );
      }
      const normalized = raw.trim();
      if (!pattern.test(normalized)) {
        throw new WebLandingAttributionError(
          'web_landing_google_attribution_invalid',
          'La atribución de Google Ads no es válida.',
          422,
          { field }
        );
      }
      values.push(normalized);
    }
  }
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    throw new WebLandingAttributionError(
      'web_landing_google_attribution_ambiguous',
      'La atribución de Google Ads contiene identificadores contradictorios.',
      422,
      { field }
    );
  }
  return unique[0] || null;
}

function campaignContextOf(project) {
  const value = plain(project)?.campaignContext ?? plain(project)?.campaign_context;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    strategyId: positiveInteger(value.strategy_id ?? value.strategyId),
    targetKind: String(value.target_kind ?? value.targetKind ?? '').trim().toLowerCase() || null,
    treatmentId: positiveInteger(value.treatment_id ?? value.treatmentId),
  };
}

function canonicalTargetKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'general' || normalized === 'generic') return 'generic';
  return normalized === 'treatment' ? 'treatment' : null;
}

function canonicalExternalCustomerId(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits || null;
}

function campaignReferenceMatches(reference, { customerId, campaignId }) {
  const item = reference && typeof reference === 'object' && !Array.isArray(reference)
    ? reference
    : {};
  return String(item.provider || '').trim().toLowerCase() === 'google_ads'
    && canonicalExternalCustomerId(item.customer_id ?? item.account_id) === customerId
    && String(item.campaign_id ?? item.external_campaign_id ?? '').trim() === campaignId;
}

function strategyRequestMatchesLandingCampaign(row, context, identity) {
  const item = plain(row) || {};
  const payload = item.solicitud && typeof item.solicitud === 'object' && !Array.isArray(item.solicitud)
    ? item.solicitud
    : {};
  if (
    payload.kind !== 'marketing_strategy'
    || String(payload.objective_id || '').trim().toLowerCase() !== 'new_patients'
    || positiveInteger(item.campaign_id) !== context.strategyId
  ) return false;
  const expectedKind = canonicalTargetKind(context.targetKind);
  if (!expectedKind) return false;
  const matches = (Array.isArray(payload.external_targets) ? payload.external_targets : []).filter((target) => {
    const kind = canonicalTargetKind(target?.kind);
    if (kind !== expectedKind) return false;
    if (kind === 'treatment' && positiveInteger(target?.treatment_id) !== context.treatmentId) return false;
    return (Array.isArray(target?.campaigns) ? target.campaigns : [])
      .some((campaign) => campaignReferenceMatches(campaign, identity));
  });
  return matches.length === 1;
}

async function resolveLegacyAssignmentStrategy({
  assignment,
  context,
  clinicId,
  customerId,
  campaignId,
  models,
}) {
  if (!context?.strategyId || !canonicalTargetKind(context.targetKind)) return null;
  const assignmentStrategyId = positiveInteger(assignment.strategy_campaign_id);
  const assignmentRequestId = positiveInteger(assignment.campaign_request_id);
  const assignmentKind = canonicalTargetKind(assignment.target_kind);
  const assignmentTreatmentId = positiveInteger(assignment.target_treatment_id);
  const contextKind = canonicalTargetKind(context.targetKind);
  if (
    (assignmentStrategyId && assignmentStrategyId !== context.strategyId)
    || (assignmentKind && assignmentKind !== contextKind)
    || (contextKind === 'treatment' && assignmentTreatmentId && assignmentTreatmentId !== context.treatmentId)
  ) {
    throw new WebLandingAttributionError(
      'web_landing_google_strategy_mismatch',
      'La campaña no coincide con la estrategia de esta landing.',
      409
    );
  }
  if (!models.CampaignRequest?.findAll) {
    throw new WebLandingAttributionError(
      'web_landing_google_attribution_unavailable',
      'No se puede comprobar la estrategia de Google Ads en este momento.',
      503
    );
  }
  const rows = await models.CampaignRequest.findAll({
    where: { campaign_id: context.strategyId, clinica_id: clinicId },
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
  const candidates = (Array.isArray(rows) ? rows : []).filter((row) => (
    strategyRequestMatchesLandingCampaign(row, context, { customerId, campaignId })
  ));
  if (candidates.length !== 1) {
    throw new WebLandingAttributionError(
      'web_landing_google_strategy_mismatch',
      'La campaña no coincide de forma inequívoca con la estrategia de esta landing.',
      409
    );
  }
  const requestId = positiveInteger(plain(candidates[0])?.id);
  if (assignmentRequestId && assignmentRequestId !== requestId) {
    throw new WebLandingAttributionError(
      'web_landing_google_strategy_mismatch',
      'La campaña no coincide con la configuración vigente de esta landing.',
      409
    );
  }
  return {
    strategyCampaignId: context.strategyId,
    campaignRequestId: requestId,
    targetKind: contextKind,
    targetTreatmentId: contextKind === 'treatment' ? context.treatmentId : null,
  };
}

async function resolveAuthorizedGoogleAttribution({ body, clinicId, groupId, projectId, models }) {
  const customerId = googleIdentifier(
    body,
    ['google_ads_customer_id', 'cc_gads_customer_id'],
    GOOGLE_CUSTOMER_ID,
    'google_ads_customer_id'
  );
  const campaignId = googleIdentifier(
    body,
    ['google_ads_campaign_id', 'cc_gads_campaign_id'],
    GOOGLE_CAMPAIGN_ID,
    'google_ads_campaign_id'
  );
  if (!customerId && !campaignId) return null;
  if (!customerId || !campaignId) {
    throw new WebLandingAttributionError(
      'web_landing_google_attribution_incomplete',
      'La atribución de Google Ads necesita cuenta y campaña.',
      422
    );
  }
  if (!models.ClinicGoogleAdsAccount?.findAll || !models.ExternalCampaignAssignment?.findOne) {
    throw new WebLandingAttributionError(
      'web_landing_google_attribution_unavailable',
      'No se puede comprobar la atribución de Google Ads en este momento.',
      503
    );
  }

  const accountRows = await models.ClinicGoogleAdsAccount.findAll({
    where: { customerId, isActive: true },
    order: [['id', 'ASC']],
    raw: true,
  });
  const accountAuthorized = (Array.isArray(accountRows) ? accountRows : []).some((row) => {
    const account = plain(row) || {};
    const scope = String(account.assignmentScope || '').trim().toLowerCase();
    if (scope === 'clinic') return Number(account.clinicaId) === clinicId;
    return scope === 'group' && groupId && Number(account.grupoClinicaId) === groupId;
  });
  if (!accountAuthorized) {
    throw new WebLandingAttributionError(
      'web_landing_google_account_unauthorized',
      'La cuenta de Google Ads no está autorizada para esta clínica.',
      409
    );
  }

  const assignment = plain(await models.ExternalCampaignAssignment.findOne({
    where: {
      provider: 'google_ads',
      customer_id: customerId,
      campaign_id: campaignId,
      clinica_id: clinicId,
      status: 'active',
    },
    raw: true,
  }));
  if (!assignment || (assignment.grupo_clinica_id && Number(assignment.grupo_clinica_id) !== groupId)) {
    throw new WebLandingAttributionError(
      'web_landing_google_campaign_unauthorized',
      'La campaña de Google Ads no está asignada a esta clínica.',
      409
    );
  }

  let strategyCampaignId = positiveInteger(assignment.strategy_campaign_id);
  let campaignRequestId = positiveInteger(assignment.campaign_request_id);
  let targetTreatmentId = positiveInteger(assignment.target_treatment_id);
  let targetKind = canonicalTargetKind(assignment.target_kind);
  if (models.WebProject?.findByPk) {
    const project = await models.WebProject.findByPk(projectId, {
      attributes: ['id', 'campaignContext'],
      raw: true,
    });
    const context = campaignContextOf(project);
    const contextKind = canonicalTargetKind(context?.targetKind);
    if (
      context?.strategyId
      && strategyCampaignId
      && context.strategyId !== strategyCampaignId
    ) {
      throw new WebLandingAttributionError(
        'web_landing_google_strategy_mismatch',
        'La campaña no coincide con la estrategia de esta landing.',
        409
      );
    }
    if (
      contextKind
      && targetKind
      && (
        contextKind !== targetKind
        || (contextKind === 'treatment' && targetTreatmentId && context.treatmentId !== targetTreatmentId)
      )
    ) {
      throw new WebLandingAttributionError(
        'web_landing_google_target_mismatch',
        'La campaña no coincide con el objetivo de esta landing.',
        409
      );
    }
    if (
      context?.strategyId
      && (!strategyCampaignId || !campaignRequestId || !targetKind)
    ) {
      const resolved = await resolveLegacyAssignmentStrategy({
        assignment,
        context,
        clinicId,
        customerId,
        campaignId,
        models,
      });
      strategyCampaignId = resolved.strategyCampaignId;
      campaignRequestId = resolved.campaignRequestId;
      targetKind = resolved.targetKind;
      targetTreatmentId = resolved.targetTreatmentId;
    }
  }

  return {
    customer_id: customerId,
    campaign_id: campaignId,
    assignment_id: positiveInteger(assignment.id),
    strategy_campaign_id: strategyCampaignId,
    campaign_request_id: campaignRequestId,
    target_kind: targetKind,
    target_treatment_id: targetTreatmentId,
  };
}

function requiredArtifactHash(value, field = 'web_artifact_input_hash') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ARTIFACT_HASH.test(normalized)) {
    throw new WebLandingAttributionError(
      'web_landing_artifact_identity_invalid',
      'La versión publicada de la landing no es válida.',
      409,
      { field }
    );
  }
  return normalized;
}

function artifactIntegrityMatches(artifact, publication, { projectId, revisionId } = {}) {
  const value = plain(artifact);
  const manifest = value?.manifest;
  return Boolean(
    value
    && manifest
    && typeof manifest === 'object'
    && !Array.isArray(manifest)
    && String(value.projectId || value.project_id || '') === String(projectId || publication?.projectId || '')
    && String(value.projectId || value.project_id || '') === String(publication?.projectId || '')
    && String(value.revisionId || value.revision_id || '') === String(revisionId || '')
    && String(value.revisionId || value.revision_id || '') === String(manifest.revision_id || '')
    && value.environment === 'production'
    && value.status === 'ready'
    && String(manifest.environment || 'production') === 'production'
    && ARTIFACT_HASH.test(String(value.artifactHash || value.artifact_hash || ''))
    && String(value.artifactHash || value.artifact_hash || '') === String(manifest.artifact_hash || '')
    && ARTIFACT_HASH.test(String(manifest.artifact_input_hash || ''))
  );
}

async function resolvePublicationArtifact({
  publication,
  projectId,
  revisionId,
  artifactInputHash = null,
  artifactHash = null,
  models = db,
  now = new Date(),
} = {}) {
  const currentPublication = plain(publication);
  if (!currentPublication?.id || !models.WebArtifact?.findByPk) return null;
  const inputSelector = artifactInputHash === null
    ? null
    : requiredArtifactHash(artifactInputHash, 'web_artifact_input_hash');
  const finalSelector = artifactHash === null
    ? null
    : requiredArtifactHash(artifactHash, 'x-clinicaclick-web-artifact');
  if (!inputSelector && !finalSelector) return null;

  const transition = await transitionContextForPublication({
    publication: currentPublication,
    models,
    now,
  });
  const inFlightDeployment = (
    !transition
    && ['pending', 'publishing', 'rolling_back'].includes(String(currentPublication.status || ''))
    && models.WebPublicationDeployment?.findOne
  ) ? plain(await models.WebPublicationDeployment.findOne({
      where: {
        publicationId: currentPublication.id,
        action: { [Op.in]: ['publish', 'rollback'] },
        status: { [Op.in]: ['queued', 'running', 'verified'] },
        artifactId: { [Op.ne]: null },
      },
      order: [['sequence', 'DESC']],
    })) : null;
  const ids = [...new Set([
    currentPublication.activeArtifactId,
    currentPublication.lastGoodArtifactId,
    inFlightDeployment?.artifactId,
    ...(transition?.accepted_artifact_ids || []),
  ].filter(Boolean).map(String))];
  const candidates = (await Promise.all(ids.map((id) => findWebArtifactMetadataByPk(models, id))))
    .map(plain)
    .filter((candidate) => artifactIntegrityMatches(candidate, currentPublication, { projectId, revisionId }))
    .filter((candidate) => (
      (!inputSelector || String(candidate.manifest.artifact_input_hash) === inputSelector)
      && (!finalSelector || String(candidate.artifactHash || candidate.artifact_hash) === finalSelector)
    ));
  return candidates.length === 1 ? candidates[0] : null;
}

async function resolveWebLandingAttribution({ body = {}, models = db, now = new Date() } = {}) {
  const externalSource = String(body.external_source || '').trim().toLowerCase();
  const hasWebIds = ['web_project_id', 'web_revision_id', 'web_page_id', 'web_form_id']
    .some((field) => body[field] !== undefined && body[field] !== null && body[field] !== '');
  if (!hasWebIds && externalSource !== 'clinicaclick_web_landing') return null;
  if (externalSource !== 'clinicaclick_web_landing') {
    throw new WebLandingAttributionError(
      'web_landing_attribution_source_required',
      'La atribución web solo se admite desde una landing de ClinicaClick.',
      422
    );
  }
  const projectId = requiredUuid(body.web_project_id, 'web_project_id');
  const revisionId = requiredUuid(body.web_revision_id, 'web_revision_id');
  const pageId = requiredUuid(body.web_page_id, 'web_page_id');
  const formId = String(body.web_form_id || '').trim();
  if (!UUID_V4.test(formId) && !SAFE_FORM_ID.test(formId)) {
    throw new WebLandingAttributionError('web_landing_attribution_invalid', 'La atribución de la landing no es válida.', 422, {
      field: 'web_form_id',
    });
  }
  const artifactInputHash = requiredArtifactHash(body.web_artifact_input_hash);
  const pageUrl = safePageUrl(body.page_url || body.landing_url);
  const revision = await models.WebRevision.findByPk(revisionId);
  if (!revision || String(revision.projectId) !== projectId) {
    throw new WebLandingAttributionError('web_landing_revision_not_active', 'La versión de la landing ya no está activa.', 409);
  }
  const page = revision.document?.pages?.find((candidate) => String(candidate?.id) === pageId);
  const form = revision.document?.nodes?.[formId];
  if (!page || !form || form.type !== 'intake_form' || !pageContainsNode(revision.document, pageId, formId)) {
    throw new WebLandingAttributionError('web_landing_form_not_found', 'El formulario no pertenece a la landing publicada.', 409);
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
    throw new WebLandingAttributionError(
      'web_landing_page_projection_invalid',
      'La página publicada no coincide con la proyección activa del proyecto.',
      409
    );
  }
  const publications = await models.WebPublication.findAll({
    where: {
      projectId,
      [Op.or]: [
        { activeRevisionId: revisionId },
        { desiredRevisionId: revisionId },
      ],
      status: { [Op.in]: SERVED_PUBLICATION_STATUSES },
      host: pageUrl.hostname.toLowerCase(),
    },
    order: [['published_at', 'DESC'], ['id', 'ASC']],
  });
  const publication = longestPublicationMatch(publications, pageUrl);
  if (!publication) {
    throw new WebLandingAttributionError(
      'web_landing_publication_not_active',
      'No se ha encontrado una publicación activa única para esta página.',
      409
    );
  }
  const artifact = await resolvePublicationArtifact({
    publication,
    projectId,
    revisionId,
    artifactInputHash,
    models,
    now,
  });
  if (!artifact) {
    throw new WebLandingAttributionError('web_landing_artifact_not_active', 'La landing publicada no tiene un artefacto activo.', 409);
  }
  const manifest = artifact.manifest && typeof artifact.manifest === 'object' ? artifact.manifest : {};
  const formContract = intakeFormContractForPage(manifest, formId, pageId);
  const expectedFields = intakeFieldContract(form);
  const activePagePaths = publishedPagePaths(manifest, publication.path, revision.document);
  if (
    manifest.project_id !== projectId
    || manifest.revision_id !== revisionId
    || manifest.environment !== 'production'
    || manifest.artifact_hash !== artifact.artifactHash
    || !formContract
    || activePagePaths.length < 1
    || String(formContract.page_id) !== pageId
    || normalizedPath(formContract.page_path) !== normalizedPath(page.slug === 'inicio' ? '/' : `/${page.slug}/`)
    || !exactIntakeFieldContract(formContract.fields, expectedFields)
  ) {
    throw new WebLandingAttributionError(
      'web_landing_form_contract_invalid',
      'El formulario no coincide con el artefacto publicado.',
      409
    );
  }
  const expectedPath = publishedPagePath(publication.path, formContract.page_path);
  if (normalizedPath(pageUrl.pathname) !== expectedPath) {
    throw new WebLandingAttributionError(
      'web_landing_page_path_mismatch',
      'La página enviada no coincide con la publicación activa.',
      409
    );
  }
  let clinicId = publication.scopeType === 'clinic'
    ? Number(publication.clinicaId)
    : Number(publication.configuration?.clinic_id);
  let groupId = publication.scopeType === 'group' ? Number(publication.grupoClinicaId) : null;
  if (!Number.isSafeInteger(clinicId) || clinicId <= 0) {
    throw new WebLandingAttributionError('web_landing_clinic_not_configured', 'La landing no tiene una clínica de destino.', 409);
  }
  const clinic = await models.Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
  });
  if (!clinic) throw new WebLandingAttributionError('web_landing_clinic_not_found', 'La clínica de la landing no existe.', 409);
  if (publication.scopeType === 'group' && Number(clinic.grupoClinicaId) !== groupId) {
    throw new WebLandingAttributionError('web_landing_clinic_scope_mismatch', 'La clínica no pertenece al alcance publicado.', 409);
  }
  if (publication.scopeType === 'clinic') groupId = Number(clinic.grupoClinicaId) || null;
  const googleAttribution = await resolveAuthorizedGoogleAttribution({
    body,
    clinicId,
    groupId,
    projectId,
    models,
  });
  return attachWebLandingInternalContext({
    project_id: projectId,
    revision_id: revisionId,
    // LeadIntakes.web_page_id is an FK to WebPages.id. The document page id
    // sent by HTML is only a structural pageKey and is never persisted as FK.
    page_id: String(pageProjection.id),
    document_page_id: pageId,
    publication_id: publication.id,
    artifact_id: artifact.id,
    artifact_hash: artifact.artifactHash,
    form_id: formId,
    scope_type: publication.scopeType,
    clinic_id: clinicId,
    group_id: groupId,
    page_url: pageUrl.toString(),
    page_slug: page.slug,
    published_page_paths: activePagePaths,
    success_anchor: String(formContract.success_anchor),
    error_anchor: String(formContract.error_anchor),
    form_fields: expectedFields,
    ...(googleAttribution ? {
      google_ads_customer_id: googleAttribution.customer_id,
      google_ads_campaign_id: googleAttribution.campaign_id,
      google_ads_assignment_id: googleAttribution.assignment_id,
      strategy_campaign_id: googleAttribution.strategy_campaign_id,
      campaign_request_id: googleAttribution.campaign_request_id,
      target_kind: googleAttribution.target_kind,
      target_treatment_id: googleAttribution.target_treatment_id,
    } : {}),
  }, { artifact, publication });
}

module.exports = {
  UUID_V4,
  WebLandingAttributionError,
  pageContainsNode,
  exactIntakeFieldContract,
  intakeFormContractForPage,
  intakeFieldContract,
  longestPublicationMatch,
  pathMatchesPublication,
  publishedPagePath,
  publishedPagePaths,
  requiredArtifactHash,
  resolvePublicationArtifact,
  resolveAuthorizedGoogleAttribution,
  resolveWebLandingAttribution,
  safePageUrl,
};
