const crypto = require('crypto');
const axios = require('axios');
const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op, literal } = db.Sequelize;

const LeadIntake = db.LeadIntake;
const LeadAttributionAudit = db.LeadAttributionAudit;
const LeadContactAttempt = db.LeadContactAttempt;
const FormSubmissionEvent = db.FormSubmissionEvent;
const Conversation = db.Conversation;
const Message = db.Message;
const Usuario = db.Usuario;
const Clinica = db.Clinica;
const GrupoClinica = db.GrupoClinica;
const Paciente = db.Paciente;
const PacienteClinica = db.PacienteClinica;
const CitaPaciente = db.CitaPaciente;
const Campana = db.Campana;
const AdCache = db.AdCache;
const ClinicMetaAsset = db.ClinicMetaAsset;
const MetaConnection = db.MetaConnection;
const ClinicGoogleAdsAccount = db.ClinicGoogleAdsAccount;
const IntakeConfig = db.IntakeConfig;
const ExternalCampaignInventory = db.ExternalCampaignInventory;
const ChatFlowTemplate = db.ChatFlowTemplate;
const ClinicaHorario = db.ClinicaHorario;
const WhatsAppWebOrigin = db.WhatsAppWebOrigin;
const { enqueueInboundFormSubmissionResume } = require('../services/automationsV2Resume.service');
const { sendMetaEvent, buildUserData: buildMetaUserData } = require('../services/metaCapi.service');
const {
  maybeUploadGoogleConversion,
  normalizeGoogleConsent,
} = require('../services/googleAdsConversionUpload.service');
const webEventsService = require('../services/webEvents.service');
const { getIO } = require('../services/socket.service');
const jobRequestsService = require('../services/jobRequests.service');
const leadAutoReplyService = require('../services/leadAutoReply.service');
const {
  enqueueGoogleDataManagerControlPlaneReconciliation,
} = require('../services/googleDataManagerDiagnosticsEnqueue.service');
const { previewLeadImport, executeLeadImport } = require('../services/leadImport.service');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');
const { normalizePhoneDigits } = require('../lib/phone');
const { normalizeConfiguredLocations } = require('../lib/intake-public-locations');
const { resolveChatStateClinicSelection } = require('../lib/intakeChatLocation');
const {
  extractClinicLabelHint,
  resolveConfiguredFormClinicLocation,
} = require('../lib/intakeFormClinicLocation');
const {
  isQuickChatSummaryRequest,
  validateQuickChatContact,
} = require('../services/intakeQuickChatSummary.service');
const {
  isCompletedChatbotLeadRequest,
  persistLeadAuditAndQuickChatOutbox,
  persistExistingLeadAuditAndQuickChatOutbox,
  triggerIntakeQuickChatSummaryFastPath,
} = require('../services/intakeQuickChatOutbox.service');
const { buildClinicMatcher } = require('../lib/clinicAttribution');
const {
  getAccessibleMarketingClinicIds,
  hasMarketingClinicScopeAccess,
} = require('../lib/marketingScopeAccess');
const { isGlobalAdmin } = require('../lib/role-helpers');
const {
  canUserAccessFeature,
} = require('../lib/access-policy');
const { resolveSafeHttpTarget } = require('../lib/safeHttpTarget');
const {
  configuredLocationsWithinAllowedScope,
  parseIntakeId,
  resolveIntakeLocationVisibility,
} = require('../lib/intakeLocations');
const { detectLegacyJoinChat } = require('../lib/intake-legacy-chat');
const { inspectSnippetRuntime } = require('../lib/intake-snippet-runtime');
const {
  buildVerificationConfigHash,
  canonicalizeIntakeDomain,
  canonicalizeIntakeDomains,
  cookieNoticeProviderMatches,
  issueVerificationAttestation,
  verifyPersistedVerificationAttestation,
  verifyVerificationAttestation,
} = require('../lib/intake-verification-attestation');
const {
  configuredClinicIds,
  matchClinicByPageUrl,
} = require('../lib/intake-page-clinic');
const { matchClinicByContactPhone } = require('../lib/intake-clinic-phone-routing');
const {
  resolveGoogleAdsCampaignId,
  resolveGoogleLeadRoute,
} = require('../lib/google-lead-routing');
const { deriveLeadConsentMetadata } = require('../lib/intake-lead-consent');
const {
  extractGoogleTagId,
  normalizeMetaAdsConfig,
  normalizeGoogleAdsConfig: normalizeEffectiveGoogleAdsConfig,
  resolveEffectiveTrackingConfig
} = require('../services/effectiveMarketingAssets.service');
const {
  mergeIntakeConfigForEditorWrite,
} = require('../lib/intake-config-write-merge');
const {
  buildMarketingOriginWhere,
  buildLeadCreatedDescription,
  buildLeadAttributionView,
} = require('../lib/lead-attribution-view');
const {
  ensureQualifiedLeadConversion,
  maybeUploadQualifiedLeadStatusTransition,
  uploadScheduleForLinkedAppointment,
} = require('../services/leadQualificationMilestone.service');
const {
  getPendingReplyStatesByConversationIds,
} = require('../services/conversationPendingReply.service');
const {
  buildWebLandingAttributionSteps,
  resolveWebLandingAttribution,
} = require('../services/webLandingAttribution.service');
const {
  runtimeConfigFromArtifactHeader,
} = require('../services/webArtifactRuntimeHeader.service');
const {
  resolveEffectivePublicIntakeRecords,
} = require('../services/webEffectiveIntakeConfig.service');
const {
  authenticatePublicIntakeRequest,
  createMetaSignatureValidator,
  pickMatchingIntakeConfig,
} = require('../lib/intakePublicAuthentication');

const CHANNELS = new Set(['paid', 'organic', 'unknown']);
const SOURCES = new Set(['meta_ads', 'google_ads', 'web', 'whatsapp', 'call_click', 'tiktok_ads', 'seo', 'direct', 'local_services']);
const STATUSES = new Set(['nuevo', 'contactado', 'esperando_info', 'info_recibida', 'cualificado', 'citado', 'acudio_cita', 'convertido', 'descartado']);
const DEDUPE_WINDOW_HOURS = parseInt(process.env.INTAKE_DEDUPE_WINDOW_HOURS || '24', 10);
const LEAD_ACTIVE_APPOINTMENT_STATES = new Set([
  'pendiente',
  'info_enviada',
  'info_confirmada',
  'recordatorio_enviado',
  'recordatorio_confirmado',
  'reprogramada',
]);

const SIGNATURE_HEADER = 'x-cc-signature';
const SIGNATURE_HEADER_SHA = 'x-cc-signature-sha256';
const EVENT_ID_HEADER = 'x-cc-event-id';
const parseInteger = parseIntakeId;
const withRuntimeTransitionHmacs = async (config) => {
  if (!config) return null;
  const value = config.get ? config.get({ plain: true }) : config;
  const candidates = await require('../services/webIntakeRuntimeReconciliation.service')
    .authenticationCandidatesForConfig(value, { models: db });
  return { ...value, runtime_transition_candidates: candidates };
};
const requireIntakeConfigScopeAccess = async (req, res, { clinicId = null, groupId = null, access = 'read' } = {}) => {
  const userId = Number.parseInt(String(req.userData?.userId || ''), 10);
  let clinicIds = [];

  if (clinicId !== null) {
    clinicIds.push(clinicId);
  }
  if (groupId !== null) {
    const rows = await Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica'],
      raw: true,
    });
    clinicIds.push(...rows.map((row) => row.id_clinica).filter(Boolean));
  }

  const allowed = await hasMarketingClinicScopeAccess({ userId, clinicIds, access });
  if (allowed) return true;
  res.status(403).json({ success: false, error: 'scope_forbidden' });
  return false;
};

const requireLeadAutomationClinicAccess = async (req, res, clinicId) => {
  if (!(await requireIntakeConfigScopeAccess(req, res, { clinicId, access: 'write' }))) return false;
  const actorId = parseInteger(req.userData?.userId);
  if (isGlobalAdmin(actorId)) return true;
  const allowed = actorId !== null && await canUserAccessFeature({
    actorId,
    featureKey: 'leads.manage',
    clinicId,
  }).catch(() => false);
  if (allowed) return true;
  res.status(403).json({ success: false, error: 'lead_manage_forbidden' });
  return false;
};

const resolveIntakeCandidateClinicIds = async ({ clinicId = null, groupId = null } = {}) => {
  if (groupId !== null) {
    const rows = await Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica'],
      raw: true,
    });
    return rows.map((row) => row.id_clinica).filter(Boolean);
  }

  if (clinicId === null) return [];
  const clinic = await Clinica.findOne({
    where: { id_clinica: clinicId },
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
  });
  if (!clinic?.grupoClinicaId) return [clinicId];

  const rows = await Clinica.findAll({
    where: { grupoClinicaId: clinic.grupoClinicaId },
    attributes: ['id_clinica'],
    raw: true,
  });
  return rows.map((row) => row.id_clinica).filter(Boolean);
};
const countMojibakeMarkers = (value) => {
  if (!value || typeof value !== 'string') return 0;
  const matches = value.match(/Ã.|Â.|â[\u0080-\u00BF]|�/g);
  return matches ? matches.length : 0;
};
const repairLikelyMojibake = (value) => {
  if (!value || typeof value !== 'string') return value;
  if (!/[ÃÂâ�]/.test(value)) return value;

  try {
    const repaired = Buffer.from(value, 'latin1').toString('utf8');
    if (!repaired) return value;
    return countMojibakeMarkers(repaired) < countMojibakeMarkers(value)
      ? repaired.normalize('NFC')
      : value;
  } catch (_error) {
    return value;
  }
};
const cleanString = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = repairLikelyMojibake(String(value)).trim();
  return normalized || null;
};
const truncateString = (value, maxLength) => {
  const normalized = cleanString(value);
  if (!normalized) return null;
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
};
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const formatDateEs = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(date)
    : null;
};
const formatTimeEs = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date)
    : null;
};
const buildActorLabel = (usuario) => {
  if (!usuario) return 'Sistema';
  const name = [usuario.nombre, usuario.apellidos].filter(Boolean).join(' ').trim();
  if (name && usuario.email_usuario) {
    return `${name} <${usuario.email_usuario}>`;
  }
  return name
    || usuario.email_usuario
    || `Usuario ${usuario.id_usuario}`;
};
// Acepta IDs separados por coma (ej: "36,37,38") y también "all" (=> null, sin filtro).
const parseIntegerList = (value) => {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'all') return null;
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  const ids = [];
  for (const part of parts) {
    const n = parseInteger(part);
    if (n !== null) ids.push(n);
  }
  const unique = Array.from(new Set(ids));
  return unique.length ? unique : null;
};
const coalesce = (...values) => values.find(v => v !== undefined && v !== null);

const buildIdWhere = (field, ids) => {
  const normalizedIds = Array.from(new Set((Array.isArray(ids) ? ids : [ids])
    .map((value) => parseInteger(value))
    .filter((value) => value !== null)));
  if (!normalizedIds.length) return null;
  return {
    [field]: normalizedIds.length === 1 ? normalizedIds[0] : { [Op.in]: normalizedIds },
  };
};

const appendAndWhere = (where, condition) => {
  if (!condition) return;
  where[Op.and] = [...(where[Op.and] || []), condition];
};

const findClinicIdsByGroup = async (groupId) => {
  const parsedGroupId = parseInteger(groupId);
  if (parsedGroupId === null) return [];
  const rows = await Clinica.findAll({
    where: { grupoClinicaId: parsedGroupId },
    attributes: ['id_clinica'],
    raw: true,
  });
  return rows.map((row) => parseInteger(row.id_clinica)).filter((value) => value !== null);
};

const findAllClinicIds = async () => {
  const rows = await Clinica.findAll({
    attributes: ['id_clinica'],
    raw: true,
  });
  return rows.map((row) => parseInteger(row.id_clinica)).filter((value) => value !== null);
};

const findGroupIdsForClinics = async (clinicIds) => {
  const normalizedClinicIds = Array.from(new Set((Array.isArray(clinicIds) ? clinicIds : [clinicIds])
    .map((value) => parseInteger(value))
    .filter((value) => value !== null)));
  if (!normalizedClinicIds.length) return [];
  const rows = await Clinica.findAll({
    where: { id_clinica: { [Op.in]: normalizedClinicIds } },
    attributes: ['grupoClinicaId'],
    raw: true,
  });
  return Array.from(new Set(rows
    .map((row) => parseInteger(row.grupoClinicaId))
    .filter((value) => value !== null)));
};

const hasFullGroupMarketingAccess = async (userId, groupId, knownClinicIds = null) => {
  const normalizedUserId = parseInteger(userId);
  const normalizedGroupId = parseInteger(groupId);
  if (normalizedUserId === null || normalizedGroupId === null) return false;
  const groupClinicIds = Array.isArray(knownClinicIds)
    ? Array.from(new Set(knownClinicIds.map((value) => parseInteger(value)).filter((value) => value !== null)))
    : await findClinicIdsByGroup(normalizedGroupId);
  if (!groupClinicIds.length) return false;
  return hasMarketingClinicScopeAccess({
    userId: normalizedUserId,
    clinicIds: groupClinicIds,
    access: 'read',
  });
};

const resolveLeadScopeFilter = async (query = {}, userId = null) => {
  const normalizedUserId = parseInteger(userId);
  const clinicIdRaw = coalesce(query.clinicId, query.clinica_id);
  const groupIdRaw = coalesce(query.groupId, query.grupo_clinica_id);
  const clinicIdsParsed = parseIntegerList(clinicIdRaw);
  const groupIdParsed = String(groupIdRaw || '').trim().toLowerCase() === 'all'
    ? null
    : parseInteger(groupIdRaw);

  let requestedClinicIds = clinicIdsParsed;
  if (requestedClinicIds === null && groupIdParsed !== null) {
    requestedClinicIds = await findClinicIdsByGroup(groupIdParsed);
  }

  const includeGroupLevel = clinicIdsParsed === null;
  if (isGlobalAdmin(normalizedUserId)) {
    if (requestedClinicIds !== null) {
      return {
        clinicIds: requestedClinicIds,
        groupIds: groupIdParsed !== null && includeGroupLevel ? [groupIdParsed] : [],
      };
    }
    return null;
  }

  const targetClinicIds = requestedClinicIds !== null ? requestedClinicIds : await findAllClinicIds();
  const clinicIds = await getAccessibleMarketingClinicIds({
    userId: normalizedUserId,
    clinicIds: targetClinicIds,
    access: 'read',
  });
  const candidateGroupIds = includeGroupLevel
    ? (groupIdParsed !== null ? [groupIdParsed] : await findGroupIdsForClinics(clinicIds))
    : [];
  const groupIds = [];
  for (const candidateGroupId of candidateGroupIds) {
    const knownGroupClinicIds = groupIdParsed === candidateGroupId ? targetClinicIds : null;
    if (await hasFullGroupMarketingAccess(normalizedUserId, candidateGroupId, knownGroupClinicIds)) {
      groupIds.push(candidateGroupId);
    }
  }

  return { clinicIds, groupIds };
};

const applyLeadScopeWhere = async (where, query = {}, userId = null) => {
  const scope = await resolveLeadScopeFilter(query, userId);
  if (scope === null) return;

  const scopeConditions = [];
  const clinicWhere = buildIdWhere('clinica_id', scope.clinicIds);
  if (clinicWhere) scopeConditions.push(clinicWhere);

  const groupWhere = buildIdWhere('grupo_clinica_id', scope.groupIds);
  if (groupWhere) {
    scopeConditions.push({
      clinica_id: null,
      ...groupWhere,
    });
  }

  if (!scopeConditions.length) {
    appendAndWhere(where, { clinica_id: 0 });
    return;
  }

  appendAndWhere(where, scopeConditions.length === 1 ? scopeConditions[0] : { [Op.or]: scopeConditions });
};

const ensureLeadScopeAccess = async (req, res, lead) => {
  const normalizedUserId = parseInteger(req.userData?.userId);
  if (isGlobalAdmin(normalizedUserId)) return true;

  const clinicId = parseInteger(lead?.clinica_id);
  if (clinicId !== null) {
    const allowedClinicIds = await getAccessibleMarketingClinicIds({
      userId: normalizedUserId,
      clinicIds: [clinicId],
      access: 'read',
    });
    if (allowedClinicIds.length) return true;
  }

  const groupId = parseInteger(lead?.grupo_clinica_id);
  if (clinicId === null && groupId !== null) {
    const groupClinicIds = await findClinicIdsByGroup(groupId);
    if (await hasFullGroupMarketingAccess(normalizedUserId, groupId, groupClinicIds)) return true;
  }

  res.status(403).json({ success: false, error: 'lead_scope_forbidden' });
  return false;
};

const leadClinicIds = async (lead) => {
  const clinicId = parseInteger(lead?.clinica_id);
  if (clinicId !== null) return [clinicId];
  const groupId = parseInteger(lead?.grupo_clinica_id);
  return groupId !== null ? findClinicIdsByGroup(groupId) : [];
};

const canAccessLeadFeature = async (req, lead, featureKey) => {
  const actorId = parseInteger(req.userData?.userId);
  if (isGlobalAdmin(actorId)) return true;
  if (actorId === null) return false;
  const clinicIds = await leadClinicIds(lead);
  if (!clinicIds.length) return false;
  const decisions = await Promise.all(clinicIds.map((clinicId) => canUserAccessFeature({
    actorId,
    featureKey,
    clinicId,
  }).catch(() => false)));
  return parseInteger(lead?.clinica_id) === null
    ? decisions.every(Boolean)
    : decisions.some(Boolean);
};

const ensureLeadFeatureAccess = async (req, res, lead, featureKey) => {
  if (!(await ensureLeadScopeAccess(req, res, lead))) return false;
  const allowed = await canAccessLeadFeature(req, lead, featureKey);
  const canSeeSensitiveData = featureKey !== 'leads.manage'
    || await canAccessLeadFeature(req, lead, 'leads.sensitive.view');
  if (allowed && canSeeSensitiveData) return true;
  res.status(403).json({
    success: false,
    error: featureKey === 'leads.manage' ? 'lead_manage_forbidden' : 'lead_sensitive_forbidden',
  });
  return false;
};

const leadPrivacySuffix = (lead) => crypto
  .createHash('sha256')
  .update(`lead:${lead?.id || 'unknown'}`)
  .digest('hex')
  .slice(0, 6)
  .toUpperCase();

const compactPrivacyObject = (value) => Object.fromEntries(
  Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
);

const sanitizeLeadClinic = (clinic) => {
  if (!clinic || typeof clinic !== 'object') return null;
  return compactPrivacyObject({
    id_clinica: parseInteger(clinic.id_clinica),
    nombre_clinica: clinic.nombre_clinica || null,
  });
};

const sanitizeLeadGroup = (group) => {
  if (!group || typeof group !== 'object') return null;
  return compactPrivacyObject({
    id_grupo: parseInteger(group.id_grupo),
    nombre_grupo: group.nombre_grupo || null,
  });
};

const sanitizeLeadCampaign = (campaign) => {
  if (!campaign || typeof campaign !== 'object') return null;
  return compactPrivacyObject({
    id: parseInteger(campaign.id),
    nombre: campaign.nombre || null,
    campaign_id: campaign.campaign_id || null,
  });
};

const sanitizeLeadMarketingCampaign = (campaign) => {
  if (!campaign || typeof campaign !== 'object') return null;
  return compactPrivacyObject({
    provider: campaign.provider || null,
    customer_id: campaign.customer_id || null,
    external_id: campaign.external_id || null,
    name: campaign.name || null,
    resolution: campaign.resolution || null,
  });
};

const sanitizeLeadSourceTrace = (trace) => {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return null;
  const utm = trace.utm && typeof trace.utm === 'object' && !Array.isArray(trace.utm)
    ? compactPrivacyObject({
        source: trace.utm.source || null,
        medium: trace.utm.medium || null,
        campaign: trace.utm.campaign || null,
      })
    : null;
  return compactPrivacyObject({
    source: trace.source || null,
    channel: trace.channel || null,
    utm,
  });
};

const redactLeadForPrivacy = (lead) => {
  const plain = toPlain(lead) || {};
  return compactPrivacyObject({
    id: parseInteger(plain.id),
    clinica_id: parseInteger(plain.clinica_id),
    grupo_clinica_id: parseInteger(plain.grupo_clinica_id),
    campana_id: parseInteger(plain.campana_id),
    clinica: sanitizeLeadClinic(plain.clinica),
    grupoClinica: sanitizeLeadGroup(plain.grupoClinica),
    campana: sanitizeLeadCampaign(plain.campana),
    channel: CHANNELS.has(plain.channel) ? plain.channel : null,
    source: SOURCES.has(plain.source) ? plain.source : null,
    contact_method: plain.contact_method || null,
    marketing_origin: plain.marketing_origin || null,
    marketing_campaign: sanitizeLeadMarketingCampaign(plain.marketing_campaign),
    clinic_match_source: plain.clinic_match_source || null,
    utm_source: plain.utm_source || null,
    utm_medium: plain.utm_medium || null,
    utm_campaign: plain.utm_campaign || null,
    google_ads_customer_id: plain.google_ads_customer_id || null,
    google_ads_campaign_id: plain.google_ads_campaign_id || null,
    status_lead: STATUSES.has(plain.status_lead) ? plain.status_lead : null,
    created_at: plain.created_at || null,
    updated_at: plain.updated_at || null,
    archived_at: plain.archived_at || null,
    nombre: 'Lead',
    apellidos: `#${leadPrivacySuffix(plain)}`,
    privacy_redacted: true,
    privacy_access: 'attribution_only',
    source_trace: sanitizeLeadSourceTrace(plain.source_trace),
    patient_match: null,
    es_paciente: false,
    linked_appointment: null,
    recent_appointment: null,
    formSubmissionEvents: [],
    historial_contactos: [],
    conversation_id: null,
    pending_whatsapp_reply_count: 0,
    pending_automation_attention: false,
  });
};

const protectLeadRowsForRequest = async (req, rows = []) => Promise.all(rows.map(async (lead) => (
  await canAccessLeadFeature(req, lead, 'leads.sensitive.view')
    ? toPlain(lead)
    : redactLeadForPrivacy(lead)
)));

const canSearchSensitiveLeadFields = async (query, userId) => {
  const actorId = parseInteger(userId);
  if (isGlobalAdmin(actorId)) return true;
  if (actorId === null) return false;
  const scope = await resolveLeadScopeFilter(query, actorId);
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds : [];
  if (!clinicIds.length) return false;
  const decisions = await Promise.all(clinicIds.map((clinicId) => canUserAccessFeature({
    actorId,
    featureKey: 'leads.sensitive.view',
    clinicId,
  }).catch(() => false)));
  return decisions.every(Boolean);
};

const buildLeadSearchConditions = (search, {
  canSearchSensitive = false,
  includeCampaignRelation = false,
} = {}) => {
  const rawTerm = String(search || '').trim();
  if (!rawTerm) return [];
  const term = `%${rawTerm}%`;
  const conditions = [];

  if (canSearchSensitive) {
    conditions.push(
      { nombre: { [Op.like]: term } },
      { email: { [Op.like]: term } },
      { telefono: { [Op.like]: term } },
      { source_detail: { [Op.like]: term } },
      { page_url: { [Op.like]: term } },
      { landing_url: { [Op.like]: term } },
    );
  }

  conditions.push({ utm_campaign: { [Op.like]: term } });
  if (includeCampaignRelation) {
    // Sequelize does not map nested $alias.attribute$ paths to the physical field name.
    conditions.push({ '$campana.nombre_campana$': { [Op.like]: term } });
  }

  const normalizedSource = rawTerm.toLowerCase();
  if (SOURCES.has(normalizedSource)) {
    conditions.push({ source: normalizedSource });
  }

  return conditions;
};

const requireLeadManageForImport = async (req, res) => {
  const clinicId = parseInteger(req.body?.config?.clinic_id ?? req.body?.config?.clinica_id);
  const actorId = parseInteger(req.userData?.userId);
  if (clinicId === null) {
    res.status(400).json({ success: false, error: 'clinic_id_required' });
    return false;
  }
  const allowed = isGlobalAdmin(actorId) || (actorId !== null && (
    await canUserAccessFeature({ actorId, featureKey: 'leads.manage', clinicId }).catch(() => false)
    && await canUserAccessFeature({ actorId, featureKey: 'leads.sensitive.view', clinicId }).catch(() => false)
  ));
  if (!allowed) {
    res.status(403).json({ success: false, error: 'lead_manage_forbidden' });
    return false;
  }
  return true;
};

const toPlain = (row) => (row && typeof row.get === 'function' ? row.get({ plain: true }) : row);

const hashValue = (value) => {
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex');
};

const normalizeEmail = (email) => (email || '').trim().toLowerCase() || null;
const normalizePhone = (phone) => {
  return normalizePhoneDigits(phone);
};
const normalizeLookupKey = (value = '') => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

const resolveFallbackClinicForGroup = async (groupId) => {
  const normalizedGroupId = parseInteger(groupId);
  if (!normalizedGroupId) return null;

  const clinic = await Clinica.findOne({
    where: { grupoClinicaId: normalizedGroupId },
    attributes: ['id_clinica', 'fecha_creacion'],
    order: [
      ['fecha_creacion', 'ASC'],
      ['id_clinica', 'ASC'],
    ],
    raw: true,
  });

  return parseInteger(clinic?.id_clinica);
};

const collectPacienteClinics = (paciente) => {
  const clinics = new Map();

  const addClinic = (clinicLike) => {
    const clinicId = parseInteger(clinicLike?.clinica_id ?? clinicLike?.id_clinica);
    if (!clinicId) return;
    clinics.set(clinicId, {
      clinica_id: clinicId,
      nombre_clinica: clinicLike?.nombre_clinica || clinicLike?.clinica?.nombre_clinica || null,
      grupo_clinica_id: parseInteger(clinicLike?.grupoClinicaId ?? clinicLike?.clinica?.grupoClinicaId)
    });
  };

  addClinic({
    clinica_id: paciente?.clinica_id,
    nombre_clinica: paciente?.clinica?.nombre_clinica,
    grupoClinicaId: paciente?.clinica?.grupoClinicaId
  });

  for (const vinculo of (paciente?.clinicasVinculadas || [])) {
    addClinic({
      clinica_id: vinculo?.clinica_id,
      nombre_clinica: vinculo?.clinica?.nombre_clinica,
      grupoClinicaId: vinculo?.clinica?.grupoClinicaId
    });
  }

  return Array.from(clinics.values());
};

const buildLeadPatientMatch = (lead, pacientes = []) => {
  const normPhone = normalizePhone(lead?.telefono);
  const normEmail = normalizeEmail(lead?.email);
  if (!normPhone && !normEmail) return null;

  const targetClinicaId = parseInteger(lead?.clinica_id ?? lead?.clinica?.id_clinica);
  const targetGrupoId = parseInteger(lead?.grupo_clinica_id ?? lead?.grupoClinica?.id_grupo);

  let bestMatch = null;

  for (const pacienteRaw of pacientes) {
    const paciente = toPlain(pacienteRaw);
    const matchedBy = normPhone && normalizePhone(paciente?.telefono_movil) === normPhone
      ? 'phone'
      : normEmail && normalizeEmail(paciente?.email) === normEmail
        ? 'email'
        : null;
    if (!matchedBy) continue;

    const coverage = collectPacienteClinics(paciente);
    const sameClinic = !!targetClinicaId && coverage.some((clinic) => clinic.clinica_id === targetClinicaId);
    const sameGroupClinic = !sameClinic && !!targetGrupoId
      ? coverage.find((clinic) => clinic.grupo_clinica_id === targetGrupoId)
      : null;

    if (!sameClinic && !sameGroupClinic) continue;

    const candidate = {
      exists: true,
      patient_id: parseInteger(paciente?.id_paciente),
      same_clinic: sameClinic,
      clinic_id: sameClinic ? targetClinicaId : sameGroupClinic?.clinica_id || null,
      clinic_name: sameClinic
        ? (lead?.clinica?.nombre_clinica || null)
        : (sameGroupClinic?.nombre_clinica || paciente?.clinica?.nombre_clinica || null),
      match_field: matchedBy,
    };

    const score = sameClinic ? 2 : 1;
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { score, data: candidate };
    }
  }

  return bestMatch?.data || null;
};

const enrichLeadsWithPatientMatches = async (leadRows = []) => {
  const leads = leadRows.map((lead) => toPlain(lead));
  if (!leads.length) return leads;

  const phoneSet = new Set();
  const emailSet = new Set();
  for (const lead of leads) {
    const normPhone = normalizePhone(lead?.telefono);
    const normEmail = normalizeEmail(lead?.email);
    if (normPhone) phoneSet.add(normPhone);
    if (normEmail) emailSet.add(normEmail);
  }

  if (!phoneSet.size && !emailSet.size) {
    return leads.map((lead) => ({
      ...lead,
      patient_match: null,
      es_paciente: ['acudio_cita', 'convertido'].includes(String(lead?.status_lead || '').trim().toLowerCase()),
    }));
  }

  const contactOr = [];
  if (phoneSet.size) {
    contactOr.push({ telefono_movil: { [Op.in]: Array.from(phoneSet) } });
  }
  if (emailSet.size) {
    contactOr.push({ email: { [Op.in]: Array.from(emailSet) } });
  }

  const pacientes = await Paciente.findAll({
    where: { [Op.or]: contactOr },
    include: [
      { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'] },
      {
        model: PacienteClinica,
        as: 'clinicasVinculadas',
        required: false,
        attributes: ['clinica_id', 'es_principal'],
        include: [{ model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'] }]
      }
    ]
  });

  return leads.map((lead) => {
    const patientMatch = buildLeadPatientMatch(lead, pacientes);
    return {
      ...lead,
      patient_match: patientMatch,
      // Al agendar se crea la ficha técnica del paciente, pero comercialmente
      // el lead no se convierte hasta que acude a clínica.
      es_paciente: ['acudio_cita', 'convertido'].includes(String(lead?.status_lead || '').trim().toLowerCase()),
    };
  });
};

const enrichLeadsWithConversationState = async (leadRows = []) => {
  const leads = leadRows.map((lead) => toPlain(lead));
  const leadIds = Array.from(new Set(
    leads
      .map((lead) => parseInteger(lead?.id))
      .filter((id) => id !== null)
  ));

  if (!leads.length || !leadIds.length || !Conversation) {
    return leads.map((lead) => ({
      ...lead,
      conversation_id: lead?.conversation_id || null,
      pending_whatsapp_reply_count: 0,
      pending_automation_attention: false,
    }));
  }

  const conversations = await Conversation.findAll({
    where: {
      lead_id: { [Op.in]: leadIds },
      channel: 'whatsapp',
    },
    attributes: ['id', 'lead_id', 'last_message_at', 'updatedAt'],
    order: [['last_message_at', 'DESC'], ['updatedAt', 'DESC'], ['id', 'DESC']],
    raw: true,
  });

  const conversationByLead = new Map();
  conversations.forEach((conversation) => {
    const leadId = parseInteger(conversation.lead_id);
    if (leadId !== null && !conversationByLead.has(leadId)) {
      conversationByLead.set(leadId, conversation);
    }
  });

  const pendingStates = await getPendingReplyStatesByConversationIds([
    ...Array.from(conversationByLead.values()).map((conversation) => conversation.id),
    ...leads.map((lead) => lead?.conversation_id),
  ]);

  return leads.map((lead) => {
    const conversation = conversationByLead.get(parseInteger(lead?.id));
    const conversationId = parseInteger(conversation?.id) || parseInteger(lead?.conversation_id);
    const pendingState = conversationId !== null ? pendingStates.get(conversationId) : null;
    const hasActiveAppointment = !!lead?.linked_appointment?.id;
    return {
      ...lead,
      conversation_id: conversationId,
      pending_whatsapp_reply_count: hasActiveAppointment ? 0 : (pendingState?.count || 0),
      pending_automation_attention: !hasActiveAppointment && pendingState?.requiresAutomationAttention === true,
    };
  });
};

const buildLinkedAppointmentSummary = (appointmentRow) => {
  const appointment = toPlain(appointmentRow);
  if (!appointment?.id_cita) {
    return null;
  }

  const inicio = appointment.inicio ? new Date(appointment.inicio) : null;
  return {
    id: appointment.id_cita,
    fecha: inicio && Number.isFinite(inicio.getTime()) ? inicio.toISOString() : appointment.inicio || null,
    hora: inicio && Number.isFinite(inicio.getTime())
      ? inicio.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
      : null,
    tipo_cita: cleanString(appointment.tipo_cita),
    estado: cleanString(appointment.estado),
    tratamiento: cleanString(appointment?.tratamiento?.nombre),
    clinica_id: parseInteger(appointment.clinica_id),
    clinica_nombre: cleanString(appointment?.clinica?.nombre_clinica),
    paciente_id: parseInteger(appointment.paciente_id),
    paciente_nombre: [
      cleanString(appointment?.paciente?.nombre),
      cleanString(appointment?.paciente?.apellidos),
    ].filter(Boolean).join(' ').trim() || cleanString(appointment?.paciente?.nombre),
  };
};

const enrichLeadsWithLinkedAppointments = async (leadRows = []) => {
  const leads = leadRows.map((lead) => toPlain(lead));
  if (!leads.length || !CitaPaciente) {
    return leads.map((lead) => ({ ...lead, linked_appointment: null, recent_appointment: null }));
  }

  const explicitAppointmentIds = Array.from(new Set(
    leads
      .map((lead) => parseInteger(lead?.call_outcome_appointment_id))
      .filter((id) => id !== null)
  ));
  const leadIds = Array.from(new Set(
    leads
      .map((lead) => parseInteger(lead?.id))
      .filter((id) => id !== null)
  ));

  const include = [
    { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'], required: false },
    { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'nombre', 'apellidos'], required: false },
    db.Tratamiento ? { model: db.Tratamiento, as: 'tratamiento', attributes: ['id_tratamiento', 'nombre'], required: false } : null,
  ].filter(Boolean);

  const explicitAppointments = explicitAppointmentIds.length
    ? await CitaPaciente.findAll({
        where: {
          id_cita: { [Op.in]: explicitAppointmentIds },
          estado: { [Op.in]: Array.from(LEAD_ACTIVE_APPOINTMENT_STATES) },
        },
        include,
      })
    : [];

  const latestAppointmentsByLead = leadIds.length
    ? await CitaPaciente.findAll({
        where: { lead_intake_id: { [Op.in]: leadIds } },
        include,
        order: [['inicio', 'DESC'], ['id_cita', 'DESC']],
      })
    : [];

  const explicitById = new Map(
    explicitAppointments
      .map((row) => [parseInteger(toPlain(row)?.id_cita), buildLinkedAppointmentSummary(row)])
      .filter(([id, summary]) => id !== null && summary)
  );

  const latestByLead = new Map();
  const recentByLead = new Map();
  for (const row of latestAppointmentsByLead) {
    const plain = toPlain(row);
    const leadId = parseInteger(plain?.lead_intake_id);
    if (leadId === null || latestByLead.has(leadId)) {
      if (!recentByLead.has(leadId)) {
        const summary = buildLinkedAppointmentSummary(row);
        if (summary) {
          recentByLead.set(leadId, summary);
        }
      }
      continue;
    }
    const summary = buildLinkedAppointmentSummary(row);
    if (summary && !recentByLead.has(leadId)) {
      recentByLead.set(leadId, summary);
    }
    if (summary && LEAD_ACTIVE_APPOINTMENT_STATES.has(String(summary.estado || '').toLowerCase())) {
      latestByLead.set(leadId, summary);
    }
  }

  return leads.map((lead) => {
    const explicitAppointmentId = parseInteger(lead?.call_outcome_appointment_id);
    const linkedAppointment = (explicitAppointmentId !== null ? explicitById.get(explicitAppointmentId) : null)
      || latestByLead.get(parseInteger(lead?.id))
      || null;
    const recentAppointment = recentByLead.get(parseInteger(lead?.id)) || null;
    return {
      ...lead,
      linked_appointment: linkedAppointment,
      recent_appointment: recentAppointment,
    };
  });
};

const enrichLeadsWithAttributionView = async (leadRows = []) => {
  const leads = leadRows.map((lead) => toPlain(lead));
  if (!leads.length) return leads;

  const googleKeys = Array.from(new Map(
    leads
      .filter((lead) => cleanString(lead?.google_ads_campaign_id))
      .map((lead) => {
        const campaignId = cleanString(lead.google_ads_campaign_id);
        const customerId = cleanString(lead.google_ads_customer_id);
        return [`${customerId || '*'}:${campaignId}`, { customerId, campaignId }];
      })
  ).values());

  const inventoryRows = ExternalCampaignInventory && googleKeys.length
    ? await ExternalCampaignInventory.findAll({
        where: {
          provider: 'google_ads',
          [Op.or]: googleKeys.map(({ customerId, campaignId }) => ({
            campaign_id: campaignId,
            ...(customerId ? { customer_id: customerId } : {}),
          })),
        },
        attributes: ['provider', 'customer_id', 'campaign_id', 'campaign_name'],
        order: [['last_seen_at', 'DESC'], ['id', 'DESC']],
        raw: true,
      })
    : [];

  const inventoryByExactKey = new Map();
  const inventoryByCampaignKey = new Map();
  for (const row of inventoryRows) {
    const campaignId = cleanString(row.campaign_id);
    if (!campaignId) continue;
    const customerId = cleanString(row.customer_id);
    if (customerId && !inventoryByExactKey.has(`${customerId}:${campaignId}`)) {
      inventoryByExactKey.set(`${customerId}:${campaignId}`, row);
    }
    if (!inventoryByCampaignKey.has(campaignId)) {
      inventoryByCampaignKey.set(campaignId, row);
    } else {
      const current = inventoryByCampaignKey.get(campaignId);
      if (current && cleanString(current.customer_id) !== customerId) {
        // A campaign id without its customer is not a safe cross-account key.
        inventoryByCampaignKey.set(campaignId, null);
      }
    }
  }

  return leads.map((lead) => {
    const campaignId = cleanString(lead.google_ads_campaign_id);
    const customerId = cleanString(lead.google_ads_customer_id);
    const inventory = campaignId
      ? (customerId
          ? inventoryByExactKey.get(`${customerId}:${campaignId}`)
          : inventoryByCampaignKey.get(campaignId))
      : null;
    return buildLeadAttributionView(lead, inventory);
  });
};

const enrichLeadsForUi = async (leadRows = []) => {
  const withAttribution = await enrichLeadsWithAttributionView(leadRows);
  const withPatientMatches = await enrichLeadsWithPatientMatches(withAttribution);
  const withAppointments = await enrichLeadsWithLinkedAppointments(withPatientMatches);
  return enrichLeadsWithConversationState(withAppointments);
};

const resolveClinicIdsForSocket = async ({ clinicId, groupId }) => {
  const parsedClinicId = parseInteger(clinicId);
  if (parsedClinicId !== null) {
    return [parsedClinicId];
  }

  const parsedGroupId = parseInteger(groupId);
  if (parsedGroupId === null) {
    return [];
  }

  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: parsedGroupId },
    attributes: ['id_clinica'],
    raw: true,
  });

  return clinics
    .map((row) => parseInteger(row.id_clinica))
    .filter((id) => id !== null);
};

const emitLeadSocketEvent = async (eventName, payload, { clinicId, groupId } = {}) => {
  const io = getIO();
  if (!io) return;

  const clinicIds = await resolveClinicIdsForSocket({ clinicId, groupId });
  if (!clinicIds.length) return;

  const uniqueClinicIds = Array.from(new Set(clinicIds));
  uniqueClinicIds.forEach((id) => {
    io.to(`clinic:${id}`).emit(eventName, payload);
  });
};

const buildLeadCreatedSocketPayload = (lead) => {
  const plain = toPlain(lead);
  return {
    type: 'created',
    lead_id: plain.id,
    clinic_id: plain.clinica_id || null,
    group_id: plain.grupo_clinica_id || null,
    campaign_id: plain.campana_id || null,
    source: plain.source || null,
    source_detail: plain.source_detail || null,
    channel: plain.channel || null,
    status_lead: plain.status_lead || 'nuevo',
    created_at: plain.created_at instanceof Date ? plain.created_at.toISOString() : String(plain.created_at || ''),
    emitted_at: new Date().toISOString(),
  };
};

const buildLeadCallInitiatedSocketPayload = ({ lead, clinicId, groupId, clickedTel, pageUrl, source, sourceDetail, linkedBy = 'lead_id' }) => {
  const plain = toPlain(lead);
  const callInitiatedAt = plain.call_initiated_at instanceof Date
    ? plain.call_initiated_at.toISOString()
    : String(plain.call_initiated_at || new Date().toISOString());

  return {
    type: 'call_initiated',
    lead_id: plain.id,
    clinic_id: parseInteger(clinicId) || plain.clinica_id || null,
    group_id: parseInteger(groupId) || plain.grupo_clinica_id || null,
    emitted_at: new Date().toISOString(),
    call_initiated: true,
    call_initiated_at: callInitiatedAt,
    source: source || plain.source || 'web',
    source_detail: sourceDetail || 'tel_modal_call',
    linked_by: linkedBy,
  };
};

const buildLeadCallOutcomeSocketPayload = ({ lead, clinicId, groupId }) => {
  const plain = toPlain(lead);
  return {
    type: 'call_outcome',
    lead_id: plain.id,
    clinic_id: parseInteger(clinicId) || plain.clinica_id || null,
    group_id: parseInteger(groupId) || plain.grupo_clinica_id || null,
    emitted_at: new Date().toISOString(),
    call_initiated: !!plain.call_initiated,
    call_initiated_at: plain.call_initiated_at instanceof Date ? plain.call_initiated_at.toISOString() : String(plain.call_initiated_at || ''),
    call_outcome: plain.call_outcome || null,
    call_outcome_at: plain.call_outcome_at instanceof Date ? plain.call_outcome_at.toISOString() : String(plain.call_outcome_at || ''),
    call_outcome_appointment_id: plain.call_outcome_appointment_id || null,
  };
};

const resolveClinicByPhoneWithinGroup = async (groupId, phone, configRecord = null) => {
  const parsedGroupId = parseInteger(groupId);
  const normalizedPhone = normalizePhone(phone);
  if (parsedGroupId === null || !normalizedPhone) {
    return null;
  }

  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: parsedGroupId },
    attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica', 'telefono', 'telefono_fijo', 'telefono_movil', 'telefono_whatsapp'],
    raw: true,
  });

  const clinicIds = clinics.map((clinic) => clinic.id_clinica).filter(Boolean);
  const clinicPhoneAssets = clinicIds.length
    ? await ClinicMetaAsset.findAll({
        where: {
          clinicaId: { [Op.in]: clinicIds },
          assignmentScope: 'clinic',
          isActive: true,
          assetType: 'whatsapp_phone_number',
        },
        attributes: ['clinicaId', 'assignmentScope', 'metaAssetName', 'additionalData'],
        raw: true,
      })
    : [];

  return matchClinicByContactPhone({
    phone: normalizedPhone,
    clinics,
    clinicPhoneAssets,
    configRecord,
    allowedClinicIds: configuredClinicIds(configRecord),
  });
};

const resolveClinicByPageUrlWithinGroup = async (groupId, pageUrl, configRecord = null) => {
  const parsedGroupId = parseInteger(groupId);
  if (parsedGroupId === null || !pageUrl) return null;

  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: parsedGroupId },
    attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica', 'url_web', 'estado_clinica'],
    raw: true,
  });
  return matchClinicByPageUrl(pageUrl, clinics, configuredClinicIds(configRecord));
};

const CALL_OUTCOMES = new Set(['citado', 'informacion', 'no_contactado']);

const buildTrackingScopeFromRecords = ({ clinicId, groupId, selectedRecord }) => {
  const selectedClinicId = parseInteger(selectedRecord?.clinic_id);
  const selectedGroupId = parseInteger(selectedRecord?.group_id);
  return {
    assignment_scope: selectedRecord?.assignment_scope === 'group'
      ? 'group'
      : (groupId && !clinicId ? 'group' : 'clinic'),
    clinic_id: clinicId || selectedClinicId || null,
    group_id: groupId || selectedGroupId || null
  };
};

const resolveEffectiveTrackingFromRecords = ({ clinicId, groupId, selectedRecord, clinicCfg, groupCfg }) => {
  const scope = buildTrackingScopeFromRecords({ clinicId, groupId, selectedRecord });
  return resolveEffectiveTrackingConfig(scope, {
    clinicRecord: clinicCfg || null,
    groupRecord: groupCfg || null
  });
};

const resolveMetaCapiRuntimeConfig = async ({ clinicId, groupId, selectedRecord, clinicCfg, groupCfg }) => {
  const tracking = resolveEffectiveTrackingFromRecords({ clinicId, groupId, selectedRecord, clinicCfg, groupCfg });
  let accessToken = cleanString(process.env.META_CAPI_TOKEN);
  const connectionId = parseInteger(tracking?.meta_ads?.connection_id);

  if (connectionId) {
    const connection = await MetaConnection.findByPk(connectionId, {
      attributes: ['id', 'accessToken'],
      raw: true
    });
    if (connection?.accessToken) {
      accessToken = connection.accessToken;
    }
  }

  return {
    tracking,
    pixelId: cleanString(tracking?.meta_ads?.pixel_id),
    accessToken: accessToken || null
  };
};
// Número de WhatsApp "público" para wa.me (dígitos, con prefijo de país si existe).
// En ClinicMetaAssets solemos tenerlo en additionalData.displayPhoneNumber o en metaAssetName.
const extractWhatsAppNumber = (asset) => {
  if (!asset) return null;
  const additional = asset.additionalData && typeof asset.additionalData === 'object' ? asset.additionalData : {};
  const raw =
    additional.displayPhoneNumber ||
    additional.display_phone_number ||
    asset.metaAssetName ||
    null;
  return normalizePhone(raw);
};
const normalizeDomain = (domain) => {
  if (!domain || typeof domain !== 'string') return null;
  const raw = domain.trim().toLowerCase();
  if (!raw) return null;
  if (raw === '*') return raw;
  if (raw.startsWith('*.')) {
    const root = canonicalizeIntakeDomain(raw.slice(2));
    return root ? `*.${root}` : null;
  }
  return canonicalizeIntakeDomain(raw) || null;
};
const stripWww = (host) => (host && host.startsWith('www.') ? host.slice(4) : host);
const isDomainAllowed = (allowlist, domain) => {
  // Sin allowlist configurada => permitido
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  const host = normalizeDomain(domain);
  if (!host) return false;

  for (const rawEntry of allowlist) {
    const entry = normalizeDomain(String(rawEntry || ''));
    if (!entry) continue;
    if (entry === '*') return true;

    // Soporte básico de wildcard "*.example.com" (equivale a cualquier subdominio, incluyendo "www")
    if (entry.startsWith('*.')) {
      const root = entry.slice(2);
      if (!root) continue;
      if (host === root || host.endsWith('.' + root)) return true;
      continue;
    }

    // Por defecto: "example.com" permite:
    // - example.com
    // - www.example.com
    // - cualquier subdominio (*.example.com)
    const root = stripWww(entry);
    if (host === entry || host === root || host === 'www.' + root) return true;
    if (host.endsWith('.' + root)) return true;
  }

  return false;
};
const parseDate = (value) => {
  const d = value ? new Date(value) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};

// Normaliza textos para evitar caracteres “exóticos” (p. ej. tipografías bold de unicode)
const sanitizeText = (value) => {
  if (!value || typeof value !== 'string') return value;
  return value
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s.,@'+-]/gu, '') // deja letras, números y signos básicos
    .trim();
};

const sanitizeLeadNoteText = (value) => {
  if (!value || typeof value !== 'string') return value;
  return value
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s.,@'+\-:/?&=#()%_]/gu, '')
    .trim();
};

const LEAD_CONTACT_REASON_LABELS = {
  no_contesta: 'No contesta',
  otro: 'Otro motivo',
};

const formatLeadContactReason = (value) => {
  const normalized = cleanString(value);
  return normalized ? (LEAD_CONTACT_REASON_LABELS[normalized] || normalized.replace(/_/g, ' ')) : null;
};

const formatAppointmentStateLabel = (estado) => {
  const normalized = cleanString(estado);
  if (!normalized) return null;
  const labels = {
    pendiente: 'Pendiente',
    info_enviada: 'Datos de la cita enviados',
    info_confirmada: 'Cita confirmada',
    recordatorio_enviado: 'Recordatorio enviado',
    recordatorio_confirmado: 'Cita confirmada',
    completada: 'Completada',
    no_asistio: 'No asistió',
    cancelada: 'Cancelada',
    reprogramada: 'Reprogramada',
  };
  return labels[normalized] || normalized.replace(/_/g, ' ');
};

const buildAppointmentActivityDescription = ({ telefono, inicio, tratamiento, estado }) => {
  const fields = [];
  const phoneValue = cleanString(telefono);
  const dateValue = formatDateEs(inicio);
  const timeValue = formatTimeEs(inicio);
  const treatmentValue = cleanString(tratamiento);
  const stateValue = formatAppointmentStateLabel(estado);

  if (phoneValue) fields.push({ label: 'Teléfono', value: phoneValue });
  if (dateValue) fields.push({ label: 'Fecha', value: dateValue });
  if (timeValue) fields.push({ label: 'Hora', value: timeValue });
  if (treatmentValue) fields.push({ label: 'Tratamiento', value: treatmentValue });
  if (stateValue) fields.push({ label: 'Estado', value: stateValue });

  return {
    plain: fields.map(({ label, value }) => `${label}: ${value}`).join('\n') || 'Sin detalles',
    html: fields.map(({ label, value }) => `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`).join('') || '<div>Sin detalles</div>',
  };
};

const sanitizeFormSubmissionValue = (value, depth = 0) => {
  if (depth > 3) return null;
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const normalized = value.normalize('NFKC').trim();
    return normalized.length > 2000 ? normalized.slice(0, 2000) : normalized;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeFormSubmissionValue(item, depth + 1))
      .filter((item) => item !== null);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = sanitizeFormSubmissionValue(item, depth + 1);
      if (normalized !== null) out[key] = normalized;
    }
    return out;
  }
  return null;
};

const normalizeFormSubmission = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const fields = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)
    ? sanitizeFormSubmissionValue(input.fields)
    : {};
  return {
    page_url: cleanString(input.page_url || input.pageUrl),
    form_id: cleanString(input.form_id || input.formId),
    form_name: cleanString(input.form_name || input.formName),
    form_selector: cleanString(input.form_selector || input.formSelector),
    submitted_at: parseDate(input.submitted_at || input.submittedAt) || new Date(),
    fields: fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {},
    payload: sanitizeFormSubmissionValue(input.payload || null),
  };
};

const extractLeadDataFromFormFields = (fields) => {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }

  const entries = Object.entries(fields)
    .map(([key, value]) => [String(key || '').trim(), normalizeLookupKey(key), cleanString(value)] )
    .filter(([key, value]) => key && value);

  const findValue = (matcher) => {
    const hit = entries.find(([, normalizedKey]) => matcher(normalizedKey));
    return hit?.[2] || null;
  };

  const findByValue = (matcher) => {
    const hit = entries.find(([, , value]) => matcher(String(value || '').trim()));
    return hit?.[2] || null;
  };

  const email =
    findValue((key) => key.includes('email') || key.includes('correo')) ||
    findByValue((value) => /.+@.+\..+/.test(value));

  const phone =
    findValue((key) => key.includes('phone') || key.includes('telefono') || key.includes('teléfono') || key.includes('mobile') || key.includes('movil') || key.includes('móvil') || key.includes('whatsapp')) ||
    (() => {
      const messageLike = findValue((key) => key.includes('message') || key.includes('mensaje'));
      if (messageLike && normalizePhone(messageLike)) return messageLike;
      return null;
    })() ||
    findByValue((value) => !!normalizePhone(value));

  const nombre =
    findValue((key) => key.includes('full_name') || key.includes('nombre_completo')) ||
    findValue((key) => (key.includes('name') || key.includes('nombre')) && !key.includes('company') && !key.includes('empresa'));

  const clinica =
    findValue((key) => key.includes('clinic') || key.includes('clinica') || key.includes('sede') || key.includes('centro') || key.includes('ubicacion')) ||
    null;

  return {
    nombre,
    email,
    telefono: phone,
    clinica,
  };
};

const stableStringify = (obj) => {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
};

const normalizeMarketingConsent = (consent) => {
  const normalized = normalizeGoogleConsent(consent);
  if (normalized === 'GRANTED') return true;
  if (normalized === 'DENIED') return false;
  return null;
};

const isConsentModeEnabledForRecord = (record) => {
  const cfg = record?.config && typeof record.config === 'object' && !Array.isArray(record.config)
    ? record.config
    : {};
  return cfg.features?.consent_mode_enabled === true;
};

const META_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN;
const META_GRAPH_TOKEN = process.env.META_GRAPH_TOKEN || process.env.META_PAGE_ACCESS_TOKEN;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v24.0';
const validateMetaSignature = createMetaSignatureValidator({
  appSecret: process.env.META_APP_SECRET,
});

async function dedupeAndCreateLead(leadPayload, rawPayload = {}, attributionSteps = {}, options = {}) {
  const normalizedEmail = normalizeEmail(leadPayload.email);
  const normalizedPhone = normalizePhone(leadPayload.telefono);
  const dedupeCutoff = new Date(Date.now() - (DEDUPE_WINDOW_HOURS * 60 * 60 * 1000));

  const payload = {
    ...leadPayload,
    email: normalizedEmail,
    email_hash: normalizedEmail ? hashValue(normalizedEmail) : null,
    telefono: normalizedPhone || leadPayload.telefono || null,
    phone_hash: normalizedPhone ? hashValue(normalizedPhone) : null
  };

  const createLead = async (transaction = null) => {
    const queryOptions = transaction ? { transaction } : {};
    if (payload.external_source && payload.external_id) {
      const existingExternal = await LeadIntake.findOne({
        where: { external_source: payload.external_source, external_id: payload.external_id, archived_at: null },
        ...queryOptions,
      });
      if (existingExternal) {
        const err = new Error('Lead duplicado (external_id)');
        err.status = 409;
        err.existingId = existingExternal.id;
        throw err;
      }
    }

    if (payload.event_id) {
      const existing = await LeadIntake.findOne({
        where: { event_id: payload.event_id, archived_at: null },
        ...queryOptions,
      });
      if (existing) {
        const err = new Error('Lead duplicado (event_id)');
        err.status = 409;
        err.existingId = existing.id;
        throw err;
      }
    }

    if (normalizedPhone || normalizedEmail) {
      const dedupeWhere = {
        archived_at: null,
        created_at: { [Op.gte]: dedupeCutoff },
        [Op.or]: []
      };
      if (normalizedPhone) dedupeWhere[Op.or].push({ phone_hash: payload.phone_hash });
      if (normalizedEmail) dedupeWhere[Op.or].push({ email_hash: payload.email_hash });
      if (dedupeWhere[Op.or].length > 0) {
        const existingRecent = await LeadIntake.findOne({ where: dedupeWhere, ...queryOptions });
        if (existingRecent) {
          const err = new Error('Lead duplicado (contacto reciente)');
          err.status = 409;
          err.existingId = existingRecent.id;
          throw err;
        }
      }
    }

    return LeadIntake.create(payload, queryOptions);
  };

  if (options.quickChatOutbox === true) {
    const persisted = await persistLeadAuditAndQuickChatOutbox({
      createLead,
      rawPayload,
      attributionSteps,
    });
    if (typeof options.onQuickChatOutboxCreated === 'function') {
      options.onQuickChatOutboxCreated(persisted);
    }
    return persisted.lead;
  }

  const lead = await createLead();

  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: rawPayload || {},
      attribution_steps: attributionSteps || {}
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar la auditoría de LeadIntake:', auditErr.message || auditErr);
  }

  return lead;
}

exports.ingestLead = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const eventId = (req.headers[EVENT_ID_HEADER] || body?.event_id || body?.eventId || null) || null;

  const {
    clinica_id,
    clinic_id,
    grupo_clinica_id,
    group_id,
    campana_id,
    channel,
    source,
    source_detail,
    clinic_match_source,
    clinic_match_value,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    gclid,
    gbraid,
    wbraid,
    ga_client_id,
    google_ads_customer_id,
    google_ads_campaign_id,
    fbclid,
    ttclid,
    referrer,
    page_url,
    landing_url,
    user_agent,
    ip,
    nombre,
    email,
    telefono,
    notas,
    status_lead,
    consentimiento_canal,
    consent_basis,
    consent_captured_at,
    consent_source,
    consent_version,
    external_source,
    external_id
  } = body;

  // Compat: intake.js usa clinic_id; el backend histórico usa clinica_id
  const explicitClinicIdRaw = coalesce(clinica_id, clinic_id, body.clinicaId, body.clinicId);
  const explicitClinicId = parseInteger(explicitClinicIdRaw);
  const explicitGroupId = parseInteger(coalesce(grupo_clinica_id, group_id, body.grupoClinicaId, body.groupId));
  let clinicaIdParsed = explicitClinicId;
  let grupoClinicaIdParsed = explicitGroupId;
  const webLandingAttribution = req.webLandingEventAttribution
    && typeof req.webLandingEventAttribution === 'object'
    && !Array.isArray(req.webLandingEventAttribution)
    ? req.webLandingEventAttribution
    : await resolveWebLandingAttribution({ body, models: db });
  if (webLandingAttribution) {
    clinicaIdParsed = webLandingAttribution.clinic_id;
    grupoClinicaIdParsed = webLandingAttribution.group_id;
  }
  const normalizedSourceForRouting = SOURCES.has(source) ? source : null;
  let canResolveGroupClinicHint = explicitClinicId === null && explicitGroupId !== null;
  const campanaIdParsed = parseInteger(campana_id);
  const attribution = body?.attribution || {};
  const leadData = body?.lead_data || {};
  const formSubmission = normalizeFormSubmission(body?.form_submission || body?.formSubmission);
  const formLeadData = extractLeadDataFromFormFields(formSubmission?.fields || {});
  const clinicNameHint = extractClinicLabelHint(body, leadData, formLeadData, formSubmission?.fields || {});

  // Validación por dominio + HMAC por clínica/grupo cuando hay IntakeConfig guardada.
  // Fallback legacy: INTAKE_WEB_SECRET solo se usa si NO existe configuración.
  const pageUrlForDomain = coalesce(
    attribution.page_url,
    body.page_url,
    body.pageUrl,
    attribution.landing_url,
    body.landing_url,
    body.landingUrl
  );
  const derivedDomain = getHostnameFromUrl(pageUrlForDomain || '');
  const domain = normalizeDomain(body.domain || derivedDomain) || '';

  // Resolución automática de clínica por activo publicitario (Meta / Google Ads)
  let clinicMatchSource = clinic_match_source || null;
  let clinicMatchValue = clinic_match_value || null;
  if (webLandingAttribution) {
    clinicMatchSource = 'clinicaclick_web_publication';
    clinicMatchValue = webLandingAttribution.publication_id;
  }

  let clinicCfg = null;
  let groupCfg = null;
  let domainCfg = null;
  if (clinicaIdParsed !== null) {
    clinicCfg = await IntakeConfig.findOne({ where: { clinic_id: clinicaIdParsed }, raw: true });
  }
  if (grupoClinicaIdParsed !== null) {
    groupCfg = await IntakeConfig.findOne({ where: { group_id: grupoClinicaIdParsed, assignment_scope: 'group' }, raw: true });
  }
  if (domain) {
    domainCfg = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain.toLowerCase()}\"') AND assignment_scope='clinic'`),
      order: [['created_at', 'ASC'], ['id', 'ASC']],
    });
    if (!domainCfg) {
      domainCfg = await IntakeConfig.findOne({
        where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain.toLowerCase()}\"') AND assignment_scope='group'`),
        order: [['created_at', 'ASC'], ['id', 'ASC']],
      });
    }
    if (domainCfg) domainCfg = domainCfg.get ? domainCfg.get({ plain: true }) : domainCfg;
  }

  ({ clinicCfg, groupCfg, domainCfg } = await resolveEffectivePublicIntakeRecords({
    clinicCfg,
    groupCfg,
    domainCfg,
    clinicId: clinicaIdParsed,
    groupId: grupoClinicaIdParsed,
    models: db,
  }));
  [clinicCfg, groupCfg, domainCfg] = await Promise.all([
    withRuntimeTransitionHmacs(clinicCfg),
    withRuntimeTransitionHmacs(groupCfg),
    withRuntimeTransitionHmacs(domainCfg),
  ]);
  const providedSignature = req.headers[SIGNATURE_HEADER] || req.headers[SIGNATURE_HEADER_SHA];
  const artifactRuntime = await runtimeConfigFromArtifactHeader(req, [clinicCfg, groupCfg, domainCfg]);
  if (artifactRuntime.present && !artifactRuntime.config) {
    return res.status(409).json({ message: 'La versión web publicada ya no está autorizada.', code: 'intake_web_artifact_not_authorized' });
  }
  const cfg = artifactRuntime.config || pickMatchingIntakeConfig({
    req,
    providedSignature,
    clinicCfg,
    groupCfg,
    domainCfg
  });

  if (cfg && Array.isArray(cfg.domains) && cfg.domains.length > 0) {
    if (!domain || !isDomainAllowed(cfg.domains, domain)) {
      return res.status(403).json({ message: 'Domain not allowed' });
    }
  }

  const intakeAuthentication = authenticatePublicIntakeRequest({
    req,
    config: cfg,
    fallbackSecret: process.env.INTAKE_WEB_SECRET,
  });
  if (!intakeAuthentication.ok) {
    return res.status(intakeAuthentication.status).json({
      message: intakeAuthentication.message,
      code: intakeAuthentication.code,
    });
  }
  req.publicIntakeAuthentication = intakeAuthentication.source;

  // Si el widget llega a nivel grupo y además recibimos nombre de clínica, ese dato
  // debe tener prioridad sobre el fallback por dominio o por clínica por defecto.
  const domainClinicId = parseInteger(domainCfg?.clinic_id);
  const domainGroupId = parseInteger(domainCfg?.group_id);
  if (!grupoClinicaIdParsed && domainGroupId !== null) {
    grupoClinicaIdParsed = domainGroupId;
  }

  // Runtime 3.2.1 conserva la sede solo en chat_state; 3.2.3 también la replica
  // como clinic_id. En scope de grupo validamos ambos caminos y, si llegan los
  // dos valores, exigimos que coincidan antes de confiar en ellos.
  const chatGroupConfigRecord = [cfg, groupCfg, domainCfg]
    .find((record) => record?.assignment_scope === 'group') || null;
  // A published Web landing has already resolved and validated its clinic in
  // the server-side publication bridge. Reinterpreting that canonical clinic
  // as a browser-submitted chat location would lose the authoritative
  // `clinicaclick_web_publication` attribution (and needlessly validate the
  // same group membership twice).
  const mustValidateGroupChatLocation = !webLandingAttribution && (
    clinicaIdParsed === null || cfg?.assignment_scope === 'group'
  );
  if (mustValidateGroupChatLocation) {
    const chatClinicSelection = await resolveChatStateClinicSelection({
      body,
      requestedGroupId: grupoClinicaIdParsed,
      submittedClinicId: explicitClinicIdRaw,
      configRecord: chatGroupConfigRecord,
      findClinicById: (candidateClinicId) => Clinica.findOne({
        where: { id_clinica: candidateClinicId },
        attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'],
        raw: true,
      }),
    });
    if (chatClinicSelection.matched) {
      clinicaIdParsed = chatClinicSelection.clinicId;
      grupoClinicaIdParsed = chatClinicSelection.groupId;
      clinicMatchSource = 'chat_location';
      clinicMatchValue = String(chatClinicSelection.clinicId);
    } else if (chatClinicSelection.hasCandidate) {
      return res.status(422).json({
        success: false,
        error: 'invalid_chat_location',
        message: 'La sede seleccionada no es válida para este formulario',
      });
    }
  }

  let preserveGoogleGroupScope = false;
  if (clinicaIdParsed === null && normalizedSourceForRouting === 'google_ads') {
    const googleRoute = await resolveGoogleLeadRoute({
      body,
      currentGroupId: grupoClinicaIdParsed,
      accountModel: ClinicGoogleAdsAccount,
      assignmentModel: db.ExternalCampaignAssignment,
    });
    if (googleRoute.matched) {
      if (googleRoute.groupId !== null) {
        grupoClinicaIdParsed = googleRoute.groupId;
        canResolveGroupClinicHint = true;
      }
      if (googleRoute.clinicId !== null) {
        clinicaIdParsed = googleRoute.clinicId;
        clinicMatchSource = googleRoute.matchSource;
        clinicMatchValue = googleRoute.matchValue;
      }
      preserveGoogleGroupScope = googleRoute.preserveGroupScope;
    }
  }

  if (
    clinicaIdParsed === null
    && grupoClinicaIdParsed !== null
    && clinicNameHint
  ) {
    const groupClinics = await Clinica.findAll({
      where: { grupoClinicaId: grupoClinicaIdParsed },
      attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica', 'estado_clinica'],
      raw: true,
    });

    const authoritativeGroupConfig = chatGroupConfigRecord?.assignment_scope === 'group'
      ? chatGroupConfigRecord
      : null;
    if (authoritativeGroupConfig) {
      const configuredClinicMatch = resolveConfiguredFormClinicLocation({
        hint: clinicNameHint,
        requestedGroupId: grupoClinicaIdParsed,
        configRecord: authoritativeGroupConfig,
        clinics: groupClinics,
      });
      if (configuredClinicMatch.matched) {
        clinicaIdParsed = configuredClinicMatch.clinicId;
        clinicMatchSource = clinicMatchSource || 'configured_location_label';
        clinicMatchValue = clinicMatchValue || clinicNameHint;
      } else if (configuredClinicMatch.hasCandidate) {
        return res.status(422).json({
          success: false,
          error: 'invalid_form_location',
          reason: configuredClinicMatch.reason || 'invalid_location',
          message: 'La sede seleccionada no es válida para este formulario',
        });
      }
    } else if (canResolveGroupClinicHint) {
      // Compatibilidad con instalaciones legacy sin configuración de sedes.
      const clinicMatcher = buildClinicMatcher(groupClinics, {
        allowFallback: true,
        requireDelimiter: false,
      });
      const clinicMatch = clinicMatcher.matchFromText(clinicNameHint, {
        source: 'clinic_name_field',
      });
      const matchedClinicId = parseInteger(clinicMatch?.match?.clinic?.id);
      if (matchedClinicId !== null) {
        clinicaIdParsed = matchedClinicId;
        clinicMatchSource = clinicMatchSource || 'clinic_name_field';
        clinicMatchValue = clinicMatchValue || clinicNameHint;
      }
    }
  }

  if (clinicaIdParsed === null && grupoClinicaIdParsed !== null && pageUrlForDomain) {
    const pageClinic = await resolveClinicByPageUrlWithinGroup(
      grupoClinicaIdParsed,
      pageUrlForDomain,
      chatGroupConfigRecord,
    );
    if (pageClinic) {
      clinicaIdParsed = parseInteger(pageClinic.id_clinica);
      clinicMatchSource = clinicMatchSource || 'page_url';
      clinicMatchValue = clinicMatchValue || pageUrlForDomain;
    }
  }

  if (!clinicaIdParsed && domainClinicId !== null) {
    clinicaIdParsed = domainClinicId;
    clinicMatchSource = clinicMatchSource || 'intake_domain';
    clinicMatchValue = clinicMatchValue || domain;
  }

  if (clinicaIdParsed === null && grupoClinicaIdParsed !== null && !preserveGoogleGroupScope) {
    const fallbackClinicId = await resolveFallbackClinicForGroup(grupoClinicaIdParsed);
    if (fallbackClinicId !== null) {
      clinicaIdParsed = fallbackClinicId;
      clinicMatchSource = clinicMatchSource || 'group_default_clinic';
      clinicMatchValue = clinicMatchValue || String(grupoClinicaIdParsed);
    }
  }

  if (clinicaIdParsed !== null && grupoClinicaIdParsed === null) {
    const clinicScope = await Clinica.findOne({
      where: { id_clinica: clinicaIdParsed },
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true,
    });
    if (clinicScope?.grupoClinicaId) {
      grupoClinicaIdParsed = parseInteger(clinicScope.grupoClinicaId);
    }
  }

  const utmSource = coalesce(attribution.utm_source, utm_source);
  const utmMedium = coalesce(attribution.utm_medium, utm_medium);
  const utmCampaign = coalesce(attribution.utm_campaign, utm_campaign);
  const utmContent = coalesce(attribution.utm_content, utm_content);
  const utmTerm = coalesce(attribution.utm_term, utm_term);
  const gclidValue = coalesce(attribution.gclid, gclid);
  const gbraidValue = coalesce(attribution.gbraid, gbraid, body.gBraid);
  const wbraidValue = coalesce(attribution.wbraid, wbraid, body.wBraid);
  const gaClientIdValue = coalesce(attribution.ga_client_id, attribution.client_id, ga_client_id, body.gaClientId, body.client_id);
  const pageUrlValue = coalesce(attribution.page_url, page_url, body.pageUrl);
  const landingUrlValue = coalesce(attribution.landing_url, landing_url, body.landingUrl);
  // Una landing publicada nunca puede persistir IDs de Google elegidos por el
  // navegador. El resolver ya los ha contrastado contra la cuenta y la
  // asignación de campaña autorizadas para la clínica canónica.
  const googleAdsCustomerIdValue = webLandingAttribution
    ? (webLandingAttribution.google_ads_customer_id || null)
    : coalesce(
        attribution.ccGadsCustomerId,
        attribution.google_ads_customer_id,
        attribution.googleAdsCustomerId,
        attribution.cc_gads_customer_id,
        google_ads_customer_id,
        body.googleAdsCustomerId,
        body.cc_gads_customer_id,
        body.ccGadsCustomerId,
        body.customer_id,
        body.google_customer_id
      );
  const googleAdsCampaignIdValue = webLandingAttribution
    ? (webLandingAttribution.google_ads_campaign_id || null)
    : resolveGoogleAdsCampaignId({
        ccCandidates: [
          attribution.cc_gads_campaign_id,
          body.cc_gads_campaign_id,
        ],
        canonicalCandidates: [
          attribution.google_ads_campaign_id,
          google_ads_campaign_id,
          body.google_campaign_id,
        ],
        gadCandidates: [
          attribution.gad_campaignid,
          body.gad_campaignid,
          body.gadCampaignId,
        ],
        urls: [pageUrlValue, landingUrlValue],
      });
  const fbclidValue = coalesce(attribution.fbclid, fbclid);
  const ttclidValue = coalesce(attribution.ttclid, ttclid);
  const referrerValue = coalesce(attribution.referrer, referrer);

  const leadNombre = sanitizeText(coalesce(leadData.nombre, formLeadData.nombre, nombre));
  const leadEmail = coalesce(leadData.email, formLeadData.email, email);
  const leadTelefono = coalesce(leadData.telefono, formLeadData.telefono, telefono);
  const leadNotas = sanitizeLeadNoteText(coalesce(leadData.notas, notas));
  const consentValue = coalesce(req.body?.consent, consentimiento_canal);
  const derivedConsentMetadata = deriveLeadConsentMetadata(consentValue);
  const isCompletedChatbotLead = isCompletedChatbotLeadRequest(body);
  const isDirectQuickChatSummary = isQuickChatSummaryRequest(body);
  const isQuickChatOutboxLead = isCompletedChatbotLead || isDirectQuickChatSummary;
  if (isQuickChatOutboxLead) {
    const quickChatContact = validateQuickChatContact({
      body,
      lead: {
        telefono: leadTelefono,
        email: leadEmail,
      },
    });
    if (!quickChatContact.phone_valid || !quickChatContact.email_valid) {
      const invalidPhone = !quickChatContact.phone_valid;
      return res.status(422).json({
        id: null,
        quickchat_summary_saved: false,
        error: invalidPhone ? 'quickchat_phone_invalid' : 'quickchat_email_invalid',
        message: invalidPhone
          ? 'Introduce un teléfono válido de entre 9 y 15 dígitos'
          : 'Introduce un email válido o deja el campo vacío',
      });
    }
  }

  if (clinicaIdParsed !== null) {
    const clinic = await Clinica.findOne({ where: { id_clinica: clinicaIdParsed } });
    if (!clinic) {
      return res.status(400).json({ message: 'La clínica indicada no existe' });
    }
  }

  if (grupoClinicaIdParsed !== null) {
    const group = await GrupoClinica.findOne({ where: { id_grupo: grupoClinicaIdParsed } });
    if (!group) {
      if (clinicaIdParsed !== null) {
        console.warn('⚠️ Intake lead con clínica válida pero grupo no resoluble; se continúa sin group_id', {
          clinic_id: clinicaIdParsed,
          group_id: grupoClinicaIdParsed,
          event_id: eventId || null
        });
        grupoClinicaIdParsed = null;
      } else {
        return res.status(400).json({ message: 'El grupo indicado no existe' });
      }
    }
  }

  if (campanaIdParsed !== null && Campana) {
    const camp = await Campana.findByPk(campanaIdParsed);
    if (!camp) {
      return res.status(400).json({ message: 'La campaña indicada no existe' });
    }
  }

  const normalizedChannel = CHANNELS.has(channel) ? channel : 'unknown';
  const normalizedSource = normalizedSourceForRouting;
  const normalizedStatus = STATUSES.has(status_lead) ? status_lead : 'nuevo';

  const normalizedEmail = normalizeEmail(leadEmail);
  const normalizedPhone = normalizePhone(leadTelefono);
  const payloadHash = hashValue(stableStringify(req.body || {}));
  const externalSource = external_source || source || null;
  const externalId = external_id || req.body?.meta_lead_id || req.body?.google_lead_id || req.body?.form_id || eventId || null;

  if (!clinicaIdParsed && normalizedSource === 'meta_ads') {
    const pageId = coalesce(req.body?.page_id, req.body?.pageId, req.body?.page?.id, req.body?.payload?.page_id);
    const adAccountId = coalesce(req.body?.ad_account_id, req.body?.adAccountId, req.body?.payload?.ad_account_id);

    let assetFound = null;

    if (pageId) {
      assetFound = await ClinicMetaAsset.findOne({
        where: { metaAssetId: String(pageId), assetType: 'facebook_page', isActive: true }
      });
      if (assetFound) {
        clinicaIdParsed = assetFound.clinicaId || clinicaIdParsed;
        grupoClinicaIdParsed = assetFound.grupoClinicaId || grupoClinicaIdParsed;
        clinicMatchSource = clinicMatchSource || 'meta_page';
        clinicMatchValue = clinicMatchValue || String(pageId);
      }
    }

    if (!clinicaIdParsed && adAccountId) {
      const asset = await ClinicMetaAsset.findOne({
        where: { metaAssetId: String(adAccountId), assetType: 'ad_account', isActive: true }
      });
      if (asset) {
        assetFound = asset;
        clinicaIdParsed = asset.clinicaId || clinicaIdParsed;
        grupoClinicaIdParsed = asset.grupoClinicaId || grupoClinicaIdParsed;
        clinicMatchSource = clinicMatchSource || 'meta_ad_account';
        clinicMatchValue = clinicMatchValue || String(adAccountId);
      }
    }

    // Si no hay activo configurado para la página/cuenta, no ingerimos para evitar saturar
    if (!clinicaIdParsed && (pageId || adAccountId)) {
      return res.status(202).json({
        message: 'Lead descartado: activo Meta no conectado en Settings',
        page_id: pageId ? String(pageId) : null,
        ad_account_id: adAccountId ? String(adAccountId) : null
      });
    }
  }

  if (clinicaIdParsed === null && grupoClinicaIdParsed === null) {
    return res.status(202).json({
      message: 'Lead descartado: no se pudo resolver clínica o grupo',
      source: normalizedSource || null,
      clinic_match_source: clinicMatchSource || null,
      clinic_match_value: clinicMatchValue || null
    });
  }

  const leadPayload = {
    event_id: eventId,
    clinica_id: clinicaIdParsed,
    grupo_clinica_id: grupoClinicaIdParsed,
    campana_id: campanaIdParsed,
    channel: normalizedChannel,
    source: normalizedSource,
    source_detail: source_detail || null,
    clinic_match_source: clinicMatchSource,
    clinic_match_value: clinicMatchValue,
    utm_source: utmSource || null,
    utm_medium: utmMedium || null,
    utm_campaign: utmCampaign || null,
    utm_content: utmContent || null,
    utm_term: utmTerm || null,
    gclid: gclidValue || null,
    gbraid: gbraidValue || null,
    wbraid: wbraidValue || null,
    ga_client_id: gaClientIdValue || null,
    google_ads_customer_id: googleAdsCustomerIdValue || null,
    google_ads_campaign_id: googleAdsCampaignIdValue || null,
    fbclid: fbclidValue || null,
    ttclid: ttclidValue || null,
    referrer: referrerValue || null,
    page_url: pageUrlValue || null,
    landing_url: landingUrlValue || null,
    user_agent: coalesce(user_agent, req.headers['user-agent']) || null,
    ip: coalesce(ip, req.headers['x-forwarded-for'], req.socket?.remoteAddress) || null,
    nombre: leadNombre || null,
    email: leadEmail || null,
    telefono: leadTelefono || null,
    notas: leadNotas || null,
    status_lead: normalizedStatus,
    consentimiento_canal: consentValue || null,
    consent_basis: consent_basis || derivedConsentMetadata.basis || null,
    consent_captured_at: consent_captured_at
      ? parseDate(consent_captured_at)
      : derivedConsentMetadata.capturedAt,
    consent_source: consent_source || derivedConsentMetadata.source || pageUrlValue || landingUrlValue || null,
    consent_version: consent_version || derivedConsentMetadata.version || null,
    external_source: externalSource,
    external_id: externalId,
    web_project_id: webLandingAttribution?.project_id || null,
    web_revision_id: webLandingAttribution?.revision_id || null,
    web_page_id: webLandingAttribution?.page_id || null,
    web_publication_id: webLandingAttribution?.publication_id || null,
    web_artifact_id: webLandingAttribution?.artifact_id || null,
    web_form_id: webLandingAttribution?.form_id || null,
    intake_payload_hash: payloadHash
  };

  let quickChatOutboxJob = null;
  let lead;
  let dedupeConflict = null;
  let shouldEmitLeadCreated = false;
  const leadAttributionSteps = buildWebLandingAttributionSteps(webLandingAttribution, {
    clinic_match_source: clinicMatchSource || null,
    clinic_match_value: clinicMatchValue || null,
    resolved_clinic_id: clinicaIdParsed,
    resolved_group_id: grupoClinicaIdParsed,
  });
  try {
    lead = await dedupeAndCreateLead(leadPayload, req.body || {}, leadAttributionSteps, {
      quickChatOutbox: isQuickChatOutboxLead,
      onQuickChatOutboxCreated: ({ job }) => {
        quickChatOutboxJob = job || null;
      },
    });
    shouldEmitLeadCreated = true;
  } catch (err) {
    if (err.status === 422 && isQuickChatOutboxLead) {
      return res.status(422).json({
        id: null,
        quickchat_summary_saved: false,
        error: err.code || 'invalid_quickchat_contact',
        message: err.message,
      });
    }
    if (err.status === 409) {
      dedupeConflict = err;
      lead = err.existingId ? await LeadIntake.findByPk(err.existingId) : null;
      if (lead) {
        const leadUpdates = {};
        if (!lead.clinica_id && clinicaIdParsed !== null) {
          leadUpdates.clinica_id = clinicaIdParsed;
        }
        if (!lead.grupo_clinica_id && grupoClinicaIdParsed !== null) {
          leadUpdates.grupo_clinica_id = grupoClinicaIdParsed;
        }
        if (!lead.clinic_match_source && clinicMatchSource) {
          leadUpdates.clinic_match_source = clinicMatchSource;
        }
        if (!lead.clinic_match_value && clinicMatchValue) {
          leadUpdates.clinic_match_value = clinicMatchValue;
        }
        if (isQuickChatOutboxLead) {
          try {
            const persisted = await persistExistingLeadAuditAndQuickChatOutbox({
              leadId: lead.id,
              rawPayload: req.body || {},
              attributionSteps: leadAttributionSteps,
              leadUpdates,
            });
            lead = persisted.lead;
            quickChatOutboxJob = persisted.job || null;
            shouldEmitLeadCreated = Object.keys(leadUpdates).length > 0;
          } catch (outboxError) {
            if (outboxError.status === 422) {
              return res.status(422).json({
                id: null,
                quickchat_summary_saved: false,
                error: outboxError.code || 'invalid_quickchat_contact',
                message: outboxError.message,
              });
            }
            throw outboxError;
          }
        } else if (Object.keys(leadUpdates).length) {
          await lead.update(leadUpdates);
          shouldEmitLeadCreated = true;
        }
      }
    } else {
      throw err;
    }
  }

  // Ambos contratos del widget dejan audit + JobRequest en el mismo commit,
  // también cuando el lead se deduplica. El fast path consume ese mismo job;
  // nunca materializa por una segunda vía lateral.
  let quickChatFastPathOutcome = null;
  if (isQuickChatOutboxLead && lead && quickChatOutboxJob?.id) {
    try {
      quickChatFastPathOutcome = await triggerIntakeQuickChatSummaryFastPath(quickChatOutboxJob.id);
    } catch (summaryError) {
      // Defensa final: el servicio relee JobRequest incluso si triggerImmediate
      // falla. Si también fallase esta envoltura, solo sabemos que el outbox fue
      // confirmado; no inventamos un estado pending/waiting.
      quickChatFastPathOutcome = {
        quickchat_summary_saved: false,
        quickchat_summary_queued: false,
        quickchat_summary_outcome_unknown: true,
        quickchat_summary_state: 'unknown_durable',
        job_status: null,
      };
      console.warn('⚠️ No se pudo consumir inmediatamente el outbox QuickChat:', summaryError.message || summaryError);
    }
  }

  // Esta segunda acción pública termina aquí: representa solo el resumen
  // interno y jamás invoca Meta CAPI, Google Ads ni una salida de WhatsApp.
  if (lead && shouldEmitLeadCreated && cleanString(lead.source).toLowerCase() !== 'call_click') {
    try {
      await leadAutoReplyService.enqueueForLead({
        lead,
        eventKind: 'write',
        eventAt: lead.created_at || lead.createdAt || new Date(),
      });
    } catch (automationError) {
      console.warn('⚠️ No se pudo encolar la respuesta automática del lead:', automationError.message || automationError);
    }
  }

  if (isDirectQuickChatSummary) {
    if (lead && shouldEmitLeadCreated) {
      try {
        await emitLeadSocketEvent('lead:created', buildLeadCreatedSocketPayload(lead), {
          clinicId: lead.clinica_id || clinicaIdParsed,
          groupId: lead.grupo_clinica_id || grupoClinicaIdParsed,
        });
      } catch (emitErr) {
        console.warn('⚠️ No se pudo emitir lead:created:', emitErr.message || emitErr);
      }
    }

    if (quickChatFastPathOutcome?.quickchat_summary_saved === true) {
      return res.status(dedupeConflict ? 200 : 201).json({
        id: lead?.id || dedupeConflict?.existingId,
        deduped: !!dedupeConflict,
        quickchat_summary_sent: true,
        quickchat_summary_saved: true,
        quickchat_summary_queued: false,
        quickchat_summary_stale: quickChatFastPathOutcome.stale === true,
        quickchat_summary_created: quickChatFastPathOutcome.created,
        conversation_id: quickChatFastPathOutcome.conversation_id,
        message_id: quickChatFastPathOutcome.message_id,
      });
    }

    if (quickChatFastPathOutcome?.quickchat_summary_queued === true) {
      return res.status(202).json({
        id: lead?.id || dedupeConflict?.existingId || null,
        deduped: !!dedupeConflict,
        quickchat_summary_sent: false,
        quickchat_summary_saved: false,
        quickchat_summary_queued: true,
        job_status: quickChatFastPathOutcome.job_status,
      });
    }

    if (quickChatFastPathOutcome?.quickchat_summary_outcome_unknown === true) {
      return res.status(202).json({
        id: lead?.id || dedupeConflict?.existingId || null,
        deduped: !!dedupeConflict,
        quickchat_summary_sent: false,
        quickchat_summary_saved: false,
        quickchat_summary_queued: false,
        quickchat_summary_outcome_unknown: true,
        quickchat_summary_state: 'unknown_durable',
      });
    }

    const terminalHttpStatus = Number(quickChatFastPathOutcome?.http_status);
    const safeTerminalStatus = Number.isInteger(terminalHttpStatus)
      && terminalHttpStatus >= 400
      && terminalHttpStatus < 500
      ? terminalHttpStatus
      : 500;
    return res.status(safeTerminalStatus).json({
      id: lead?.id || dedupeConflict?.existingId || null,
      deduped: !!dedupeConflict,
      quickchat_summary_sent: false,
      quickchat_summary_saved: false,
      quickchat_summary_queued: false,
      error: quickChatFastPathOutcome?.error_code || 'quickchat_summary_failed',
      message: quickChatFastPathOutcome?.error_message || 'No se pudo crear el resumen QuickChat',
    });
  }

  const embeddedQuickChatSummary = quickChatFastPathOutcome?.quickchat_summary_saved === true
    ? quickChatFastPathOutcome
    : null;

  let formSubmissionEvent = null;
  if (formSubmission && FormSubmissionEvent) {
    try {
      formSubmissionEvent = await FormSubmissionEvent.create({
        clinic_id: lead?.clinica_id || clinicaIdParsed,
        group_id: lead?.grupo_clinica_id || grupoClinicaIdParsed,
        lead_intake_id: lead?.id || null,
        page_url: formSubmission.page_url || pageUrlValue || landingUrlValue || null,
        form_id: formSubmission.form_id || null,
        form_name: formSubmission.form_name || null,
        form_selector: formSubmission.form_selector || null,
        match_domain: normalizeDomain(getHostnameFromUrl(formSubmission.page_url || pageUrlValue || '')),
        source_detail: source_detail || 'web_form',
        email_normalized: normalizedEmail,
        phone_normalized: normalizedPhone,
        fields_json: formSubmission.fields || {},
        payload_json: formSubmission.payload || req.body || {},
        submitted_at: formSubmission.submitted_at || new Date(),
      });

      await enqueueInboundFormSubmissionResume({
        clinicId: lead?.clinica_id || clinicaIdParsed,
        leadId: lead?.id || null,
        email: normalizedEmail,
        phone: normalizedPhone,
        pageUrl: formSubmission.page_url || pageUrlValue || null,
        formId: formSubmission.form_id || null,
        formName: formSubmission.form_name || null,
        formSelector: formSubmission.form_selector || null,
        fields: formSubmission.fields || {},
        submittedAt: formSubmission.submitted_at instanceof Date
          ? formSubmission.submitted_at.toISOString()
          : String(formSubmission.submitted_at || ''),
        formSubmissionEventId: formSubmissionEvent.id,
        sourceDetail: source_detail || 'web_form',
        payload: formSubmission.payload || req.body || {},
      });
    } catch (formErr) {
      console.warn('⚠️ No se pudo registrar/reanudar envío de formulario:', formErr.message || formErr);
    }
  }

  if (lead && shouldEmitLeadCreated) {
    try {
      await emitLeadSocketEvent('lead:created', buildLeadCreatedSocketPayload(lead), {
        clinicId: lead.clinica_id || clinicaIdParsed,
        groupId: lead.grupo_clinica_id || grupoClinicaIdParsed
      });
    } catch (emitErr) {
      console.warn('⚠️ No se pudo emitir lead:created:', emitErr.message || emitErr);
    }
  }

  // Un cierre `chatbot` deduplicado ya conserva su audit/outbox y no es una
  // nueva conversión publicitaria. Devuelve el outcome del mismo job antes de
  // Meta/Google; el 409 general inferior queda reservado al resto de dedupes.
  if (dedupeConflict && isCompletedChatbotLead) {
    if (quickChatFastPathOutcome?.quickchat_summary_saved === true) {
      return res.status(200).json({
        id: lead?.id || dedupeConflict.existingId,
        deduped: true,
        quickchat_summary_saved: true,
        quickchat_summary_queued: false,
        quickchat_summary_stale: quickChatFastPathOutcome.stale === true,
        quickchat_summary_created: quickChatFastPathOutcome.created,
        conversation_id: quickChatFastPathOutcome.conversation_id,
        message_id: quickChatFastPathOutcome.message_id,
      });
    }
    if (quickChatFastPathOutcome?.quickchat_summary_queued === true) {
      return res.status(202).json({
        id: lead?.id || dedupeConflict.existingId,
        deduped: true,
        quickchat_summary_saved: false,
        quickchat_summary_queued: true,
        job_status: quickChatFastPathOutcome.job_status,
      });
    }
    if (quickChatFastPathOutcome?.quickchat_summary_outcome_unknown === true) {
      return res.status(202).json({
        id: lead?.id || dedupeConflict.existingId,
        deduped: true,
        quickchat_summary_saved: false,
        quickchat_summary_queued: false,
        quickchat_summary_outcome_unknown: true,
        quickchat_summary_state: 'unknown_durable',
      });
    }
    const terminalHttpStatus = Number(quickChatFastPathOutcome?.http_status);
    const safeTerminalStatus = Number.isInteger(terminalHttpStatus)
      && terminalHttpStatus >= 400
      && terminalHttpStatus < 500
      ? terminalHttpStatus
      : 500;
    return res.status(safeTerminalStatus).json({
      id: lead?.id || dedupeConflict.existingId,
      deduped: true,
      quickchat_summary_saved: false,
      quickchat_summary_queued: false,
      error: quickChatFastPathOutcome?.error_code || 'quickchat_summary_failed',
      ...(quickChatFastPathOutcome?.error_message
        ? { message: quickChatFastPathOutcome.error_message }
        : {}),
    });
  }

  if (dedupeConflict) {
    return res.status(409).json({ message: dedupeConflict.message, id: dedupeConflict.existingId, reason: dedupeConflict.message });
  }

  // Permite al snippet solicitar un evento concreto (p. ej. Contact para tel_modal).
  // Si viene vacío o es inválido, mantenemos Lead por defecto (compatibilidad).
  const requestedEventNameRaw = coalesce(body.event_name, body.eventName);
  const requestedEventName = requestedEventNameRaw ? String(requestedEventNameRaw).trim().toLowerCase() : '';
  const normalizedEventNameForCapi =
    requestedEventName === 'contact' ? 'Contact' :
      requestedEventName === 'schedule' ? 'Schedule' :
        requestedEventName === 'purchase' ? 'Purchase' :
          'Lead';

  const finalClinicCfg = clinicaIdParsed !== null
    ? await IntakeConfig.findOne({ where: { clinic_id: clinicaIdParsed }, raw: true })
    : null;
  const finalGroupCfg = grupoClinicaIdParsed !== null
    ? await IntakeConfig.findOne({ where: { group_id: grupoClinicaIdParsed, assignment_scope: 'group' }, raw: true })
    : null;
  const effectiveTracking = resolveEffectiveTrackingFromRecords({
    clinicId: clinicaIdParsed,
    groupId: grupoClinicaIdParsed,
    selectedRecord: cfg,
    clinicCfg: finalClinicCfg,
    groupCfg: finalGroupCfg
  });
  const metaRuntime = await resolveMetaCapiRuntimeConfig({
    clinicId: clinicaIdParsed,
    groupId: grupoClinicaIdParsed,
    selectedRecord: cfg,
    clinicCfg: finalClinicCfg,
    groupCfg: finalGroupCfg
  });
  const leadConsentModeEnabled = [cfg, finalClinicCfg, finalGroupCfg].some(isConsentModeEnabledForRecord);
  const leadMarketingConsent = normalizeMarketingConsent(coalesce(body.consent, body.consentimiento_canal) || null);
  const allowLeadAdPlatformEvents = !leadConsentModeEnabled || leadMarketingConsent === true;

  // Emitir a Meta CAPI si hay datos mínimos
  try {
    const userData = buildMetaUserData({
      email: leadEmail,
      phone: leadTelefono,
      ip: coalesce(ip, req.headers['x-forwarded-for'], req.socket?.remoteAddress),
      ua: coalesce(user_agent, req.headers['user-agent']),
      externalId: lead.id
    });
    if (allowLeadAdPlatformEvents) {
      await sendMetaEvent({
        eventName: normalizedEventNameForCapi,
        eventTime: Math.floor(Date.now() / 1000),
        eventId: lead.event_id || `lead-${lead.id}`,
        actionSource: 'website',
        eventSourceUrl: pageUrlValue || landingUrlValue || null,
        clinicId: clinicaIdParsed,
        source: normalizedSource,
        sourceDetail: source_detail || null,
        utmCampaign: utmCampaign || null,
        userData,
        pixelId: metaRuntime.pixelId,
        accessToken: metaRuntime.accessToken
      });
    }
  } catch (e) {
    console.warn('⚠️ No se pudo enviar evento Meta CAPI:', e.message || e);
  }

  // Conversión server-side de Google Ads al capturar lead/contact.
  // Siempre que sea posible se atribuye por click id. Para los scopes/eventos
  // autorizados y con consentimiento explícito, la misma petición añade email
  // y teléfono normalizados + SHA-256 como Conversión mejorada; nunca adjunta
  // tratamiento, página sensible ni datos clínicos.
  try {
    const googleCustomData = {
      gclid: gclidValue || null,
      gbraid: gbraidValue || null,
      wbraid: wbraidValue || null,
      client_id: gaClientIdValue || null,
      value: coalesce(body.value, body.conversion_value),
      currency: coalesce(body.currency, body.conversion_currency),
      conversion_time: coalesce(body.conversion_time, body.conversionDateTime, new Date()),
      customer_id: coalesce(googleAdsCustomerIdValue, body.customerId),
      campaign_id: googleAdsCampaignIdValue || null,
      conversion_action: coalesce(body.conversion_action, body.conversionAction),
      conversion_action_id: coalesce(body.conversion_action_id, body.conversionActionId),
      send_to: coalesce(body.send_to, body.sendTo),
      consent: coalesce(body.consent, body.consentimiento_canal)
    };
    await maybeUploadGoogleConversion({
      cfgRecord: cfg,
      googleAdsConfig: effectiveTracking.google_ads,
      eventName: normalizedEventNameForCapi,
      customData: googleCustomData,
      userData: {
        email: leadEmail,
        phone: leadTelefono
      },
      consent: coalesce(body.consent, body.consentimiento_canal),
      eventId: lead.event_id || `lead-${lead.id}`,
      clinicId: clinicaIdParsed,
      groupId: grupoClinicaIdParsed,
      assignmentScope: effectiveTracking.google_ads?.config_source === 'group' ? 'group' : 'clinic',
      allowUpload: allowLeadAdPlatformEvents,
      consentModeEnabled: leadConsentModeEnabled
    });
  } catch (adsErr) {
    console.warn('⚠️ Google Ads upload error (ingestLead):', adsErr.response?.data || adsErr.message || adsErr);
  }

  const quickChatSummaryQueued = isCompletedChatbotLead
    && quickChatFastPathOutcome?.quickchat_summary_queued === true;
  const quickChatSummaryOutcomeUnknown = isCompletedChatbotLead
    && quickChatFastPathOutcome?.quickchat_summary_outcome_unknown === true;
  const quickChatSummaryFailed = isCompletedChatbotLead
    && quickChatFastPathOutcome?.quickchat_summary_saved !== true
    && quickChatFastPathOutcome?.quickchat_summary_queued !== true
    && quickChatFastPathOutcome?.quickchat_summary_outcome_unknown !== true;
  const quickChatTerminalHttpStatus = Number(quickChatFastPathOutcome?.http_status);
  const safeQuickChatTerminalStatus = Number.isInteger(quickChatTerminalHttpStatus)
    && quickChatTerminalHttpStatus >= 400
    && quickChatTerminalHttpStatus < 500
    ? quickChatTerminalHttpStatus
    : 500;
  const ingestResponseStatus = quickChatSummaryQueued || quickChatSummaryOutcomeUnknown
    ? 202
    : (quickChatSummaryFailed ? safeQuickChatTerminalStatus : 201);

  res.status(ingestResponseStatus).json({
    id: lead.id,
    ...(dedupeConflict ? { deduped: true } : {}),
    ...(embeddedQuickChatSummary
      ? {
          quickchat_summary_saved: true,
          quickchat_summary_queued: false,
          quickchat_summary_stale: embeddedQuickChatSummary.stale === true,
          quickchat_summary_created: embeddedQuickChatSummary.created,
          conversation_id: embeddedQuickChatSummary.conversation_id,
          message_id: embeddedQuickChatSummary.message_id,
        }
      : {}),
    ...(quickChatSummaryQueued
      ? {
          quickchat_summary_saved: false,
          quickchat_summary_queued: true,
          job_status: quickChatFastPathOutcome.job_status,
        }
      : {}),
    ...(quickChatSummaryOutcomeUnknown
      ? {
          quickchat_summary_saved: false,
          quickchat_summary_queued: false,
          quickchat_summary_outcome_unknown: true,
          quickchat_summary_state: 'unknown_durable',
        }
      : {}),
    ...(quickChatSummaryFailed
      ? {
          quickchat_summary_saved: false,
          quickchat_summary_queued: false,
          error: quickChatFastPathOutcome?.error_code || 'quickchat_summary_failed',
          ...(quickChatFastPathOutcome?.error_message
            ? { message: quickChatFastPathOutcome.error_message }
            : {}),
        }
      : {}),
  });

});

exports.previewLeadImport = asyncHandler(async (req, res) => {
  if (!(await requireLeadManageForImport(req, res))) return;
  const preview = await previewLeadImport(req.body || {});
  return res.json(preview);
});

exports.executeLeadImport = asyncHandler(async (req, res) => {
  if (!(await requireLeadManageForImport(req, res))) return;
  const result = await executeLeadImport(req.body || {});
  return res.status(201).json(result);
});

// ===========================
// Configuración del snippet
// ===========================

const DEFAULT_CHAT_FLOW = {
  version: '1.0',
  steps: [
    { type: 'message', text: 'Hola. Te ayudamos a pedir cita.' },
    { type: 'input', text: 'Como te llamas?', input_type: 'text', placeholder: 'Tu nombre', field: 'nombre' },
    { type: 'input', text: 'Gracias {{paciente.nombre}}. Cual es tu telefono?', input_type: 'tel', placeholder: 'Tu telefono', field: 'telefono' },
    { type: 'input', text: 'Y tu email? (opcional)', input_type: 'email', placeholder: 'Tu email', field: 'email' },
    { type: 'cta', text: 'Confirma que quieres que te contactemos:', button_text: 'Ok, contactadme' }
  ]
};

const DEFAULT_TEXTS = {
  chat_title: 'WhatsApp',
  chat_welcome: 'Hola. Quieres pedirnos una cita de valoracion sin coste?',
  // Tel modal (bloqueante): capturamos datos antes de abrir tel:
  // Nota: el snippet soporta variables {nombre_clinica} y {telefono}.
  tel_modal_title: 'Conectando con la recepción de {nombre_clinica}',
  tel_modal_subtitle: 'Déjanos tu teléfono por si se pierde la conexión',
  consent_text: 'Acepto la politica de privacidad',
  privacy_url: '/politica-privacidad',
  terms_url: '/terminos-y-condiciones'
};

const DEFAULT_APPEARANCE = {
  position: 'bottom-right',
  icon_type: 'whatsapp',
  icon_color: '#FFFFFF',
  icon_bg_color: '#25D366',
  bubble_text: 'Necesitas ayuda?',
  bubble_enabled: true,
  bubble_delay: 3000,
  bubble_bg_color: '#FFFFFF',
  bubble_text_color: '#1F2937',
  animation: 'bounce',
  header_bg_color: '#075E54',
  header_text_color: '#FFFFFF',
  chat_width: 380,
  chat_height: 520,
  auto_open_delay: 0,
  typing_delay: 1500,
  mobile_fullscreen: true,
  frequency: 'every_visit',
  frequency_hours: 24,
  show_branding: true,
  // Tel modal header color (used for gradient + button styling in snippet)
  tel_modal_header_color: '#3B82F6'
};

const DEFAULT_GOOGLE_ADS = {
  enabled: false,
  customer_id: null,
  conversion_action: null,
  conversion_action_id: null,
  send_to: null,
  currency: 'EUR'
};

const DEFAULT_META_ADS = {
  enabled: true,
  connection_id: null,
  ad_account_id: null,
  pixel_id: null
};

const DEFAULT_CLINIC_TIMEZONE = 'Europe/Madrid';

const parseClinicConfigForSchedule = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }
  return null;
};

const isValidTimeZone = (value) => {
  if (!value || typeof value !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch (_error) {
    return false;
  }
};

const resolveClinicTimezoneForSchedule = (clinica) => {
  const cfg = parseClinicConfigForSchedule(clinica?.configuracion);
  const candidate = cfg?.timezone || cfg?.timeZone || cfg?.tz;
  return isValidTimeZone(candidate) ? candidate : DEFAULT_CLINIC_TIMEZONE;
};

const formatPartsInTimeZone = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const bag = {};
  for (const part of parts) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }

  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
};

const pad2 = (value) => String(value).padStart(2, '0');

const formatLocalDateFromParts = (parts) => `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
const formatLocalTimeFromParts = (parts) => `${pad2(parts.hour)}:${pad2(parts.minute)}`;
const dayIndexFromLocalDate = (fechaLocal) => new Date(`${fechaLocal}T12:00:00Z`).getUTCDay();

const minutesFromHm = (value) => {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};

const normalizeDisciplinesFromClinicConfigForFlow = (configuracion) => {
  const cfg = parseClinicConfigForSchedule(configuracion) || {};
  const raw = Array.isArray(cfg.disciplinas) ? cfg.disciplinas : (cfg.disciplina ? [cfg.disciplina] : []);
  return raw
    .map((d) => String(d || '').trim().toLowerCase())
    .filter(Boolean);
};

const matchesTemplateDisciplinesForFlow = (templateDisciplinaCodes, clinicDisciplinaCodes) => {
  const templateCodes = Array.isArray(templateDisciplinaCodes)
    ? templateDisciplinaCodes.map((code) => String(code || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const clinicCodes = Array.isArray(clinicDisciplinaCodes)
    ? clinicDisciplinaCodes.map((code) => String(code || '').trim().toLowerCase()).filter(Boolean)
    : [];

  if (clinicCodes.length === 0) return true;
  if (templateCodes.length === 0) return true;
  return templateCodes.some((code) => clinicCodes.includes(code));
};

const DAY_SHORT_LABELS = {
  0: 'D',
  1: 'L',
  2: 'M',
  3: 'X',
  4: 'J',
  5: 'V',
  6: 'S',
};

const formatOpeningHourTime = (value) => {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value || '').trim();
  const hour = String(Number(match[1]));
  const minute = match[2] === '00' ? '' : `:${match[2]}`;
  return `${hour}${minute}`;
};

const formatOpeningHourRanges = (ranges) => {
  const validRanges = (ranges || [])
    .map((range) => ({
      start: String(range?.hora_inicio || '').trim(),
      end: String(range?.hora_fin || '').trim(),
    }))
    .filter((range) => range.start && range.end)
    .sort((a, b) => a.start.localeCompare(b.start));

  if (!validRanges.length) return '';

  return validRanges
    .map((range) => `de ${formatOpeningHourTime(range.start)} a ${formatOpeningHourTime(range.end)}h`)
    .join(' y ');
};

const formatDayGroupLabel = (days) => {
  const ordered = (days || []).map((day) => Number(day)).filter((day) => Number.isInteger(day));
  if (!ordered.length) return '';
  if (ordered.length === 1) return DAY_SHORT_LABELS[ordered[0]] || '';

  const groups = [];
  let start = ordered[0];
  let prev = ordered[0];
  for (let i = 1; i < ordered.length; i++) {
    const current = ordered[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    groups.push(start === prev ? DAY_SHORT_LABELS[start] : `${DAY_SHORT_LABELS[start]}-${DAY_SHORT_LABELS[prev]}`);
    start = current;
    prev = current;
  }
  groups.push(start === prev ? DAY_SHORT_LABELS[start] : `${DAY_SHORT_LABELS[start]}-${DAY_SHORT_LABELS[prev]}`);
  return groups.join(' y ');
};

const buildOpeningHoursText = (horarios) => {
  if (!Array.isArray(horarios) || horarios.length === 0) return null;

  const activeByDay = new Map();
  horarios
    .filter((h) => h && (h.activo === undefined || h.activo === true || h.activo === 1))
    .forEach((h) => {
      const day = Number(h.dia_semana);
      if (!Number.isInteger(day) || day < 0 || day > 6) return;
      const list = activeByDay.get(day) || [];
      list.push({ hora_inicio: h.hora_inicio, hora_fin: h.hora_fin });
      activeByDay.set(day, list);
    });

  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  const groupsBySignature = [];
  for (const day of dayOrder) {
    const ranges = activeByDay.get(day) || [];
    const rangeText = formatOpeningHourRanges(ranges);
    if (!rangeText) continue;
    const last = groupsBySignature[groupsBySignature.length - 1];
    if (last && last.rangeText === rangeText) {
      last.days.push(day);
    } else {
      groupsBySignature.push({ rangeText, days: [day] });
    }
  }

  if (!groupsBySignature.length) return null;

  return groupsBySignature
    .map((group) => `${formatDayGroupLabel(group.days)} ${group.rangeText}`)
    .join(' y ');
};

const buildOpeningHoursTextByClinicId = async (clinicIds) => {
  const ids = Array.from(new Set((clinicIds || []).map((id) => parseInteger(id)).filter(Boolean)));
  const result = new Map();
  if (!ids.length || !ClinicaHorario) return result;

  const rows = await ClinicaHorario.findAll({
    where: { clinica_id: { [Op.in]: ids }, activo: true },
    attributes: ['clinica_id', 'dia_semana', 'hora_inicio', 'hora_fin'],
    raw: true,
  });

  for (const id of ids) {
    const horarios = rows.filter((row) => Number(row.clinica_id) === Number(id));
    result.set(id, buildOpeningHoursText(horarios));
  }

  return result;
};

const resolveClinicOpenState = async (clinicId) => {
  const normalizedClinicId = parseInteger(clinicId);
  if (!normalizedClinicId || !ClinicaHorario) {
    return { open_now: null, has_schedule: false, checked_at: new Date().toISOString() };
  }

  const clinica = await Clinica.findOne({
    where: { id_clinica: normalizedClinicId },
    attributes: ['id_clinica', 'configuracion'],
    raw: true,
  });
  const timeZone = resolveClinicTimezoneForSchedule(clinica);
  const now = new Date();
  const parts = formatPartsInTimeZone(now, timeZone);
  const localDate = formatLocalDateFromParts(parts);
  const localTime = formatLocalTimeFromParts(parts);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const dow = dayIndexFromLocalDate(localDate);

  const horarios = await ClinicaHorario.findAll({
    where: { clinica_id: normalizedClinicId, activo: true },
    attributes: ['dia_semana', 'hora_inicio', 'hora_fin'],
    raw: true,
  });

  if (!Array.isArray(horarios) || horarios.length === 0) {
    return {
      open_now: null,
      has_schedule: false,
      timezone: timeZone,
      local_date: localDate,
      local_time: localTime,
      checked_at: now.toISOString(),
    };
  }

  const todaysWindows = horarios
    .filter((h) => Number(h.dia_semana) === dow)
    .map((h) => ({
      start: minutesFromHm(h.hora_inicio),
      end: minutesFromHm(h.hora_fin),
    }))
    .filter((w) => w.start !== null && w.end !== null && w.start < w.end);

  const openNow = todaysWindows.some((w) => currentMinutes >= w.start && currentMinutes < w.end);
  return {
    open_now: openNow,
    has_schedule: true,
    timezone: timeZone,
    local_date: localDate,
    local_time: localTime,
    checked_at: now.toISOString(),
  };
};

const extractClosedClinicFlowRules = (template) => {
  const base = template?.toJSON ? template.toJSON() : template;
  if (!base || !base.show_when_clinic_closed) return [];

  if (Array.isArray(base.flows) && base.flows.length > 0) {
    return base.flows
      .filter((flowRule) => flowRule?.flow?.steps?.length > 0)
      .map((flowRule, index) => ({
        id: `template_${base.id}_${index}`,
        name: resolveChatFlowTemplateRuleName(base, flowRule.name),
        is_default: false,
        enabled: flowRule.enabled !== false,
        url_rules: Array.isArray(flowRule.url_rules) && flowRule.url_rules.length ? flowRule.url_rules : ['*'],
        show_when_clinic_closed: true,
        template_id: base.id,
        catalog_template_id: base.id,
        template_flow_index: index,
        catalog_template_flow_index: index,
        flow: flowRule.flow,
      }));
  }

  if (base.flow?.steps?.length > 0) {
    return [{
      id: `template_${base.id}_0`,
      name: base.name,
      is_default: false,
      enabled: true,
      url_rules: ['*'],
      show_when_clinic_closed: true,
      template_id: base.id,
      catalog_template_id: base.id,
      template_flow_index: 0,
      catalog_template_flow_index: 0,
      flow: base.flow,
    }];
  }

  return [];
};

function resolveChatFlowTemplateRuleName(template, flowName) {
  const baseName = String(template?.name || '').trim();
  const name = String(flowName || '').trim();
  if (!name || name.toLowerCase() === 'default') return baseName || 'Flujo de chat';
  return name;
}

const getCatalogTemplateIdFromFlowRule = (flowRule) => {
  const parsed = parseInteger(flowRule?.catalog_template_id ?? flowRule?.template_id ?? flowRule?._templateId);
  if (parsed) return parsed;

  const idMatch = String(flowRule?.id || '').match(/^catalog_(\d+)_\d+$/);
  if (idMatch) {
    const idParsed = parseInteger(idMatch[1]);
    if (idParsed) return idParsed;
  }

  return null;
};

const getCatalogTemplateFlowIndexFromFlowRule = (flowRule) => {
  const value = flowRule?.catalog_template_flow_index ?? flowRule?.template_flow_index;
  if (value !== undefined && value !== null) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  const idMatch = String(flowRule?.id || '').match(/^catalog_\d+_(\d+)$/);
  if (idMatch) {
    const indexParsed = Number(idMatch[1]);
    if (Number.isFinite(indexParsed)) return indexParsed;
  }

  return 0;
};

const hasCatalogFlowCopy = (flows, templateId, templateFlowIndex) => {
  const parsedTemplateId = parseInteger(templateId);
  if (!parsedTemplateId) return false;
  return (flows || []).some((flowRule) => (
    getCatalogTemplateIdFromFlowRule(flowRule) === parsedTemplateId
    && getCatalogTemplateFlowIndexFromFlowRule(flowRule) === Number(templateFlowIndex || 0)
  ));
};

const loadClosedClinicTemplateFlows = async (clinicId) => {
  const normalizedClinicId = parseInteger(clinicId);
  if (!normalizedClinicId || !ChatFlowTemplate) return [];

  const clinica = await Clinica.findOne({
    where: { id_clinica: normalizedClinicId },
    attributes: ['id_clinica', 'configuracion'],
    raw: true,
  });
  const clinicDisciplinaCodes = normalizeDisciplinesFromClinicConfigForFlow(clinica?.configuracion);

  const templates = await ChatFlowTemplate.findAll({
    where: { is_active: true, show_when_clinic_closed: true },
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
  });

  return (templates || [])
    .filter((template) => matchesTemplateDisciplinesForFlow(template.disciplina_codes, clinicDisciplinaCodes))
    .flatMap(extractClosedClinicFlowRules);
};

const defaultConfigPayload = (clinicId, groupId) => ({
  clinic_id: clinicId || null,
  group_id: groupId || null,
  assignment_scope: groupId ? 'group' : 'clinic',
  config_exists: false,
  domains: [],
  features: {
    chat_enabled: true,
    tel_modal_enabled: true,
    viewcontent_enabled: true,
    form_intercept_enabled: true,
    webevents_enabled: true,
    consent_mode_enabled: false,
    consent_provider: 'clinicaclick',
    external_cmp_provider: 'complianz',
    // Capability flag only: the emitted value is always the visitor's choice.
    // Defaults never imply GRANTED consent.
    ad_personalization_enabled: true,
    ad_personalization_consent_source: 'visitor_choice',
    google_ads_user_data_enabled: false,
    google_ads_user_data_disclosure_confirmed: false,
    google_ads_user_data_runtime_enabled: false
  },
  flow: DEFAULT_CHAT_FLOW,
  flows: null,
  appearance: DEFAULT_APPEARANCE,
  google_ads: DEFAULT_GOOGLE_ADS,
  meta_ads: DEFAULT_META_ADS,
  tracking: {
    meta_ads: {
      enabled: false,
      pixel_id: null,
      tag_injection_enabled: false,
      config_source: null
    },
    google_ads: {
      enabled: false,
      send_to: null,
      tag_id: null,
      tag_injection_enabled: false,
      config_source: null
    }
  },
  texts: DEFAULT_TEXTS,
  clinic_open_state: null,
  snippet_verification: null,
  locations: [],
  has_hmac: false,
  config: {}
});

const resolveSharedWebGroupConfigForClinic = async (clinicId) => {
  const parsedClinicId = parseInteger(clinicId);
  if (parsedClinicId === null) {
    return null;
  }

  const clinicRow = await Clinica.findOne({
    where: { id_clinica: parsedClinicId },
    attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
    raw: true
  });
  const groupId = parseInteger(clinicRow?.grupoClinicaId);
  if (!clinicRow || groupId === null) {
    return { clinicRow, groupId: null, record: null };
  }

  const group = await GrupoClinica.findOne({
    where: { id_grupo: groupId },
    attributes: ['id_grupo', 'nombre_grupo', 'web_assignment_mode'],
    raw: true
  });
  const record = await IntakeConfig.findOne({
    where: { group_id: groupId, assignment_scope: 'group' },
    raw: true
  });
  const recordConfig = record?.config && typeof record.config === 'object'
    && !Array.isArray(record.config)
    ? record.config
    : {};
  const locationIds = new Set((Array.isArray(recordConfig.locations) ? recordConfig.locations : [])
    .map((location) => parseInteger(location?.id || location?.clinic_id))
    .filter(Boolean));
  const usesSharedWebConfig = group?.web_assignment_mode === 'automatic'
    || locationIds.has(parsedClinicId);

  return {
    clinicRow,
    groupId,
    group,
    record: usesSharedWebConfig ? (record || null) : null
  };
};

const getIntakeConfig = async (
  req,
  res,
  { includeAllLocations = false, allowedLocationClinicIds = null } = {},
) => {
  // La config es “source of truth” para el snippet; evitar 304/ETag y cachés agresivas.
  res.set('Cache-Control', 'no-store');

  const clinicIdRaw = req.query.clinic_id;
  const groupIdRaw = req.query.group_id;
  const domain = normalizeDomain(String(req.query.domain || '')) || '';
  const clinicIdParsed = parseInteger(clinicIdRaw);
  const groupIdParsed = parseInteger(groupIdRaw);

  let record = null;
  let sharedWebContext = null;
  // Prioridad:
  // - Si el snippet pasa clinic_id explícito y su grupo usa web compartida => config efectiva de grupo.
  // - Si el snippet pasa clinic_id explícito sin web compartida => config de clínica.
  // - Si el snippet pasa group_id explícito => config de grupo.
  // - Si no hay IDs => resolver por dominio (primero clínica, aplicando web compartida, luego grupo).
  //
  // Motivo: el HMAC se configura por scope (clínica vs grupo). Si el snippet se instala con
  // data-group-id, NO debemos devolver config de clínica solo por el dominio, o el snippet firmará
  // con la key de grupo pero el backend esperará la key de clínica (401).
  if (clinicIdParsed !== null) {
    sharedWebContext = await resolveSharedWebGroupConfigForClinic(clinicIdParsed);
    record = sharedWebContext?.record || null;
    if (!record) {
      record = await IntakeConfig.findOne({ where: { clinic_id: clinicIdParsed }, raw: true });
    }
  }
  if (!record && groupIdParsed !== null) {
    record = await IntakeConfig.findOne({ where: { group_id: groupIdParsed, assignment_scope: 'group' }, raw: true });
  }
  if (!record && domain) {
    record = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain}\"') AND assignment_scope='clinic'`)
    });
    if (record && record.get) record = record.get({ plain: true });
    if (record?.clinic_id) {
      sharedWebContext = await resolveSharedWebGroupConfigForClinic(record.clinic_id);
      record = sharedWebContext?.record || record;
    }
  }
  if (!record && domain) {
    record = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain}\"') AND assignment_scope='group'`)
    });
    if (record && record.get) record = record.get({ plain: true });
  }

  let effectiveClinicId = sharedWebContext?.clinicRow?.id_clinica || record?.clinic_id || clinicIdParsed || null;
  let effectiveGroupId = sharedWebContext?.groupId || record?.group_id || groupIdParsed || null;
  let effectiveClinicRow = sharedWebContext?.clinicRow || null;
  let effectiveGroupRow = sharedWebContext?.group || null;
  if (!effectiveGroupId && effectiveClinicId) {
    effectiveClinicRow = await Clinica.findOne({
      where: { id_clinica: effectiveClinicId },
      attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
      raw: true
    });
    effectiveGroupId = parseInteger(effectiveClinicRow?.grupoClinicaId);
  }

  const clinicRecord = effectiveClinicId
    ? await IntakeConfig.findOne({ where: { clinic_id: effectiveClinicId }, raw: true })
    : null;
  const groupRecord = effectiveGroupId
    ? await IntakeConfig.findOne({ where: { group_id: effectiveGroupId, assignment_scope: 'group' }, raw: true })
    : null;
  const effectiveTracking = resolveEffectiveTrackingFromRecords({
    clinicId: effectiveClinicId,
    groupId: effectiveGroupId,
    selectedRecord: record,
    clinicCfg: clinicRecord,
    groupCfg: groupRecord
  });

  const payload = defaultConfigPayload(record?.clinic_id || clinicIdParsed, record?.group_id || groupIdParsed);
  if (effectiveClinicId && !effectiveClinicRow) {
    effectiveClinicRow = await Clinica.findOne({
      where: { id_clinica: effectiveClinicId },
      attributes: ['id_clinica', 'nombre_clinica'],
      raw: true
    });
  }
  if (effectiveClinicRow?.nombre_clinica) {
    payload.clinic_name = effectiveClinicRow.nombre_clinica;
  }
  if (effectiveGroupId && !effectiveGroupRow) {
    effectiveGroupRow = await GrupoClinica.findOne({
      where: { id_grupo: effectiveGroupId },
      attributes: ['id_grupo', 'nombre_grupo'],
      raw: true
    });
  }
  if (effectiveGroupRow?.nombre_grupo) {
    payload.group_name = effectiveGroupRow.nombre_grupo;
    if (record?.assignment_scope === 'group' || sharedWebContext?.record || groupIdParsed !== null) {
      payload.clinic_name = effectiveGroupRow.nombre_grupo;
    }
  }
  if (record) {
    const cfg = record.config || {};
    payload.config_exists = true;
    payload.clinic_id = record.clinic_id || null;
    payload.group_id = record.group_id || null;
    payload.assignment_scope = record.assignment_scope || payload.assignment_scope;
    payload.domains = record.domains || [];
    payload.features = { ...payload.features, ...(cfg.features || {}) };
    payload.flow = cfg.flow || payload.flow;
    payload.flows = cfg.flows || payload.flows;
    payload.appearance = { ...payload.appearance, ...(cfg.appearance || {}) };
    payload.google_ads = { ...payload.google_ads, ...normalizeEffectiveGoogleAdsConfig(effectiveTracking.google_ads || {}) };
    payload.meta_ads = { ...payload.meta_ads, ...normalizeMetaAdsConfig(effectiveTracking.meta_ads || {}) };
    payload.tracking = {
      meta_ads: {
        enabled: effectiveTracking.meta_ads.enabled !== false && !!effectiveTracking.meta_ads.pixel_id,
        pixel_id: effectiveTracking.meta_ads.pixel_id || null,
        config_source: effectiveTracking.meta_ads.config_source || null,
        tag_injection_enabled: !!effectiveTracking.meta_ads.pixel_id
      },
      google_ads: {
        enabled: effectiveTracking.google_ads.enabled !== false && !!extractGoogleTagId(effectiveTracking.google_ads.send_to),
        send_to: effectiveTracking.google_ads.send_to || null,
        tag_id: extractGoogleTagId(effectiveTracking.google_ads.send_to),
        config_source: effectiveTracking.google_ads.config_source || null,
        tag_injection_enabled: !!extractGoogleTagId(effectiveTracking.google_ads.send_to)
      }
    };
    payload.texts = { ...payload.texts, ...(cfg.texts || {}) };
    payload.snippet_verification = cfg.snippet_verification || null;
    if (!includeAllLocations && payload.snippet_verification) {
      // The public runtime needs feature flags, not reusable admin proofs.
      const {
        attestations_by_domain: _attestations,
        attestation_config_hash: _configHash,
        ...publicVerificationSummary
      } = payload.snippet_verification;
      payload.snippet_verification = publicVerificationSummary;
    }
    if (!includeAllLocations && payload.features) {
      const {
        ad_personalization_activation_audit: _personalizationAudit,
        ...publicFeatures
      } = payload.features;
      payload.features = publicFeatures;
    }
    payload.locations = cfg.locations || [];
    payload.config = includeAllLocations
      ? cfg
      : {
          features: payload.features,
          flow: payload.flow,
          flows: payload.flows,
          appearance: payload.appearance,
          google_ads: payload.google_ads,
          meta_ads: payload.meta_ads,
          texts: payload.texts,
          snippet_verification: payload.snippet_verification,
          locations: payload.locations,
        };
    payload.has_hmac = !!record.hmac_key;
    if (sharedWebContext?.record) {
      payload.effective_config_source = 'group_web_shared';
      payload.requested_clinic_id = clinicIdParsed || sharedWebContext.clinicRow?.id_clinica || null;
    }
    if (domain && payload.domains.length > 0 && !isDomainAllowed(payload.domains, domain)) {
      return res.status(403).json({ message: 'Domain not allowed' });
    }
  } else {
    payload.google_ads = { ...payload.google_ads, ...normalizeEffectiveGoogleAdsConfig(effectiveTracking.google_ads || {}) };
    payload.meta_ads = { ...payload.meta_ads, ...normalizeMetaAdsConfig(effectiveTracking.meta_ads || {}) };
    payload.tracking = {
      meta_ads: {
        enabled: effectiveTracking.meta_ads.enabled !== false && !!effectiveTracking.meta_ads.pixel_id,
        pixel_id: effectiveTracking.meta_ads.pixel_id || null,
        config_source: effectiveTracking.meta_ads.config_source || null,
        tag_injection_enabled: !!effectiveTracking.meta_ads.pixel_id
      },
      google_ads: {
        enabled: effectiveTracking.google_ads.enabled !== false && !!extractGoogleTagId(effectiveTracking.google_ads.send_to),
        send_to: effectiveTracking.google_ads.send_to || null,
        tag_id: extractGoogleTagId(effectiveTracking.google_ads.send_to),
        config_source: effectiveTracking.google_ads.config_source || null,
        tag_injection_enabled: !!extractGoogleTagId(effectiveTracking.google_ads.send_to)
      }
    };
  }

  // Locations disponibles para el editor (sedes = clínicas del mismo grupo).
  // - Si la config es por grupo => todas las clínicas del grupo.
  // - Si la config es por clínica y pertenece a un grupo => todas las clínicas del grupo.
  // - Si no pertenece a un grupo => solo la propia clínica.
  payload.available_locations = [];
  try {
    let resolvedGroupId = payload.group_id || null;
    let clinicRow = null;

    if (!resolvedGroupId && payload.clinic_id) {
      clinicRow = await Clinica.findOne({
        where: { id_clinica: payload.clinic_id },
        attributes: ['id_clinica', 'nombre_clinica', 'telefono', 'telefono_fijo', 'telefono_movil', 'telefono_whatsapp', 'direccion', 'grupoClinicaId'],
        raw: true
      });
      resolvedGroupId = clinicRow?.grupoClinicaId || null;
    }

    if (resolvedGroupId) {
      // WhatsApp por grupo (fallback si una clínica no tiene número específico).
      let groupWhatsApp = null;
      try {
        const groupPhone = await ClinicMetaAsset.findOne({
          where: {
            grupoClinicaId: resolvedGroupId,
            assignmentScope: 'group',
            isActive: true,
            assetType: 'whatsapp_phone_number'
          },
          attributes: ['metaAssetName', 'additionalData', 'updatedAt'],
          order: [['updatedAt', 'DESC']],
          raw: true
        });
        groupWhatsApp = extractWhatsAppNumber(groupPhone);
      } catch (e) {
        // No bloquear el snippet/editor por un fallo en soporte extra.
        groupWhatsApp = null;
      }

      const clinics = await Clinica.findAll({
        where: { grupoClinicaId: resolvedGroupId },
        attributes: ['id_clinica', 'nombre_clinica', 'telefono', 'telefono_fijo', 'telefono_movil', 'telefono_whatsapp', 'direccion', 'url_web', 'url_avatar'],
        order: [['nombre_clinica', 'ASC']],
        raw: true
      });

      // WhatsApp por clínica (si existe), con fallback al número del grupo.
      const clinicIds = clinics.map((c) => c.id_clinica).filter(Boolean);
      const openingHoursByClinicId = await buildOpeningHoursTextByClinicId(clinicIds);
      const whatsappByClinicId = new Map();
      if (clinicIds.length) {
        const clinicPhones = await ClinicMetaAsset.findAll({
          where: {
            assetType: 'whatsapp_phone_number',
            isActive: true,
            clinicaId: { [Op.in]: clinicIds }
          },
          attributes: ['clinicaId', 'metaAssetName', 'additionalData', 'updatedAt'],
          order: [['updatedAt', 'DESC']],
          raw: true
        });
        for (const asset of clinicPhones) {
          const cid = asset?.clinicaId;
          if (!cid) continue;
          if (whatsappByClinicId.has(cid)) continue; // ya tenemos el más reciente por el order
          const wa = extractWhatsAppNumber(asset);
          if (wa) whatsappByClinicId.set(cid, wa);
        }
      }

      payload.available_locations = clinics.map((c) => {
        const fixedPhone = c.telefono_fijo || c.telefono || null;
        const mobilePhone = c.telefono_movil || null;
        const manualWhatsapp = normalizePhone(c.telefono_whatsapp);
        const phone = fixedPhone || mobilePhone || null;
        const connectedWhatsapp = whatsappByClinicId.get(c.id_clinica) || null;
        const whatsapp = connectedWhatsapp || manualWhatsapp || groupWhatsApp || normalizePhone(mobilePhone || fixedPhone) || null;
        const whatsappSource = connectedWhatsapp
          ? 'clinic_meta'
          : (manualWhatsapp
            ? 'clinic_manual'
            : (groupWhatsApp ? 'group_meta' : (whatsapp ? 'contact_fallback' : null)));
        return {
          id: c.id_clinica,
          label: c.nombre_clinica,
          phone,
          fixed_phone: fixedPhone,
          mobile_phone: mobilePhone,
          phone_source: fixedPhone ? 'clinic_fixed' : (mobilePhone ? 'clinic_mobile' : null),
          whatsapp,
          whatsapp_connected: !!connectedWhatsapp,
          whatsapp_source: whatsappSource,
          address: c.direccion || null,
          url_web: c.url_web || null,
          opening_hours_text: openingHoursByClinicId.get(c.id_clinica) || null,
          url_avatar: c.url_avatar || null
        };
      });
    } else if (payload.clinic_id) {
      if (!clinicRow) {
        clinicRow = await Clinica.findOne({
          where: { id_clinica: payload.clinic_id },
          attributes: ['id_clinica', 'nombre_clinica', 'telefono', 'telefono_fijo', 'telefono_movil', 'telefono_whatsapp', 'direccion', 'url_web', 'url_avatar'],
          raw: true
        });
      }
      if (clinicRow) {
        let whatsapp = null;
        try {
          const clinicPhone = await ClinicMetaAsset.findOne({
            where: {
              clinicaId: clinicRow.id_clinica,
              isActive: true,
              assetType: 'whatsapp_phone_number'
            },
            attributes: ['metaAssetName', 'additionalData', 'updatedAt'],
            order: [['updatedAt', 'DESC']],
            raw: true
          });
          whatsapp = extractWhatsAppNumber(clinicPhone);
        } catch (e) {
          whatsapp = null;
        }
        const fixedPhone = clinicRow.telefono_fijo || clinicRow.telefono || null;
        const mobilePhone = clinicRow.telefono_movil || null;
        const manualWhatsapp = normalizePhone(clinicRow.telefono_whatsapp);
        const connectedWhatsapp = whatsapp || null;
        const effectiveWhatsapp = connectedWhatsapp || manualWhatsapp || normalizePhone(mobilePhone || fixedPhone) || null;
        const openingHoursByClinicId = await buildOpeningHoursTextByClinicId([clinicRow.id_clinica]);
        payload.available_locations = [{
          id: clinicRow.id_clinica,
          label: clinicRow.nombre_clinica,
          phone: fixedPhone || mobilePhone || null,
          fixed_phone: fixedPhone,
          mobile_phone: mobilePhone,
          phone_source: fixedPhone ? 'clinic_fixed' : (mobilePhone ? 'clinic_mobile' : null),
          whatsapp: effectiveWhatsapp,
          whatsapp_connected: !!connectedWhatsapp,
          whatsapp_source: connectedWhatsapp
            ? 'clinic_meta'
            : (manualWhatsapp ? 'clinic_manual' : (effectiveWhatsapp ? 'contact_fallback' : null)),
          address: clinicRow.direccion || null,
          url_web: clinicRow.url_web || null,
          opening_hours_text: openingHoursByClinicId.get(clinicRow.id_clinica) || null,
          url_avatar: clinicRow.url_avatar || null
        }];
      }
    }
  } catch (e) {
    // No bloquear el snippet por un fallo de soporte UI.
    payload.available_locations = [];
  }
  // Preserve the persisted subset before editor normalization: that helper
  // deliberately expands an empty list to every candidate for admin editing.
  // Public responses must instead expose only the configured subset. A clinic
  // scope may safely fall back to itself; an empty group scope exposes none.
  const locationVisibility = resolveIntakeLocationVisibility(
    payload.available_locations,
    payload.locations,
    {
      includeAllLocations,
      clinicId: payload.clinic_id,
      allowedClinicIds: allowedLocationClinicIds,
    },
  );
  payload.available_locations = locationVisibility.availableLocations;
  payload.locations = normalizeConfiguredLocations(
    locationVisibility.configuredLocations,
    payload.available_locations,
  );
  if (payload.config && typeof payload.config === 'object' && !Array.isArray(payload.config)) {
    payload.config = { ...payload.config, locations: payload.locations };
  }

  // Estado de apertura + flujos especiales de "clínica cerrada".
  // Si no hay horario estructurado, open_now queda null y el widget mantiene su lógica normal.
  try {
    const openStateClinicId = effectiveClinicId || payload.clinic_id || null;
    payload.clinic_open_state = await resolveClinicOpenState(openStateClinicId);

    if (payload.clinic_open_state?.open_now === false) {
      const persistedFlows = Array.isArray(payload.flows) ? payload.flows : [];
      const closedFlows = (await loadClosedClinicTemplateFlows(openStateClinicId))
        .filter((flowRule) => !hasCatalogFlowCopy(
          persistedFlows,
          flowRule.template_id,
          getCatalogTemplateFlowIndexFromFlowRule(flowRule)
        ));
      if (closedFlows.length > 0) {
        payload.flows = [
          ...closedFlows,
          ...persistedFlows,
        ];
      }
    }
  } catch (e) {
    payload.clinic_open_state = {
      open_now: null,
      has_schedule: false,
      checked_at: new Date().toISOString(),
      error: 'clinic_schedule_unavailable',
    };
  }

  return res.json(payload);
};

exports.getIntakeConfig = asyncHandler(async (req, res) => getIntakeConfig(req, res));

exports.getIntakeConfigAdmin = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.query.clinic_id);
  const groupId = parseInteger(req.query.group_id);
  if (clinicId === null && groupId === null) {
    return res.status(400).json({ success: false, error: 'clinic_or_group_required' });
  }
  if (clinicId !== null && groupId !== null) {
    return res.status(400).json({ success: false, error: 'ambiguous_scope' });
  }
  if (!(await requireIntakeConfigScopeAccess(req, res, {
    clinicId,
    groupId,
    access: 'read'
  }))) return;

  let allowedLocationClinicIds = null;
  if (clinicId !== null && groupId === null) {
    const candidateClinicIds = await resolveIntakeCandidateClinicIds({ clinicId });
    allowedLocationClinicIds = await getAccessibleMarketingClinicIds({
      userId: req.userData?.userId,
      clinicIds: candidateClinicIds,
      access: 'read',
    });
  }

  return getIntakeConfig(req, res, {
    includeAllLocations: true,
    allowedLocationClinicIds,
  });
});

const snippetAttestationError = (reason, domain = null) => {
  const error = new Error('La verificación de la web ya no es válida. Vuelve a comprobar los dominios antes de guardar.');
  error.code = 'snippet_verification_attestation_invalid';
  error.reason = reason || 'attestation_invalid';
  error.domain = domain || null;
  return error;
};

const positiveSnippetVerificationClaim = (verification) => {
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return false;
  return [
    'verified',
    'runtime_compatible',
    'consent_mode_detected',
    'cookie_notice_detected',
    'google_consent_mode_detected',
  ].some((key) => verification[key] === true)
    || [
      'domains',
      'runtime_compatible_domains',
      'consent_mode_domains',
      'cookie_notice_domains',
      'google_consent_mode_domains',
    ].some((key) => Array.isArray(verification[key]) && verification[key].length > 0);
};

const rebuildTrustedSnippetVerification = ({
  rawVerification,
  scopeType,
  scopeId,
  domains,
  config,
  hmacKey,
  rejectInvalid,
}) => {
  const source = rawVerification && typeof rawVerification === 'object' && !Array.isArray(rawVerification)
    ? rawVerification
    : {};
  const rawAttestations = source.attestations_by_domain
    && typeof source.attestations_by_domain === 'object'
    && !Array.isArray(source.attestations_by_domain)
    ? source.attestations_by_domain
    : {};
  if (rejectInvalid && Object.keys(rawAttestations).length === 0 && positiveSnippetVerificationClaim(source)) {
    throw snippetAttestationError('attestation_missing');
  }

  const configuredDomains = canonicalizeIntakeDomains(domains);
  const configuredDomainSet = new Set(configuredDomains);
  const configHash = buildVerificationConfigHash({
    scopeType,
    scopeId,
    domains,
    config,
    hmacKey,
  });
  const validByDomain = new Map();

  for (const [rawDomain, rawToken] of Object.entries(rawAttestations)) {
    const domain = canonicalizeIntakeDomain(rawDomain);
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!domain || !token || !configuredDomainSet.has(domain) || validByDomain.has(domain)) {
      if (rejectInvalid) {
        throw snippetAttestationError(
          !configuredDomainSet.has(domain) ? 'attestation_domain_not_configured' : 'attestation_malformed',
          domain || rawDomain,
        );
      }
      continue;
    }
    let verified = (rejectInvalid
      ? verifyVerificationAttestation
      : verifyPersistedVerificationAttestation)(token, {
      scopeType,
      scopeId,
      domain,
      configHash,
    });
    if (!verified.valid) {
      if (rejectInvalid) throw snippetAttestationError(verified.reason, domain);
      continue;
    }
    if (rejectInvalid) {
      const persisted = verifyPersistedVerificationAttestation(token, {
        scopeType,
        scopeId,
        domain,
        configHash,
      });
      if (!persisted.valid) throw snippetAttestationError(persisted.reason, domain);
      verified = { ...verified, ...persisted };
    }
    validByDomain.set(domain, {
      token,
      claims: verified.claims,
      operationalExpiresAtIso: verified.operationalExpiresAtIso || null,
    });
  }

  const attestationsByDomain = {};
  const expiresByDomain = {};
  const verificationExpiresByDomain = {};
  const runtimeVersionsByDomain = {};
  const cookieProvidersByDomain = {};
  const legacyChatProvidersByDomain = {};
  const legalPagesByDomain = {};
  const checkedUrls = {};
  const installedDomains = [];
  const runtimeDomains = [];
  const consentDomains = [];
  const cookieDomains = [];
  const googleConsentDomains = [];
  const legacyChatDomains = [];
  const legalDomains = [];
  const issuedAtValues = [];

  for (const domain of configuredDomains) {
    const item = validByDomain.get(domain);
    if (!item) continue;
    const { token, claims } = item;
    const signals = claims.signals || {};
    attestationsByDomain[domain] = token;
    expiresByDomain[domain] = new Date(Number(claims.exp) * 1000).toISOString();
    verificationExpiresByDomain[domain] = item.operationalExpiresAtIso
      || new Date(Number(claims.exp) * 1000).toISOString();
    issuedAtValues.push(Number(claims.iat));
    if (signals.installed === true) installedDomains.push(domain);
    if (signals.runtime_compatible === true) runtimeDomains.push(domain);
    if (signals.consent_mode_detected === true) consentDomains.push(domain);
    if (signals.cookie_notice_detected === true) cookieDomains.push(domain);
    if (signals.google_consent_mode_detected === true) googleConsentDomains.push(domain);
    if (signals.legacy_chat_detected === true) legacyChatDomains.push(domain);
    if (signals.legal_urls_detected === true) legalDomains.push(domain);
    runtimeVersionsByDomain[domain] = signals.runtime_version || null;
    cookieProvidersByDomain[domain] = signals.cookie_notice_provider || null;
    legacyChatProvidersByDomain[domain] = signals.legacy_chat_provider || null;
    legalPagesByDomain[domain] = signals.legal_pages || {};
    checkedUrls[domain] = signals.checked_url || null;
  }

  const everyDomain = (covered) => configuredDomains.length > 0
    && configuredDomains.every((domain) => covered.includes(domain));
  const providers = Array.from(new Set(
    Object.values(cookieProvidersByDomain).filter(Boolean),
  ));
  const legacyChatProviders = Array.from(new Set(
    Object.values(legacyChatProvidersByDomain).filter(Boolean),
  ));
  const latestIssuedAt = issuedAtValues.length > 0 ? Math.max(...issuedAtValues) : null;

  return {
    verified: everyDomain(installedDomains),
    verified_at: latestIssuedAt ? new Date(latestIssuedAt * 1000).toISOString() : null,
    domains: installedDomains,
    runtime_compatible: everyDomain(runtimeDomains),
    runtime_compatible_domains: runtimeDomains,
    runtime_versions_by_domain: runtimeVersionsByDomain,
    consent_mode_detected: everyDomain(consentDomains),
    consent_mode_domains: consentDomains,
    cookie_notice_detected: everyDomain(cookieDomains),
    cookie_notice_provider: providers.join(', ') || null,
    cookie_notice_domains: cookieDomains,
    cookie_notice_providers_by_domain: cookieProvidersByDomain,
    google_consent_mode_detected: everyDomain(googleConsentDomains),
    google_consent_mode_domains: googleConsentDomains,
    legacy_chat_detected: legacyChatDomains.length > 0,
    legacy_chat_provider: legacyChatProviders.join(', ') || null,
    legacy_chat_domains: legacyChatDomains,
    legacy_chat_providers_by_domain: legacyChatProvidersByDomain,
    legal_urls_detected: everyDomain(legalDomains),
    legal_pages_by_domain: legalPagesByDomain,
    checked_urls: checkedUrls,
    attestations_by_domain: attestationsByDomain,
    attestation_expires_at_by_domain: expiresByDomain,
    verification_expires_at_by_domain: verificationExpiresByDomain,
    attestation_config_hash: configHash,
  };
};

exports.upsertIntakeConfig = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.params.clinicId);
  const requestedGroupId = parseInteger(req.body?.group_id);
  if (!clinicId && !requestedGroupId) return res.status(400).json({ message: 'clinicId o group_id requerido' });
  if (!(await requireIntakeConfigScopeAccess(req, res, {
    clinicId: requestedGroupId ? null : clinicId,
    groupId: requestedGroupId,
    access: 'write'
  }))) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const verificationOnlyMutation = body.mutation_kind === 'snippet_verification';
  const domainAddMutation = body.mutation_kind === 'domain_add';
  const partialMutation = verificationOnlyMutation || domainAddMutation;
  let groupId = requestedGroupId;
  let scope = groupId ? 'group' : 'clinic';
  if (scope === 'clinic') {
    const sharedWebContext = await resolveSharedWebGroupConfigForClinic(clinicId);
    if (sharedWebContext?.record) {
      if (partialMutation) {
        // The caller remains authorized against the selected clinic. Only the
        // two narrow, lock-protected mutations may resolve their effective web
        // row automatically; a full group editor write still requires group
        // scope so one clinic cannot replace shared configuration.
        scope = 'group';
        groupId = sharedWebContext.groupId;
      } else {
        return res.status(409).json({
          message: 'Esta clínica usa la configuración web del grupo. Selecciona el grupo para editarla para todas las clínicas.',
          assignment_scope: 'group',
          group_id: sharedWebContext.groupId,
          clinic_id: clinicId
        });
      }
    }
  }

  const domainToAdd = domainAddMutation ? canonicalizeIntakeDomain(body.domain) : null;
  if (domainAddMutation && !domainToAdd) {
    return res.status(400).json({ success: false, error: 'intake_domain_invalid' });
  }
  const submittedDomains = Array.isArray(body.domains) ? body.domains : [];
  const hasHmacKeyField = Object.prototype.hasOwnProperty.call(body, 'hmac_key');
  const requestedHmacKey = body.hmac_key;
  let allowedLocationClinicIds = [];
  if (!partialMutation) {
    const candidateLocationClinicIds = await resolveIntakeCandidateClinicIds({
      clinicId: scope === 'clinic' ? clinicId : null,
      groupId: scope === 'group' ? groupId : null,
    });
    allowedLocationClinicIds = await getAccessibleMarketingClinicIds({
      userId: req.userData?.userId,
      clinicIds: candidateLocationClinicIds,
      access: 'write',
    });
  }
  const hasRootVerification = Object.prototype.hasOwnProperty.call(body, 'snippet_verification');
  const hasNestedVerification = Boolean(
    body.config
      && typeof body.config === 'object'
      && !Array.isArray(body.config)
      && Object.prototype.hasOwnProperty.call(body.config, 'snippet_verification')
  );
  const submittedVerification = hasRootVerification
    ? body.snippet_verification
    : (hasNestedVerification ? body.config.snippet_verification : null);
  const scopeWhere = scope === 'group'
    ? { group_id: groupId, assignment_scope: 'group' }
    : { clinic_id: clinicId };

  const persistence = await db.sequelize.transaction(async (transaction) => {
    // Serialize editor writes with the automatic gate/reconciliation jobs. The
    // merge must use the latest committed server-owned state, not the snapshot
    // that happened to be returned when the editor screen was opened.
    const existing = await IntakeConfig.findOne({
      where: scopeWhere,
      transaction,
      lock: transaction.LOCK.UPDATE,
      raw: true,
    });
    const existingConfig = existing?.config && typeof existing.config === 'object'
      && !Array.isArray(existing.config)
      ? existing.config
      : {};
    if (partialMutation && !existing) {
      return {
        error: {
          status: 404,
          body: { success: false, error: 'intake_config_not_found' },
        },
      };
    }
    const existingDomains = canonicalizeIntakeDomains(Array.isArray(existing?.domains) ? existing.domains : []);
    const domains = verificationOnlyMutation
      ? existingDomains
      : domainAddMutation
        ? canonicalizeIntakeDomains([...existingDomains, domainToAdd])
        : submittedDomains;
    const config = partialMutation
      ? { ...existingConfig }
      : mergeIntakeConfigForEditorWrite(
          existingConfig,
          body,
          normalizeEffectiveGoogleAdsConfig,
          normalizeMetaAdsConfig,
        );

    if (!partialMutation
      && Object.prototype.hasOwnProperty.call(config, 'locations')
      && !Array.isArray(config.locations)) {
      return { error: { status: 400, body: { success: false, error: 'locations_invalid' } } };
    }
    const configuredLocations = Array.isArray(config.locations) ? config.locations : [];
    if (!partialMutation
      && !configuredLocationsWithinAllowedScope(configuredLocations, allowedLocationClinicIds)) {
      return { error: { status: 403, body: { success: false, error: 'location_scope_forbidden' } } };
    }

    // If the frontend omits hmac_key, preserve the value read under lock.
    let nextHmacKey = null;
    if (partialMutation) {
      nextHmacKey = existing?.hmac_key || null;
    } else if (hasHmacKeyField) {
      nextHmacKey = requestedHmacKey ? String(requestedHmacKey) : null;
    } else {
      nextHmacKey = existing?.hmac_key || null;
      if (!nextHmacKey && domains.length > 0) {
        nextHmacKey = crypto.randomBytes(32).toString('hex');
      }
    }

    const verificationSource = hasRootVerification || hasNestedVerification
      ? submittedVerification
      : existingConfig.snippet_verification;
    if (verificationOnlyMutation && !hasRootVerification && !hasNestedVerification) {
      return {
        error: {
          status: 400,
          body: { success: false, error: 'snippet_verification_required' },
        },
      };
    }
    try {
      config.snippet_verification = rebuildTrustedSnippetVerification({
        rawVerification: verificationSource,
        scopeType: scope,
        scopeId: scope === 'group' ? groupId : clinicId,
        domains,
        config,
        hmacKey: nextHmacKey,
        rejectInvalid: hasRootVerification || hasNestedVerification,
      });
    } catch (error) {
      if (error?.code === 'snippet_verification_attestation_invalid') {
        return {
          error: {
            status: 400,
            body: {
              success: false,
              error: error.code,
              reason: error.reason,
              domain: error.domain,
              message: error.message,
            },
          },
        };
      }
      throw error;
    }

    await IntakeConfig.upsert({
      clinic_id: scope === 'clinic' ? (clinicId || null) : null,
      group_id: groupId || null,
      assignment_scope: scope,
      domains,
      config,
      hmac_key: nextHmacKey,
    }, { transaction });
    return { config, domains };
  });

  if (persistence.error) {
    return res.status(persistence.error.status).json(persistence.error.body);
  }
  try {
    await enqueueGoogleDataManagerControlPlaneReconciliation({
      origin: verificationOnlyMutation
        ? 'marketing:web_measurement_verified'
        : domainAddMutation
          ? 'marketing:web_measurement_domain_added'
          : 'marketing:web_measurement_configured',
      requestedBy: req.userData?.userId || null,
      requestedByName: req.userData?.name
        || req.userData?.nombre
        || req.userData?.email
        || null,
      requestedByRole: req.userData?.role || req.userData?.rol || null,
    });
  } catch (error) {
    // Saving the web configuration is the source of truth. The periodic
    // diagnostics pass remains the fallback if the immediate durable enqueue
    // is temporarily unavailable.
    console.warn('No se pudo encolar la reconciliación de medición web:', error.message || error);
  }
  return res.json({
    success: true,
    domains: persistence.domains,
    snippet_verification: persistence.config.snippet_verification,
  });
});

// ======================================
// Config secreta (solo UI autenticada)
// ======================================

exports.getIntakeConfigSecretClinic = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.params.clinicId);
  if (clinicId === null) return res.status(400).json({ message: 'clinicId requerido' });
  if (!(await requireIntakeConfigScopeAccess(req, res, { clinicId, access: 'read' }))) return;

  const sharedWebContext = await resolveSharedWebGroupConfigForClinic(clinicId);
  const record = sharedWebContext?.record
    || await IntakeConfig.findOne({ where: { clinic_id: clinicId }, raw: true });
  return res.json({
    clinic_id: clinicId,
    assignment_scope: sharedWebContext?.record ? 'group' : 'clinic',
    group_id: sharedWebContext?.record ? sharedWebContext.groupId : null,
    has_hmac: !!record?.hmac_key,
    hmac_key: record?.hmac_key || null
  });
});

exports.getIntakeConfigSecretGroup = asyncHandler(async (req, res) => {
  const groupId = parseInteger(req.params.groupId);
  if (groupId === null) return res.status(400).json({ message: 'groupId requerido' });
  if (!(await requireIntakeConfigScopeAccess(req, res, { groupId, access: 'read' }))) return;

  const record = await IntakeConfig.findOne({ where: { group_id: groupId, assignment_scope: 'group' }, raw: true });
  return res.json({
    group_id: groupId,
    has_hmac: !!record?.hmac_key,
    hmac_key: record?.hmac_key || null
  });
});

// ======================================
// Verificación de instalación del snippet
// (UI autenticada)
// ======================================

exports.verifySnippetInstalled = asyncHandler(async (req, res) => {
  const domainRaw = String(req.query.domain || '').trim();
  const clinicId = parseInteger(req.query.clinic_id);
  const groupId = parseInteger(req.query.group_id);
  const pageUrlRaw = String(req.query.url || req.query.page_url || '').trim();

  if (!domainRaw) {
    return res.status(400).json({ installed: false, details: 'Falta el parámetro domain' });
  }
  const domain = normalizeDomain(domainRaw);
  if (!domain) {
    return res.status(400).json({ installed: false, details: 'Dominio inválido' });
  }
  if (domain === 'localhost' || domain.endsWith('.local') || domain === '127.0.0.1') {
    return res.status(400).json({ installed: false, details: 'Dominio no permitido para verificación' });
  }

  // Requerimos un scope explícito para evitar verificar config de terceros por "solo dominio".
  if (clinicId === null && groupId === null) {
    return res.status(400).json({ installed: false, details: 'clinic_id o group_id requerido' });
  }
  if (clinicId !== null && groupId !== null) {
    return res.status(400).json({ installed: false, details: 'El scope de verificación es ambiguo' });
  }
  if (!(await requireIntakeConfigScopeAccess(req, res, { clinicId, groupId, access: 'read' }))) return;

  let record = null;
  let effectiveGroupId = groupId;
  if (clinicId !== null) {
    const sharedWebContext = await resolveSharedWebGroupConfigForClinic(clinicId);
    record = sharedWebContext?.record
      || await IntakeConfig.findOne({ where: { clinic_id: clinicId }, raw: true });
    effectiveGroupId = sharedWebContext?.record ? sharedWebContext.groupId : null;
  }
  if (!record && groupId !== null) {
    record = await IntakeConfig.findOne({ where: { group_id: groupId, assignment_scope: 'group' }, raw: true });
  }
  if (!record) {
    return res.status(404).json({ installed: false, details: 'No hay configuración de intake para este scope' });
  }

  const allowlist = Array.isArray(record.domains) ? record.domains : [];
  if (allowlist.length === 0) {
    return res.status(400).json({ installed: false, details: 'Añade al menos un dominio en la configuración antes de verificar' });
  }
  if (!isDomainAllowed(allowlist, domain)) {
    return res.status(403).json({ installed: false, details: 'Dominio no permitido para esta configuración' });
  }

  const scope = effectiveGroupId !== null ? 'group' : 'clinic';
  const expectedId = scope === 'group' ? (record.group_id || effectiveGroupId) : (record.clinic_id || clinicId);
  const expectedAttr = scope === 'group' ? 'data-group-id' : 'data-clinic-id';
  const recordConfig = record?.config && typeof record.config === 'object' && !Array.isArray(record.config)
    ? record.config
    : {};
  const recordFeatures = recordConfig.features && typeof recordConfig.features === 'object'
    && !Array.isArray(recordConfig.features)
    ? recordConfig.features
    : {};
  const configuredConsentEnabled = recordFeatures.consent_mode_enabled === true;
  const configuredConsentProvider = String(recordFeatures.consent_provider || '').trim().toLowerCase();
  const configuredExternalCmpProvider = String(recordFeatures.external_cmp_provider || '').trim().toLowerCase();

  // Construir URLs candidatas a verificar.
  // Si el usuario pasa una URL completa, la respetamos (pero debe coincidir el host allowlisted).
  const candidates = [];
  if (pageUrlRaw) {
    try {
      const u = new URL(pageUrlRaw);
      const host = normalizeDomain(u.hostname);
      if (!host || !isDomainAllowed(allowlist, host)) {
        return res.status(400).json({ installed: false, details: 'La URL no coincide con el dominio allowlisteado' });
      }
      candidates.push(u.toString());
    } catch {
      return res.status(400).json({ installed: false, details: 'URL inválida' });
    }
  } else {
    const base = stripWww(domain);
    candidates.push(`https://${base}/`);
    if (!base.startsWith('www.')) {
      candidates.push(`https://www.${base}/`);
    }
    candidates.push(`http://${base}/`);
    if (!base.startsWith('www.')) {
      candidates.push(`http://www.${base}/`);
    }
  }
  const uniqueCandidates = Array.from(new Set(candidates));

  const fetchSafeHtml = async (initialUrl, bypassCache = false) => {
    let currentUrl = initialUrl;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const safeTarget = await resolveSafeHttpTarget(currentUrl);
      if (!isDomainAllowed(allowlist, normalizeDomain(safeTarget.hostname))) {
        throw new Error('La redirección salió del dominio allowlisteado');
      }
      try {
        const resp = await axios.get(safeTarget.url, {
          timeout: 8000,
          maxRedirects: 0,
          maxContentLength: 2 * 1024 * 1024,
          maxBodyLength: 2 * 1024 * 1024,
          httpAgent: safeTarget.httpAgent,
          httpsAgent: safeTarget.httpsAgent,
          proxy: false,
          headers: {
            'User-Agent': 'ClinicaClick Snippet Verifier/1.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            ...(bypassCache ? {
              'Cache-Control': 'no-cache, no-store, max-age=0',
              'Pragma': 'no-cache'
            } : {})
          },
          validateStatus: (status) => status >= 200 && status < 400
        });
        if (resp.status >= 300 && resp.status < 400) {
          const location = String(resp.headers?.location || '').trim();
          if (!location || redirectCount === 5) {
            throw new Error('La web devolvió demasiadas redirecciones o una redirección inválida');
          }
          currentUrl = new URL(location, safeTarget.url).toString();
          continue;
        }
        if (typeof resp.data === 'string' && resp.data.length > 0) {
          return { html: resp.data, finalUrl: safeTarget.url, lastError: null };
        }
        throw new Error('La web no devolvió contenido HTML');
      } finally {
        safeTarget.httpAgent.destroy();
        safeTarget.httpsAgent.destroy();
      }
    }
    throw new Error('La web superó el límite de redirecciones');
  };

  const fetchFirstHtml = async (urls, bypassCache = false) => {
    let lastError = null;

    for (const url of urls) {
      try {
        return await fetchSafeHtml(url, bypassCache);
      } catch (e) {
        lastError = e;
      }
    }

    return { html: null, finalUrl: null, lastError };
  };

  const verifyConfiguredLegalPages = async (checkedUrl) => {
    const config = record?.config && typeof record.config === 'object' && !Array.isArray(record.config)
      ? record.config
      : {};
    const texts = config?.texts && typeof config.texts === 'object' && !Array.isArray(config.texts)
      ? config.texts
      : {};
    const definitions = {
      legal: texts.legal_url || texts.terms_url || null,
      cookies: texts.cookies_url || null,
      privacy: texts.privacy_url || null,
    };
    const baseUrl = checkedUrl || `https://${stripWww(domain)}/`;
    const pages = {};

    for (const [key, configuredValue] of Object.entries(definitions)) {
      const raw = String(configuredValue || '').trim();
      if (!raw) {
        pages[key] = { configured: false, reachable: false, url: null, reason: 'missing_url' };
        continue;
      }
      let absoluteUrl;
      try {
        absoluteUrl = new URL(raw, baseUrl).toString();
        const host = normalizeDomain(new URL(absoluteUrl).hostname);
        if (!host || !isDomainAllowed(allowlist, host)) {
          pages[key] = { configured: true, reachable: false, url: absoluteUrl, reason: 'domain_not_allowed' };
          continue;
        }
      } catch (_error) {
        pages[key] = { configured: true, reachable: false, url: raw, reason: 'invalid_url' };
        continue;
      }

      try {
        const fetched = await fetchSafeHtml(absoluteUrl, false);
        pages[key] = {
          configured: true,
          reachable: true,
          url: absoluteUrl,
          checked_url: fetched.finalUrl || absoluteUrl,
          reason: null,
        };
      } catch (error) {
        pages[key] = {
          configured: true,
          reachable: false,
          url: absoluteUrl,
          reason: 'unreachable',
          details: truncateString(error?.message || 'No se pudo abrir la URL', 255),
        };
      }
    }

    const values = Object.values(pages);
    return {
      legal_pages: pages,
      legal_urls_detected: values.every((page) => page.configured && page.reachable),
      missing_legal_urls: Object.entries(pages)
        .filter(([, page]) => !page.configured)
        .map(([key]) => key),
      unreachable_legal_urls: Object.entries(pages)
        .filter(([, page]) => page.configured && !page.reachable)
        .map(([key]) => key),
    };
  };

  const withCacheBust = (url) => {
    try {
      const u = new URL(url);
      u.searchParams.set('cc_cache_bust', Date.now().toString());
      return u.toString();
    } catch {
      return url;
    }
  };

  const isClinicaClickAssetHost = (src, checkedUrl) => {
    try {
      const url = new URL(src, checkedUrl || `https://${domain}/`);
      const host = normalizeDomain(url.hostname);
      return Boolean(
        host === 'clinicaclick.com' ||
        host.endsWith('.clinicaclick.com')
      );
    } catch {
      return false;
    }
  };

  const fetchSnippetScriptInfo = async (src, checkedUrl) => {
    if (!src || !isClinicaClickAssetHost(src, checkedUrl)) return null;
    try {
      let currentUrl = new URL(src, checkedUrl || `https://${domain}/`).toString();
      let body = '';
      let finalUrl = null;
      for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
        const safeTarget = await resolveSafeHttpTarget(currentUrl);
        if (!isClinicaClickAssetHost(safeTarget.url, safeTarget.url)) {
          throw new Error('El runtime redirigió fuera de los dominios de ClinicaClick');
        }
        try {
          const resp = await axios.get(safeTarget.url, {
            timeout: 5000,
            maxRedirects: 0,
            maxContentLength: 512 * 1024,
            maxBodyLength: 512 * 1024,
            httpAgent: safeTarget.httpAgent,
            httpsAgent: safeTarget.httpsAgent,
            proxy: false,
            headers: {
              'User-Agent': 'ClinicaClick Snippet Verifier/1.0',
              'Accept': 'application/javascript,text/javascript,*/*;q=0.8',
              'Cache-Control': 'no-cache',
              'Pragma': 'no-cache',
            },
            validateStatus: (status) => status >= 200 && status < 400,
          });
          if (resp.status >= 300 && resp.status < 400) {
            const location = String(resp.headers?.location || '').trim();
            if (!location || redirectCount === 3) {
              throw new Error('El runtime devolvió demasiadas redirecciones o una redirección inválida');
            }
            currentUrl = new URL(location, safeTarget.url).toString();
            continue;
          }
          body = typeof resp.data === 'string' ? resp.data : '';
          finalUrl = safeTarget.url;
          break;
        } finally {
          safeTarget.httpAgent.destroy();
          safeTarget.httpsAgent.destroy();
        }
      }
      if (!body) return null;
      return { body, finalUrl: finalUrl || currentUrl };
    } catch (err) {
      console.warn('[intake] No se pudo inspeccionar runtime del snippet', src, err?.message || err);
      return null;
    }
  };

  const detectExternalCookieNotice = (htmlToCheck) => {
    const html = String(htmlToCheck || '');
    const providers = [];
    const add = (name, pattern) => {
      if (pattern.test(html) && !providers.includes(name)) providers.push(name);
    };

    add('Complianz', /cmplz-|complianz/i);
    add('Cookiebot', /cookiebot|CybotCookiebot/i);
    add('OneTrust', /onetrust|Optanon/i);
    add('CookieYes', /cookieyes|cky-consent/i);
    add('Iubenda', /iubenda/i);
    add('Didomi', /didomi/i);
    add('Borlabs Cookie', /borlabs-cookie/i);
    add('Cookie Notice', /cookie-notice|cn-notice/i);
    add('GDPR Cookie Compliance', /moove_gdpr|gdpr-cookie-compliance/i);

    // Detect an actual default command in served HTML. WP Consent API merely
    // exposes a category API and is not proof that Google Consent Mode is
    // configured or that a default-denied command runs before advertising.
    const googleConsentModeDetected =
      /(?:\b|\.)gtag\s*\(\s*['"]consent['"]\s*,\s*['"]default['"]/i.test(html);

    // JoinChat es el chat heredado que estamos sustituyendo por el runtime de
    // ClinicaClick. Informarlo en la misma verificacion permite migrar en dos
    // tiempos: instalar y verificar primero; desactivar JoinChat despues.
    const joinChatDetected = detectLegacyJoinChat(html);

    return {
      cookie_notice_detected: providers.length > 0,
      cookie_notice_provider: providers.join(', ') || null,
      cookie_notice_providers: providers,
      google_consent_mode_detected: googleConsentModeDetected,
      legacy_chat_detected: joinChatDetected,
      legacy_chat_provider: joinChatDetected ? 'JoinChat' : null,
    };
  };

  const getSnippetRuntimeInfo = async (tags, checkedUrl) => {
    return inspectSnippetRuntime({
      tags,
      checkedUrl,
      fetchScript: fetchSnippetScriptInfo,
      isAllowedAssetUrl: isClinicaClickAssetHost,
    });
  };

  const evaluateSnippetHtml = async (htmlToCheck, checkedUrl) => {
    const externalCookieNoticeInfo = detectExternalCookieNotice(htmlToCheck);
    const scriptTags = htmlToCheck.match(/<script\b[^>]*>/gi) || [];
    const snippetTags = scriptTags.filter((t) => /(intake|loader)\.js/i.test(t));
    if (snippetTags.length === 0) {
      return {
        installed: false,
        reason: 'missing_snippet',
        checked_url: checkedUrl,
        details: `No se encontró el fragmento de código de medición de ClinicaClick en ${checkedUrl || domain}.`,
        ...externalCookieNoticeInfo,
      };
    }

    const idRe = new RegExp(`${expectedAttr}\\s*=\\s*['"]?${expectedId}['"]?`, 'i');
    const tagsForScope = snippetTags.filter((t) => idRe.test(t));
    if (tagsForScope.length === 0) {
      // Pista útil: ¿hay intake.js pero con otro scope/id?
      const clinicIdMatch = snippetTags.map((t) => t.match(/data-clinic-id\s*=\s*['"]?(\d+)['"]?/i)).find(Boolean);
      const groupIdMatch = snippetTags.map((t) => t.match(/data-group-id\s*=\s*['"]?(\d+)['"]?/i)).find(Boolean);
      const hint = clinicIdMatch?.[1]
        ? `Se detectó data-clinic-id="${clinicIdMatch[1]}".`
        : (groupIdMatch?.[1] ? `Se detectó data-group-id="${groupIdMatch[1]}".` : null);
      return {
        installed: false,
        reason: 'scope_mismatch',
        checked_url: checkedUrl,
        details: `Se encontró el fragmento de código de medición, pero no coincide con esta configuración (${expectedAttr}="${expectedId}").${hint ? ` ${hint}` : ''}`,
        ...externalCookieNoticeInfo,
      };
    }

    const runtimeInfo = await getSnippetRuntimeInfo(tagsForScope, checkedUrl);
    const consentAttributesDetected = tagsForScope.some((tag) => {
      const enabled = tag.match(/data-consent-mode-enabled\s*=\s*['"]([^'"]+)['"]/i)?.[1];
      const provider = tag.match(/data-consent-provider\s*=\s*['"]([^'"]+)['"]/i)?.[1];
      return String(enabled || '').trim().toLowerCase() === 'true'
        && String(provider || '').trim().toLowerCase() === configuredConsentProvider;
    });
    const clinicaclickBootstrapDetected =
      /data-clinicaclick-consent-bootstrap\s*=\s*['"][^'"]+['"]/i.test(htmlToCheck)
      && /ClinicaClickConsentBootstrap/i.test(htmlToCheck)
      && /(?:\b|\.)gtag\s*\(\s*['"]consent['"]\s*,\s*['"]default['"]/i.test(htmlToCheck);
    const providerBootstrapDetected = configuredConsentProvider === 'clinicaclick'
      ? clinicaclickBootstrapDetected
      : (
          configuredConsentProvider === 'external_cmp'
          && externalCookieNoticeInfo.cookie_notice_detected === true
          && cookieNoticeProviderMatches(
            externalCookieNoticeInfo.cookie_notice_providers,
            configuredExternalCmpProvider,
          )
          && externalCookieNoticeInfo.google_consent_mode_detected === true
        );
    const consentModeDetected = configuredConsentEnabled
      && ['clinicaclick', 'external_cmp'].includes(configuredConsentProvider)
      && runtimeInfo.runtime_compatible === true
      && consentAttributesDetected
      && providerBootstrapDetected;
    const detectedRuntime = {
      ...runtimeInfo,
      consent_attributes_detected: consentAttributesDetected,
      consent_bootstrap_detected: providerBootstrapDetected,
      consent_mode_detected: consentModeDetected,
    };

    // Si existe HMAC en backend, aceptar cualquier tag del scope que tenga la clave vigente.
    // El plugin/editor actuales no publican esa clave: exponen un relay
    // same-origin fijo y firman server-side. El HMAC en el tag se conserva solo
    // como compatibilidad durante la migración de snippets manuales antiguos.
    if (record.hmac_key) {
      const expectedHmac = String(record.hmac_key).trim();
      const hmacKeys = tagsForScope.map((tag) => {
        const m = tag.match(/data-hmac-key\s*=\s*['"]([^'"]+)['"]/i);
        return m?.[1] ? String(m[1]).trim() : null;
      });

      if (hmacKeys.includes(expectedHmac)) {
        return { installed: true, checked_url: checkedUrl, ...detectedRuntime, ...externalCookieNoticeInfo, consent_mode_detected: consentModeDetected };
      }

      const sameOriginBridgeDetected = tagsForScope.some((tag) => {
        const value = tag.match(/data-event-bridge-url\s*=\s*['"]([^'"]+)['"]/i)?.[1];
        return String(value || '').trim() === '/_clinicaclick/events';
      });
      if (sameOriginBridgeDetected) {
        return {
          installed: true,
          checked_url: checkedUrl,
          security_transport: 'same_origin_server_bridge',
          ...detectedRuntime,
          ...externalCookieNoticeInfo,
          consent_mode_detected: consentModeDetected,
        };
      }

      if (hmacKeys.every((key) => !key)) {
        return {
          installed: false,
          reason: 'missing_secure_transport',
          checked_url: checkedUrl,
          details: 'Se encontró el fragmento de medición, pero no su canal seguro de envío. Actualiza el plugin o vuelve a copiar el fragmento.',
          ...externalCookieNoticeInfo,
        };
      }

      return {
        installed: false,
        reason: 'hmac_mismatch',
        checked_url: checkedUrl,
        details: 'Se encontró el fragmento de código de medición, pero la clave de seguridad no coincide con la que tiene guardada ClinicaClick.',
        ...externalCookieNoticeInfo,
      };
    }

    return { installed: true, checked_url: checkedUrl, ...detectedRuntime, ...externalCookieNoticeInfo, consent_mode_detected: consentModeDetected };
  };

  const primaryFetch = await fetchFirstHtml(uniqueCandidates, false);

  if (!primaryFetch.html) {
    const code = primaryFetch.lastError?.response?.status || null;
    return res.status(502).json({
      installed: false,
      details: `No se pudo acceder a ${domain} para verificar${code ? ` (HTTP ${code})` : ''}`
    });
  }

  const primaryEvaluation = await evaluateSnippetHtml(primaryFetch.html, primaryFetch.finalUrl);
  const legalPageVerification = await verifyConfiguredLegalPages(
    primaryEvaluation.checked_url || primaryFetch.finalUrl
  );
  if (primaryEvaluation.installed) {
    const configHash = buildVerificationConfigHash({
      scopeType: scope,
      scopeId: expectedId,
      domains: record.domains,
      config: recordConfig,
      hmacKey: record.hmac_key,
    });
    const attestation = issueVerificationAttestation({
      scopeType: scope,
      scopeId: expectedId,
      domain,
      configHash,
      signals: {
        ...primaryEvaluation,
        ...legalPageVerification,
      },
    });
    return res.json({
      installed: true,
      checked_url: primaryEvaluation.checked_url,
      consent_mode_detected: !!primaryEvaluation.consent_mode_detected,
      uses_loader: !!primaryEvaluation.uses_loader,
      runtime_version: primaryEvaluation.runtime_version || null,
      runtime_declared_version: primaryEvaluation.runtime_declared_version || null,
      runtime_compatible: !!primaryEvaluation.runtime_compatible,
      security_transport: primaryEvaluation.security_transport || (record.hmac_key ? 'legacy_browser_hmac' : null),
      cookie_notice_detected: !!primaryEvaluation.cookie_notice_detected,
      cookie_notice_provider: primaryEvaluation.cookie_notice_provider || null,
      google_consent_mode_detected: !!primaryEvaluation.google_consent_mode_detected,
      legacy_chat_detected: !!primaryEvaluation.legacy_chat_detected,
      legacy_chat_provider: primaryEvaluation.legacy_chat_provider || null,
      ...legalPageVerification,
      verification_attestation: attestation.token,
      verification_attestation_expires_at: attestation.expiresAt,
      verification_attestation_error: attestation.reason,
    });
  }

  const bypassCandidates = uniqueCandidates.map(withCacheBust);
  const bypassFetch = await fetchFirstHtml(bypassCandidates, true);
  if (bypassFetch.html) {
    const bypassEvaluation = await evaluateSnippetHtml(bypassFetch.html, bypassFetch.finalUrl);
    if (bypassEvaluation.installed) {
      return res.json({
        installed: false,
        cache_stale: true,
        checked_url: primaryEvaluation.checked_url || primaryFetch.finalUrl,
        bypass_checked_url: bypassEvaluation.checked_url,
        consent_mode_detected: !!bypassEvaluation.consent_mode_detected,
        uses_loader: !!bypassEvaluation.uses_loader,
        runtime_version: bypassEvaluation.runtime_version || null,
        runtime_declared_version: bypassEvaluation.runtime_declared_version || null,
        runtime_compatible: !!bypassEvaluation.runtime_compatible,
        cookie_notice_detected: !!bypassEvaluation.cookie_notice_detected,
        cookie_notice_provider: bypassEvaluation.cookie_notice_provider || null,
        google_consent_mode_detected: !!bypassEvaluation.google_consent_mode_detected,
        legacy_chat_detected: !!bypassEvaluation.legacy_chat_detected,
        legacy_chat_provider: bypassEvaluation.legacy_chat_provider || null,
        ...legalPageVerification,
        details: 'La web devuelve el fragmento seguro al saltar caché, pero la página normal sigue sirviendo una versión antigua. Purga la caché de WordPress, del hosting o de la CDN y vuelve a verificar.'
      });
    }
  }

  return res.json({ ...primaryEvaluation, ...legalPageVerification });
});

// ===========================
// Eventos genéricos (ViewContent, Contact, Schedule, Purchase)
// ===========================

const getHostnameFromUrl = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

exports.registerWhatsappOrigin = asyncHandler(async (req, res) => {
  if (!WhatsAppWebOrigin) {
    return res.status(503).json({ success: false, message: 'WhatsApp web origin no disponible' });
  }

  const body = req.body || {};
  const ref = cleanString(body.ref)?.toLowerCase();
  if (!ref || !/^[a-f0-9]{8,64}$/.test(ref)) {
    return res.status(400).json({ success: false, message: 'ref inválido' });
  }

  let clinicIdParsed = parseInteger(coalesce(body.clinic_id, body.clinica_id, body.clinicId));
  let groupIdParsed = parseInteger(coalesce(body.group_id, body.grupo_clinica_id, body.groupId));
  const pageUrl = truncateString(coalesce(body.page_url, body.pageUrl), 1024);
  const googleAdsCampaignId = resolveGoogleAdsCampaignId({
    ccCandidates: [body.cc_gads_campaign_id],
    canonicalCandidates: [body.google_ads_campaign_id, body.google_campaign_id],
    gadCandidates: [body.gad_campaignid, body.gadCampaignId],
    urls: [pageUrl, body.landing_url, body.landingUrl],
  });
  const derivedDomain = getHostnameFromUrl(pageUrl || '');
  const domain = normalizeDomain(coalesce(body.domain, derivedDomain));
  if (domain && !/^[a-z0-9.-]+$/.test(domain)) {
    return res.status(400).json({ success: false, message: 'domain inválido' });
  }

  let clinicCfg = null;
  let groupCfg = null;
  let domainCfg = null;
  if (clinicIdParsed !== null) {
    clinicCfg = await IntakeConfig.findOne({ where: { clinic_id: clinicIdParsed }, raw: true });
  }
  if (groupIdParsed !== null) {
    groupCfg = await IntakeConfig.findOne({ where: { group_id: groupIdParsed, assignment_scope: 'group' }, raw: true });
  }
  if (domain) {
    domainCfg = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain}\"') AND assignment_scope='clinic'`),
      order: [['created_at', 'ASC'], ['id', 'ASC']],
      raw: true,
    });
    if (!domainCfg) {
      domainCfg = await IntakeConfig.findOne({
        where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain}\"') AND assignment_scope='group'`),
        order: [['created_at', 'ASC'], ['id', 'ASC']],
        raw: true,
      });
    }
  }

  ({ clinicCfg, groupCfg, domainCfg } = await resolveEffectivePublicIntakeRecords({
    clinicCfg,
    groupCfg,
    domainCfg,
    clinicId: clinicIdParsed,
    groupId: groupIdParsed,
    models: db,
  }));
  [clinicCfg, groupCfg, domainCfg] = await Promise.all([
    withRuntimeTransitionHmacs(clinicCfg),
    withRuntimeTransitionHmacs(groupCfg),
    withRuntimeTransitionHmacs(domainCfg),
  ]);
  const provided = req.headers[SIGNATURE_HEADER] || req.headers[SIGNATURE_HEADER_SHA];
  const artifactRuntime = await runtimeConfigFromArtifactHeader(req, [clinicCfg, groupCfg, domainCfg]);
  if (artifactRuntime.present && !artifactRuntime.config) {
    return res.status(409).json({ success: false, message: 'La versión web publicada ya no está autorizada.', code: 'intake_web_artifact_not_authorized' });
  }
  const cfg = artifactRuntime.config || pickMatchingIntakeConfig({
    req,
    providedSignature: provided,
    clinicCfg,
    groupCfg,
    domainCfg
  });

  if (cfg && Array.isArray(cfg.domains) && cfg.domains.length > 0) {
    if (!domain || !isDomainAllowed(cfg.domains, domain)) {
      return res.status(403).json({ success: false, message: 'Domain not allowed' });
    }
  }

  const intakeAuthentication = authenticatePublicIntakeRequest({
    req,
    config: cfg,
    fallbackSecret: process.env.INTAKE_WEB_SECRET,
  });
  if (!intakeAuthentication.ok) {
    return res.status(intakeAuthentication.status).json({
      success: false,
      message: intakeAuthentication.message,
      code: intakeAuthentication.code,
    });
  }
  req.publicIntakeAuthentication = intakeAuthentication.source;

  const domainClinicId = parseInteger(domainCfg?.clinic_id);
  const domainGroupId = parseInteger(domainCfg?.group_id);
  if (clinicIdParsed === null && domainClinicId !== null) {
    clinicIdParsed = domainClinicId;
  }
  if (groupIdParsed === null && domainGroupId !== null) {
    groupIdParsed = domainGroupId;
  }
  if (clinicIdParsed === null && groupIdParsed !== null) {
    const pageClinic = await resolveClinicByPageUrlWithinGroup(
      groupIdParsed,
      pageUrl,
      [cfg, groupCfg, domainCfg].find((record) => record?.assignment_scope === 'group') || null,
    );
    clinicIdParsed = parseInteger(pageClinic?.id_clinica)
      || await resolveFallbackClinicForGroup(groupIdParsed);
  }
  if (clinicIdParsed === null && groupIdParsed === null) {
    return res.status(400).json({ success: false, message: 'clinic_id o group_id requerido' });
  }

  const ttlDays = Math.max(1, parseInteger(process.env.WHATSAPP_WEB_ORIGIN_TTL_DAYS) || 7);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const payload = {
    ref,
    clinic_id: clinicIdParsed,
    group_id: groupIdParsed,
    domain: truncateString(domain, 255),
    page_url: pageUrl,
    referrer: truncateString(body.referrer, 1024),
    utm_source: truncateString(body.utm_source, 128),
    utm_medium: truncateString(body.utm_medium, 128),
    utm_campaign: truncateString(body.utm_campaign, 128),
    utm_content: truncateString(body.utm_content, 128),
    utm_term: truncateString(body.utm_term, 128),
    gclid: truncateString(body.gclid, 128),
    gbraid: truncateString(body.gbraid || body.gBraid, 255),
    wbraid: truncateString(body.wbraid || body.wBraid, 255),
    ga_client_id: truncateString(body.ga_client_id || body.gaClientId || body.client_id, 191),
    google_ads_customer_id: truncateString(body.google_ads_customer_id || body.cc_gads_customer_id, 32),
    google_ads_campaign_id: googleAdsCampaignId,
    fbclid: truncateString(body.fbclid, 128),
    ttclid: truncateString(body.ttclid, 128),
    event_id: truncateString(req.headers[EVENT_ID_HEADER] || body.event_id || body.eventId, 128),
    expires_at: expiresAt,
    metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : null,
  };

  const existing = await WhatsAppWebOrigin.findOne({ where: { ref } });
  let record = existing;
  let created = false;
  if (existing) {
    await existing.update(payload);
  } else {
    record = await WhatsAppWebOrigin.create(payload);
    created = true;
  }

  return res.json({
    success: true,
    ref,
    id: record.id,
    created,
    expires_at: expiresAt.toISOString(),
  });
});

exports.receiveIntakeEvent = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const eventName = body.event_name || body.eventName || 'ViewContent';
  let clinicIdParsed = parseInteger(coalesce(body.clinic_id, body.clinica_id, body.clinicId));
  let groupIdParsed = parseInteger(coalesce(body.group_id, body.grupo_clinica_id, body.groupId));

  const eventSourceUrl = coalesce(
    body.event_source_url,
    body.eventSourceUrl,
    body.page_url,
    body.pageUrl,
    body.event_data?.page_url,
    body.event_data?.pageUrl
  );

  const domainFromBody = body.domain || null;
  const derivedDomain = getHostnameFromUrl(eventSourceUrl || '');
  const domain = normalizeDomain(domainFromBody || derivedDomain) || '';

  const customDataFromBody =
    body.custom_data && typeof body.custom_data === 'object' && !Array.isArray(body.custom_data) ? body.custom_data : {};
  const eventDataFromBody =
    body.event_data && typeof body.event_data === 'object' && !Array.isArray(body.event_data) ? body.event_data : {};

  // Aceptar el payload del snippet "v2" (campos planos + event_data) y el payload "canónico" (custom_data/user_data).
  const custom_data = {
    ...customDataFromBody,
    ...eventDataFromBody
  };

  // Compat: campos planos (utm/gclid/etc.)
  if (body.source && custom_data.source == null) custom_data.source = body.source;
  if (body.source_detail && custom_data.source_detail == null) custom_data.source_detail = body.source_detail;
  if (body.utm_campaign && custom_data.utm_campaign == null) custom_data.utm_campaign = body.utm_campaign;
  if (body.gclid && custom_data.gclid == null) custom_data.gclid = body.gclid;
  if (body.gbraid && custom_data.gbraid == null) custom_data.gbraid = body.gbraid;
  if (body.wbraid && custom_data.wbraid == null) custom_data.wbraid = body.wbraid;
  if (body.fbclid && custom_data.fbclid == null) custom_data.fbclid = body.fbclid;
  if (body.value != null && custom_data.value == null) custom_data.value = body.value;
  if (body.currency && custom_data.currency == null) custom_data.currency = body.currency;
  const googleAdsCampaignId = resolveGoogleAdsCampaignId({
    ccCandidates: [
      body.cc_gads_campaign_id,
      customDataFromBody.cc_gads_campaign_id,
      eventDataFromBody.cc_gads_campaign_id,
    ],
    canonicalCandidates: [
      body.google_ads_campaign_id,
      body.google_campaign_id,
      customDataFromBody.google_ads_campaign_id,
      customDataFromBody.google_campaign_id,
      customDataFromBody.campaign_id,
      eventDataFromBody.google_ads_campaign_id,
    ],
    gadCandidates: [
      body.gad_campaignid,
      body.gadCampaignId,
      customDataFromBody.gad_campaignid,
      eventDataFromBody.gad_campaignid,
    ],
    urls: [
      eventSourceUrl,
      body.landing_url,
      body.landingUrl,
      eventDataFromBody.landing_url,
      eventDataFromBody.landingUrl,
    ],
  });
  if (googleAdsCampaignId) {
    custom_data.campaign_id = googleAdsCampaignId;
    custom_data.google_ads_campaign_id = googleAdsCampaignId;
  }

  const userDataFromBody =
    body.user_data && typeof body.user_data === 'object' && !Array.isArray(body.user_data) ? body.user_data : {};

  // Compat: algunos clientes pueden mandar lead_data (nombre/email/telefono) también en eventos.
  const leadDataFromBody =
    body.lead_data && typeof body.lead_data === 'object' && !Array.isArray(body.lead_data) ? body.lead_data : {};

  const user_data = {
    ...userDataFromBody,
    ...leadDataFromBody
  };

  const fbp = body.fbp || user_data.fbp;
  const fbc = body.fbc || user_data.fbc;

  let clinicCfg = null;
  let groupCfg = null;
  let domainCfg = null;
  if (clinicIdParsed !== null) {
    clinicCfg = await IntakeConfig.findOne({ where: { clinic_id: clinicIdParsed }, raw: true });
  }
  if (groupIdParsed !== null) {
    groupCfg = await IntakeConfig.findOne({ where: { group_id: groupIdParsed, assignment_scope: 'group' }, raw: true });
  }
  if (domain) {
    domainCfg = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain.toLowerCase()}\"') AND assignment_scope='clinic'`),
      order: [['created_at', 'ASC'], ['id', 'ASC']],
    });
    if (!domainCfg) {
      domainCfg = await IntakeConfig.findOne({
        where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain.toLowerCase()}\"') AND assignment_scope='group'`),
        order: [['created_at', 'ASC'], ['id', 'ASC']],
      });
    }
    if (domainCfg) domainCfg = domainCfg.get ? domainCfg.get({ plain: true }) : domainCfg;
  }

  ({ clinicCfg, groupCfg, domainCfg } = await resolveEffectivePublicIntakeRecords({
    clinicCfg,
    groupCfg,
    domainCfg,
    clinicId: clinicIdParsed,
    groupId: groupIdParsed,
    models: db,
  }));
  [clinicCfg, groupCfg, domainCfg] = await Promise.all([
    withRuntimeTransitionHmacs(clinicCfg),
    withRuntimeTransitionHmacs(groupCfg),
    withRuntimeTransitionHmacs(domainCfg),
  ]);
  const provided = req.headers['x-cc-signature'] || req.headers['x-cc-signature-sha256'];
  const artifactRuntime = await runtimeConfigFromArtifactHeader(req, [clinicCfg, groupCfg, domainCfg]);
  if (artifactRuntime.present && !artifactRuntime.config) {
    return res.status(409).json({ message: 'La versión web publicada ya no está autorizada.', code: 'intake_web_artifact_not_authorized' });
  }
  const cfg = artifactRuntime.config || pickMatchingIntakeConfig({
    req,
    providedSignature: provided,
    clinicCfg,
    groupCfg,
    domainCfg
  });

  if (cfg && Array.isArray(cfg.domains) && cfg.domains.length > 0) {
    // Si hay allowlist configurada, el dominio es obligatorio.
    if (!domain || !isDomainAllowed(cfg.domains, domain)) {
      return res.status(403).json({ message: 'Domain not allowed' });
    }
  }

  const intakeAuthentication = authenticatePublicIntakeRequest({
    req,
    config: cfg,
    fallbackSecret: process.env.INTAKE_WEB_SECRET,
  });
  if (!intakeAuthentication.ok) {
    return res.status(intakeAuthentication.status).json({
      message: intakeAuthentication.message,
      code: intakeAuthentication.code,
    });
  }
  req.publicIntakeAuthentication = intakeAuthentication.source;

  const domainClinicId = parseInteger(domainCfg?.clinic_id);
  const domainGroupId = parseInteger(domainCfg?.group_id);
  if (clinicIdParsed === null && domainClinicId !== null) {
    clinicIdParsed = domainClinicId;
  }
  if (groupIdParsed === null && domainGroupId !== null) {
    groupIdParsed = domainGroupId;
  }
  if (clinicIdParsed === null && groupIdParsed !== null) {
    const pageClinic = await resolveClinicByPageUrlWithinGroup(
      groupIdParsed,
      eventSourceUrl,
      [cfg, groupCfg, domainCfg].find((record) => record?.assignment_scope === 'group') || null,
    );
    clinicIdParsed = parseInteger(pageClinic?.id_clinica);
  }
  if (clinicIdParsed === null && groupIdParsed !== null && String(eventName).trim().toLowerCase() === 'callinitiated') {
    const clickedTel = cleanString(coalesce(
      body.clicked_tel,
      body.clickedTel,
      eventDataFromBody.clicked_tel,
      eventDataFromBody.clickedTel,
    ));
    const phoneClinic = await resolveClinicByPhoneWithinGroup(
      groupIdParsed,
      clickedTel,
      [cfg, groupCfg, domainCfg].find((record) => record?.assignment_scope === 'group') || null,
    );
    clinicIdParsed = parseInteger(phoneClinic?.id_clinica);
  }

  const finalClinicCfg = clinicIdParsed !== null
    ? await IntakeConfig.findOne({ where: { clinic_id: clinicIdParsed }, raw: true })
    : null;
  const finalGroupCfg = groupIdParsed !== null
    ? await IntakeConfig.findOne({ where: { group_id: groupIdParsed, assignment_scope: 'group' }, raw: true })
    : null;
  const effectiveTracking = resolveEffectiveTrackingFromRecords({
    clinicId: clinicIdParsed,
    groupId: groupIdParsed,
    selectedRecord: cfg,
    clinicCfg: finalClinicCfg,
    groupCfg: finalGroupCfg
  });
  const metaRuntime = await resolveMetaCapiRuntimeConfig({
    clinicId: clinicIdParsed,
    groupId: groupIdParsed,
    selectedRecord: cfg,
    clinicCfg: finalClinicCfg,
    groupCfg: finalGroupCfg
  });
  const consentRecord = cfg || finalClinicCfg || finalGroupCfg || null;
  const consentModeEnabled = [cfg, finalClinicCfg, finalGroupCfg].some(isConsentModeEnabledForRecord);
  const marketingConsent = normalizeMarketingConsent(body.consent || custom_data.consent || eventDataFromBody.consent || null);
  const allowAdPlatformEvents = !consentModeEnabled || marketingConsent === true;

  try {
    await webEventsService.recordWebEvent({
      req,
      body,
      cfgRecord: consentRecord,
      clinicId: cfg?.clinic_id || clinicIdParsed || null,
      groupId: cfg?.group_id || groupIdParsed || null,
      eventName: eventName || 'ViewContent',
      eventSourceUrl,
      customData: custom_data
    });
  } catch (webEventErr) {
    console.warn('⚠️ WebEvent persist error:', webEventErr.message || webEventErr);
  }

  const userData = buildMetaUserData({
    email: user_data.email,
    phone: user_data.phone || user_data.telefono,
    ip: user_data.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    ua: user_data.ua || req.headers['user-agent'],
    fbp: fbp || user_data.fbp,
    fbc: fbc || user_data.fbc,
    externalId: user_data.external_id
  });

  if (allowAdPlatformEvents) {
    await sendMetaEvent({
      eventName: eventName || 'ViewContent',
      eventTime: body.event_time || Math.floor(Date.now() / 1000),
      eventId: body.event_id || undefined,
      actionSource: body.action_source || 'website',
      eventSourceUrl: eventSourceUrl || undefined,
      clinicId: cfg?.clinic_id || clinicIdParsed || null,
      source: custom_data.source,
      sourceDetail: custom_data.source_detail,
      utmCampaign: custom_data.utm_campaign,
      value: custom_data.value,
      currency: custom_data.currency || 'EUR',
      userData,
      pixelId: metaRuntime.pixelId,
      accessToken: metaRuntime.accessToken
    });
  }

  // Google Ads Enhanced Conversions (server-side)
  // Prioridad de configuración:
  // 1) custom_data del propio evento
  // 2) config.google_ads (clínica/grupo)
  // 3) variables de entorno
  try {
    await maybeUploadGoogleConversion({
      cfgRecord: cfg,
      googleAdsConfig: effectiveTracking.google_ads,
      eventName: eventName || 'ViewContent',
      customData: {
        ...custom_data,
        conversion_time: coalesce(custom_data.conversion_time, custom_data.conversionDateTime, body.event_time)
      },
      userData: user_data,
      consent: body.consent || null,
      eventId: body.event_id || user_data.external_id || null,
      clinicId: clinicIdParsed,
      groupId: groupIdParsed,
      assignmentScope: effectiveTracking.google_ads?.config_source === 'group' ? 'group' : 'clinic',
      allowUpload: allowAdPlatformEvents,
      consentModeEnabled
    });
  } catch (adsErr) {
    console.warn('⚠️ Google Ads upload error (events):', adsErr.response?.data || adsErr.message || adsErr);
  }

  const normalizedEventName = String(eventName || '').trim().toLowerCase();
  if (normalizedEventName === 'callinitiated') {
    const leadId = parseInteger(coalesce(body.lead_id, body.leadId, eventDataFromBody.lead_id, eventDataFromBody.leadId));
    const clickedTel = cleanString(coalesce(body.clicked_tel, body.clickedTel, eventDataFromBody.clicked_tel, eventDataFromBody.clickedTel));
    const pageUrl = cleanString(coalesce(body.page_url, body.pageUrl, eventDataFromBody.page_url, eventDataFromBody.pageUrl, eventSourceUrl));
    let lead = leadId !== null ? await LeadIntake.findByPk(leadId) : null;

    let resolvedClinicId = clinicIdParsed;
    let resolvedGroupId = groupIdParsed;

    if (!resolvedClinicId && lead?.clinica_id) {
      resolvedClinicId = parseInteger(lead.clinica_id);
    }
    if (!resolvedGroupId && lead?.grupo_clinica_id) {
      resolvedGroupId = parseInteger(lead.grupo_clinica_id);
    }

    if (!resolvedClinicId && resolvedGroupId !== null && clickedTel) {
      const matchedClinic = await resolveClinicByPhoneWithinGroup(
        resolvedGroupId,
        clickedTel,
        finalGroupCfg || groupCfg || cfg || null,
      );
      if (matchedClinic) {
        resolvedClinicId = parseInteger(matchedClinic.id_clinica);
        resolvedGroupId = parseInteger(matchedClinic.grupoClinicaId) || resolvedGroupId;
      }
    }

    if (lead) {
      const callInitiatedAt = new Date();
      const updatePayload = {
        call_initiated: true,
        call_initiated_at: callInitiatedAt,
        call_outcome: null,
        call_outcome_at: null,
        call_outcome_notes: null,
        call_outcome_appointment_id: null,
      };
      if (!lead.clinica_id && resolvedClinicId !== null) {
        updatePayload.clinica_id = resolvedClinicId;
      }
      if (!lead.grupo_clinica_id && resolvedGroupId !== null) {
        updatePayload.grupo_clinica_id = resolvedGroupId;
      }
      await lead.update(updatePayload);

      try {
        await leadAutoReplyService.enqueueForLead({
          lead,
          eventKind: 'call',
          eventAt: callInitiatedAt,
        });
      } catch (automationError) {
        console.warn('⚠️ No se pudo encolar la respuesta automática tras la llamada:', automationError.message || automationError);
      }

      try {
        await LeadAttributionAudit.create({
          lead_intake_id: lead.id,
          raw_payload: body || {},
          attribution_steps: { action: 'call_initiated', clinic_id: resolvedClinicId, group_id: resolvedGroupId }
        });
      } catch (auditErr) {
        console.warn('⚠️ No se pudo registrar auditoría de llamada iniciada:', auditErr.message || auditErr);
      }

      try {
        await emitLeadSocketEvent(
          'lead:call_initiated',
          buildLeadCallInitiatedSocketPayload({
            lead,
            clinicId: resolvedClinicId,
            groupId: resolvedGroupId,
            clickedTel,
            pageUrl,
            source: body.source || 'web',
            sourceDetail: eventDataFromBody.source_detail || body.source_detail || 'tel_modal_call',
            linkedBy: leadId !== null ? 'lead_id' : 'phone'
          }),
          { clinicId: resolvedClinicId, groupId: resolvedGroupId }
        );
      } catch (emitErr) {
        console.warn('⚠️ No se pudo emitir lead:call_initiated:', emitErr.message || emitErr);
      }
    }
  }

  res.json({ success: true });
});

exports.verifyMetaWebhook = asyncHandler(async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

const mapMetaField = (fieldData = [], name) => {
  const item = fieldData.find((f) => f.name === name);
  if (!item || !Array.isArray(item.values)) return null;
  return item.values[0] ?? null;
};

const META_UNMAPPED_PAGE_LOG_TTL_MS = Number(process.env.META_UNMAPPED_PAGE_LOG_TTL_MS || 60 * 60 * 1000);
const META_PAGE_MAPPING_CACHE_TTL_MS = Number(process.env.META_PAGE_MAPPING_CACHE_TTL_MS || 5 * 60 * 1000);
const metaUnmappedPageLogCache = new Map();
const metaPageMappingCache = new Map();
const shouldLogUnmappedMetaLeadgen = (pageId, formId) => {
  const key = `${pageId || 'unknown'}|${formId || 'unknown'}`;
  const now = Date.now();
  const last = metaUnmappedPageLogCache.get(key) || 0;
  if (now - last < META_UNMAPPED_PAGE_LOG_TTL_MS) {
    return false;
  }
  metaUnmappedPageLogCache.set(key, now);
  return true;
};
const resolveActiveMetaLeadPage = async (pageId) => {
  const normalizedPageId = cleanString(pageId);
  if (!normalizedPageId || !ClinicMetaAsset) return null;

  const cached = metaPageMappingCache.get(normalizedPageId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await ClinicMetaAsset.findOne({
    where: { metaAssetId: String(normalizedPageId), assetType: 'facebook_page', isActive: true },
    raw: true,
  });
  metaPageMappingCache.set(normalizedPageId, {
    value: value || null,
    expiresAt: now + META_PAGE_MAPPING_CACHE_TTL_MS,
  });
  return value || null;
};

exports.receiveMetaWebhook = asyncHandler(async (req, res) => {
  if (!validateMetaSignature(req)) {
    return res.status(401).json({ message: 'Firma Meta inválida' });
  }

  const { object, entry } = req.body || {};
  if (object !== 'page' || !Array.isArray(entry)) {
    return res.status(200).json({ success: true });
  }

  for (const pageEntry of entry) {
    if (!Array.isArray(pageEntry.changes)) continue;
    for (const change of pageEntry.changes) {
      if (change.field !== 'leadgen' || !change.value) continue;
      const changeValue = change.value;
      const leadId = changeValue.leadgen_id || changeValue.lead_id;
      const formId = changeValue.form_id || null;
      const adId = changeValue.ad_id || null;
      const pageId = changeValue.page_id || pageEntry.id || null;
      if (!leadId) continue;

      let mappedPage = null;
      try {
        mappedPage = await resolveActiveMetaLeadPage(pageId);
      } catch (mapClinicErr) {
        console.warn('⚠️ No se pudo mapear clínica desde page_id:', mapClinicErr.message || mapClinicErr);
      }

      if (!mappedPage) {
        if (shouldLogUnmappedMetaLeadgen(pageId, formId)) {
          console.info(`Lead Meta ignorado por página no conectada a ClinicaClick: page_id=${pageId || 'unknown'} form_id=${formId || 'unknown'} lead_id=${leadId}`);
        }
        continue;
      }

      let leadData = {};
      try {
        if (!META_GRAPH_TOKEN) throw new Error('META_GRAPH_TOKEN no configurado');
        const fields = 'field_data,ad_id,form_id,created_time';
        const { data } = await axios.get(`https://graph.facebook.com/${META_GRAPH_VERSION}/${leadId}`, {
          params: { access_token: META_GRAPH_TOKEN, fields }
        });
        const fd = data?.field_data || [];
        leadData = {
          nombre: mapMetaField(fd, 'full_name') || mapMetaField(fd, 'first_name'),
          email: mapMetaField(fd, 'email'),
          telefono: mapMetaField(fd, 'phone_number'),
          ref: data
        };
      } catch (fetchErr) {
        console.warn('⚠️ No se pudo obtener datos del lead de Meta:', fetchErr.message || fetchErr);
      }

      // Buscar campaña por ad_id si es posible
      let campanaId = null;
      try {
        if (adId && AdCache) {
          const adCache = await AdCache.findOne({ where: { ad_id: adId } });
          if (adCache) {
            const camp = await Campana.findOne({ where: { campaign_id: adCache.campaign_id } });
            if (camp) campanaId = camp.id;
          }
        }
      } catch (mapErr) {
        console.warn('⚠️ No se pudo mapear campana desde ad_id:', mapErr.message || mapErr);
      }

      const leadPayload = {
        clinica_id: mappedPage.clinicaId || null,
        grupo_clinica_id: mappedPage.grupoClinicaId || null,
        event_id: leadId,
        campana_id: campanaId,
        channel: 'paid',
        source: 'meta_ads',
        source_detail: `leadgen_form:${formId || 'unknown'}`,
        utm_campaign: changeValue.campaign_name || null,
        utm_source: 'meta',
        utm_medium: 'leadgen',
        nombre: leadData.nombre || null,
        email: leadData.email || null,
        telefono: leadData.telefono || null,
        status_lead: 'nuevo',
        external_source: 'meta_leadgen',
        external_id: leadId,
        intake_payload_hash: hashValue(stableStringify(changeValue)),
        clinic_match_source: 'meta_page_id',
        clinic_match_value: pageId || null
      };

      try {
        const createdLead = await dedupeAndCreateLead(
          leadPayload,
          { change: changeValue, meta_lead_data: leadData },
          { meta_page_id: pageId }
        );
        await leadAutoReplyService.enqueueForLead({
          lead: createdLead,
          eventKind: 'write',
          eventAt: createdLead.created_at || createdLead.createdAt || new Date(),
        });
      } catch (err) {
        if (err.status === 409) {
          console.info(`Lead Meta duplicado (${err.message}) -> ${err.existingId}`);
          const existingLead = err.existingId
            ? await LeadIntake.findByPk(err.existingId)
            : null;
          if (existingLead) {
            await leadAutoReplyService.enqueueForLead({
              lead: existingLead,
              eventKind: 'write',
              eventAt: existingLead.created_at || existingLead.createdAt || new Date(),
            });
          }
          continue;
        }
        console.error('Error creando LeadIntake desde Meta webhook:', err.message || err);
      }
    }
  }

  return res.status(200).json({ success: true });
});

const LEAD_LIST_SORT_FIELDS = new Set(['created_at', 'channel', 'source', 'status_lead', 'campana_id']);

const buildLeadListPayload = async (query = {}, context = {}) => {
  const {
    clinicId,
    groupId,
    campanaId,
    channel,
    source,
    status,
    search,
    startDate,
    endDate,
    limit = 50,
    offset = 0,
    page,
    pageSize,
    sortBy,
    sortOrder
  } = query;

  const where = {};
  const includeArchived = ['1', 'true', 'yes'].includes(String(query.includeArchived || query.include_archived || '').toLowerCase());
  if (!includeArchived) where.archived_at = null;
  const clinicIdRaw = clinicId || query.clinica_id;
  const groupIdRaw = groupId || query.grupo_clinica_id;
  const campanaIdParsed = parseInteger(campanaId || query.campana_id);

  await applyLeadScopeWhere(where, { ...query, clinicId: clinicIdRaw, groupId: groupIdRaw }, context.userId);
  if (campanaIdParsed !== null) where.campana_id = campanaIdParsed;
  if (channel && CHANNELS.has(channel)) where.channel = channel;
  if (source && SOURCES.has(source)) {
    const originWhere = buildMarketingOriginWhere(source, Op);
    if (originWhere) where[Op.and] = [...(where[Op.and] || []), originWhere];
  }
  if (status && STATUSES.has(status)) where.status_lead = status;

  if (startDate || endDate) {
    where.created_at = {};
    if (startDate) where.created_at[Op.gte] = new Date(startDate);
    if (endDate) where.created_at[Op.lte] = new Date(endDate);
  }

  if (search) {
    const canSearchSensitive = await canSearchSensitiveLeadFields(query, context.userId);
    const searchConditions = buildLeadSearchConditions(search, {
      canSearchSensitive,
      includeCampaignRelation: true,
    });
    if (searchConditions.length) where[Op.or] = searchConditions;
  }

  const pageSizeParsed = Math.max(parseInteger(pageSize) || Math.min(Math.max(Number(limit) || 50, 1), 200), 1);
  const pageParsed = Math.max(parseInteger(page) || 0, 0);
  const parsedOffset = pageParsed > 0 ? (pageParsed - 1) * pageSizeParsed : Math.max(Number(offset) || 0, 0);
  const parsedLimit = pageSizeParsed;
  const normalizedSortBy = LEAD_LIST_SORT_FIELDS.has(sortBy) ? sortBy : 'created_at';
  const normalizedSortOrder = String(sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const order = [[normalizedSortBy, normalizedSortOrder]];
  if (normalizedSortBy !== 'id') {
    order.push(['id', normalizedSortOrder]);
  }

  const leads = await LeadIntake.findAndCountAll({
    where,
    include: [
      { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] },
      { model: GrupoClinica, as: 'grupoClinica', attributes: ['id_grupo', 'nombre_grupo'] },
      { model: Campana, as: 'campana', attributes: ['id', 'nombre', 'campaign_id'], required: false }
    ].filter(Boolean),
    distinct: true,
    subQuery: false,
    order,
    limit: parsedLimit,
    offset: parsedOffset
  });

  const pageNumber = pageParsed > 0 ? pageParsed : Math.floor(parsedOffset / parsedLimit) + 1;
  const totalPages = parsedLimit > 0 ? Math.ceil(leads.count / parsedLimit) : 0;

  const enrichedItems = await enrichLeadsForUi(leads.rows);
  const requestLike = { userData: { userId: context.userId } };
  const items = await protectLeadRowsForRequest(requestLike, enrichedItems);

  return {
    total: leads.count,
    limit: parsedLimit,
    offset: parsedOffset,
    page: pageNumber,
    pageSize: parsedLimit,
    totalPages,
    items
  };
};

exports.listLeads = asyncHandler(async (req, res) => {
  const payload = await buildLeadListPayload(req.query, { userId: req.userData?.userId });
  res.status(200).json(payload);
});

exports.getLeadAutoReplyStatus = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.query.clinic_id || req.query.clinicId);
  if (clinicId === null) {
    return res.status(400).json({ success: false, error: 'clinic_id_required' });
  }
  if (!(await requireLeadAutomationClinicAccess(req, res, clinicId))) return;
  const status = await leadAutoReplyService.getStatus(clinicId);
  return res.status(200).json({ success: true, data: status });
});

exports.getLeadAutoReplyPendingPreview = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.query.clinic_id || req.query.clinicId);
  if (clinicId === null) return res.status(400).json({ success: false, error: 'clinic_id_required' });
  if (!(await requireLeadAutomationClinicAccess(req, res, clinicId))) return;
  const preview = await leadAutoReplyService.getPendingPreview(clinicId);
  return res.status(200).json({ success: true, data: preview });
});

exports.startLeadAutoReplyPendingSend = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.body?.clinic_id || req.body?.clinicId);
  if (clinicId === null) return res.status(400).json({ success: false, error: 'clinic_id_required' });
  if (!(await requireLeadAutomationClinicAccess(req, res, clinicId))) return;
  try {
    const batch = await leadAutoReplyService.startPendingBatch({
      clinicId,
      actorUserId: parseInteger(req.userData?.userId) || 1,
    });
    return res.status(202).json({ success: true, data: batch });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.code || 'lead_auto_reply_batch_start_failed',
      message: error.message,
    });
  }
});

exports.getLeadAutoReplyPendingProgress = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.query.clinic_id || req.query.clinicId);
  const jobId = parseInteger(req.params.jobId);
  if (clinicId === null || jobId === null) {
    return res.status(400).json({ success: false, error: 'clinic_id_and_job_id_required' });
  }
  if (!(await requireLeadAutomationClinicAccess(req, res, clinicId))) return;
  try {
    const progress = await leadAutoReplyService.getPendingBatchProgress({ clinicId, jobId });
    return res.status(200).json({ success: true, data: progress });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.code || 'lead_auto_reply_batch_progress_failed',
      message: error.message,
    });
  }
});

exports.updateLeadAutoReply = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.body?.clinic_id || req.body?.clinicId);
  if (clinicId === null) {
    return res.status(400).json({ success: false, error: 'clinic_id_required' });
  }
  if (!(await requireLeadAutomationClinicAccess(req, res, clinicId))) return;
  try {
    const hasConfig = req.body?.config && typeof req.body.config === 'object' && !Array.isArray(req.body.config);
    const status = hasConfig
      ? await leadAutoReplyService.saveConfig({
          clinicId,
          actorUserId: parseInteger(req.userData?.userId) || 1,
          input: {
            ...req.body.config,
            ...(req.body.active !== undefined ? { active: req.body.active === true } : {}),
          },
        })
      : await leadAutoReplyService.setActive({ clinicId, active: req.body?.active === true });
    return res.status(200).json({ success: true, data: status });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.code || 'lead_auto_reply_update_failed',
      message: error.message,
      details: error.details || null,
    });
  }
});

exports.searchLeads = asyncHandler(async (req, res) => {
  const payload = await buildLeadListPayload(req.query, { userId: req.userData?.userId });
  res.status(200).json(payload);
});

exports.getLeadById = asyncHandler(async (req, res) => {
  const leadId = parseInteger(req.params.id);
  if (!leadId) {
    return res.status(400).json({ message: 'Lead inválido' });
  }

  const lead = await LeadIntake.findByPk(leadId, {
    include: [
      { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] },
      { model: GrupoClinica, as: 'grupoClinica', attributes: ['id_grupo', 'nombre_grupo'] },
      { model: Campana, as: 'campana', attributes: ['id', 'nombre', 'campaign_id'], required: false },
      {
        model: FormSubmissionEvent,
        as: 'formSubmissionEvents',
        separate: true,
        order: [['submitted_at', 'DESC']],
        limit: 10,
      },
    ],
  });

  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }
  if (!(await ensureLeadScopeAccess(req, res, lead))) return;

  const out = lead.toJSON();
  const latestFormSubmission = Array.isArray(out.formSubmissionEvents) && out.formSubmissionEvents.length
    ? out.formSubmissionEvents[0]
    : null;
  const fallbackLeadData = latestFormSubmission?.payload_json?.lead_data && typeof latestFormSubmission.payload_json.lead_data === 'object'
    ? latestFormSubmission.payload_json.lead_data
    : {};

  if (!out.nombre && fallbackLeadData.nombre) out.nombre = fallbackLeadData.nombre;
  if (!out.email && fallbackLeadData.email) out.email = normalizeEmail(fallbackLeadData.email) || fallbackLeadData.email;
  if (!out.telefono && fallbackLeadData.telefono) out.telefono = normalizePhone(fallbackLeadData.telefono) || fallbackLeadData.telefono;

  if (Conversation) {
    const conversation = await findCanonicalWhatsappConversation({
      clinicId: out.clinica_id,
      contactId: out.telefono,
      leadId,
      createIfMissing: false,
    });
    out.conversation_id = conversation?.id || null;
  }

  const [enrichedLead] = await enrichLeadsForUi([out]);
  const [protectedLead] = await protectLeadRowsForRequest(req, [enrichedLead || out]);

  res.status(200).json(protectedLead || redactLeadForPrivacy(out));
});

exports.getLeadActivity = asyncHandler(async (req, res) => {
  const leadId = parseInteger(req.params.id);
  if (!leadId) {
    return res.status(400).json({ message: 'Lead inválido' });
  }

  const lead = await LeadIntake.findByPk(leadId, {
    include: [
      {
        model: FormSubmissionEvent,
        as: 'formSubmissionEvents',
        separate: true,
        order: [['submitted_at', 'DESC']],
        limit: 20,
      },
    ],
  });

  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }
  if (!(await ensureLeadFeatureAccess(req, res, lead, 'leads.sensitive.view'))) return;

  if (lead.telefono && lead.clinica_id) {
    await findCanonicalWhatsappConversation({
      clinicId: lead.clinica_id,
      contactId: lead.telefono,
      leadId,
      createIfMissing: false,
    });
  }

  const conversations = await Conversation.findAll({
    where: { lead_id: leadId },
    attributes: ['id', 'channel'],
    raw: true,
  });
  const conversationIds = conversations.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);

  const appointments = await CitaPaciente.findAll({
    where: { lead_intake_id: leadId },
    attributes: [
      'id_cita',
      'paciente_id',
      'created_by',
      'updated_by',
      'created_at',
      'updated_at',
      'inicio',
      'estado',
      'tipo_cita',
    ],
    include: [
      db.Paciente ? { model: db.Paciente, as: 'paciente', attributes: ['id_paciente', 'nombre', 'apellidos', 'telefono_movil'], required: false } : null,
      db.Tratamiento ? { model: db.Tratamiento, as: 'tratamiento', attributes: ['id_tratamiento', 'nombre'], required: false } : null,
    ].filter(Boolean),
    order: [['inicio', 'ASC'], ['id_cita', 'ASC']],
  });

  const messages = conversationIds.length
    ? await Message.findAll({
        where: { conversation_id: { [Op.in]: conversationIds } },
        attributes: [
          'id',
          'conversation_id',
          'sender_id',
          'direction',
          'content',
          'message_type',
          'status',
          'metadata',
          'sent_at',
          'createdAt',
        ],
        order: [['createdAt', 'DESC']],
        raw: true,
        limit: 100,
      })
    : [];

  const actorIds = Array.from(new Set(
    [
      ...messages.map((message) => Number(message.sender_id)),
      ...appointments.map((appointment) => Number(toPlain(appointment)?.created_by)),
      ...appointments.map((appointment) => Number(toPlain(appointment)?.updated_by)),
    ]
      .filter((id) => Number.isFinite(id) && id > 0)
  ));

  const usuarios = actorIds.length
    ? await Usuario.findAll({
        where: { id_usuario: { [Op.in]: actorIds } },
        attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario'],
        raw: true,
      })
    : [];
  const usuariosById = new Map(usuarios.map((usuario) => [Number(usuario.id_usuario), usuario]));

  const items = [];

  for (const event of lead.formSubmissionEvents || []) {
    const detailParts = [];
    if (event.form_name) detailParts.push(event.form_name);
    if (event.page_url) detailParts.push(event.page_url);
    items.push({
      id: `lead-form-${event.id}`,
      leadId: String(leadId),
      fecha: event.submitted_at || event.created_at || lead.created_at,
      tipo: 'lead_form_submitted',
      titulo: 'Formulario enviado',
      descripcion: detailParts.join(' · ') || 'Envío de formulario web',
      icono: 'heroicons_outline:document-text',
      color: 'info',
      detalles: {
        form_id: event.form_id || null,
        form_name: event.form_name || null,
        page_url: event.page_url || null,
      },
    });
  }

  for (const contacto of Array.isArray(lead.historial_contactos) ? lead.historial_contactos : []) {
    items.push({
      id: `lead-contact-${leadId}-${contacto.fecha}`,
      leadId: String(leadId),
      fecha: contacto.fecha || lead.updated_at || lead.created_at,
      tipo: 'lead_contact_attempt',
      titulo: 'Contacto registrado',
      descripcion: contacto.notas || formatLeadContactReason(contacto.motivo) || 'Intento de contacto',
      icono: 'heroicons_outline:phone',
      color: 'warning',
      usuarioId: contacto.usuario_id ? String(contacto.usuario_id) : null,
      detalles: {
        motivo: contacto.motivo || null,
      },
    });
  }

  if (lead.callback_reminder_at) {
    items.push({
      id: `lead-callback-reminder-${leadId}`,
      leadId: String(leadId),
      fecha: lead.callback_reminder_at,
      tipo: 'lead_contact_attempt',
      titulo: 'Recordatorio para volver a llamar',
      descripcion: lead.callback_reminder_reason || lead.callback_reminder_notes || 'Seguimiento pendiente',
      icono: 'heroicons_outline:clock',
      color: 'warning',
    });
  }

  items.push({
    id: `lead-created-${leadId}`,
    leadId: String(leadId),
    fecha: lead.created_at,
    tipo: 'lead_created',
    titulo: 'Lead creado',
    descripcion: buildLeadCreatedDescription(lead),
    icono: 'heroicons_outline:user-plus',
    color: 'success',
  });

  for (const appointment of appointments) {
    const plain = toPlain(appointment);
    const createdByUser = usuariosById.get(Number(plain.created_by));
    const updatedByUser = usuariosById.get(Number(plain.updated_by));
    const createdDescriptions = buildAppointmentActivityDescription({
      telefono: cleanString(plain?.paciente?.telefono_movil) || cleanString(lead.telefono),
      inicio: plain.inicio,
      tratamiento: plain?.tratamiento?.nombre,
    });

    items.push({
      id: `lead-appointment-created-${plain.id_cita}`,
      leadId: String(leadId),
      fecha: plain.created_at || plain.inicio || lead.updated_at || lead.created_at,
      tipo: 'appointment_created',
      titulo: 'Cita agendada',
      descripcion: createdDescriptions.plain,
      descripcion_html: createdDescriptions.html,
      icono: 'heroicons_outline:calendar-days',
      color: 'info',
      usuarioId: createdByUser ? String(createdByUser.id_usuario) : null,
      usuarioNombre: buildActorLabel(createdByUser),
      detalles: {
        cita_id: plain.id_cita,
        estado: plain.estado || null,
        tipo_cita: plain.tipo_cita || null,
      },
    });

    const updatedAt = plain.updated_at ? new Date(plain.updated_at).getTime() : null;
    const createdAt = plain.created_at ? new Date(plain.created_at).getTime() : null;
    if (!updatedAt || !createdAt || updatedAt <= createdAt) {
      continue;
    }

    const statusToEventType = {
      info_enviada: 'appointment_created',
      info_confirmada: 'appointment_confirmed',
      recordatorio_enviado: 'appointment_reminder_window',
      recordatorio_confirmado: 'appointment_confirmed',
      completada: 'appointment_completed',
      cancelada: 'appointment_cancelled',
      no_asistio: 'appointment_no_show',
      reprogramada: 'appointment_rescheduled',
    };
    const eventType = statusToEventType[String(plain.estado || '').toLowerCase()] || 'appointment_created';
    const statusDescriptions = buildAppointmentActivityDescription({
      telefono: cleanString(plain?.paciente?.telefono_movil) || cleanString(lead.telefono),
      inicio: plain.inicio,
      tratamiento: plain?.tratamiento?.nombre,
      estado: plain.estado,
    });

    items.push({
      id: `lead-appointment-status-${plain.id_cita}`,
      leadId: String(leadId),
      fecha: plain.updated_at,
      tipo: eventType,
      titulo: 'Estado de cita actualizado',
      descripcion: statusDescriptions.plain,
      descripcion_html: statusDescriptions.html,
      icono: 'heroicons_outline:check-badge',
      color: ['cancelada', 'no_asistio'].includes(String(plain.estado || '').toLowerCase()) ? 'warning' : 'success',
      usuarioId: updatedByUser ? String(updatedByUser.id_usuario) : null,
      usuarioNombre: buildActorLabel(updatedByUser),
      detalles: {
        cita_id: plain.id_cita,
        estado: plain.estado || null,
      },
    });
  }

  for (const message of messages) {
    const actor = usuariosById.get(Number(message.sender_id));
    const createdAt = message.sent_at || message.createdAt || lead.updated_at || lead.created_at;
    const text = cleanString(message.content) || '—';
    const isFailed = String(message.status || '').toLowerCase() === 'failed';
    const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
    const waError = Array.isArray(metadata.wa_error) && metadata.wa_error.length
      ? cleanString(metadata.wa_error[0]?.message) || cleanString(metadata.wa_error[0]?.title)
      : null;
    const isAutomationEvent = message.message_type === 'event' && metadata.kind === 'automation_flow_event';
    if (isAutomationEvent && String(metadata.reason || '').toLowerCase() === 'flow_send_whatsapp') {
      continue;
    }

    if (message.direction === 'outbound') {
      const isTemplate = message.message_type === 'template';
      items.push({
        id: `lead-message-${message.id}`,
        leadId: String(leadId),
        fecha: createdAt,
        tipo: isTemplate ? 'lead_whatsapp_template_sent' : 'lead_whatsapp_message_sent',
        titulo: isTemplate ? 'Plantilla de WhatsApp enviada' : (isAutomationEvent ? 'Evento automático' : 'Mensaje de WhatsApp enviado'),
        descripcion: isFailed && waError ? `${text} · ${waError}` : text,
        icono: isTemplate ? 'heroicons_outline:document-text' : (isAutomationEvent ? 'heroicons_outline:bolt' : 'heroicons_outline:chat-bubble-left-right'),
        color: isFailed ? 'warning' : 'info',
        usuarioId: actor ? String(actor.id_usuario) : null,
        usuarioNombre: buildActorLabel(actor),
        detalles: {
          status: message.status || null,
          message_type: message.message_type || null,
          conversation_id: message.conversation_id || null,
        },
      });
      continue;
    }

    items.push({
      id: `lead-message-${message.id}`,
      leadId: String(leadId),
      fecha: createdAt,
      tipo: 'lead_whatsapp_reply',
      titulo: 'Respuesta recibida por WhatsApp',
      descripcion: text,
      icono: 'heroicons_outline:chat-bubble-left-right',
      color: 'info',
      usuarioId: null,
      usuarioNombre: cleanString(lead.nombre) || 'Lead',
      detalles: {
        status: message.status || null,
        message_type: message.message_type || null,
        conversation_id: message.conversation_id || null,
      },
    });
  }

  return res.status(200).json(
    items.sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime())
  );
});

exports.getLeadStats = asyncHandler(async (req, res) => {
  const {
    clinicId,
    groupId,
    campanaId,
    channel,
    source,
    search,
    startDate,
    endDate
  } = req.query;

  const where = {};
  const includeArchived = ['1', 'true', 'yes'].includes(String(req.query.includeArchived || req.query.include_archived || '').toLowerCase());
  if (!includeArchived) where.archived_at = null;
  const clinicIdRaw = clinicId || req.query.clinica_id;
  const groupIdRaw = groupId || req.query.grupo_clinica_id;
  const campanaIdParsed = parseInteger(campanaId || req.query.campana_id);

  await applyLeadScopeWhere(where, { ...req.query, clinicId: clinicIdRaw, groupId: groupIdRaw }, req.userData?.userId);
  if (campanaIdParsed !== null) where.campana_id = campanaIdParsed;
  if (channel && CHANNELS.has(channel)) where.channel = channel;
  if (source && SOURCES.has(source)) {
    const originWhere = buildMarketingOriginWhere(source, Op);
    if (originWhere) where[Op.and] = [...(where[Op.and] || []), originWhere];
  }

  if (startDate || endDate) {
    where.created_at = {};
    if (startDate) where.created_at[Op.gte] = new Date(startDate);
    if (endDate) where.created_at[Op.lte] = new Date(endDate);
  }

  if (search) {
    const canSearchSensitive = await canSearchSensitiveLeadFields(
      { ...req.query, clinicId: clinicIdRaw, groupId: groupIdRaw },
      req.userData?.userId,
    );
    const searchConditions = buildLeadSearchConditions(search, { canSearchSensitive });
    if (searchConditions.length) where[Op.or] = searchConditions;
  }

  // Obtener conteos por estado
  const total = await LeadIntake.count({ where });
  const nuevos = await LeadIntake.count({ where: { ...where, status_lead: 'nuevo' } });
  const contactados = await LeadIntake.count({ where: { ...where, status_lead: 'contactado' } });
  const esperando_info = await LeadIntake.count({ where: { ...where, status_lead: 'esperando_info' } });
  const info_recibida = await LeadIntake.count({ where: { ...where, status_lead: 'info_recibida' } });
  const cualificados = await LeadIntake.count({ where: { ...where, status_lead: 'cualificado' } });
  const citados = await LeadIntake.count({ where: { ...where, status_lead: 'citado' } });
  const acudio_cita = await LeadIntake.count({ where: { ...where, status_lead: 'acudio_cita' } });
  const convertidos = await LeadIntake.count({ where: { ...where, status_lead: 'convertido' } });
  const descartados = await LeadIntake.count({ where: { ...where, status_lead: 'descartado' } });

  const tasa_conversion = total > 0 ? (convertidos / total) * 100 : 0;

  res.status(200).json({
    total,
    nuevos,
    contactados,
    esperando_info,
    info_recibida,
    cualificados,
    citados,
    acudio_cita,
    convertidos,
    descartados,
    tasa_conversion
  });
});

exports.updateLeadStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status_lead, notas_internas, asignado_a, motivo_descarte } = req.body || {};

  const lead = await LeadIntake.findByPk(id);
  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }
  if (!(await ensureLeadFeatureAccess(req, res, lead, 'leads.manage'))) return;

  if (status_lead && !STATUSES.has(status_lead)) {
    return res.status(400).json({ message: 'status_lead inválido' });
  }

  if (status_lead === 'descartado' && !motivo_descarte) {
    return res.status(400).json({ message: 'motivo_descarte es obligatorio al descartar' });
  }

  const previousStatus = String(lead.status_lead || '').trim().toLowerCase();
  const updatePayload = {};
  if (status_lead) updatePayload.status_lead = status_lead;
  if (notas_internas !== undefined) updatePayload.notas_internas = notas_internas;
  if (asignado_a !== undefined) updatePayload.asignado_a = asignado_a;
  if (motivo_descarte !== undefined) updatePayload.motivo_descarte = motivo_descarte;

  await lead.update(updatePayload);

  let qualifiedLeadConversion = null;
  if (status_lead === 'cualificado') {
    qualifiedLeadConversion = await maybeUploadQualifiedLeadStatusTransition({
      lead,
      previousStatus,
      nextStatus: status_lead,
      occurredAt: lead.updated_at || new Date(),
      logger: console,
    });
  }

  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: { status_lead, notas_internas, asignado_a, motivo_descarte },
      attribution_steps: {
        action: 'status_update',
        userId: req.userData?.userId || null,
        previous_status: previousStatus,
        qualified_lead_event_id: status_lead === 'cualificado' ? `lead-${lead.id}-qualified` : null,
        qualified_lead_conversion: qualifiedLeadConversion
          ? {
              sent: qualifiedLeadConversion.sent === true,
              accepted: qualifiedLeadConversion.accepted === true,
              reason: qualifiedLeadConversion.reason || null,
            }
          : null,
      }
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar auditoría de cambio de estado:', auditErr.message || auditErr);
  }

  res.status(200).json(lead);
});

exports.registrarContacto = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { motivo, notas } = req.body || {};
  const reminderAtRaw = req.body?.callback_reminder_at;
  const reminderReason = cleanString(req.body?.callback_reminder_reason) || formatLeadContactReason(motivo) || 'Volver a llamar';
  const reminderNotes = cleanString(req.body?.callback_reminder_notes) || cleanString(notas);
  const hasReminderField = Object.prototype.hasOwnProperty.call(req.body || {}, 'callback_reminder_at');

  const lead = await LeadIntake.findByPk(id);
  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }
  if (!(await ensureLeadFeatureAccess(req, res, lead, 'leads.manage'))) return;

  let reminderAt = null;
  if (hasReminderField && reminderAtRaw) {
    reminderAt = new Date(reminderAtRaw);
    if (!Number.isFinite(reminderAt.getTime())) {
      return res.status(400).json({ message: 'callback_reminder_at inválido' });
    }
  }

  // Obtener historial actual o inicializar
  const historial = lead.historial_contactos || [];
  
  // Añadir nuevo registro de contacto
  const contactedAt = new Date();
  const nuevoContacto = {
    fecha: contactedAt.toISOString(),
    motivo: motivo || 'no_contesta',
    notas: notas || null,
    canal: 'llamada',
    usuario_id: req.userData?.userId || null
  };
  
  historial.push(nuevoContacto);

  if (lead.callback_reminder_job_id) {
    try {
      await jobRequestsService.markCancelled(lead.callback_reminder_job_id, {
        errorMessage: 'Recordatorio sustituido por una nueva programación',
      });
    } catch (_err) {
      // no bloqueamos el update del lead si no encontramos el job previo
    }
  }

  let reminderJob = null;
  if (reminderAt) {
    reminderJob = await jobRequestsService.enqueueJobRequest({
      type: 'lead_callback_reminder_notify',
      priority: 'normal',
      status: 'waiting',
      origin: 'lead_callback_reminder',
      requestedBy: req.userData?.userId || null,
      requestedByName: cleanString(
        req.userData?.name
        || req.userData?.nombre
        || req.userData?.username
        || req.userData?.email
        || null
      ),
      requestedByRole: cleanString(req.userData?.role || req.userData?.rol || 'admin'),
      nextRunAt: reminderAt,
      payload: {
        lead_id: lead.id,
        user_id: req.userData?.userId || null,
        clinic_id: lead.clinica_id || null,
        reason: reminderReason,
        notes: reminderNotes,
      },
    });
  }

  // Actualizar el lead
  const updatePayload = {
    historial_contactos: historial,
    num_contactos: (lead.num_contactos || 0) + 1,
    ultimo_contacto: contactedAt,
    // Registrar otro intento no degrada hitos CRM ya alcanzados. Volver a
    // `contactado` desde `cualificado` solo puede ser una transición explícita.
    status_lead: ['cualificado', 'citado', 'acudio_cita', 'convertido', 'descartado']
      .includes(String(lead.status_lead || '').trim().toLowerCase())
      ? lead.status_lead
      : 'contactado',
  };
  if (hasReminderField) {
    updatePayload.callback_reminder_at = reminderAt ? reminderAt.toISOString() : null;
    updatePayload.callback_reminder_reason = reminderAt ? reminderReason : null;
    updatePayload.callback_reminder_notes = reminderAt ? reminderNotes : null;
    updatePayload.callback_reminder_created_by = reminderAt ? (req.userData?.userId || null) : null;
    updatePayload.callback_reminder_job_id = reminderAt ? reminderJob?.id || null : null;
    updatePayload.callback_reminder_notified_at = null;
  }

  await lead.update(updatePayload);

  if (LeadContactAttempt) {
    try {
      await LeadContactAttempt.create({
        lead_intake_id: lead.id,
        usuario_id: req.userData?.userId || null,
        canal: 'llamada',
        motivo: motivo || 'no_contesta',
        notas: notas || null,
        created_at: contactedAt,
        updated_at: contactedAt,
      });
    } catch (attemptErr) {
      // El historial legado ya conserva el contacto; no hacemos fallar una
      // acción del usuario por una incidencia de normalización secundaria.
      console.warn('⚠️ No se pudo normalizar el intento de contacto:', attemptErr.message || attemptErr);
    }
  }

  // Registrar auditoría
  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: {
        action: 'registrar_contacto',
        motivo,
        notas,
        callback_reminder_at: reminderAt ? reminderAt.toISOString() : null,
        callback_reminder_reason: reminderAt ? reminderReason : null,
      },
      attribution_steps: { action: 'registrar_contacto', userId: req.userData?.userId || null }
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar auditoría de contacto:', auditErr.message || auditErr);
  }

  res.status(200).json(lead);
});

exports.getCandidateAppointments = asyncHandler(async (req, res) => {
  const leadId = parseInteger(req.params.id);
  const hours = Math.max(1, Math.min(parseInteger(req.query.hours) || 48, 168));

  if (leadId === null) {
    return res.status(400).json({ message: 'Lead inválido' });
  }

  const lead = await LeadIntake.findByPk(leadId);
  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }
  if (!(await ensureLeadFeatureAccess(req, res, lead, 'leads.manage'))) return;

  const clinicId = parseInteger(lead.clinica_id);
  const normalizedPhone = normalizePhone(lead.telefono);
  const now = new Date();
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const to = new Date(now.getTime() + hours * 60 * 60 * 1000);

  const appointmentWhere = {
    clinica_id: clinicId,
    inicio: { [Op.between]: [from, to] },
  };

  const appointments = await CitaPaciente.findAll({
    where: appointmentWhere,
    include: [
      {
        model: Paciente,
        as: 'paciente',
        attributes: ['id_paciente', 'nombre', 'apellidos', 'telefono_movil'],
        required: false,
      },
      db.Tratamiento ? { model: db.Tratamiento, as: 'tratamiento', attributes: ['id_tratamiento', 'nombre'], required: false } : null,
    ].filter(Boolean),
    order: [['inicio', 'DESC'], ['id_cita', 'DESC']],
  });

  const items = (appointments || []).map((appointment) => {
    const plain = toPlain(appointment);
    const phone = normalizePhone(plain?.paciente?.telefono_movil);
    const matchesLead = parseInteger(plain?.lead_intake_id) === leadId;
    const matchesPhone = !!normalizedPhone && !!phone && phone === normalizedPhone;
    if (!matchesLead && !matchesPhone) {
      return null;
    }
    const start = plain?.inicio ? new Date(plain.inicio) : null;
    return {
      id: parseInteger(plain?.id_cita),
      fecha: start && Number.isFinite(start.getTime()) ? start.toISOString() : plain?.inicio || null,
      hora: start && Number.isFinite(start.getTime())
        ? start.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
        : null,
      paciente_nombre: [cleanString(plain?.paciente?.nombre), cleanString(plain?.paciente?.apellidos)].filter(Boolean).join(' ').trim() || cleanString(plain?.paciente?.nombre) || 'Paciente',
      paciente_telefono: cleanString(plain?.paciente?.telefono_movil),
      tratamiento: cleanString(plain?.tratamiento?.nombre),
      phone_match: matchesPhone,
    };
  }).filter((item) => item && item.id !== null);

  return res.status(200).json({ success: true, items });
});

exports.saveCallOutcome = asyncHandler(async (req, res) => {
  const leadId = parseInteger(req.params.id);
  const outcome = cleanString(req.body?.outcome);
  const appointmentId = parseInteger(req.body?.appointment_id);
  const notes = cleanString(req.body?.notes);

  if (leadId === null) {
    return res.status(400).json({ message: 'Lead inválido' });
  }

  if (!CALL_OUTCOMES.has(outcome)) {
    return res.status(400).json({ message: 'call_outcome inválido' });
  }
  if (appointmentId !== null && outcome !== 'citado') {
    return res.status(400).json({ message: 'appointment_id solo es válido para call_outcome citado' });
  }

  const lead = await LeadIntake.findByPk(leadId);
  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }
  if (!(await ensureLeadFeatureAccess(req, res, lead, 'leads.manage'))) return;

  let linkedAppointment = null;
  if (appointmentId !== null) {
    linkedAppointment = await CitaPaciente.findByPk(appointmentId);
    if (!linkedAppointment) {
      return res.status(404).json({ message: 'Cita no encontrada' });
    }
    if (parseInteger(linkedAppointment.clinica_id) !== parseInteger(lead.clinica_id)) {
      return res.status(409).json({ message: 'La cita no pertenece a la clínica del lead' });
    }
    const linkedLeadId = parseInteger(linkedAppointment.lead_intake_id);
    if (linkedLeadId !== null && linkedLeadId !== leadId) {
      return res.status(409).json({ message: 'La cita ya está vinculada a otro lead' });
    }
    if (!LEAD_ACTIVE_APPOINTMENT_STATES.has(String(linkedAppointment.estado || '').trim().toLowerCase())) {
      return res.status(409).json({ message: 'La cita no está activa y no puede cerrar este lead' });
    }
  }

  const updatePayload = {
    call_initiated: true,
    call_outcome: outcome,
    call_outcome_at: new Date(),
    call_outcome_notes: notes || null,
    call_outcome_appointment_id: appointmentId || null,
    callback_reminder_at: null,
    callback_reminder_reason: null,
    callback_reminder_notes: null,
    callback_reminder_created_by: null,
    callback_reminder_job_id: null,
  };

  if (lead.callback_reminder_job_id) {
    try {
      await jobRequestsService.markCancelled(lead.callback_reminder_job_id, {
        errorMessage: 'Recordatorio cancelado por resolución manual de la llamada',
      });
    } catch (_err) {
      // no bloqueamos el guardado del outcome
    }
  }

  if (!lead.call_initiated_at) {
    updatePayload.call_initiated_at = new Date();
  }
  if (outcome === 'citado') {
    updatePayload.status_lead = 'citado';
  } else if (outcome === 'informacion') {
    updatePayload.status_lead = 'descartado';
    updatePayload.motivo_descarte = 'solo_pidio_informacion';
  }

  if (linkedAppointment && parseInteger(linkedAppointment.lead_intake_id) !== leadId) {
    await linkedAppointment.update({
      lead_intake_id: leadId,
      ...(lead.campana_id && !linkedAppointment.campana_id ? { campana_id: lead.campana_id } : {}),
    });
  }

  let qualifiedLeadConversion = null;
  if (outcome === 'citado' && linkedAppointment) {
    qualifiedLeadConversion = await ensureQualifiedLeadConversion({
      lead,
      occurredAt: linkedAppointment.created_at || new Date(),
      logger: console,
    });
  }

  await lead.update(updatePayload);

  let scheduleConversion = null;
  if (outcome === 'citado' && linkedAppointment) {
    scheduleConversion = await uploadScheduleForLinkedAppointment({
      lead,
      appointment: linkedAppointment,
      logger: console,
    });
  }

  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: { outcome, appointment_id: appointmentId, notes },
      attribution_steps: {
        action: 'call_outcome',
        userId: req.userData?.userId || null,
        appointment_linked: Boolean(linkedAppointment),
        qualified_lead_event_id: linkedAppointment ? `lead-${lead.id}-qualified` : null,
        schedule_event_id: linkedAppointment ? `appointment-${linkedAppointment.id_cita}` : null,
        qualified_lead_conversion: qualifiedLeadConversion
          ? { sent: qualifiedLeadConversion.sent === true, accepted: qualifiedLeadConversion.accepted === true, reason: qualifiedLeadConversion.reason || null }
          : null,
        schedule_conversion: scheduleConversion
          ? { sent: scheduleConversion.sent === true, accepted: scheduleConversion.accepted === true, reason: scheduleConversion.reason || null }
          : null,
      }
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar auditoría de call_outcome:', auditErr.message || auditErr);
  }

  try {
    await emitLeadSocketEvent(
      'lead:call_outcome',
      buildLeadCallOutcomeSocketPayload({
        lead,
        clinicId: lead.clinica_id,
        groupId: lead.grupo_clinica_id
      }),
      { clinicId: lead.clinica_id, groupId: lead.grupo_clinica_id }
    );
  } catch (emitErr) {
    console.warn('⚠️ No se pudo emitir lead:call_outcome:', emitErr.message || emitErr);
  }

  return res.status(200).json({ lead });
});

exports.deleteLead = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const lead = await LeadIntake.findByPk(id);
  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }
  if (!(await ensureLeadFeatureAccess(req, res, lead, 'leads.manage'))) return;

  // Registrar auditoría antes de eliminar
  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: { action: 'delete', lead_data: lead.toJSON() },
      attribution_steps: { action: 'delete', userId: req.userData?.userId || null }
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar auditoría de eliminación:', auditErr.message || auditErr);
  }

  await lead.destroy();

  res.status(200).json({ message: 'Lead eliminado correctamente', id: parseInt(id) });
});

// Utilidades puras para contratos de privacidad. No se exponen como ruta HTTP.
exports.__leadPrivacyContract = Object.freeze({
  buildLeadSearchConditions,
  ensureLeadScopeAccess,
  hasFullGroupMarketingAccess,
  redactLeadForPrivacy,
  resolveLeadScopeFilter,
});
