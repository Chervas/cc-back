'use strict';

const crypto = require('node:crypto');
const { Op, QueryTypes, col, fn } = require('sequelize');
const db = require('../../models');
const { assertUserCanAccessFeature } = require('../lib/access-policy');
const { isGlobalAdmin } = require('../lib/role-helpers');
const { assertValidWebDocument } = require('../lib/webDocument');
const {
  assertWebScopeEnabled,
  webPublishingCapabilities,
} = require('../lib/marketingWebFeatureFlags');
const {
  collectWebResourceReferences,
  resolveWebDocumentResources,
} = require('./webResourceResolver.service');
const {
  effectiveIntakeConfigForScope,
} = require('./webEffectiveIntakeConfig.service');

const PROJECT_PURPOSES = new Set(['landing', 'microsite', 'website']);
const PROJECT_STATUSES = new Set(['draft', 'active', 'archived']);
const SCOPE_TYPES = new Set(['clinic', 'group']);
const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE_NUMBER = 10000;
const CAMPAIGN_TARGET_KINDS = new Set(['general', 'treatment']);
const CAMPAIGN_TEMPLATE_CATEGORIES = Object.freeze({
  general: new Set(['clinic', 'local', 'qualification']),
  treatment: new Set(['treatment']),
});
const TEMPLATE_CATEGORIES = new Set(['treatment', 'clinic', 'local', 'qualification', 'custom']);
const CAMPAIGN_CONTEXT_KEYS = new Set([
  'strategy_id', 'strategyId', 'target_kind', 'targetKind', 'treatment_id', 'treatmentId',
]);

class WebProjectServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'WebProjectServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function positiveInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function boundedInteger(value, fallback, maximum) {
  const parsed = positiveInteger(value);
  return Math.min(parsed || fallback, maximum);
}

function booleanQueryFlag(value, fieldName) {
  if (value === undefined) return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new WebProjectServiceError(
    `invalid_${fieldName}`,
    `${fieldName} debe ser true o false.`
  );
}

function validatedPreviewDocument(value, templateId, expectedHash) {
  try {
    const document = typeof value === 'string' ? JSON.parse(value) : value;
    const integrity = assertValidWebDocument(document);
    if (!/^[a-f0-9]{64}$/.test(String(expectedHash || '')) || integrity.hash !== expectedHash) {
      throw new Error('template_document_hash_mismatch');
    }
    // Reparse the canonical representation so the response only contains plain,
    // normalized JSON that passed the complete WebDocument v1 contract.
    return JSON.parse(integrity.canonical);
  } catch (error) {
    if (error instanceof WebProjectServiceError) throw error;
    throw new WebProjectServiceError(
      'template_preview_invalid',
      'La vista previa de esta plantilla no está disponible.',
      503,
      { template_id: String(templateId || '') }
    );
  }
}

function normalizeCampaignContext(input) {
  if (input === undefined || input === null || input === '') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WebProjectServiceError(
      'invalid_campaign_context',
      'campaign_context debe identificar una estrategia y un objetivo de campana.',
      422
    );
  }
  const unknownKeys = Object.keys(input).filter((key) => !CAMPAIGN_CONTEXT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new WebProjectServiceError(
      'invalid_campaign_context',
      'campaign_context contiene campos no admitidos.',
      422,
      { unknown_fields: unknownKeys.sort() }
    );
  }
  const strategyId = positiveInteger(input.strategy_id ?? input.strategyId);
  const targetKind = String(input.target_kind ?? input.targetKind ?? '').trim().toLowerCase();
  const treatmentInput = input.treatment_id ?? input.treatmentId;
  if (!strategyId || !CAMPAIGN_TARGET_KINDS.has(targetKind)) {
    throw new WebProjectServiceError(
      'invalid_campaign_context',
      'campaign_context requiere strategy_id positivo y target_kind general o treatment.',
      422
    );
  }
  if (targetKind === 'general') {
    if (treatmentInput !== undefined && treatmentInput !== null && treatmentInput !== '') {
      throw new WebProjectServiceError(
        'invalid_campaign_context',
        'El objetivo general no admite treatment_id.',
        422
      );
    }
    return { strategy_id: strategyId, target_kind: 'general', treatment_id: null };
  }
  const treatmentId = positiveInteger(treatmentInput);
  if (!treatmentId) {
    throw new WebProjectServiceError(
      'invalid_campaign_context',
      'El objetivo treatment requiere treatment_id positivo.',
      422
    );
  }
  return { strategy_id: strategyId, target_kind: 'treatment', treatment_id: treatmentId };
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function normalizeScope(input = {}) {
  const scopeType = String(input.scope_type ?? input.scopeType ?? '').trim().toLowerCase();
  const scopeId = positiveInteger(
    input.scope_id
      ?? input.scopeId
      ?? (scopeType === 'group' ? input.group_id ?? input.grupo_clinica_id : input.clinic_id ?? input.clinica_id)
  );
  if (!SCOPE_TYPES.has(scopeType)) {
    throw new WebProjectServiceError('invalid_scope_type', 'scope_type debe ser clinic o group.');
  }
  if (!scopeId) {
    throw new WebProjectServiceError('invalid_scope_id', 'scope_id debe ser un entero positivo.');
  }
  return { type: scopeType, id: scopeId };
}

function scopeColumns(scope) {
  return scope.type === 'clinic'
    ? { scopeType: 'clinic', clinicaId: scope.id, grupoClinicaId: null }
    : { scopeType: 'group', clinicaId: null, grupoClinicaId: scope.id };
}

function scopeWhere(scope) {
  return scope.type === 'clinic'
    ? { scopeType: 'clinic', clinicaId: scope.id }
    : { scopeType: 'group', grupoClinicaId: scope.id };
}

async function clinicIdsForScope(scope, options = {}) {
  const models = options.models || db;
  if (scope.type === 'clinic') {
    const clinic = await models.Clinica.findByPk(scope.id, {
      attributes: ['id_clinica'],
      raw: true,
      transaction: options.transaction,
    });
    if (!clinic) {
      throw new WebProjectServiceError('clinic_not_found', 'La clínica no existe.', 404);
    }
    return [Number(clinic.id_clinica)];
  }

  const group = await models.GrupoClinica.findByPk(scope.id, {
    attributes: ['id_grupo'],
    raw: true,
    transaction: options.transaction,
  });
  if (!group) {
    throw new WebProjectServiceError('group_not_found', 'El grupo de clínicas no existe.', 404);
  }
  const clinics = await models.Clinica.findAll({
    where: { grupoClinicaId: scope.id },
    attributes: ['id_clinica'],
    raw: true,
    transaction: options.transaction,
  });
  return clinics
    .map((clinic) => positiveInteger(clinic.id_clinica))
    .filter(Boolean);
}

async function groupIdForClinic(clinicId, options = {}) {
  const clinic = await (options.models || db).Clinica.findByPk(clinicId, {
    attributes: ['grupoClinicaId'],
    raw: true,
    transaction: options.transaction,
  });
  return positiveInteger(clinic?.grupoClinicaId);
}

/**
 * Resuelve la misma configuración efectiva que usa intake en producción.
 * Una configuración de grupo solo se hereda si la clínica figura de forma
 * explícita en `locations`; nunca se amplía el alcance por conveniencia.
 */
async function intakeConfigForWebScope(scope, options = {}) {
  const models = options.models || db;
  if (!models.IntakeConfig?.findOne) return null;
  if (scope.type === 'group') {
    return effectiveIntakeConfigForScope({
      scopeType: 'group',
      groupId: scope.id,
      rejectInvalidInheritance: true,
      models,
      transaction: options.transaction,
    });
  }
  return effectiveIntakeConfigForScope({
    scopeType: 'clinic',
    clinicId: scope.id,
    preserveClinicConfig: true,
    rejectInvalidInheritance: true,
    models,
    transaction: options.transaction,
  });
}

function siteDefaultsFromIntake(record) {
  const raw = plain(record);
  const intakeId = positiveInteger(raw?.id);
  const config = raw?.config && typeof raw.config === 'object' && !Array.isArray(raw.config)
    ? raw.config
    : {};
  const features = config.features && typeof config.features === 'object' && !Array.isArray(config.features)
    ? config.features
    : {};
  const texts = config.texts && typeof config.texts === 'object' && !Array.isArray(config.texts)
    ? config.texts
    : {};
  const provider = ['clinicaclick', 'external_cmp'].includes(String(features.consent_provider || '').trim().toLowerCase())
    ? String(features.consent_provider).trim().toLowerCase()
    : 'inherit';
  const privacyUrl = String(texts.privacy_url || '').trim() || null;
  const consentText = String(texts.consent_text || '').trim()
    || (privacyUrl ? 'Acepto la política de privacidad.' : null);
  const updatedAt = raw?.updated_at ? new Date(raw.updated_at) : null;
  const updatedStamp = updatedAt && Number.isFinite(updatedAt.getTime())
    ? updatedAt.toISOString().slice(0, 10)
    : 'actual';
  const consentReady = Boolean(
    intakeId
    && features.consent_mode_enabled === true
    && provider !== 'inherit'
    && privacyUrl
    && consentText
  );
  return {
    configured: Boolean(intakeId),
    source_scope: intakeId ? (raw.assignment_scope === 'group' ? 'group' : 'clinic') : null,
    source_scope_id: intakeId
      ? positiveInteger(raw.assignment_scope === 'group' ? raw.group_id : raw.clinic_id)
      : null,
    consent_source_scope: intakeId ? (raw.assignment_scope === 'group' ? 'group' : 'clinic') : null,
    consent_source_scope_id: intakeId
      ? positiveInteger(raw.assignment_scope === 'group' ? raw.group_id : raw.clinic_id)
      : null,
    consent_source_intake_config_id: intakeId,
    consent_ready: consentReady,
    consent: {
      provider,
      preview_mode: !consentReady,
      privacy_policy_url: privacyUrl,
      privacy_policy_version: privacyUrl && intakeId ? `intake-${intakeId}-${updatedStamp}` : null,
      privacy_consent_text: consentText,
    },
    integrations: {
      intake_config_id: intakeId ? String(intakeId) : null,
      chat_enabled: features.chat_enabled === true,
      whatsapp_enabled: features.chat_enabled === true,
      phone_enabled: features.tel_modal_enabled === true,
    },
  };
}

async function resolveWebProjectSiteDefaults(scope, options = {}) {
  const record = await intakeConfigForWebScope(scope, options);
  const effectiveDefaults = siteDefaultsFromIntake(record);
  if (scope.type !== 'clinic' || effectiveDefaults.consent_ready) return effectiveDefaults;

  // Algunas altas técnicas crean una IntakeConfig de clínica únicamente para
  // HMAC, verificación del snippet o flags del runtime. Ese registro estrecho
  // debe seguir gobernando intake/chat/teléfono, pero no puede ocultar un
  // consentimiento de grupo válido para una clínica incluida explícitamente.
  const models = options.models || db;
  if (!models.IntakeConfig?.findOne || !models.Clinica?.findByPk) return effectiveDefaults;
  const groupId = await groupIdForClinic(scope.id, options);
  if (!groupId) return effectiveDefaults;
  const groupRecord = await effectiveIntakeConfigForScope({
    scopeType: 'group',
    groupId,
    rejectInvalidInheritance: true,
    models,
    transaction: options.transaction,
  });
  const rawGroup = plain(groupRecord);
  const locations = Array.isArray(rawGroup?.config?.locations) ? rawGroup.config.locations : [];
  const explicitlyIncluded = locations.some((location) => (
    positiveInteger(location?.id ?? location?.clinic_id) === scope.id
  ));
  if (!explicitlyIncluded) return effectiveDefaults;

  const groupDefaults = siteDefaultsFromIntake(groupRecord);
  if (!groupDefaults.consent_ready) return effectiveDefaults;
  return {
    ...effectiveDefaults,
    consent_ready: true,
    consent: groupDefaults.consent,
    // source_scope describe la configuración que sigue recibiendo el lead.
    // La procedencia legal se separa para no atribuir al grupo integrations
    // que continúan siendo estrictamente de clínica.
    consent_source_scope: 'group',
    consent_source_scope_id: groupId,
    consent_source_intake_config_id: positiveInteger(rawGroup?.id),
  };
}

function applyWebProjectSiteDefaults(document, defaults) {
  const next = JSON.parse(JSON.stringify(document));
  next.consent = { ...next.consent, ...defaults.consent };
  next.integrations = { ...next.integrations, ...defaults.integrations };
  assertValidWebDocument(next);
  return next;
}

async function assertScopeAccess(actorId, scope, featureKey, options = {}) {
  assertWebScopeEnabled(scope);
  const normalizedActorId = positiveInteger(actorId);
  if (!normalizedActorId) {
    throw new WebProjectServiceError('unauthenticated', 'No se ha podido identificar al usuario.', 401);
  }

  const clinicIds = await clinicIdsForScope(scope, options);
  if (clinicIds.length === 0 && !isGlobalAdmin(normalizedActorId)) {
    throw new WebProjectServiceError(
      'empty_group_scope_forbidden',
      'El grupo no tiene clínicas sobre las que comprobar permisos.',
      403
    );
  }
  try {
    const assertFeatureAccess = options.assertFeatureAccess || assertUserCanAccessFeature;
    await Promise.all(clinicIds.map((clinicId) => assertFeatureAccess({
      actorId: normalizedActorId,
      featureKey,
      clinicId,
    })));
  } catch (error) {
    if (Number(error?.status) === 403) {
      throw new WebProjectServiceError(
        'scope_forbidden',
        'No tienes permiso para realizar esta acción en todas las clínicas del alcance.',
        403,
        { scope_type: scope.type, scope_id: scope.id, feature_key: featureKey }
      );
    }
    throw error;
  }
  return clinicIds;
}

function createBlankWebDocument({ name, locale = 'es-ES' } = {}) {
  const pageId = crypto.randomUUID();
  const sectionId = crypto.randomUUID();
  const headingId = crypto.randomUUID();
  const textId = crypto.randomUUID();
  const buttonId = crypto.randomUUID();
  const formId = crypto.randomUUID();
  const firstNameId = crypto.randomUUID();
  const phoneId = crypto.randomUUID();
  const consentId = crypto.randomUUID();
  const safeName = String(name || 'Nueva landing').trim().slice(0, 120) || 'Nueva landing';

  const document = {
    schema_version: 1,
    design_system: {
      brand: 'clinicaclick',
      tokens: {
        color_primary: '#5B5BF7',
        color_secondary: '#181D35',
        color_accent: '#22C3A6',
        color_surface: '#FFFFFF',
        color_text: '#181D35',
        font_heading: 'system',
        font_body: 'system',
        radius: 'lg',
        spacing_density: 'comfortable',
      },
    },
    pages: [{
      id: pageId,
      title: safeName,
      slug: 'inicio',
      root_node_ids: [sectionId],
      seo: {
        title: safeName.slice(0, 70),
        description: '',
        canonical_url: null,
        social_asset_id: null,
        index: false,
        follow: false,
      },
    }],
    globals: { header_node_id: null, footer_node_id: null },
    nodes: {
      [sectionId]: {
        id: sectionId,
        type: 'section',
        version: 1,
        props: { layout: 'stack', columns: 1, semantic_tag: 'main' },
        children: [headingId, textId, buttonId, formId],
        style_tokens: {
          background: 'surface',
          foreground: 'default',
          content_width: 'standard',
          spacing_top: 'xl',
          spacing_bottom: 'xl',
          gap: 'md',
          radius: 'inherit',
          shadow: 'none',
          align: 'stretch',
        },
      },
      [headingId]: {
        id: headingId,
        type: 'heading',
        version: 1,
        props: { text: safeName, level: 1, size: '3xl', align: 'left', tone: 'default' },
        children: [],
      },
      [textId]: {
        id: textId,
        type: 'text',
        version: 1,
        props: {
          text: locale.toLowerCase().startsWith('es')
            ? 'Explica aquí, de forma clara, cómo puede ayudar la clínica al paciente.'
            : 'Explain clearly how the clinic can help the patient.',
          size: 'md',
          align: 'left',
          tone: 'default',
        },
        children: [],
      },
      [buttonId]: {
        id: buttonId,
        type: 'button',
        version: 1,
        props: {
          label: locale.toLowerCase().startsWith('es') ? 'Pedir cita' : 'Request an appointment',
          action: 'intake_form_anchor',
          target: formId,
          variant: 'primary',
          open_in_new_tab: false,
        },
        children: [],
      },
      [formId]: {
        id: formId,
        type: 'intake_form',
        version: 1,
        props: {
          form_key: 'primary_contact',
          title: locale.toLowerCase().startsWith('es') ? 'Cuéntanos cómo podemos ayudarte' : 'Tell us how we can help',
          description: '',
          submit_label: locale.toLowerCase().startsWith('es') ? 'Enviar' : 'Send',
          success_message: locale.toLowerCase().startsWith('es')
            ? 'Gracias. La clínica contactará contigo lo antes posible.'
            : 'Thank you. The clinic will contact you shortly.',
          fields: [
            { id: firstNameId, name: 'first_name', type: 'text', label: 'Nombre', required: true, autocomplete: 'given-name' },
            { id: phoneId, name: 'phone', type: 'tel', label: 'Teléfono', required: true, autocomplete: 'tel' },
            { id: consentId, name: 'privacy_consent', type: 'checkbox', label: 'Acepto la política de privacidad', required: true, autocomplete: 'off' },
          ],
        },
        children: [],
      },
    },
    bindings: {},
    seo: { title_suffix: '', indexing: 'noindex', default_social_asset_id: null },
    consent: {
      provider: 'inherit',
      preview_mode: true,
      privacy_policy_url: null,
      privacy_policy_version: null,
      privacy_consent_text: null,
    },
    integrations: {
      intake_config_id: null,
      chat_enabled: false,
      whatsapp_enabled: false,
      phone_enabled: false,
    },
  };

  assertValidWebDocument(document);
  return document;
}

/**
 * Instancia una plantilla sin reutilizar IDs estructurales entre proyectos.
 * Los IDs de assets, contenidos e integraciones son referencias externas y se conservan.
 */
function instantiateWebDocument(sourceDocument) {
  assertValidWebDocument(sourceDocument);
  const document = JSON.parse(JSON.stringify(sourceDocument));
  // Los artefactos no empaquetan fuentes web. Los tokens históricos siguen
  // siendo válidos para abrir documentos existentes, pero cualquier proyecto
  // nuevo se instancia con la pila del sistema para que el resultado sea
  // estable y no dependa de una fuente instalada localmente.
  document.design_system.tokens.font_heading = 'system';
  document.design_system.tokens.font_body = 'system';
  const pageIds = new Map(document.pages.map((page) => [page.id, crypto.randomUUID()]));
  const nodeIds = new Map(Object.keys(document.nodes).map((id) => [id, crypto.randomUUID()]));
  const bindingIds = new Map(Object.keys(document.bindings).map((id) => [id, crypto.randomUUID()]));

  document.pages = document.pages.map((page) => ({
    ...page,
    id: pageIds.get(page.id),
    root_node_ids: page.root_node_ids.map((id) => nodeIds.get(id)),
  }));

  const nextNodes = {};
  for (const [oldId, node] of Object.entries(document.nodes)) {
    const id = nodeIds.get(oldId);
    const next = {
      ...node,
      id,
      children: node.children.map((childId) => nodeIds.get(childId)),
      ...(Array.isArray(node.binding_ids)
        ? { binding_ids: node.binding_ids.map((bindingId) => bindingIds.get(bindingId)) }
        : {}),
    };
    if (next.type === 'button') {
      if (next.props.action === 'internal_page' && pageIds.has(next.props.target)) {
        next.props.target = pageIds.get(next.props.target);
      }
      if (next.props.action === 'intake_form_anchor' && nodeIds.has(next.props.target)) {
        next.props.target = nodeIds.get(next.props.target);
      }
    }
    if (next.type === 'intake_form') {
      next.props.fields = next.props.fields.map((field) => ({ ...field, id: crypto.randomUUID() }));
    }
    nextNodes[id] = next;
  }
  document.nodes = nextNodes;

  const nextBindings = {};
  for (const [oldId, binding] of Object.entries(document.bindings)) {
    const id = bindingIds.get(oldId);
    nextBindings[id] = {
      ...binding,
      target_node_id: nodeIds.get(binding.target_node_id),
    };
  }
  document.bindings = nextBindings;
  document.globals = {
    header_node_id: document.globals.header_node_id
      ? nodeIds.get(document.globals.header_node_id)
      : null,
    footer_node_id: document.globals.footer_node_id
      ? nodeIds.get(document.globals.footer_node_id)
      : null,
  };

  assertValidWebDocument(document);
  return document;
}

function serializeDraft(row) {
  const draft = plain(row);
  if (!draft) return null;
  return {
    id: draft.id,
    lock_version: draft.lockVersion,
    document_hash: draft.documentHash,
    base_revision_id: draft.baseRevisionId || null,
    updated_at: draft.updated_at,
  };
}

function serializeRevision(row) {
  const revision = plain(row);
  if (!revision) return null;
  return {
    id: revision.id,
    revision_number: revision.revisionNumber,
    status: revision.status,
    document_hash: revision.documentHash,
    created_at: revision.created_at,
  };
}

function collectExternalDocumentReferences(document, scope = null) {
  return collectWebResourceReferences(document, scope);
}

function assertRevisionReadyForApproval(document, scope, options = {}) {
  const issues = [];
  if (document?.consent?.preview_mode !== false) issues.push({ code: 'consent_preview_mode' });
  if (!document?.consent?.privacy_policy_url) issues.push({ code: 'privacy_policy_url_missing' });
  if (!document?.consent?.privacy_policy_version) issues.push({ code: 'privacy_policy_version_missing' });
  if (!document?.consent?.privacy_consent_text) issues.push({ code: 'privacy_consent_text_missing' });
  const hasIntakeForm = Object.values(document?.nodes || {}).some((node) => node?.type === 'intake_form');
  if (hasIntakeForm && !document?.integrations?.intake_config_id) {
    issues.push({ code: 'intake_config_missing' });
  }
  const unresolved = Array.isArray(options.unresolvedReferences)
    ? options.unresolvedReferences
    : collectExternalDocumentReferences(document, scope);
  if (unresolved.length > 0) {
    issues.push({ code: 'external_references_unresolved', references: unresolved });
  }
  if (issues.length === 0) return true;
  throw new WebProjectServiceError(
    'web_revision_not_ready',
    'La revisión todavía tiene requisitos legales o recursos sin resolver.',
    422,
    { issues }
  );
}

function serializeProject(row, options = {}) {
  const project = plain(row);
  const scopeId = project.scopeType === 'clinic' ? project.clinicaId : project.grupoClinicaId;
  const pages = Array.isArray(project.pages) ? project.pages : [];
  return {
    id: project.id,
    scope_type: project.scopeType,
    scope_id: scopeId,
    name: project.name,
    purpose: project.purpose,
    locale: project.locale,
    status: project.status,
    campaign_context: normalizeCampaignContext(project.campaignContext),
    version: project.version,
    page_count: Number(options.pageCount ?? pages.length ?? 0),
    draft: serializeDraft(options.draft ?? project.draft),
    latest_revision: serializeRevision(options.latestRevision),
    ...(options.publishingCapabilities ? {
      capabilities: options.publishingCapabilities,
    } : {}),
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

async function getProjectOrThrow(projectId, options = {}) {
  const project = await (options.models || db).WebProject.findByPk(String(projectId || ''), {
    include: options.include || undefined,
    transaction: options.transaction,
    lock: options.lock,
  });
  if (!project) {
    throw new WebProjectServiceError('project_not_found', 'El proyecto web no existe.', 404);
  }
  return project;
}

function scopeFromProject(row) {
  const project = plain(row);
  return project.scopeType === 'clinic'
    ? { type: 'clinic', id: Number(project.clinicaId) }
    : { type: 'group', id: Number(project.grupoClinicaId) };
}

async function assertProjectAccess(actorId, project, featureKey, options = {}) {
  const scope = scopeFromProject(project);
  try {
    await assertScopeAccess(actorId, scope, featureKey, options);
  } catch (error) {
    if (Number(error?.status) === 403) {
      throw new WebProjectServiceError('project_not_found', 'El proyecto web no existe.', 404);
    }
    throw error;
  }
  return scope;
}

async function listProjects({ actorId, query = {}, models = db, env = process.env } = {}) {
  const scope = normalizeScope(query);
  await assertScopeAccess(actorId, scope, 'marketing.web.view', { models });
  const publishingCapabilities = webPublishingCapabilities(scope, env);
  const page = boundedInteger(query.page, 1, MAX_PAGE_NUMBER);
  const limit = boundedInteger(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const status = String(query.status || '').trim().toLowerCase();
  if (status && !PROJECT_STATUSES.has(status)) {
    throw new WebProjectServiceError('invalid_project_status', 'El estado solicitado no es válido.');
  }

  const where = { ...scopeWhere(scope), ...(status ? { status } : {}) };
  const result = await models.WebProject.findAndCountAll({
    where,
    include: [
      { model: models.WebPage, as: 'pages', attributes: ['id'], required: false },
      { model: models.WebDraft, as: 'draft', attributes: ['id', 'lockVersion', 'documentHash', 'baseRevisionId', 'updated_at'], required: false },
    ],
    distinct: true,
    order: [['updated_at', 'DESC'], ['id', 'ASC']],
    limit,
    offset: (page - 1) * limit,
  });

  const rows = result.rows || [];
  const projectIds = rows.map((project) => project.id);
  const latestNumbers = projectIds.length > 0
    ? await models.WebRevision.findAll({
      where: { projectId: { [Op.in]: projectIds } },
      attributes: [
        'projectId',
        [fn('MAX', col('revision_number')), 'maxRevisionNumber'],
      ],
      group: ['projectId'],
      raw: true,
    })
    : [];
  const latestPairs = latestNumbers
    .map((row) => ({
      projectId: row.projectId,
      revisionNumber: positiveInteger(row.maxRevisionNumber),
    }))
    .filter((row) => row.projectId && row.revisionNumber);
  const revisionRows = latestPairs.length > 0
    ? await models.WebRevision.findAll({
      where: { [Op.or]: latestPairs },
      attributes: ['id', 'projectId', 'revisionNumber', 'status', 'documentHash', 'created_at'],
    })
    : [];
  const latestRevisionByProject = new Map();
  for (const revision of revisionRows) {
    const projectId = String(plain(revision).projectId);
    if (!latestRevisionByProject.has(projectId)) latestRevisionByProject.set(projectId, revision);
  }

  const total = Number(result.count || 0);
  return {
    scope: { type: scope.type, id: scope.id },
    capabilities: publishingCapabilities,
    items: rows.map((project) => serializeProject(project, {
      latestRevision: latestRevisionByProject.get(String(project.id)) || null,
      publishingCapabilities,
    })),
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    },
  };
}

async function resolveTemplate(templateId, scope, actorId, transaction, models = db) {
  if (!templateId) return null;
  const template = await models.WebTemplate.findByPk(String(templateId), { transaction });
  if (!template || template.status !== 'active') {
    throw new WebProjectServiceError('template_not_found', 'La plantilla no existe o no está activa.', 404);
  }
  const raw = plain(template);
  const inheritedGroupId = scope.type === 'clinic'
    ? await groupIdForClinic(scope.id, { models, transaction })
    : null;
  const sameScope = raw.scopeType === 'global'
    || (raw.scopeType === scope.type && Number(raw.scopeType === 'clinic' ? raw.clinicaId : raw.grupoClinicaId) === scope.id)
    || (scope.type === 'clinic' && raw.scopeType === 'group' && Number(raw.grupoClinicaId) === inheritedGroupId);
  if (!sameScope || (raw.scopeType === 'global' && !raw.isPublic && !isGlobalAdmin(actorId))) {
    throw new WebProjectServiceError('template_forbidden', 'La plantilla no está disponible en este alcance.', 403);
  }
  return template;
}

function strategyPayload(row) {
  const value = plain(row)?.solicitud;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function campaignTemplateCompatibility(template, campaignContext) {
  const value = plain(template) || {};
  const category = String(value.category || '').trim().toLowerCase();
  const allowedCategories = CAMPAIGN_TEMPLATE_CATEGORIES[campaignContext.target_kind];
  let compatibility = value.compatibility;
  let compatibilityValid = true;
  if (typeof compatibility === 'string') {
    try {
      compatibility = JSON.parse(compatibility);
    } catch {
      compatibility = null;
      compatibilityValid = false;
    }
  }
  if (!compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility)) {
    compatibility = {};
    compatibilityValid = false;
  }
  const purposes = compatibility.purposes;
  return {
    compatible: compatibilityValid
      && Boolean(allowedCategories?.has(category))
      && (!Array.isArray(purposes) || purposes.includes('landing')),
    category,
    declared_purposes: Array.isArray(purposes) ? purposes : null,
  };
}

function assertCampaignTemplateCompatible(template, campaignContext) {
  if (!campaignContext) return true;
  if (!template) {
    throw new WebProjectServiceError(
      'campaign_template_required',
      'Una landing vinculada a campaña necesita una plantilla compatible.',
      422
    );
  }
  const contract = campaignTemplateCompatibility(template, campaignContext);
  if (contract.compatible) return true;
  throw new WebProjectServiceError(
    'campaign_template_incompatible',
    'La plantilla no es compatible con el objetivo de esta campaña.',
    422,
    {
      template_id: String(plain(template)?.id || ''),
      template_category: contract.category || null,
      target_kind: campaignContext.target_kind,
      declared_purposes: contract.declared_purposes,
    }
  );
}

function clinicIdsDeclaredByStrategy(rows) {
  const ids = [];
  for (const row of rows) {
    const value = plain(row) || {};
    ids.push(value.clinica_id);
    const scope = strategyPayload(value).scope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) continue;
    ids.push(scope.clinic_id);
    if (Array.isArray(scope.clinic_ids)) ids.push(...scope.clinic_ids);
  }
  return [...new Set(ids.map(positiveInteger).filter(Boolean))];
}

function strategyMatchesScope(rows, scope, scopeClinicIds) {
  const declaredClinicIds = clinicIdsDeclaredByStrategy(rows);
  if (scope.type === 'clinic') {
    if (declaredClinicIds.length !== 1 || declaredClinicIds[0] !== scope.id) return false;
    return rows.every((row) => {
      const payloadScope = strategyPayload(row).scope;
      if (!payloadScope || typeof payloadScope !== 'object' || Array.isArray(payloadScope)) {
        return Number(plain(row)?.clinica_id) === scope.id;
      }
      const assignment = String(payloadScope.assignment_scope || 'clinic').trim().toLowerCase();
      return assignment === 'clinic'
        && Number(payloadScope.clinic_id || plain(row)?.clinica_id) === scope.id;
    });
  }
  const allowed = new Set(scopeClinicIds);
  if (declaredClinicIds.length === 0 || declaredClinicIds.some((id) => !allowed.has(id))) return false;
  return rows.every((row) => {
    const payloadScope = strategyPayload(row).scope;
    return payloadScope
      && typeof payloadScope === 'object'
      && !Array.isArray(payloadScope)
      && String(payloadScope.assignment_scope || '').trim().toLowerCase() === 'group'
      && Number(payloadScope.group_id) === scope.id;
  });
}

function campaignMatchesScope(campaign, scope, inheritedGroupId) {
  const value = plain(campaign) || {};
  const clinicId = positiveInteger(value.clinica_id ?? value.clinicaId);
  const groupId = positiveInteger(value.grupo_clinica_id ?? value.grupoClinicaId);
  if (scope.type === 'clinic') {
    return clinicId === scope.id && (!groupId || groupId === inheritedGroupId);
  }
  return !clinicId && groupId === scope.id;
}

function treatmentMatchesScope(treatment, scope, inheritedGroupId) {
  const value = plain(treatment) || {};
  if (![true, 1, '1'].includes(value.activo)) return false;
  const clinicId = positiveInteger(value.clinica_id ?? value.clinicaId);
  const groupId = positiveInteger(value.grupo_clinica_id ?? value.grupoClinicaId);
  if (scope.type === 'clinic') {
    const hiddenFor = Array.isArray(value.eliminado_por_clinica)
      ? value.eliminado_por_clinica.map(positiveInteger).filter(Boolean)
      : [];
    if (hiddenFor.includes(scope.id)) return false;
    if (clinicId) return clinicId === scope.id;
    if (groupId) return Boolean(inheritedGroupId) && groupId === inheritedGroupId;
    return value.origen === 'sistema';
  }
  if (clinicId) return false;
  if (groupId) return groupId === scope.id;
  return value.origen === 'sistema';
}

async function campaignStrategyRows(strategyId, { models, transaction }) {
  if (!models.CampaignRequest?.findAll) {
    throw new WebProjectServiceError(
      'campaign_context_validation_unavailable',
      'No se puede validar ahora la estrategia de campaña.',
      503
    );
  }
  const lock = transaction?.LOCK?.UPDATE;
  const queryOptions = {
    attributes: ['id', 'clinica_id', 'campaign_id', 'estado', 'solicitud'],
    raw: true,
    transaction,
    ...(lock ? { lock } : {}),
  };
  let rows = await models.CampaignRequest.findAll({
    ...queryOptions,
    where: { campaign_id: strategyId },
  });
  rows = rows.filter((row) => strategyPayload(row).kind === 'marketing_strategy');
  return rows;
}

async function assertCampaignContextResources({ campaignContext, scope, template, models, transaction }) {
  if (!campaignContext) return true;
  assertCampaignTemplateCompatible(template, campaignContext);
  if (!models.Campaign?.findByPk || !models.Tratamiento?.findByPk) {
    throw new WebProjectServiceError(
      'campaign_context_validation_unavailable',
      'No se puede validar ahora la campaña y su tratamiento.',
      503
    );
  }
  const rows = await campaignStrategyRows(campaignContext.strategy_id, { models, transaction });
  if (rows.length === 0) {
    throw new WebProjectServiceError(
      'campaign_strategy_not_found',
      'La estrategia de campaña ya no existe.',
      404
    );
  }
  const scopeClinicIds = await clinicIdsForScope(scope, { models, transaction });
  if (!strategyMatchesScope(rows, scope, scopeClinicIds)) {
    throw new WebProjectServiceError(
      'campaign_strategy_scope_mismatch',
      'La estrategia no pertenece al alcance seleccionado.',
      409
    );
  }
  const campaignIds = [...new Set(rows.map((row) => positiveInteger(plain(row)?.campaign_id)).filter(Boolean))];
  if (campaignIds.length !== 1) {
    throw new WebProjectServiceError(
      'campaign_strategy_campaign_invalid',
      'La estrategia no conserva una campaña canónica.',
      409
    );
  }
  const lock = transaction?.LOCK?.UPDATE;
  const campaign = await models.Campaign.findByPk(campaignIds[0], {
    transaction,
    ...(lock ? { lock } : {}),
  });
  const inheritedGroupId = scope.type === 'clinic'
    ? await groupIdForClinic(scope.id, { models, transaction })
    : null;
  if (!campaign) {
    throw new WebProjectServiceError(
      'campaign_strategy_campaign_not_found',
      'La campaña asociada a la estrategia ya no existe.',
      409
    );
  }
  if (!campaignMatchesScope(campaign, scope, inheritedGroupId)) {
    throw new WebProjectServiceError(
      'campaign_strategy_campaign_scope_mismatch',
      'La campaña asociada no pertenece al alcance seleccionado.',
      409
    );
  }

  const payloads = rows.map(strategyPayload);
  if (campaignContext.target_kind === 'general') {
    if (!payloads.every((payload) => String(payload.promotion_type || '').trim().toLowerCase() === 'generic')) {
      throw new WebProjectServiceError(
        'campaign_target_incompatible',
        'La estrategia no tiene un objetivo general.',
        422
      );
    }
    return true;
  }

  const treatmentId = campaignContext.treatment_id;
  const treatmentBelongsToEveryPayload = payloads.every((payload) => (
    String(payload.promotion_type || '').trim().toLowerCase() !== 'generic'
    && Array.isArray(payload.treatments)
    && payload.treatments.some((item) => positiveInteger(item?.id ?? item?.id_tratamiento) === treatmentId)
  ));
  if (!treatmentBelongsToEveryPayload) {
    throw new WebProjectServiceError(
      'campaign_target_incompatible',
      'El tratamiento no pertenece a la estrategia seleccionada.',
      422
    );
  }
  const treatment = await models.Tratamiento.findByPk(treatmentId, {
    transaction,
    ...(lock ? { lock } : {}),
  });
  if (!treatment || !treatmentMatchesScope(treatment, scope, inheritedGroupId)) {
    throw new WebProjectServiceError(
      'campaign_treatment_unavailable',
      'El tratamiento ya no está activo o no pertenece al alcance seleccionado.',
      409
    );
  }
  return true;
}

async function syncProjectPages({ project, document, actorId, transaction, models = db, templateId = undefined }) {
  const existingPages = await models.WebPage.findAll({
    where: { projectId: project.id },
    transaction,
    paranoid: false,
  });
  const activePages = existingPages.filter((page) => !plain(page).deleted_at);
  const deletedPages = existingPages.filter((page) => Boolean(plain(page).deleted_at));
  const existingByKey = new Map(activePages.map((page) => [String(page.pageKey), page]));

  // WebPage es una proyección reconstruible del WebDocument. Una proyección
  // retirada no debe conservar índices únicos que impidan reutilizar su ruta.
  for (const existing of deletedPages) {
    await existing.destroy({ transaction, force: true });
  }
  for (const existing of activePages) {
    if (!document.pages.some((page) => page.id === String(existing.pageKey))) {
      await existing.destroy({ transaction, force: true });
    }
  }

  // Libera primero las rutas que van a cambiar para permitir swaps atómicos
  // (por ejemplo /equipo <-> /tratamientos) dentro de la misma transacción.
  for (const page of document.pages) {
    const existing = existingByKey.get(page.id);
    if (existing && String(existing.slug) !== page.slug) {
      await existing.update({ slug: `tmp-${crypto.randomUUID()}` }, { transaction, silent: true });
    }
  }

  for (let index = 0; index < document.pages.length; index += 1) {
    const page = document.pages[index];
    const existing = existingByKey.get(page.id);
    const values = {
      title: page.title,
      slug: page.slug,
      position: index,
      seo: page.seo || {},
      status: 'draft',
      updatedByUserId: positiveInteger(actorId),
      ...(templateId === undefined ? {} : { templateId }),
    };
    if (existing) {
      await existing.update({
        ...values,
        version: Number(existing.version || 1) + 1,
      }, { transaction });
    } else {
      await models.WebPage.create({
        id: crypto.randomUUID(),
        projectId: project.id,
        pageKey: page.id,
        parentPageId: null,
        templateId: templateId || null,
        version: 1,
        createdByUserId: positiveInteger(actorId),
        ...values,
      }, { transaction });
    }
  }
}

async function createProject({ actorId, body = {}, requestId = null, models = db, sequelize = db.sequelize } = {}) {
  const scope = normalizeScope(body);
  await assertScopeAccess(actorId, scope, 'marketing.web.edit', { models });
  const name = String(body.name || '').trim();
  const purpose = String(body.purpose || 'landing').trim().toLowerCase();
  const locale = String(body.locale || 'es-ES').trim();
  const campaignContext = normalizeCampaignContext(body.campaign_context ?? body.campaignContext);
  if (!name || name.length > 191) {
    throw new WebProjectServiceError('invalid_project_name', 'El nombre debe tener entre 1 y 191 caracteres.');
  }
  if (!PROJECT_PURPOSES.has(purpose)) {
    throw new WebProjectServiceError('invalid_project_purpose', 'El tipo de proyecto no es válido.');
  }
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) {
    throw new WebProjectServiceError('invalid_project_locale', 'El idioma debe usar un locale válido, por ejemplo es-ES.');
  }
  if (campaignContext && purpose !== 'landing') {
    throw new WebProjectServiceError(
      'campaign_context_requires_landing',
      'Solo una landing puede vincularse a una estrategia de campana.',
      422
    );
  }

  return sequelize.transaction(async (transaction) => {
    const template = await resolveTemplate(body.template_id, scope, actorId, transaction, models);
    await assertCampaignContextResources({
      campaignContext,
      scope,
      template,
      models,
      transaction,
    });
    const instantiatedDocument = template
      ? instantiateWebDocument(plain(template).document)
      : createBlankWebDocument({ name, locale });
    const siteDefaults = await resolveWebProjectSiteDefaults(scope, { models, transaction });
    const document = applyWebProjectSiteDefaults(instantiatedDocument, siteDefaults);
    const integrity = assertValidWebDocument(document);
    const projectId = crypto.randomUUID();
    const project = await models.WebProject.create({
      id: projectId,
      ...scopeColumns(scope),
      ownerUserId: positiveInteger(actorId),
      name,
      purpose,
      locale,
      status: 'draft',
      campaignContext,
      version: 1,
      createdByUserId: positiveInteger(actorId),
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });

    await models.WebPage.bulkCreate(document.pages.map((page, index) => ({
      id: crypto.randomUUID(),
      projectId,
      // pageKey enlaza la proyección con pages[]. El PK técnico nunca se
      // comparte entre proyectos aunque se importen IDs estructurales iguales.
      pageKey: page.id,
      title: page.title,
      slug: page.slug,
      parentPageId: null,
      templateId: template?.id || null,
      position: index,
      seo: page.seo || {},
      status: 'draft',
      version: 1,
      createdByUserId: positiveInteger(actorId),
      updatedByUserId: positiveInteger(actorId),
    })), { transaction });

    const draft = await models.WebDraft.create({
      id: crypto.randomUUID(),
      projectId,
      baseRevisionId: null,
      schemaVersion: 1,
      document,
      documentHash: integrity.hash,
      lockVersion: 1,
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });

    await models.WebAuditEvent.create({
      projectId,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: 'web.project.created',
      entityType: 'web_project',
      entityId: projectId,
      requestId,
      previousHash: null,
      nextHash: integrity.hash,
      metadata: {
        purpose,
        locale,
        template_id: template?.id || null,
        campaign_context: campaignContext,
      },
    }, { transaction });

    project.setDataValue('pages', document.pages.map((page) => ({ id: page.id })));
    project.setDataValue('draft', draft);
    return serializeProject(project, { pageCount: document.pages.length, draft });
  });
}

async function getProject({ actorId, projectId, models = db, env = process.env } = {}) {
  const project = await getProjectOrThrow(projectId, {
    models,
    include: [
      { model: models.WebPage, as: 'pages', required: false },
      { model: models.WebDraft, as: 'draft', attributes: ['id', 'lockVersion', 'documentHash', 'baseRevisionId', 'updated_at'], required: false },
    ],
  });
  const scope = await assertProjectAccess(actorId, project, 'marketing.web.view', { models });
  const publishingCapabilities = webPublishingCapabilities(scope, env);
  const latestRevision = await models.WebRevision.findOne({
    where: { projectId: project.id },
    order: [['revisionNumber', 'DESC']],
  });
  return {
    ...serializeProject(project, { latestRevision, publishingCapabilities }),
    scope: { type: scope.type, id: scope.id },
    pages: (plain(project).pages || []).map((page) => ({
      id: page.id,
      page_key: page.pageKey,
      title: page.title,
      slug: page.slug,
      position: page.position,
      status: page.status,
      version: page.version,
      seo: page.seo || {},
    })),
  };
}

async function getDraft({ actorId, projectId, models = db } = {}) {
  const project = await getProjectOrThrow(projectId, { models });
  const scope = await assertProjectAccess(actorId, project, 'marketing.web.view', { models });
  const draft = await models.WebDraft.findOne({ where: { projectId: project.id } });
  if (!draft) {
    throw new WebProjectServiceError('draft_not_found', 'El proyecto todavía no tiene borrador.', 404);
  }
  const row = plain(draft);
  return {
    id: row.id,
    project_id: row.projectId,
    base_revision_id: row.baseRevisionId || null,
    schema_version: row.schemaVersion,
    document: row.document,
    document_hash: row.documentHash,
    lock_version: row.lockVersion,
    updated_at: row.updated_at,
    site_defaults: await resolveWebProjectSiteDefaults(scope, { models }),
  };
}

async function updateProject({ actorId, projectId, body = {}, requestId = null, models = db, sequelize = db.sequelize } = {}) {
  const expectedVersion = positiveInteger(body.version ?? body.expected_version);
  if (!expectedVersion) {
    throw new WebProjectServiceError('project_version_required', 'version es obligatorio para actualizar.', 428);
  }

  return sequelize.transaction(async (transaction) => {
    const project = await getProjectOrThrow(projectId, {
      models,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const scope = await assertProjectAccess(actorId, project, 'marketing.web.edit', { models, transaction });
    if (Number(project.version) !== expectedVersion) {
      throw new WebProjectServiceError(
        'project_conflict',
        'El proyecto cambió en otra sesión. Recarga antes de editarlo.',
        409,
        { expected_version: expectedVersion, current_version: Number(project.version) }
      );
    }

    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name || name.length > 191) {
        throw new WebProjectServiceError('invalid_project_name', 'El nombre debe tener entre 1 y 191 caracteres.');
      }
      patch.name = name;
    }
    if (body.locale !== undefined) {
      const locale = String(body.locale || '').trim();
      if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) {
        throw new WebProjectServiceError('invalid_project_locale', 'El idioma no es válido.');
      }
      patch.locale = locale;
    }
    if (body.purpose !== undefined) {
      const purpose = String(body.purpose || '').trim().toLowerCase();
      if (!PROJECT_PURPOSES.has(purpose)) {
        throw new WebProjectServiceError('invalid_project_purpose', 'El tipo de proyecto no es válido.');
      }
      patch.purpose = purpose;
    }
    if (body.status !== undefined) {
      const status = String(body.status || '').trim().toLowerCase();
      if (!['draft', 'archived'].includes(status)) {
        throw new WebProjectServiceError(
          'invalid_project_status_transition',
          'El estado active solo puede establecerlo el flujo de publicación.'
        );
      }
      patch.status = status;
    }
    if (Object.keys(patch).length === 0) {
      throw new WebProjectServiceError('empty_project_patch', 'No hay cambios válidos que guardar.');
    }

    const previousVersion = Number(project.version);
    await project.update({
      ...patch,
      version: previousVersion + 1,
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });
    await models.WebAuditEvent.create({
      projectId: project.id,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: 'web.project.updated',
      entityType: 'web_project',
      entityId: project.id,
      requestId,
      metadata: { fields: Object.keys(patch), previous_version: previousVersion, next_version: previousVersion + 1 },
    }, { transaction });
    return serializeProject(project);
  });
}

async function saveDraft({ actorId, projectId, body = {}, requestId = null, models = db, sequelize = db.sequelize } = {}) {
  const expectedLockVersion = positiveInteger(body.lock_version ?? body.expected_lock_version);
  if (!expectedLockVersion) {
    throw new WebProjectServiceError('lock_version_required', 'lock_version es obligatorio para guardar.', 428);
  }
  const integrity = assertValidWebDocument(body.document);

  return sequelize.transaction(async (transaction) => {
    const project = await getProjectOrThrow(projectId, {
      models,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const scope = await assertProjectAccess(actorId, project, 'marketing.web.edit', { models, transaction });
    const draft = await models.WebDraft.findOne({
      where: { projectId: project.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!draft) {
      throw new WebProjectServiceError('draft_not_found', 'El proyecto todavía no tiene borrador.', 404);
    }
    if (Number(draft.lockVersion) !== expectedLockVersion) {
      throw new WebProjectServiceError(
        'draft_conflict',
        'El borrador cambió en otra sesión. Recarga antes de volver a guardar.',
        409,
        { expected_lock_version: expectedLockVersion, current_lock_version: Number(draft.lockVersion) }
      );
    }

    const previousHash = draft.documentHash;
    draft.document = body.document;
    draft.documentHash = integrity.hash;
    draft.schemaVersion = 1;
    draft.updatedByUserId = positiveInteger(actorId);
    await draft.save({ transaction });
    await syncProjectPages({
      project,
      document: body.document,
      actorId,
      transaction,
      models,
    });
    await project.update({
      version: Number(project.version) + 1,
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });

    await models.WebAuditEvent.create({
      projectId: project.id,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: 'web.draft.saved',
      entityType: 'web_draft',
      entityId: draft.id,
      requestId,
      previousHash,
      nextHash: integrity.hash,
      metadata: { lock_version: draft.lockVersion },
    }, { transaction });

    return {
      id: draft.id,
      project_id: project.id,
      project_version: Number(project.version),
      document_hash: integrity.hash,
      lock_version: draft.lockVersion,
      updated_at: draft.updated_at,
    };
  });
}

async function createRevision({ actorId, projectId, body = {}, requestId = null, models = db, sequelize = db.sequelize } = {}) {
  const expectedLockVersion = positiveInteger(body.lock_version ?? body.expected_lock_version);
  if (!expectedLockVersion) {
    throw new WebProjectServiceError('lock_version_required', 'lock_version es obligatorio para crear una revisión.', 428);
  }
  if (
    body.content_snapshot !== undefined
    && (
      !body.content_snapshot
      || typeof body.content_snapshot !== 'object'
      || Array.isArray(body.content_snapshot)
      || Object.keys(body.content_snapshot).length > 0
    )
  ) {
    throw new WebProjectServiceError(
      'content_snapshot_not_supported',
      'El snapshot editorial se habilitará con el contrato tipado del CMS; no se admite contenido libre.',
      422
    );
  }
  return sequelize.transaction(async (transaction) => {
    const project = await getProjectOrThrow(projectId, {
      models,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const scope = await assertProjectAccess(actorId, project, 'marketing.web.edit', { models, transaction });
    const draft = await models.WebDraft.findOne({
      where: { projectId: project.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!draft) {
      throw new WebProjectServiceError('draft_not_found', 'El proyecto todavía no tiene borrador.', 404);
    }
    if (Number(draft.lockVersion) !== expectedLockVersion) {
      throw new WebProjectServiceError(
        'draft_conflict',
        'El borrador cambió antes de crear la revisión.',
        409,
        { expected_lock_version: expectedLockVersion, current_lock_version: Number(draft.lockVersion) }
      );
    }
    const lastRevision = await models.WebRevision.findOne({
      where: { projectId: project.id },
      order: [['revisionNumber', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const revisionNumber = Number(lastRevision?.revisionNumber || 0) + 1;
    const revision = await models.WebRevision.create({
      id: crypto.randomUUID(),
      projectId: project.id,
      revisionNumber,
      schemaVersion: draft.schemaVersion,
      document: draft.document,
      documentHash: draft.documentHash,
      contentSnapshot: {},
      status: 'draft',
      createdByUserId: positiveInteger(actorId),
    }, { transaction });
    draft.baseRevisionId = revision.id;
    await draft.save({ transaction });
    await models.WebAuditEvent.create({
      projectId: project.id,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: 'web.revision.created',
      entityType: 'web_revision',
      entityId: revision.id,
      requestId,
      previousHash: null,
      nextHash: draft.documentHash,
      metadata: { revision_number: revisionNumber, lock_version: draft.lockVersion },
    }, { transaction });
    return {
      revision: serializeRevision(revision),
      draft: {
        id: draft.id,
        lock_version: Number(draft.lockVersion),
        base_revision_id: revision.id,
        updated_at: draft.updated_at,
      },
    };
  });
}

async function listRevisions({ actorId, projectId, query = {}, models = db } = {}) {
  const project = await getProjectOrThrow(projectId, { models });
  await assertProjectAccess(actorId, project, 'marketing.web.view', { models });
  const page = boundedInteger(query.page, 1, MAX_PAGE_NUMBER);
  const limit = boundedInteger(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const result = await models.WebRevision.findAndCountAll({
    where: { projectId: project.id },
    order: [['revisionNumber', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  const total = Number(result.count || 0);
  return {
    items: (result.rows || []).map(serializeRevision),
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

function revisionFeatureForAction(action) {
  return action === 'submit' ? 'marketing.web.edit' : 'marketing.web.review';
}

async function transitionRevision({ actorId, revisionId, action, requestId = null, models = db, sequelize = db.sequelize } = {}) {
  const targetAction = String(action || '').trim().toLowerCase();
  if (!['submit', 'approve'].includes(targetAction)) {
    throw new WebProjectServiceError('invalid_revision_action', 'La transición de revisión no es válida.');
  }
  return sequelize.transaction(async (transaction) => {
    // Todas las escrituras que abarcan proyecto/revisión adquieren locks en el
    // mismo orden. La primera lectura solo obtiene el project_id; no bloquea.
    const revisionPointer = await models.WebRevision.findByPk(String(revisionId || ''), {
      attributes: ['id', 'projectId'],
      transaction,
    });
    if (!revisionPointer) {
      throw new WebProjectServiceError('revision_not_found', 'La revisión no existe.', 404);
    }
    const project = await getProjectOrThrow(revisionPointer.projectId, {
      models,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const revision = await models.WebRevision.findByPk(String(revisionId || ''), {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!revision || String(revision.projectId) !== String(project.id)) {
      throw new WebProjectServiceError(
        'revision_project_conflict',
        'La revisión cambió mientras se preparaba la transición.',
        409
      );
    }
    let scope;
    try {
      scope = await assertProjectAccess(
        actorId,
        project,
        revisionFeatureForAction(targetAction),
        { models, transaction }
      );
    } catch (error) {
      if (error?.code === 'project_not_found' && Number(error?.status) === 404) {
        throw new WebProjectServiceError('revision_not_found', 'La revisión no existe.', 404);
      }
      throw error;
    }
    const previousStatus = revision.status;
    let resolution = null;
    if (targetAction === 'submit') {
      if (!['draft', 'failed'].includes(previousStatus)) {
        throw new WebProjectServiceError('invalid_revision_transition', 'Solo una revisión en borrador puede enviarse a revisión.', 409);
      }
      revision.status = 'review';
      revision.submittedByUserId = positiveInteger(actorId);
      revision.submittedAt = new Date();
    } else {
      if (previousStatus !== 'review') {
        throw new WebProjectServiceError('invalid_revision_transition', 'Solo una revisión pendiente puede aprobarse.', 409);
      }
      resolution = await resolveWebDocumentResources({
        document: revision.document,
        scope,
        models,
        transaction,
        // Seleccionar un UUID grupal en el documento es la acción explícita de
        // herencia. Un proyecto de grupo nunca hereda recursos de clínicas.
        allowGroupInheritance: true,
      });
      assertRevisionReadyForApproval(revision.document, scope, {
        unresolvedReferences: resolution.unresolved,
      });
      await models.WebRevision.update(
        { status: 'superseded' },
        {
          where: {
            projectId: project.id,
            status: 'approved',
            id: { [Op.ne]: revision.id },
          },
          transaction,
          individualHooks: true,
        }
      );
      revision.status = 'approved';
      revision.contentSnapshot = resolution.snapshot;
      revision.approvedByUserId = positiveInteger(actorId);
      revision.approvedAt = new Date();
    }
    await revision.save({
      transaction,
      ...(targetAction === 'approve' ? { webContentSnapshotFreeze: true } : {}),
    });
    await models.WebAuditEvent.create({
      projectId: project.id,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: `web.revision.${targetAction === 'submit' ? 'submitted' : 'approved'}`,
      entityType: 'web_revision',
      entityId: revision.id,
      requestId,
      previousHash: revision.documentHash,
      nextHash: revision.documentHash,
      metadata: {
        previous_status: previousStatus,
        next_status: revision.status,
        ...(resolution ? {
          resolved_reference_count: resolution.resolved.length,
          unresolved_reference_count: resolution.unresolved.length,
          content_entry_count: Object.keys(resolution.snapshot.content_entries).length,
          media_asset_count: Object.keys(resolution.snapshot.media_assets).length,
        } : {}),
      },
    }, { transaction });
    return {
      ...serializeRevision(revision),
      ...(resolution ? {
        resolved_references: resolution.resolved,
        unresolved_references: resolution.unresolved,
      } : {}),
    };
  });
}

async function listTemplates({ actorId, query = {}, models = db } = {}) {
  const scope = normalizeScope(query);
  await assertScopeAccess(actorId, scope, 'marketing.web.view', { models });
  const includePreview = booleanQueryFlag(query.include_preview, 'include_preview');
  const category = String(query.category || '').trim().toLowerCase();
  if (category && !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(category)) {
    throw new WebProjectServiceError('invalid_template_category', 'La categoría de plantilla no es válida.');
  }
  const page = boundedInteger(query.page, 1, MAX_PAGE_NUMBER);
  const limit = boundedInteger(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const inheritedGroupId = scope.type === 'clinic'
    ? await groupIdForClinic(scope.id, { models })
    : null;
  const sequelize = models.sequelize || db.sequelize;
  if (!sequelize?.query) {
    throw new WebProjectServiceError(
      'template_catalog_unavailable',
      'El catálogo de plantillas no está disponible.',
      503
    );
  }
  const replacements = {
    scopeId: scope.id,
    inheritedGroupId: inheritedGroupId || 0,
    category,
    limit,
    offset: (page - 1) * limit,
  };
  const scopePredicate = scope.type === 'clinic'
    ? `(
        (scope_type = 'clinic' AND clinica_id = :scopeId)
        OR (scope_type = 'group' AND grupo_clinica_id = :inheritedGroupId AND :inheritedGroupId > 0)
        OR (scope_type = 'global' AND is_public = 1)
      )`
    : `(
        (scope_type = 'group' AND grupo_clinica_id = :scopeId)
        OR (scope_type = 'global' AND is_public = 1)
      )`;
  const priorityExpression = scope.type === 'clinic'
    ? `CASE
        WHEN scope_type = 'clinic' AND clinica_id = :scopeId THEN 3
        WHEN scope_type = 'group' AND grupo_clinica_id = :inheritedGroupId THEN 2
        ELSE 1
      END`
    : `CASE WHEN scope_type = 'group' AND grupo_clinica_id = :scopeId THEN 2 ELSE 1 END`;
  const rankedSql = `
    SELECT
      id, catalog_key, name, description, category, version,
      preview_asset_id, compatibility, scope_type, clinica_id,
      grupo_clinica_id, is_public, status, created_at, updated_at,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_key, version
        ORDER BY ${priorityExpression} DESC, id ASC
      ) AS scope_rank
    FROM WebTemplates
    WHERE status = 'active'
      AND deleted_at IS NULL
      AND ${scopePredicate}
      ${category ? 'AND category = :category' : ''}
  `;
  const rows = await sequelize.query(`
    WITH ranked_templates AS (${rankedSql})
    SELECT id, catalog_key, name, description, category, version,
           preview_asset_id, compatibility, scope_type, clinica_id,
           grupo_clinica_id, is_public, status, created_at, updated_at
    FROM ranked_templates
    WHERE scope_rank = 1
    ORDER BY category ASC, name ASC, version DESC, id ASC
    LIMIT :limit OFFSET :offset
  `, { replacements, type: QueryTypes.SELECT });
  const countRows = await sequelize.query(`
    WITH ranked_templates AS (${rankedSql})
    SELECT COUNT(*) AS total FROM ranked_templates WHERE scope_rank = 1
  `, { replacements, type: QueryTypes.SELECT });
  const previewById = new Map();
  if (includePreview && rows.length > 0) {
    const previewRows = await sequelize.query(`
      SELECT id, document, document_hash
      FROM WebTemplates
      WHERE id IN (:previewTemplateIds)
        AND status = 'active'
        AND deleted_at IS NULL
        AND ${scopePredicate}
        ${category ? 'AND category = :category' : ''}
    `, {
      replacements: { ...replacements, previewTemplateIds: rows.map((row) => row.id) },
      type: QueryTypes.SELECT,
    });
    for (const preview of previewRows) previewById.set(String(preview.id), preview);
  }
  const items = rows.map((template) => {
    const sourceScope = String(template.scope_type || '').trim().toLowerCase();
    const sourceScopeId = sourceScope === 'clinic'
      ? Number(template.clinica_id)
      : sourceScope === 'group'
        ? Number(template.grupo_clinica_id)
        : null;
    const item = {
      id: template.id,
      catalog_key: template.catalog_key,
      name: template.name,
      description: template.description || null,
      category: template.category,
      version: Number(template.version),
      preview_asset_id: template.preview_asset_id || null,
      compatibility: typeof template.compatibility === 'string'
        ? JSON.parse(template.compatibility || '{}')
        : (template.compatibility || {}),
      source_scope: sourceScope,
      source_scope_id: Number.isSafeInteger(sourceScopeId) && sourceScopeId > 0 ? sourceScopeId : null,
      is_public: template.is_public === true || Number(template.is_public) === 1,
      managed_by_scope: sourceScope === scope.type && sourceScopeId === scope.id,
      status: template.status,
      created_at: template.created_at,
      updated_at: template.updated_at,
    };
    if (includePreview) {
      const preview = previewById.get(String(template.id));
      item.preview_document = validatedPreviewDocument(preview?.document, template.id, preview?.document_hash);
    }
    return item;
  });
  const total = Number(countRows[0]?.total || 0);
  return {
    items,
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

function normalizeTemplateMetadata(body = {}, { partial = false } = {}) {
  const result = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 191) {
      throw new WebProjectServiceError('invalid_template_name', 'El nombre debe tener entre 1 y 191 caracteres.', 422);
    }
    result.name = name;
  }
  if (!partial || body.description !== undefined) {
    const description = body.description == null ? null : String(body.description).trim();
    if (description && description.length > 5000) {
      throw new WebProjectServiceError('invalid_template_description', 'La descripción no puede superar 5.000 caracteres.', 422);
    }
    result.description = description || null;
  }
  if (!partial || body.category !== undefined) {
    const category = String(body.category || 'custom').trim().toLowerCase();
    if (!TEMPLATE_CATEGORIES.has(category)) {
      throw new WebProjectServiceError('invalid_template_category', 'La categoría de plantilla no es válida.', 422);
    }
    result.category = category;
  }
  return result;
}

function templateScope(row) {
  const template = plain(row);
  if (template.scopeType === 'clinic') return { type: 'clinic', id: Number(template.clinicaId) };
  if (template.scopeType === 'group') return { type: 'group', id: Number(template.grupoClinicaId) };
  throw new WebProjectServiceError('template_forbidden', 'Las plantillas globales se administran desde el catálogo interno.', 403);
}

function customTemplateCatalogKey(name) {
  const slug = String(name || 'plantilla')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'plantilla';
  return `custom-${slug}-${crypto.randomBytes(4).toString('hex')}`;
}

function serializeManagedTemplate(row) {
  const template = plain(row);
  return {
    id: template.id,
    scope_type: template.scopeType,
    scope_id: Number(template.scopeType === 'clinic' ? template.clinicaId : template.grupoClinicaId),
    catalog_key: template.catalogKey,
    name: template.name,
    description: template.description || null,
    category: template.category,
    version: Number(template.version),
    status: template.status,
    is_public: Boolean(template.isPublic),
    document_hash: template.documentHash,
    created_at: template.created_at,
    updated_at: template.updated_at,
  };
}

async function createTemplateFromProject({ actorId, projectId, body = {}, requestId = null, models = db, sequelize = db.sequelize, assertFeatureAccess } = {}) {
  const project = await getProjectOrThrow(projectId, { models });
  const scope = await assertProjectAccess(actorId, project, 'marketing.web.templates.manage', { models, assertFeatureAccess });
  const metadata = normalizeTemplateMetadata(body);
  return sequelize.transaction(async (transaction) => {
    const lockedProject = await getProjectOrThrow(projectId, { models, transaction, lock: transaction.LOCK.UPDATE });
    await assertProjectAccess(actorId, lockedProject, 'marketing.web.templates.manage', { models, transaction, assertFeatureAccess });
    const draft = await models.WebDraft.findOne({ where: { projectId: lockedProject.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!draft) throw new WebProjectServiceError('draft_not_found', 'El proyecto no tiene un borrador que guardar como plantilla.', 404);
    const integrity = assertValidWebDocument(plain(draft).document);
    const template = await models.WebTemplate.create({
      id: crypto.randomUUID(),
      ...scopeColumns(scope),
      catalogKey: customTemplateCatalogKey(metadata.name),
      ...metadata,
      document: JSON.parse(JSON.stringify(plain(draft).document)),
      documentHash: integrity.hash,
      schemaVersion: 1,
      version: 1,
      compatibility: { purposes: ['landing', 'microsite', 'website'], locale: plain(lockedProject).locale },
      previewAssetId: null,
      isPublic: false,
      status: 'active',
      createdByUserId: positiveInteger(actorId),
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });
    await models.WebAuditEvent.create({
      projectId: lockedProject.id,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: 'web.template.created',
      entityType: 'web_template',
      entityId: template.id,
      requestId,
      previousHash: null,
      nextHash: integrity.hash,
      metadata: { catalog_key: template.catalogKey, name: metadata.name, category: metadata.category },
    }, { transaction });
    return serializeManagedTemplate(template);
  });
}

async function updateTemplate({ actorId, templateId, body = {}, requestId = null, models = db, sequelize = db.sequelize, assertFeatureAccess } = {}) {
  const metadata = normalizeTemplateMetadata(body, { partial: true });
  if (Object.keys(metadata).length === 0) {
    throw new WebProjectServiceError('empty_template_patch', 'Indica algún dato de la plantilla que quieras cambiar.', 422);
  }
  return sequelize.transaction(async (transaction) => {
    const template = await models.WebTemplate.findByPk(String(templateId || ''), { transaction, lock: transaction.LOCK.UPDATE });
    if (!template) throw new WebProjectServiceError('template_not_found', 'La plantilla no existe.', 404);
    const scope = templateScope(template);
    await assertScopeAccess(actorId, scope, 'marketing.web.templates.manage', { models, transaction, assertFeatureAccess });
    const previous = serializeManagedTemplate(template);
    await template.update({ ...metadata, updatedByUserId: positiveInteger(actorId) }, { transaction });
    await models.WebAuditEvent.create({
      projectId: null,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: 'web.template.updated',
      entityType: 'web_template',
      entityId: template.id,
      requestId,
      previousHash: template.documentHash,
      nextHash: template.documentHash,
      metadata: { previous: { name: previous.name, description: previous.description, category: previous.category } },
    }, { transaction });
    return serializeManagedTemplate(template);
  });
}

async function archiveTemplate({ actorId, templateId, requestId = null, models = db, sequelize = db.sequelize, assertFeatureAccess } = {}) {
  return sequelize.transaction(async (transaction) => {
    const template = await models.WebTemplate.findByPk(String(templateId || ''), { transaction, lock: transaction.LOCK.UPDATE });
    if (!template) throw new WebProjectServiceError('template_not_found', 'La plantilla no existe.', 404);
    const scope = templateScope(template);
    await assertScopeAccess(actorId, scope, 'marketing.web.templates.manage', { models, transaction, assertFeatureAccess });
    if (template.status !== 'archived') {
      await template.update({ status: 'archived', updatedByUserId: positiveInteger(actorId) }, { transaction });
      await models.WebAuditEvent.create({
        projectId: null,
        ...scopeColumns(scope),
        actorUserId: positiveInteger(actorId),
        eventType: 'web.template.archived',
        entityType: 'web_template',
        entityId: template.id,
        requestId,
        previousHash: template.documentHash,
        nextHash: template.documentHash,
        metadata: {},
      }, { transaction });
    }
    return serializeManagedTemplate(template);
  });
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  WebProjectServiceError,
  assertProjectAccess,
  assertScopeAccess,
  assertRevisionReadyForApproval,
  clinicIdsForScope,
  collectExternalDocumentReferences,
  createBlankWebDocument,
  createProject,
  createTemplateFromProject,
  createRevision,
  getDraft,
  getProject,
  getProjectOrThrow,
  groupIdForClinic,
  intakeConfigForWebScope,
  instantiateWebDocument,
  listRevisions,
  listProjects,
  listTemplates,
  normalizeScope,
  normalizeCampaignContext,
  positiveInteger,
  resolveWebProjectSiteDefaults,
  siteDefaultsFromIntake,
  applyWebProjectSiteDefaults,
  assertCampaignContextResources,
  assertCampaignTemplateCompatible,
  campaignTemplateCompatibility,
  revisionFeatureForAction,
  saveDraft,
  scopeColumns,
  scopeFromProject,
  serializeProject,
  syncProjectPages,
  transitionRevision,
  updateProject,
  updateTemplate,
  archiveTemplate,
};
