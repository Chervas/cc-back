'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../models');
const { consentClinicIds, setConsentGroupScope } = require('../lib/tablet-kiosk-scope');
const consentDocumentChoices = require('../lib/consent-document-choices');
const consentDocumentPersonalData = require('../lib/consent-document-personal-data');
const documentCompletion = require('../lib/consent-document-completion');
const documentBlocks = require('../lib/consent-document-blocks');
const documentBranding = require('../lib/consent-document-branding');
const consentClinicTime = require('../lib/consent-clinic-time');
const { renderConsentVersionHtml } = require('../lib/consent-version-html');
const { medicalQuestionnaireEnabled, clinicMedicalQuestionnaireEnabled } = require('../lib/patient-intake-configuration');
const { Op } = db.Sequelize;
const execFileAsync = promisify(execFile);
// Keep PDFs self-contained: isolated runtimes cannot fetch frontend assets.
const DOCUMENT_BRAND_LOGO = 'data:image/svg+xml;base64,' + require('fs').readFileSync(
    path.join(__dirname, '../assets/nutrition/brand/clinicaclick-logo-text.svg')
).toString('base64');

const PURPOSE_VALUES = new Set([
    'clinical',
    'data_protection',
    'clinical_image',
    'marketing_image',
    'commercial_communications',
    'financial',
    'revocation',
    'other',
]);

const STATUS_VALUES = new Set(['draft', 'active', 'archived']);
const VERSION_STATUS_VALUES = new Set(['draft', 'published', 'archived']);
const BLOCKING_VALUES = new Set(['hard', 'soft', 'optional']);
const VALIDITY_VALUES = new Set(['single_act', 'treatment_episode', 'treatment_plan', 'until_date', 'manual']);
const SIGNING_TIMING_VALUES = new Set(['first_visit', 'before_treatment', 'at_treatment', 'before_each_session', 'at_least_24h_before', 'manual']);
const DOCUMENT_CLOSED_STATUSES = new Set(['signed', 'completed', 'rejected', 'revoked', 'expired', 'cancelled', 'superseded', 'voided']);
const DOCUMENT_PENDING_STATUSES = new Set(['pending', 'sent', 'viewed']);
const CHANNEL_VALUES = new Set(['tablet', 'email', 'whatsapp', 'internal']);
const PUBLIC_TOKEN_SECRET = process.env.CONSENT_PUBLIC_TOKEN_SECRET || process.env.JWT_SECRET || 'clinicaclick-dev-consentimientos';
const KIOSK_TOKEN_SECRET = process.env.CONSENT_KIOSK_TOKEN_SECRET || PUBLIC_TOKEN_SECRET;
const KIOSK_TOKEN_TTL = process.env.CONSENT_KIOSK_TOKEN_TTL || '30d';
const DEFAULT_LINK_TTL_HOURS = Number.parseInt(process.env.CONSENT_LINK_TTL_HOURS || '168', 10);
const DEFAULT_SURGICAL_MIN_HOURS = Number.parseInt(process.env.CONSENT_SURGICAL_MIN_HOURS || '24', 10);
const DEFAULT_CHROMIUM_PATH = '/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell';

const SIGNING_TIMING_META = {
    first_visit: {
        label: 'Primera cita',
        recommendation: 'Solicita la firma en la primera cita o alta del paciente.',
        priority: 20,
    },
    before_treatment: {
        label: 'Antes del tratamiento',
        recommendation: 'Solicita la firma antes de iniciar el tratamiento.',
        priority: 60,
    },
    at_treatment: {
        label: 'Al realizar el tratamiento',
        recommendation: 'Solicita la firma el mismo día, antes de empezar el acto clínico.',
        priority: 50,
    },
    before_each_session: {
        label: 'Antes de cada sesión',
        recommendation: 'Solicita la firma antes de cada sesión del tratamiento.',
        priority: 70,
    },
    at_least_24h_before: {
        label: '24h antes',
        recommendation: 'Solicita la firma al menos 24 horas antes del tratamiento.',
        priority: 90,
    },
    manual: {
        label: 'Manual',
        recommendation: 'El equipo debe decidir cuándo pedir la firma según el caso.',
        priority: 10,
    },
};

function toIntOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toCleanString(value) {
    if (value === undefined || value === null) return null;
    const cleaned = String(value).trim();
    return cleaned || null;
}

function normalizeEnum(value, allowed, fallback) {
    const cleaned = toCleanString(value);
    return cleaned && allowed.has(cleaned) ? cleaned : fallback;
}

function parseJsonObject(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function defaultSigningTimingForPurpose(purpose) {
    if (['data_protection', 'commercial_communications', 'marketing_image'].includes(String(purpose || ''))) {
        return 'first_visit';
    }
    return 'before_treatment';
}

function normalizeSigningTiming(value, fallback = 'before_treatment') {
    const cleaned = toCleanString(value);
    return cleaned && SIGNING_TIMING_VALUES.has(cleaned) ? cleaned : fallback;
}

function getSigningPolicyFromVersion(version = {}, template = {}) {
    const schema = parseJsonObject(version?.variable_schema);
    const clinicalPolicy = parseJsonObject(schema.clinical_policy);
    const signingTiming = parseJsonObject(schema.signing_timing);
    const fallback = defaultSigningTimingForPurpose(template?.purpose);
    const mode = normalizeSigningTiming(
        (typeof schema.signing_timing === 'string' ? schema.signing_timing : null)
        || signingTiming.mode
        || clinicalPolicy.signing_timing
        || clinicalPolicy.due_policy,
        fallback
    );
    const meta = SIGNING_TIMING_META[mode] || SIGNING_TIMING_META.before_treatment;
    const configuredHours = Number.parseInt(
        String(clinicalPolicy.recommended_min_hours_before || signingTiming.recommended_min_hours_before || ''),
        10
    );
    const recommendedMinHours = Number.isFinite(configuredHours) && configuredHours > 0
        ? configuredHours
        : (mode === 'at_least_24h_before' ? DEFAULT_SURGICAL_MIN_HOURS : null);
    return {
        due_policy: mode,
        signing_timing: mode,
        signing_timing_label: meta.label,
        recommendation: meta.recommendation,
        recommended_min_hours_before: recommendedMinHours,
        priority: meta.priority,
    };
}

function getSigningPolicyFromDocument(documentLike) {
    const document = getPlain(documentLike);
    const snapshot = parseJsonObject(document.snapshot_json);
    const version = parseJsonObject(snapshot.version);
    const schema = parseJsonObject(version.variable_schema);
    const frozenPolicy = parseJsonObject(snapshot.clinical_policy);
    return getSigningPolicyFromVersion({ ...version, variable_schema: {
        ...schema,
        clinical_policy: { ...parseJsonObject(schema.clinical_policy), ...frozenPolicy },
        signing_timing: frozenPolicy.signing_timing || frozenPolicy.due_policy || schema.signing_timing,
    } }, parseJsonObject(snapshot.template));
}

function pickSigningPolicy(policies = []) {
    const validPolicies = policies.filter(Boolean);
    if (!validPolicies.length) {
        return getSigningPolicyFromVersion({}, { purpose: 'clinical' });
    }
    return validPolicies
        .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))[0];
}

function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const cleaned = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'si', 'sí'].includes(cleaned)) return true;
    if (['false', '0', 'no'].includes(cleaned)) return false;
    return fallback;
}

function normalizeStringList(value) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(
        value
            .map((item) => toCleanString(item))
            .filter(Boolean)
    ));
}

function generatePublicId(prefix) {
    return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

function generateReadablePassword() {
    const raw = crypto.randomBytes(12).toString('base64url');
    return `cc-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function slugifyKioskPart(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 36);
}

async function generateUniquePublicId(model, prefix, transaction = null) {
    for (let i = 0; i < 8; i += 1) {
        const publicId = generatePublicId(prefix);
        const existing = await model.findOne({ where: { public_id: publicId }, attributes: ['id'], raw: true, transaction });
        if (!existing) return publicId;
    }
    throw new Error(`${prefix}_public_id_generation_failed`);
}

function getPlain(value) {
    return typeof value?.toJSON === 'function' ? value.toJSON() : value;
}

function normalizeTemplatePayload(payload = {}, fallback = {}) {
    return {
        name: toCleanString(payload.name ?? payload.nombre) || fallback.name || null,
        description: toCleanString(payload.description ?? payload.descripcion) ?? fallback.description ?? null,
        purpose: normalizeEnum(payload.purpose ?? payload.tipo, PURPOSE_VALUES, fallback.purpose || 'clinical'),
        status: normalizeEnum(payload.status ?? payload.estado, STATUS_VALUES, fallback.status || 'active'),
        blocking_policy: normalizeEnum(payload.blocking_policy ?? payload.bloqueo, BLOCKING_VALUES, fallback.blocking_policy || 'hard'),
        validity_mode: normalizeEnum(payload.validity_mode ?? payload.validez, VALIDITY_VALUES, fallback.validity_mode || 'single_act'),
        is_generic: normalizeBoolean(payload.is_generic ?? payload.generico, fallback.is_generic || false),
        is_default: normalizeBoolean(payload.is_default ?? payload.predeterminado, fallback.is_default || false),
        requires_patient_signature: normalizeBoolean(payload.requires_patient_signature ?? payload.requiere_firma_paciente, fallback.requires_patient_signature ?? true),
        requires_representative_when_minor: normalizeBoolean(payload.requires_representative_when_minor ?? payload.requiere_representante_menor, fallback.requires_representative_when_minor ?? true),
        requires_professional_signature: normalizeBoolean(payload.requires_professional_signature ?? payload.requiere_firma_profesional, fallback.requires_professional_signature || false),
        catalog_key: toCleanString(payload.catalog_key) ?? fallback.catalog_key ?? null,
    };
}

function normalizeVersionPayload(payload = {}, fallback = {}) {
    const status = normalizeEnum(payload.version_status ?? payload.status_version ?? payload.estado_version,
        VERSION_STATUS_VALUES, fallback.status || 'published');
    const publishedAt = status === 'draft' ? null
        : Object.prototype.hasOwnProperty.call(payload, 'published_at') ? payload.published_at
        : fallback.published_at !== undefined ? fallback.published_at
        : status === 'published' ? new Date() : null;
    const version = documentBlocks.normalizeVersion({
        version: toIntOrNull(payload.version) || fallback.version || 1,
        locale: toCleanString(payload.locale ?? payload.idioma) || fallback.locale || 'es',
        title: toCleanString(payload.title ?? payload.titulo) || fallback.title || toCleanString(payload.name ?? payload.nombre) || 'Consentimiento',
        body_json: payload.body_json ?? payload.contenido_json ?? fallback.body_json ?? null,
        body_html: toCleanString(payload.body_html ?? payload.contenido_html) ?? fallback.body_html ?? null,
        variable_schema: payload.variable_schema ?? payload.variables ?? fallback.variable_schema ?? null,
        status,
        published_at: publishedAt,
    }, { purpose: payload.purpose || fallback.purpose || 'other' });
    if (Object.hasOwn(parseJsonObject(version.body_json), 'document_branding')) {
        documentBranding.validateDocumentBrandingConfig(parseJsonObject(version.body_json).document_branding);
    }
    return version;
}

function buildDefaultBodyHtml(title) {
    const safeTitle = toCleanString(title) || 'Consentimiento informado';
    return [
        `<h2>${safeTitle}</h2>`,
        '<p>Paciente: {{paciente.nombre_completo}}</p>',
        '<p>Clínica: {{clinica.nombre}}</p>',
        '<p>Tratamiento: {{tratamiento.nombre}}</p>',
        '<p>El paciente declara haber recibido información comprensible sobre la actuación propuesta, sus beneficios, riesgos frecuentes, riesgos relevantes, alternativas y consecuencias de no realizarla.</p>',
        '<p>El paciente ha podido plantear preguntas y entiende que puede revocar este consentimiento conforme a la normativa aplicable.</p>',
    ].join('\n');
}

const { formatDateTime, formatDateOnly } = consentClinicTime;

function buildTemplateContext({ paciente, clinica, tratamiento, cita, profesional } = {}) {
    const patientName = [paciente?.nombre, paciente?.apellidos].filter(Boolean).join(' ').trim();
    const professionalName = [profesional?.nombre, profesional?.apellidos].filter(Boolean).join(' ').trim();
    const fiscal = parseJsonObject(clinica?.datos_fiscales_clinica);
    const responsible = require('../lib/registration-privacy-configuration').controller(clinica);
    const now = new Date();
    const timeZone = consentClinicTime.resolveClinicTimezone(clinica);
    return {
        document_presentation: require('../lib/consent-document-presentation').newPresentation(),
        paciente: {
            id: paciente?.id_paciente || paciente?.id || null,
            public_id: paciente?.public_id || null,
            nombre: paciente?.nombre || '',
            apellidos: paciente?.apellidos || '',
            nombre_completo: patientName || paciente?.nombre || '',
            dni: paciente?.dni || '',
            documento: paciente?.dni || '',
            email: paciente?.email || '',
            telefono: paciente?.telefono_movil || paciente?.telefono || '',
            telefono2: paciente?.telefono_secundario || '',
            telefono_movil: paciente?.telefono_movil || paciente?.telefono || '',
            telefono_fijo: paciente?.telefono_secundario || '',
            compania: '',
            fecha_nacimiento: consentClinicTime.formatCalendarDate(paciente?.fecha_nacimiento),
            direccion: paciente?.direccion || paciente?.domicilio || '',
            codigo_postal: paciente?.codigo_postal || paciente?.cp || '',
            ciudad: paciente?.ciudad || paciente?.poblacion || paciente?.localidad || '',
            provincia: paciente?.provincia || '',
            pais: paciente?.pais || '',
        },
        clinica: {
            id: clinica?.id_clinica || clinica?.id || null,
            nombre: clinica?.nombre_clinica || clinica?.nombre || '',
            time_zone: timeZone,
            razon_social: fiscal.denominacion_social || fiscal.razon_social || fiscal.razonSocial || fiscal.nombre_fiscal || '',
            cif: fiscal.cif_nif || fiscal.cif || fiscal.nif || fiscal.documento || '',
            email: clinica?.email || '',
            telefono: clinica?.telefono_whatsapp || clinica?.telefono_movil || clinica?.telefono || '',
            direccion: clinica?.direccion || '',
            codigo_postal: clinica?.codigo_postal || '',
            ciudad: clinica?.ciudad || '',
            provincia: clinica?.provincia || '',
            pais: clinica?.pais || '',
        },
        responsable: { razon_social: responsible.legal_name, cif: responsible.tax_id, direccion: responsible.address,
            email: responsible.email, telefono: responsible.phone, dpo_nombre: responsible.dpo_name, dpo_email: responsible.dpo_email },
        tratamiento: {
            id: tratamiento?.id_tratamiento || tratamiento?.id || null,
            nombre: tratamiento?.nombre || '',
            disciplina: tratamiento?.disciplina || '',
            categoria: tratamiento?.categoria || '',
        },
        cita: {
            id: cita?.id_cita || cita?.id || null,
            inicio: cita?.inicio || null,
            fin: cita?.fin || null,
            fecha: formatDateTime(cita?.inicio, timeZone),
        },
        profesional: {
            id: profesional?.id_usuario || profesional?.id || null,
            nombre: professionalName || profesional?.nombre || '',
            email: profesional?.email_usuario || profesional?.email || '',
        },
        fecha: {
            firma: formatDateOnly(now, timeZone),
            generacion: formatDateTime(now, timeZone),
        },
    };
}

function resolvePath(context, path) {
    return String(path || '')
        .split('.')
        .reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : ''), context);
}

function renderTemplateHtml(html, context) {
    const source = toCleanString(html) || '';
    return source.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key) => {
        const value = resolvePath(context, key);
        return value === undefined || value === null ? '' : String(value);
    });
}

function hashSnapshot(payload) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(payload || {}))
        .digest('hex');
}

function hashRenderedSnapshot(snapshot, html) {
    if (documentBlocks.versionBlocks(snapshot.version, snapshot.template)) {
        snapshot.integrity = { algorithm: consentDocumentChoices.CHOICE_HASH_ALGORITHM };
        return consentDocumentChoices.choiceSnapshotHash(snapshot, html);
    }
    if (documentCompletion.policy(snapshot.version, snapshot.template)) {
        snapshot.integrity = { algorithm: consentDocumentChoices.CHOICE_HASH_ALGORITHM };
        return documentCompletion.hash(snapshot, html);
    }
    if (!consentDocumentChoices.getConsentChoiceForm({ snapshot_json: snapshot })) {
        return hashSnapshot({ ...snapshot, rendered_html: html });
    }
    // Only the newly introduced interactive form uses canonical receipts.
    // Patient/professional signatures and revocations keep this same version.
    snapshot.integrity = { algorithm: consentDocumentChoices.CHOICE_HASH_ALGORITHM };
    return consentDocumentChoices.choiceSnapshotHash(snapshot, html);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getLinkTtlHours(value = null) {
    const parsed = Number.parseInt(String(value ?? DEFAULT_LINK_TTL_HOURS), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 168;
}

function addHours(date, hours) {
    const base = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
    return new Date(base.getTime() + getLinkTtlHours(hours) * 60 * 60 * 1000);
}

function getTabletBaseUrl() {
    return toCleanString(process.env.CONSENT_TABLET_BASE_URL)
        || toCleanString(process.env.FRONTEND_PUBLIC_URL)
        || 'https://tablet.clinicaclick.com';
}

function buildPublicConsentUrl(token, baseUrl = null) {
    const resolvedBaseUrl = toCleanString(baseUrl) || getTabletBaseUrl();
    return `${resolvedBaseUrl.replace(/\/+$/, '')}/tablet/consentimientos/${encodeURIComponent(token)}`;
}

function signPackageToken(packageRow, { channel = 'tablet', ttlHours = null } = {}) {
    const plain = getPlain(packageRow);
    const expiresInHours = getLinkTtlHours(ttlHours);
    return jwt.sign({
        type: 'consent_signature_package',
        package_public_id: plain.public_id,
        package_id: plain.id,
        channel,
    }, PUBLIC_TOKEN_SECRET, { expiresIn: `${expiresInHours}h` });
}

function verifyPackageToken(tokenRaw) {
    const token = toCleanString(tokenRaw);
    if (!token) {
        const err = new Error('consent_public_token_required');
        err.statusCode = 400;
        throw err;
    }
    try {
        const payload = jwt.verify(token, PUBLIC_TOKEN_SECRET);
        if (payload?.type !== 'consent_signature_package' || !payload?.package_public_id) {
            const err = new Error('invalid_consent_public_token');
            err.statusCode = 401;
            throw err;
        }
        return payload;
    } catch (error) {
        if (error.statusCode) throw error;
        const err = new Error(error.name === 'TokenExpiredError' ? 'expired_consent_public_token' : 'invalid_consent_public_token');
        err.statusCode = 401;
        throw err;
    }
}

function extractBearerToken(value) {
    const raw = toCleanString(value);
    if (!raw) return null;
    return raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;
}

function verifyKioskToken(tokenRaw) {
    const token = extractBearerToken(tokenRaw);
    if (!token) {
        const err = new Error('tablet_kiosk_token_required');
        err.statusCode = 401;
        throw err;
    }
    try {
        const payload = jwt.verify(token, KIOSK_TOKEN_SECRET);
        if (payload?.type !== 'clinic_tablet_kiosk' || !payload?.kiosk_id || !payload?.clinic_id) {
            const err = new Error('invalid_tablet_kiosk_token');
            err.statusCode = 401;
            throw err;
        }
        return payload;
    } catch (error) {
        if (error.statusCode) throw error;
        const err = new Error(error.name === 'TokenExpiredError' ? 'expired_tablet_kiosk_token' : 'invalid_tablet_kiosk_token');
        err.statusCode = 401;
        throw err;
    }
}

function isMinorPatient(paciente, clinica) {
    return consentClinicTime.isMinor(paciente?.fecha_nacimiento,
        { timeZone: consentClinicTime.resolveClinicTimezone(clinica) });
}

function getRepresentativeSnapshot(paciente) {
    const relaciones = Array.isArray(paciente?.relaciones) ? paciente.relaciones : [];
    return relaciones.map((relacion) => ({
        id: relacion.id || relacion.id_relacion || null,
        nombre: [relacion.nombre, relacion.apellidos].filter(Boolean).join(' ').trim() || relacion.nombre_completo || relacion.nombre || null,
        parentesco: relacion.parentesco || relacion.tipo_relacion || null,
        telefono: relacion.telefono || relacion.telefono_movil || null,
        email: relacion.email || null,
    }));
}

function requiresRepresentative(document) {
    const snapshot = document?.snapshot_json && typeof document.snapshot_json === 'object' ? document.snapshot_json : {};
    return !!snapshot?.patient_flags?.is_minor && !!snapshot?.template?.requires_representative_when_minor;
}

function normalizeSignatureEvidence(payload = {}, requestMeta = {}) {
    const signerName = toCleanString(payload.signer_name ?? payload.nombre_firmante);
    const representativeName = toCleanString(payload.representative_name ?? payload.nombre_representante);
    const signatureDataUrl = toCleanString(payload.signature_data_url ?? payload.firma_data_url);
    return {
        method: toCleanString(payload.method ?? payload.metodo) || 'tablet_signature',
        signer_name: signerName || representativeName || null,
        signer_role: toCleanString(payload.signer_role ?? payload.rol_firmante) || (representativeName ? 'representative' : 'patient'),
        representative_name: representativeName || null,
        representative_document: toCleanString(payload.representative_document ?? payload.documento_representante),
        relationship: toCleanString(payload.relationship ?? payload.parentesco),
        accepted_statement: (payload.accepted_statement ?? payload.declaracion_aceptada) === true,
        signature_data_url: signatureDataUrl && signatureDataUrl.length < 250000 ? signatureDataUrl : null,
        signed_at: new Date().toISOString(),
        ip: toCleanString(requestMeta.ip),
        user_agent: toCleanString(requestMeta.userAgent),
        device_label: toCleanString(payload.device_label ?? payload.dispositivo),
    };
}

function requireSignatureEvidence(evidence, document) {
    if (documentCompletion.documentPolicy(document)) throw Object.assign(new Error('consent_document_requires_completion'), { statusCode: 409 });
    let code = null;
    if (!evidence.accepted_statement) code = 'consent_signature_statement_required';
    else if (!evidence.signer_name) code = 'consent_signature_name_required';
    else if (!evidence.signature_data_url || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(evidence.signature_data_url)
        || !Buffer.from(evidence.signature_data_url.slice(22), 'base64').subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) code = 'consent_drawn_signature_required';
    else if (!['patient', 'representative'].includes(evidence.signer_role)) code = 'consent_signature_role_invalid';
    else if (requiresRepresentative(document) && (evidence.signer_role !== 'representative' || !evidence.relationship)) code = 'representative_signature_required';
    if (code) {
        const error = new Error(code);
        error.statusCode = 400;
        throw error;
    }
}

function requireActiveConsentPackage(packageLike) {
    const item = getPlain(packageLike);
    if (item.status === 'cancelled' || item.status === 'expired' || (item.expires_at && new Date(item.expires_at).getTime() <= Date.now())) {
        const error = new Error('consent_package_unavailable');
        error.statusCode = 410;
        throw error;
    }
}

function normalizeRevocationEvidence(payload = {}, requestMeta = {}) {
    return {
        reason: toCleanString(payload.reason ?? payload.motivo) || 'revocado_por_paciente',
        revoked_by: toCleanString(payload.revoked_by ?? payload.revocado_por) || 'clinic_user',
        revoked_at: new Date().toISOString(),
        ip: toCleanString(requestMeta.ip),
        user_agent: toCleanString(requestMeta.userAgent),
    };
}

function normalizeProfessionalSignatureEvidence(payload = {}, requestMeta = {}, userId = null) {
    const actorId = toIntOrNull(userId);
    if (!actorId || actorId <= 0) {
        const err = new Error('professional_signature_actor_required');
        err.statusCode = 401;
        throw err;
    }
    const requestedId = toIntOrNull(payload.professional_id ?? payload.profesional_id);
    if (requestedId && requestedId !== actorId) {
        const err = new Error('professional_signature_actor_mismatch');
        err.statusCode = 400;
        throw err;
    }
    if ((payload.accepted_statement ?? payload.declaracion_aceptada) !== true) {
        const err = new Error('professional_signature_statement_required');
        err.statusCode = 400;
        throw err;
    }
    return {
        method: 'professional_confirmation',
        professional_id: actorId,
        professional_name: null,
        accepted_statement: true,
        signed_at: new Date().toISOString(),
        ip: toCleanString(requestMeta.ip),
        user_agent: toCleanString(requestMeta.userAgent),
    };
}

function buildPrintableHtml(documentRow) {
    const doc = getPlain(documentRow);
    const unsignedDocument = !!documentCompletion.documentPolicy(doc);
    const snapshot = doc.snapshot_json && typeof doc.snapshot_json === 'object' ? doc.snapshot_json : {};
    const evidence = snapshot.signature_evidence || null;
    const professionalEvidence = snapshot.professional_signature_evidence || null;
    const revocation = snapshot.revocation_evidence || null;
    const patient = snapshot.context?.paciente || {};
    const clinic = snapshot.context?.clinica || {};
    const timeZone = consentClinicTime.documentTimezone(doc);
    const treatment = snapshot.context?.tratamiento || {};
    const appointment = snapshot.context?.cita || {};
    const professional = snapshot.context?.profesional || {};
    const safeHtml = doc.snapshot_html || '';
    const frozenBranding = documentBranding.brandingFromSnapshot(doc);
    const roleLabel = (role) => {
        if (role === 'representative') return 'Representante legal';
        if (role === 'professional') return 'Profesional';
        return 'Paciente';
    };
    const methodLabel = (method) => {
        const value = String(method || '');
        if (value.includes('tablet')) return 'Firma en tablet';
        if (value.includes('whatsapp')) return 'Firma desde enlace WhatsApp';
        if (value.includes('email')) return 'Firma desde enlace email';
        if (value.includes('professional')) return 'Confirmación profesional';
        return 'Firma digital';
    };
    const statusLabel = (status) => ({
        pending: 'Pendiente',
        sent: 'Enviado',
        viewed: 'Visto',
        signed: 'Firmado',
        completed: 'Completado',
        revoked: 'Revocado',
        rejected: 'Rechazado',
        expired: 'Caducado',
        cancelled: 'Cancelado',
        superseded: 'Sustituido',
        voided: 'Anulado',
    }[status] || status || 'Sin estado');
    const brandLogo = `<img class="brand-logo" alt="ClinicaClick" src="${DOCUMENT_BRAND_LOGO}" />`;
    const completionEvidence = documentCompletion.isCompleted(doc) ? snapshot.completion_evidence : null;
    const completionBlock = completionEvidence ? `<section class="evidence-panel"><div class="section-heading"><div><div class="eyebrow">Recepción</div><h2>Documento completado sin firma</h2></div><span class="status-chip">Completado</span></div><dl class="detail-grid"><div><dt>Fecha</dt><dd>${escapeHtml(formatDateTime(completionEvidence.completed_at, timeZone))}</dd></div><div><dt>Acción</dt><dd>Lectura confirmada por el paciente. No constituye una firma.</dd></div></dl></section>` : '';
    const signatureBlock = evidence ? `
        <section class="evidence-panel">
            <div class="section-heading">
                <div>
                    <div class="eyebrow">Evidencia</div>
                    <h2>Firma del paciente</h2>
                </div>
                <span class="status-chip">Firmado</span>
            </div>
            <div class="signature-layout">
                <dl class="detail-grid">
                    <div><dt>Firmante</dt><dd>${escapeHtml(evidence.signer_name || patient.nombre_completo || 'Paciente')}</dd></div>
                    <div><dt>Rol</dt><dd>${escapeHtml(roleLabel(evidence.signer_role))}</dd></div>
                    <div><dt>Fecha</dt><dd>${escapeHtml(formatDateTime(evidence.signed_at || doc.signed_at, timeZone))}</dd></div>
                    <div><dt>Método</dt><dd>${escapeHtml(methodLabel(evidence.method || 'tablet_signature'))}</dd></div>
                    ${evidence.ip ? `<div><dt>IP</dt><dd>${escapeHtml(evidence.ip)}</dd></div>` : ''}
                    ${evidence.relationship ? `<div><dt>Relación</dt><dd>${escapeHtml(evidence.relationship)}</dd></div>` : ''}
                </dl>
                ${evidence.signature_data_url ? `
                    <figure class="signature-card">
                        <img class="signature" src="${evidence.signature_data_url}" alt="Firma" />
                        <figcaption>Firma manuscrita capturada</figcaption>
                    </figure>
                ` : ''}
            </div>
        </section>
    ` : '';
    const professionalSignatureBlock = professionalEvidence ? `
        <section class="evidence-panel professional">
            <div class="section-heading">
                <div>
                    <div class="eyebrow">Evidencia</div>
                    <h2>Firma del profesional</h2>
                </div>
                <span class="status-chip slate">Validado</span>
            </div>
            <dl class="detail-grid">
                <div><dt>Profesional</dt><dd>${escapeHtml(professionalEvidence.professional_name || professional.nombre || 'Profesional')}</dd></div>
                <div><dt>Fecha</dt><dd>${escapeHtml(formatDateTime(professionalEvidence.signed_at || doc.professional_signed_at, timeZone))}</dd></div>
                <div><dt>Método</dt><dd>${escapeHtml(methodLabel(professionalEvidence.method || 'professional_confirmation'))}</dd></div>
            </dl>
        </section>
    ` : '';
    const revocationBlock = revocation ? `
        <section class="evidence-panel warning">
            <div class="section-heading">
                <div>
                    <div class="eyebrow">Estado</div>
                    <h2>Revocación</h2>
                </div>
                <span class="status-chip red">Revocado</span>
            </div>
            <p>Revocado el ${escapeHtml(formatDateTime(revocation.revoked_at || doc.revoked_at, timeZone))}. Motivo: ${escapeHtml(revocation.reason || 'No indicado')}.</p>
        </section>
    ` : '';

    return `<!doctype html>
<html lang="${doc.locale || 'es'}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(doc.title || 'Consentimiento')}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { font-family: Inter, Arial, sans-serif; color: #111827; margin: 0; background: #f1f5f9; text-align: center; }
    .preview-shell { display: inline-block; padding: 32px 24px 56px; text-align: left; }
    main { width: 960px; max-width: calc(100vw - 48px); margin: 0 auto; padding: 64px; background: #fff; border-radius: 18px; box-shadow: 0 16px 40px rgba(15, 23, 42, 0.12); }
    header { border-bottom: 1px solid #e5e7eb; margin-bottom: 36px; padding-bottom: 28px; }
    .document-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 32px; margin-bottom: 32px; }
    .document-kicker { color: #64748b; font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
    .document-title { color: #111827; font-size: 34px; font-weight: 700; line-height: 1.05; letter-spacing: -0.02em; margin-top: 5px; }
    .document-id { color: #64748b; font-size: 12px; line-height: 1.45; margin-top: 8px; max-width: 520px; overflow-wrap: anywhere; }
    .status-box { min-width: 150px; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px 16px; text-align: right; }
    .status-box dt { color: #64748b; font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
    .status-box dd { color: #111827; font-size: 18px; font-weight: 800; margin-top: 3px; }
    .header-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(220px, 0.82fr); gap: 26px; align-items: start; }
    .info-card, .summary-list { border-left: 1px solid #e5e7eb; padding-left: 20px; min-height: 92px; }
    .info-title { color: #64748b; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 10px; }
    .info-copy { color: #475569; font-size: 13px; line-height: 1.55; }
    .info-copy .strong { color: #111827; font-weight: 800; }
    .summary-list { display: grid; gap: 10px; margin: 0; }
    .summary-list div { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 12px; align-items: baseline; }
    .summary-list dt { color: #64748b; font-size: 11px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; }
    .summary-list dd { color: #111827; font-size: 14px; font-weight: 800; overflow-wrap: anywhere; }
    h1 { font-size: 28px; margin: 0 0 8px; line-height: 1.18; letter-spacing: -0.01em; }
    h2 { font-size: 17px; margin: 0; }
    p, li { font-size: 14px; line-height: 1.65; }
    .content { margin-top: 0; }
    .consent-clinic-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 0 0 24px; }
    .consent-clinic-name { font-size: 13px; font-weight: 700; color: #475569; }
    .consent-clinic-logos { display: flex; align-items: center; gap: 12px; }
    .consent-clinic-logo-frame { display: inline-flex; align-items: center; justify-content: center; padding: 8px 12px; border-radius: 6px; background: #fff; }
    .consent-clinic-logo-frame.on-dark { background: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .consent-clinic-logo-frame img { display: block; width: 96px; height: 80px; object-fit: contain; }
    .consent-clinic-footer { font-size: 10px; line-height: 1.5; color: #64748b; overflow-wrap: anywhere; }
    .consent-custom-fields { margin: 24px 0; }
    .consent-custom-fields dl { display: grid; gap: 16px; }
    .consent-custom-fields dt { font-weight: 700; }
    .consent-custom-fields dd { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .content h1, .content h2 { margin: 24px 0 10px; }
    /* The printable wrapper already renders the document title. This is a
       presentation rule only: signed snapshot_html and its hash stay intact. */
    .content > .bs-privacy-digital > h2:first-child { display: none; }
    .consent-patient-identity { margin: 24px 0; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; }
    .consent-patient-identity h3 { margin: 0 0 16px; font-size: 15px; }
    .consent-patient-identity dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 24px; margin: 0; }
    .consent-patient-identity dl > div { min-width: 0; }
    .consent-patient-identity dd { margin-top: 4px; font-size: 14px; line-height: 1.4; overflow-wrap: anywhere; }
    .evidence-panel { border: 1px solid #e2e8f0; border-top: 4px solid #334155; background: #f8fafc; border-radius: 12px; padding: 22px; margin-top: 40px; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
    .evidence-panel.professional { border-top-color: #475569; }
    .evidence-panel.warning { border-color: #fecaca; border-top-color: #b91c1c; background: #fff7f7; }
    .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
    .eyebrow { color: #64748b; font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; }
    .status-chip { display: inline-flex; align-items: center; min-height: 26px; border-radius: 999px; background: #0f172a; color: #fff; padding: 4px 12px; font-size: 12px; font-weight: 700; }
    .status-chip.slate { background: #334155; }
    .status-chip.red { background: #991b1b; }
    .signature-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 24px; align-items: start; }
    .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 22px; margin: 0; }
    .detail-grid div { min-width: 0; }
    dt { color: #64748b; font-size: 11px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; }
    dd { margin: 0; }
    .detail-grid dd { color: #0f172a; font-size: 14px; font-weight: 600; margin-top: 3px; overflow-wrap: anywhere; }
    .signature-card { margin: 0; border: 1px solid #e5e7eb; background: #fff; border-radius: 10px; padding: 12px; }
    .signature { display: block; width: 100%; max-height: 112px; object-fit: contain; }
    figcaption { margin-top: 8px; color: #64748b; font-size: 11px; text-align: center; }
    footer { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-top: 34px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #64748b; font-size: 12px; }
    .footer-meta { min-width: 0; overflow-wrap: anywhere; }
    .brand-lockup { display: inline-flex; align-items: center; white-space: nowrap; }
    .brand-logo { display: block; width: 116px; height: auto; filter: brightness(0); }
    @media screen and (max-width: 780px) {
      .preview-shell { display: block; padding: 0; }
      main { width: 100%; max-width: none; min-height: 100vh; border-radius: 0; padding: 28px 20px 40px; box-shadow: none; }
      .document-heading { display: grid; gap: 18px; }
      .document-title { font-size: 28px; }
      .status-box { text-align: left; }
      .header-grid, .signature-layout { grid-template-columns: 1fr; display: grid; }
      .detail-grid { grid-template-columns: 1fr; }
      .consent-patient-identity dl { grid-template-columns: 1fr; }
      footer { align-items: flex-start; flex-direction: column; }
    }
    @media print {
      @page { size: A4; margin: 14mm; }
      body { background: #fff; text-align: left; }
      .preview-shell { display: block; padding: 0; }
      main { width: auto; max-width: none; padding: 0; border-radius: 0; box-shadow: none; }
      header, .evidence-panel { break-inside: avoid; page-break-inside: avoid; }
      header { margin-bottom: 24px; padding-bottom: 18px; }
      .document-heading { display: grid; grid-template-columns: minmax(0, 1fr) 104px; gap: 18px; align-items: start; margin-bottom: 20px; }
      .document-kicker { font-size: 9.5px; letter-spacing: 0.1em; }
      .document-title { font-size: 25px; line-height: 1; margin-top: 3px; }
      .document-id { max-width: none; font-size: 9.5px; margin-top: 6px; }
      .status-box { min-width: 0; border-radius: 7px; padding: 7px 9px; text-align: right; }
      .status-box dt { font-size: 8.5px; }
      .status-box dd { font-size: 13px; }
      .header-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px 20px; }
      .info-card { min-height: 0; padding-left: 12px; }
      .info-title, .summary-list dt { font-size: 9px; margin-bottom: 6px; }
      .info-copy, .summary-list dd { font-size: 11px; line-height: 1.35; }
      .summary-list { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; border-left: 0; padding-left: 0; min-height: 0; }
      .summary-list div { border-left: 1px solid #e5e7eb; padding-left: 12px; grid-template-columns: max-content minmax(0, 1fr); gap: 12px; }
      .summary-list dt { margin-bottom: 0; }
      h1 { font-size: 22px; line-height: 1.15; }
      h2 { font-size: 14px; }
      p, li { font-size: 11.5px; line-height: 1.5; }
      .content h1, .content h2 { margin: 18px 0 8px; }
      .evidence-panel { border: 1px solid #d8dee8; border-top-width: 1px; background: #fff; border-radius: 7px; box-shadow: none; padding: 11px 12px; margin-top: 20px; }
      .evidence-panel.warning { background: #fff; border-color: #e5b4b4; }
      .section-heading { align-items: center; margin-bottom: 10px; }
      .eyebrow { font-size: 8.5px; margin-bottom: 2px; }
      .status-chip { min-height: 18px; border: 1px solid #cbd5e1; background: #fff; color: #111827; padding: 1px 7px; font-size: 9px; }
      .status-chip.slate, .status-chip.red { background: #fff; color: #111827; }
      .signature-layout { grid-template-columns: minmax(0, 1fr) 170px; gap: 12px; align-items: center; }
      .detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
      dt { font-size: 8.5px; }
      .detail-grid dd { font-size: 10.5px; margin-top: 1px; }
      .signature-card { border-radius: 5px; padding: 6px; }
      .signature { max-height: 58px; }
      figcaption { margin-top: 4px; font-size: 8.5px; }
      footer { margin-top: 24px; padding-top: 10px; font-size: 9px; }
      .brand-logo { width: 74px; }
    }
  </style>
</head>
<body>
<div class="preview-shell">
  <main>
    <header>
      <div class="document-heading">
        <div>
          <div class="document-kicker">${unsignedDocument ? 'Documento del paciente' : 'Consentimiento informado'}</div>
          <div class="document-title">${unsignedDocument ? 'DOCUMENTO' : 'CONSENTIMIENTO'}</div>
          <div class="document-id">Documento ${escapeHtml(doc.public_id || doc.id)}</div>
        </div>
        <dl class="status-box">
          <dt>Estado</dt>
          <dd>${escapeHtml(statusLabel(doc.status))}</dd>
        </dl>
      </div>
      <div class="header-grid">
        <section class="info-card">
          <div class="info-title">Centro</div>
          <div class="info-copy">
            <div class="strong">${escapeHtml(clinic.nombre || '')}</div>
            ${clinic.direccion ? `<div>${escapeHtml(clinic.direccion)}</div>` : ''}
          </div>
        </section>
        <section class="info-card">
          <div class="info-title">Paciente</div>
          <div class="info-copy">
            <div class="strong">${escapeHtml(patient.nombre_completo || '')}</div>
            ${patient.documento ? `<div>${escapeHtml(patient.documento)}</div>` : ''}
            ${patient.email ? `<div>${escapeHtml(patient.email)}</div>` : ''}
          </div>
        </section>
        <dl class="summary-list">
          <div><dt>Tratamiento</dt><dd>${escapeHtml(treatment.nombre || 'No indicado')}</dd></div>
          <div><dt>Cita</dt><dd>${escapeHtml(appointment.fecha || 'No indicada')}</dd></div>
        </dl>
      </div>
    </header>
    ${documentBranding.renderDocumentBrandingHtml(frozenBranding, 'header')}
    <h1>${escapeHtml(doc.title || 'Consentimiento')}</h1>
    <section class="content">${safeHtml}</section>
    ${signatureBlock}
    ${completionBlock}
    ${professionalSignatureBlock}
    ${revocationBlock}
    <footer>
      ${documentBranding.renderDocumentBrandingHtml(frozenBranding, 'footer')}
      <div class="footer-meta">Documento ${escapeHtml(doc.public_id || doc.id)}. Hash: ${escapeHtml(doc.snapshot_hash || 'pendiente')}.</div>
      <div class="brand-lockup">${brandLogo}</div>
    </footer>
  </main>
</div>
</body>
</html>`;
}

async function htmlToPdfBuffer(html, filenameSeed = 'consentimiento') {
    const chromiumPath = toCleanString(process.env.CHROME_PATH)
        || toCleanString(process.env.CHROMIUM_PATH)
        || DEFAULT_CHROMIUM_PATH;
    const safeSeed = String(filenameSeed || 'consentimiento').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clinicaclick-consent-'));
    const htmlPath = path.join(workDir, `${safeSeed}.html`);
    const pdfPath = path.join(workDir, `${safeSeed}.pdf`);

    try {
        await fs.writeFile(htmlPath, html, 'utf8');
        await execFileAsync(chromiumPath, [
            '--headless',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--no-pdf-header-footer',
            `--print-to-pdf=${pdfPath}`,
            `file://${htmlPath}`,
        ], { timeout: 25000, maxBuffer: 1024 * 1024 });
        return await fs.readFile(pdfPath);
    } catch (error) {
        const err = new Error(`pdf_generation_failed:${error.message || 'unknown'}`);
        err.statusCode = 500;
        throw err;
    } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function findPacienteByIdentifier(identifier) {
    const value = toCleanString(identifier);
    if (!value || !db.Paciente) return null;
    if (/^\d+$/.test(value)) {
        return db.Paciente.findByPk(Number(value), {
            include: [
                db.PacienteRelacion ? { model: db.PacienteRelacion, as: 'relaciones', required: false } : null,
            ].filter(Boolean),
        });
    }
    const publicIds = value.startsWith('pat_') ? [value, `pac_${value.slice(4)}`] : [value];
    return db.Paciente.findOne({
        where: { public_id: { [Op.in]: publicIds } },
        include: [
            db.PacienteRelacion ? { model: db.PacienteRelacion, as: 'relaciones', required: false } : null,
        ].filter(Boolean),
    });
}

async function getLatestCatalogVersion(catalogId, locale = 'es', transaction = null) {
    return db.ConsentTemplateCatalogVersion.findOne({
        transaction,
        where: {
            catalog_id: catalogId,
            locale,
            status: { [Op.in]: ['published', 'draft'] },
        },
        order: [['version', 'DESC'], ['id', 'DESC']],
    });
}

async function getLatestClinicVersion(templateId, locale = 'es', transaction = null) {
    return db.ClinicConsentTemplateVersion.findOne({
        transaction,
        where: {
            clinic_template_id: templateId,
            locale,
            status: { [Op.in]: ['published', 'draft'] },
        },
        order: [['version', 'DESC'], ['id', 'DESC']],
    });
}

async function listAdminTemplates(filters = {}) {
    const where = {};
    const status = toCleanString(filters.status ?? filters.estado);
    if (status && status !== 'all') where.status = status;
    const purpose = toCleanString(filters.purpose ?? filters.tipo);
    if (purpose && PURPOSE_VALUES.has(purpose)) where.purpose = purpose;
    const q = toCleanString(filters.q);
    if (q) {
        where[Op.or] = [
            { name: { [Op.like]: `%${q}%` } },
            { description: { [Op.like]: `%${q}%` } },
            { catalog_key: { [Op.like]: `%${q}%` } },
        ];
    }

    return db.ConsentTemplateCatalog.findAll({
        where,
        include: [
            { model: db.ConsentTemplateCatalogVersion, as: 'versions', required: false },
            { model: db.ConsentTemplateCatalogDiscipline, as: 'disciplines', required: false },
            {
                model: db.ConsentTemplateCatalogTreatment,
                as: 'treatments',
                required: false,
                include: [
                    {
                        model: db.Tratamiento,
                        as: 'tratamiento',
                        required: false,
                        attributes: ['id_tratamiento', 'codigo', 'nombre', 'disciplina', 'especialidad', 'categoria', 'origen'],
                    },
                ],
            },
        ],
        order: [['updatedAt', 'DESC']],
    });
}

async function createAdminTemplate(payload = {}, userId = null) {
    const data = normalizeTemplatePayload(payload, { status: 'active', is_generic: true });
    if (!data.name) {
        const err = new Error('name_required');
        err.statusCode = 400;
        throw err;
    }
    const version = normalizeVersionPayload(payload, { title: data.name, body_html: buildDefaultBodyHtml(data.name) });
    documentCompletion.validateTemplate(version, data);
    const publicId = await generateUniquePublicId(db.ConsentTemplateCatalog, 'cadmin');
    const catalog = await db.ConsentTemplateCatalog.create({
        ...data,
        public_id: publicId,
        catalog_key: data.catalog_key || publicId,
        created_by: userId,
    });

    await db.ConsentTemplateCatalogVersion.create({
        catalog_id: catalog.id,
        version: version.version,
        locale: version.locale,
        title: version.title,
        body_json: version.body_json,
        body_html: version.body_html || buildDefaultBodyHtml(version.title),
        variable_schema: version.variable_schema,
        status: version.status,
        published_at: version.published_at,
        created_by: userId,
    });

    const disciplineCodes = normalizeStringList(payload.disciplina_codes ?? payload.disciplinas);
    if (disciplineCodes.length) {
        await db.ConsentTemplateCatalogDiscipline.bulkCreate(
            disciplineCodes.map((disciplina_code) => ({ catalog_id: catalog.id, disciplina_code })),
            { ignoreDuplicates: true }
        );
    }

    const treatmentIds = Array.isArray(payload.tratamiento_ids)
        ? Array.from(new Set(payload.tratamiento_ids.map(toIntOrNull).filter(Boolean)))
        : [];
    if (treatmentIds.length) {
        await db.ConsentTemplateCatalogTreatment.bulkCreate(
            treatmentIds.map((tratamiento_id) => ({ catalog_id: catalog.id, tratamiento_id })),
            { ignoreDuplicates: true }
        );
    }

    return db.ConsentTemplateCatalog.findByPk(catalog.id, {
        include: [
            { model: db.ConsentTemplateCatalogVersion, as: 'versions' },
            { model: db.ConsentTemplateCatalogDiscipline, as: 'disciplines' },
            {
                model: db.ConsentTemplateCatalogTreatment,
                as: 'treatments',
                include: [
                    {
                        model: db.Tratamiento,
                        as: 'tratamiento',
                        required: false,
                        attributes: ['id_tratamiento', 'codigo', 'nombre', 'disciplina', 'especialidad', 'categoria', 'origen'],
                    },
                ],
            },
        ],
    });
}

async function updateAdminTemplate(id, payload = {}, userId = null) {
    const catalogId = toIntOrNull(id);
    const catalog = catalogId ? await db.ConsentTemplateCatalog.findByPk(catalogId) : null;
    if (!catalog) {
        const err = new Error('admin_consent_template_not_found');
        err.statusCode = 404;
        throw err;
    }
    const data = normalizeTemplatePayload(payload, getPlain(catalog));
    if (!data.name) {
        const err = new Error('name_required');
        err.statusCode = 400;
        throw err;
    }

    const currentVersion = await getLatestCatalogVersion(catalog.id, toCleanString(payload.locale) || 'es');
    documentCompletion.validateTemplate(normalizeVersionPayload(payload, { body_json: currentVersion?.body_json || null }), data);
    await catalog.update(data);

    const shouldCreateVersion =
        Object.prototype.hasOwnProperty.call(payload, 'body_html') ||
        Object.prototype.hasOwnProperty.call(payload, 'contenido_html') ||
        Object.prototype.hasOwnProperty.call(payload, 'body_json') ||
        Object.prototype.hasOwnProperty.call(payload, 'title') ||
        Object.prototype.hasOwnProperty.call(payload, 'titulo');

    if (shouldCreateVersion) {
        const latest = await getLatestCatalogVersion(catalog.id, toCleanString(payload.locale) || 'es');
        const version = normalizeVersionPayload(payload, {
            version: (latest?.version || 0) + 1,
            title: data.name,
            body_html: latest?.body_html || buildDefaultBodyHtml(data.name),
            body_json: latest?.body_json || null,
            variable_schema: latest?.variable_schema || null,
        });
        await db.ConsentTemplateCatalogVersion.create({
            catalog_id: catalog.id,
            version: Math.max(version.version, (latest?.version || 0) + 1),
            locale: version.locale,
            title: version.title,
            body_json: version.body_json,
            body_html: version.body_html || buildDefaultBodyHtml(version.title),
            variable_schema: version.variable_schema,
            status: version.status,
            published_at: version.published_at,
            created_by: userId,
        });
    }

    if (Array.isArray(payload.disciplina_codes) || Array.isArray(payload.disciplinas)) {
        const disciplineCodes = normalizeStringList(payload.disciplina_codes ?? payload.disciplinas);
        await db.ConsentTemplateCatalogDiscipline.destroy({ where: { catalog_id: catalog.id } });
        if (disciplineCodes.length) {
            await db.ConsentTemplateCatalogDiscipline.bulkCreate(
                disciplineCodes.map((disciplina_code) => ({ catalog_id: catalog.id, disciplina_code })),
                { ignoreDuplicates: true }
            );
        }
    }

    if (Array.isArray(payload.tratamiento_ids)) {
        const treatmentIds = Array.from(new Set(payload.tratamiento_ids.map(toIntOrNull).filter(Boolean)));
        await db.ConsentTemplateCatalogTreatment.destroy({ where: { catalog_id: catalog.id } });
        if (treatmentIds.length) {
            await db.ConsentTemplateCatalogTreatment.bulkCreate(
                treatmentIds.map((tratamiento_id) => ({ catalog_id: catalog.id, tratamiento_id })),
                { ignoreDuplicates: true }
            );
        }
    }

    return db.ConsentTemplateCatalog.findByPk(catalog.id, {
        include: [
            { model: db.ConsentTemplateCatalogVersion, as: 'versions' },
            { model: db.ConsentTemplateCatalogDiscipline, as: 'disciplines' },
            {
                model: db.ConsentTemplateCatalogTreatment,
                as: 'treatments',
                include: [
                    {
                        model: db.Tratamiento,
                        as: 'tratamiento',
                        required: false,
                        attributes: ['id_tratamiento', 'codigo', 'nombre', 'disciplina', 'especialidad', 'categoria', 'origen'],
                    },
                ],
            },
        ],
    });
}

async function listClinicTemplates(filters = {}) {
    const clinicId = toIntOrNull(filters.clinic_id ?? filters.clinica_id);
    const where = {};
    if (clinicId) where.clinic_id = clinicId;
    const status = toCleanString(filters.status ?? filters.estado);
    if (status && status !== 'all') where.status = status;
    const purpose = toCleanString(filters.purpose ?? filters.tipo);
    if (purpose && PURPOSE_VALUES.has(purpose)) where.purpose = purpose;
    const q = toCleanString(filters.q);
    if (q) {
        where[Op.or] = [
            { name: { [Op.like]: `%${q}%` } },
            { description: { [Op.like]: `%${q}%` } },
            { catalog_key: { [Op.like]: `%${q}%` } },
        ];
    }
    return db.ClinicConsentTemplate.findAll({
        where,
        include: [
            { model: db.ClinicConsentTemplateVersion, as: 'versions', required: false },
            {
                model: db.ConsentTemplateCatalog,
                as: 'sourceCatalog',
                required: false,
                include: [
                    { model: db.ConsentTemplateCatalogDiscipline, as: 'disciplines', required: false },
                ],
            },
            {
                model: db.TreatmentConsentRequirement,
                as: 'treatmentRequirements',
                required: false,
                include: [
                    {
                        model: db.Tratamiento,
                        as: 'tratamiento',
                        required: false,
                        attributes: ['id_tratamiento', 'codigo', 'nombre', 'disciplina', 'especialidad', 'categoria', 'origen'],
                    },
                ],
            },
        ],
        order: [['updatedAt', 'DESC']],
    });
}

function normalizeTreatmentIds(value) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map(toIntOrNull).filter(Boolean)));
}

async function syncClinicTemplateTreatmentLinks(templateIdRaw, clinicIdRaw, treatmentIdsRaw = []) {
    const templateId = toIntOrNull(templateIdRaw);
    const clinicId = toIntOrNull(clinicIdRaw);
    if (!templateId || !clinicId) return;

    const treatmentIds = normalizeTreatmentIds(treatmentIdsRaw);
    await db.TreatmentConsentRequirement.destroy({
        where: {
            clinic_template_id: templateId,
            clinica_id: clinicId,
        },
    });

    if (!treatmentIds.length) return;

    await db.TreatmentConsentRequirement.bulkCreate(
        treatmentIds.map((tratamientoId, index) => ({
            tratamiento_id: tratamientoId,
            clinica_id: clinicId,
            clinic_template_id: templateId,
            catalog_template_id: null,
            requirement_scope: 'treatment',
            condition_key: null,
            required: true,
            blocking_policy: 'hard',
            sort_order: index,
        })),
        { ignoreDuplicates: true }
    );
}

function clinicTemplateInclude() {
    return [
        { model: db.ClinicConsentTemplateVersion, as: 'versions', required: false },
        {
            model: db.ConsentTemplateCatalog,
            as: 'sourceCatalog',
            required: false,
            include: [
                { model: db.ConsentTemplateCatalogDiscipline, as: 'disciplines', required: false },
            ],
        },
        {
            model: db.TreatmentConsentRequirement,
            as: 'treatmentRequirements',
            required: false,
            include: [
                {
                    model: db.Tratamiento,
                    as: 'tratamiento',
                    required: false,
                    attributes: ['id_tratamiento', 'codigo', 'nombre', 'disciplina', 'especialidad', 'categoria', 'origen'],
                },
            ],
        },
    ];
}

async function createClinicTemplate(payload = {}, userId = null) {
    const clinicId = toIntOrNull(payload.clinic_id ?? payload.clinica_id);
    if (!clinicId) {
        const err = new Error('clinic_id_required');
        err.statusCode = 400;
        throw err;
    }
    const data = normalizeTemplatePayload(payload, { status: 'active' });
    if (!data.name) {
        const err = new Error('name_required');
        err.statusCode = 400;
        throw err;
    }
    const sourceCatalogId = toIntOrNull(payload.source_catalog_id ?? payload.catalog_template_id);
    const sourceVersionId = toIntOrNull(payload.source_catalog_version_id);
    const version = normalizeVersionPayload(payload, { title: data.name, body_html: buildDefaultBodyHtml(data.name) });
    documentCompletion.validateTemplate(version, data);
    const publicId = await generateUniquePublicId(db.ClinicConsentTemplate, 'cclin');
    const template = await db.ClinicConsentTemplate.create({
        ...data,
        public_id: publicId,
        clinic_id: clinicId,
        source_catalog_id: sourceCatalogId,
        source_catalog_version_id: sourceVersionId,
        catalog_key: data.catalog_key || publicId,
        created_by: userId,
    });
    await db.ClinicConsentTemplateVersion.create({
        clinic_template_id: template.id,
        source_catalog_version_id: sourceVersionId,
        version: version.version,
        locale: version.locale,
        title: version.title,
        body_json: version.body_json,
        body_html: version.body_html || buildDefaultBodyHtml(version.title),
        variable_schema: version.variable_schema,
        status: version.status,
        published_at: version.published_at,
        created_by: userId,
    });
    if (Array.isArray(payload.tratamiento_ids)) {
        await syncClinicTemplateTreatmentLinks(template.id, clinicId, payload.tratamiento_ids);
    }

    const createdTemplate = await db.ClinicConsentTemplate.findByPk(template.id, {
        include: clinicTemplateInclude(),
    });

    const applyToGroup = normalizeBoolean(payload.apply_to_group ?? payload.aplicar_a_grupo ?? payload.usar_en_grupo, false);
    if (applyToGroup) {
        const clinic = await db.Clinica.findByPk(clinicId, { raw: true });
        const groupId = toIntOrNull(clinic?.grupoClinicaId ?? clinic?.grupo_clinica_id);
        if (groupId) {
            const groupClinics = await db.Clinica.findAll({
                where: { grupoClinicaId: groupId },
                attributes: ['id_clinica'],
                raw: true,
            });
            const sharedCatalogKey = getPlain(createdTemplate)?.catalog_key || getPlain(createdTemplate)?.public_id || data.catalog_key;
            for (const targetClinic of groupClinics) {
                const targetClinicId = toIntOrNull(targetClinic.id_clinica);
                if (!targetClinicId || targetClinicId === clinicId) continue;
                const existing = sharedCatalogKey
                    ? await db.ClinicConsentTemplate.findOne({
                        where: { clinic_id: targetClinicId, catalog_key: sharedCatalogKey },
                        attributes: ['id'],
                    })
                    : null;
                if (existing) continue;
                await createClinicTemplate({
                    ...payload,
                    clinic_id: targetClinicId,
                    clinica_id: targetClinicId,
                    catalog_key: sharedCatalogKey,
                    tratamiento_ids: [],
                    apply_to_group: false,
                    aplicar_a_grupo: false,
                    usar_en_grupo: false,
                }, userId);
            }
        }
    }

    return createdTemplate;
}

async function updateClinicTemplate(id, payload = {}, userId = null) {
    const templateId = toIntOrNull(id);
    const template = templateId ? await db.ClinicConsentTemplate.findByPk(templateId) : null;
    if (!template) {
        const err = new Error('clinic_consent_template_not_found');
        err.statusCode = 404;
        throw err;
    }
    const data = normalizeTemplatePayload(payload, getPlain(template));
    if (!data.name) {
        const err = new Error('name_required');
        err.statusCode = 400;
        throw err;
    }
    const currentVersion = await getLatestClinicVersion(template.id, toCleanString(payload.locale) || 'es');
    documentCompletion.validateTemplate(normalizeVersionPayload(payload, { body_json: currentVersion?.body_json || null }), data);
    await template.update(data);

    const shouldCreateVersion =
        Object.prototype.hasOwnProperty.call(payload, 'body_html') ||
        Object.prototype.hasOwnProperty.call(payload, 'contenido_html') ||
        Object.prototype.hasOwnProperty.call(payload, 'body_json') ||
        Object.prototype.hasOwnProperty.call(payload, 'title') ||
        Object.prototype.hasOwnProperty.call(payload, 'titulo');

    if (shouldCreateVersion) {
        const latest = await getLatestClinicVersion(template.id, toCleanString(payload.locale) || 'es');
        const version = normalizeVersionPayload(payload, {
            version: (latest?.version || 0) + 1,
            title: data.name,
            body_html: latest?.body_html || buildDefaultBodyHtml(data.name),
            body_json: latest?.body_json || null,
            variable_schema: latest?.variable_schema || null,
        });
        await db.ClinicConsentTemplateVersion.create({
            clinic_template_id: template.id,
            source_catalog_version_id: template.source_catalog_version_id || null,
            version: Math.max(version.version, (latest?.version || 0) + 1),
            locale: version.locale,
            title: version.title,
            body_json: version.body_json,
            body_html: version.body_html || buildDefaultBodyHtml(version.title),
            variable_schema: version.variable_schema,
            status: version.status,
            published_at: version.published_at,
            created_by: userId,
        });
    }

    if (Array.isArray(payload.tratamiento_ids)) {
        await syncClinicTemplateTreatmentLinks(template.id, template.clinic_id, payload.tratamiento_ids);
    }

    return db.ClinicConsentTemplate.findByPk(template.id, {
        include: clinicTemplateInclude(),
    });
}

async function syncClinicTemplatesFromCatalog(clinicIdRaw, userId = null) {
    const clinicId = toIntOrNull(clinicIdRaw);
    if (!clinicId) {
        const err = new Error('clinic_id_required');
        err.statusCode = 400;
        throw err;
    }
    const clinic = await db.Clinica.findByPk(clinicId, { raw: true });
    if (!clinic) {
        const err = new Error('clinic_not_found');
        err.statusCode = 404;
        throw err;
    }

    const config = clinic.configuracion && typeof clinic.configuracion === 'object' ? clinic.configuracion : {};
    const clinicDisciplines = normalizeStringList(config.disciplinas || (config.disciplina ? [config.disciplina] : []));
    const catalogWhere = { status: 'active' };
    const include = [
        { model: db.ConsentTemplateCatalogVersion, as: 'versions', required: false },
        { model: db.ConsentTemplateCatalogDiscipline, as: 'disciplines', required: false },
        { model: db.ConsentTemplateCatalogTreatment, as: 'treatments', required: false },
    ];
    const catalogItems = await db.ConsentTemplateCatalog.findAll({ where: catalogWhere, include });
    const created = [];

    for (const item of catalogItems) {
        const plain = getPlain(item);
        const itemDisciplines = Array.isArray(plain.disciplines)
            ? plain.disciplines.map((disc) => disc.disciplina_code).filter(Boolean)
            : [];
        const catalogTreatmentIds = getCatalogTreatmentIds(plain);
        const resolvedTreatmentIds = await resolveCatalogTreatmentsForClinic(catalogTreatmentIds, clinic);
        const isGeneric = !!plain.is_generic || (itemDisciplines.length === 0 && catalogTreatmentIds.length === 0);
        const matchesDiscipline = isGeneric || itemDisciplines.some((code) => clinicDisciplines.includes(code));
        const matchesTreatment = catalogTreatmentIds.length > 0 && resolvedTreatmentIds.length > 0;
        if (!matchesDiscipline && !matchesTreatment) continue;

        const existing = await db.ClinicConsentTemplate.findOne({
            where: { clinic_id: clinicId, source_catalog_id: item.id },
            attributes: ['id'],
        });
        if (existing) continue;

        const sourceVersion = await getLatestCatalogVersion(item.id, 'es');
        const copy = await createClinicTemplate({
            clinic_id: clinicId,
            source_catalog_id: item.id,
            source_catalog_version_id: sourceVersion?.id || null,
            catalog_key: plain.catalog_key,
            name: plain.name,
            description: plain.description,
            purpose: plain.purpose,
            status: 'active',
            blocking_policy: plain.blocking_policy,
            validity_mode: plain.validity_mode,
            is_default: true,
            requires_patient_signature: plain.requires_patient_signature,
            requires_representative_when_minor: plain.requires_representative_when_minor,
            requires_professional_signature: plain.requires_professional_signature,
            locale: sourceVersion?.locale || 'es',
            // Copying editable catalog text is not publication. Keep the
            // source version state/date; an absent source stays unpublished.
            version_status: sourceVersion?.status || 'draft',
            published_at: sourceVersion?.published_at ?? null,
            title: sourceVersion?.title || plain.name,
            body_json: sourceVersion?.body_json || null,
            body_html: sourceVersion?.body_html || buildDefaultBodyHtml(plain.name),
            variable_schema: sourceVersion?.variable_schema || null,
            tratamiento_ids: resolvedTreatmentIds,
        }, userId);
        created.push(copy);
    }

    return { created_count: created.length, items: created };
}

function getCatalogDisciplineCodes(catalogPlain) {
    return Array.isArray(catalogPlain?.disciplines)
        ? catalogPlain.disciplines.map((disc) => disc.disciplina_code).filter(Boolean)
        : [];
}

function getCatalogTreatmentIds(catalogPlain) {
    return Array.isArray(catalogPlain?.treatments)
        ? Array.from(new Set(catalogPlain.treatments.map((item) => toIntOrNull(item.tratamiento_id)).filter(Boolean)))
        : [];
}

async function resolveCatalogTreatmentsForClinic(catalogTreatmentIds = [], clinicPlain = {}) {
    const baseIds = Array.from(new Set((catalogTreatmentIds || []).map(toIntOrNull).filter(Boolean)));
    if (!baseIds.length) return [];

    const clinicId = toIntOrNull(clinicPlain.id_clinica);
    const groupId = toIntOrNull(clinicPlain.grupoClinicaId ?? clinicPlain.grupo_clinica_id);
    const scopedCopyWhere = [];
    if (clinicId) scopedCopyWhere.push({ origen: 'clinica', clinica_id: clinicId });
    if (groupId) scopedCopyWhere.push({ origen: 'grupo', grupo_clinica_id: groupId });

    const treatmentWhere = {
        activo: true,
        [Op.or]: [
            { id_tratamiento: { [Op.in]: baseIds } },
            ...(scopedCopyWhere.length
                ? scopedCopyWhere.map((scope) => ({
                    ...scope,
                    id_tratamiento_base: { [Op.in]: baseIds },
                }))
                : []),
        ],
    };

    const treatments = await db.Tratamiento.findAll({
        where: treatmentWhere,
        attributes: ['id_tratamiento'],
        raw: true,
    });
    return Array.from(new Set(treatments.map((item) => toIntOrNull(item.id_tratamiento)).filter(Boolean)));
}

async function hasActiveRequirementForTreatments(clinicId, treatmentIds = []) {
    const parsedClinicId = toIntOrNull(clinicId);
    const parsedTreatmentIds = Array.from(new Set((treatmentIds || []).map(toIntOrNull).filter(Boolean)));
    if (!parsedClinicId || !parsedTreatmentIds.length) return false;

    const existing = await db.TreatmentConsentRequirement.findOne({
        where: {
            clinica_id: parsedClinicId,
            tratamiento_id: { [Op.in]: parsedTreatmentIds },
        },
        include: [
            {
                model: db.ClinicConsentTemplate,
                as: 'clinicTemplate',
                required: true,
                where: { status: 'active' },
                attributes: ['id', 'status'],
            },
        ],
        attributes: ['id'],
    });
    return !!existing;
}

async function propagateAdminTemplateToClinics(catalogIdRaw, options = {}) {
    const catalogId = toIntOrNull(catalogIdRaw);
    if (!catalogId) {
        const err = new Error('admin_consent_template_id_required');
        err.statusCode = 400;
        throw err;
    }

    const catalog = await db.ConsentTemplateCatalog.findByPk(catalogId, {
        include: [
            { model: db.ConsentTemplateCatalogVersion, as: 'versions', required: false },
            { model: db.ConsentTemplateCatalogDiscipline, as: 'disciplines', required: false },
            { model: db.ConsentTemplateCatalogTreatment, as: 'treatments', required: false },
        ],
    });
    if (!catalog) {
        const err = new Error('admin_consent_template_not_found');
        err.statusCode = 404;
        throw err;
    }

    const catalogPlain = getPlain(catalog);
    const disciplineCodes = getCatalogDisciplineCodes(catalogPlain);
    const catalogTreatmentIds = getCatalogTreatmentIds(catalogPlain);
    const isGeneric = !!catalogPlain.is_generic || (!disciplineCodes.length && !catalogTreatmentIds.length);
    const sourceVersion = await getLatestCatalogVersion(catalog.id, 'es');
    const targetClinicIds = normalizeTreatmentIds(options.clinic_ids ?? options.clinica_ids ?? []);

    const clinicWhere = targetClinicIds.length
        ? { id_clinica: { [Op.in]: targetClinicIds } }
        : { [Op.or]: [{ estado_clinica: true }, { estado_clinica: null }] };
    const clinics = await db.Clinica.findAll({ where: clinicWhere, raw: true });

    const created = [];
    const skipped = [];
    let draftCount = 0;

    for (const clinic of clinics) {
        const clinicId = toIntOrNull(clinic.id_clinica);
        if (!clinicId) continue;

        const config = clinic.configuracion && typeof clinic.configuracion === 'object' ? clinic.configuracion : {};
        const clinicDisciplines = normalizeStringList(config.disciplinas || (config.disciplina ? [config.disciplina] : []));
        const resolvedTreatmentIds = await resolveCatalogTreatmentsForClinic(catalogTreatmentIds, clinic);
        const matchesDiscipline = isGeneric || disciplineCodes.some((code) => clinicDisciplines.includes(code));
        const matchesTreatment = catalogTreatmentIds.length > 0 && resolvedTreatmentIds.length > 0;
        if (!matchesDiscipline && !matchesTreatment) {
            skipped.push({ clinic_id: clinicId, reason: 'scope_mismatch' });
            continue;
        }

        const existingSource = await db.ClinicConsentTemplate.findOne({
            where: { clinic_id: clinicId, source_catalog_id: catalog.id },
            attributes: ['id'],
        });
        if (existingSource) {
            skipped.push({ clinic_id: clinicId, reason: 'already_exists' });
            continue;
        }

        const hasTreatmentConflict = await hasActiveRequirementForTreatments(clinicId, resolvedTreatmentIds);
        const copyStatus = hasTreatmentConflict ? 'draft' : 'active';
        if (copyStatus === 'draft') draftCount += 1;

        const copy = await createClinicTemplate({
            clinic_id: clinicId,
            source_catalog_id: catalog.id,
            source_catalog_version_id: sourceVersion?.id || null,
            catalog_key: catalogPlain.catalog_key,
            name: catalogPlain.name,
            description: catalogPlain.description,
            purpose: catalogPlain.purpose,
            status: copyStatus,
            blocking_policy: catalogPlain.blocking_policy,
            validity_mode: catalogPlain.validity_mode,
            is_default: copyStatus === 'active',
            requires_patient_signature: catalogPlain.requires_patient_signature,
            requires_representative_when_minor: catalogPlain.requires_representative_when_minor,
            requires_professional_signature: catalogPlain.requires_professional_signature,
            locale: sourceVersion?.locale || 'es',
            version_status: sourceVersion?.status || 'draft',
            published_at: sourceVersion?.published_at ?? null,
            title: sourceVersion?.title || catalogPlain.name,
            body_json: sourceVersion?.body_json || null,
            body_html: sourceVersion?.body_html || buildDefaultBodyHtml(catalogPlain.name),
            variable_schema: sourceVersion?.variable_schema || null,
            tratamiento_ids: resolvedTreatmentIds,
        }, options.userId || null);
        created.push(copy);
    }

    return {
        success: true,
        catalog_id: catalog.id,
        clinics_total: clinics.length,
        created_count: created.length,
        draft_count: draftCount,
        skipped_count: skipped.length,
        skipped,
        items: created,
    };
}

async function getTreatmentRequirements({ tratamientoId, tratamientoIds = null, clinicaId = null, transaction = null }) {
    const parsedTreatmentId = toIntOrNull(tratamientoId);
    const ids = Array.isArray(tratamientoIds) ? [...new Set(tratamientoIds.map(toIntOrNull).filter(Boolean))] : [];
    if (!parsedTreatmentId && !ids.length) return [];
    const where = { tratamiento_id: ids.length ? { [Op.in]: ids } : parsedTreatmentId };
    const parsedClinicId = toIntOrNull(clinicaId);
    if (parsedClinicId) {
        where[Op.or] = [{ clinica_id: parsedClinicId }, { clinica_id: null }];
    }
    return db.TreatmentConsentRequirement.findAll({
        where,
        transaction,
        include: [
            { model: db.ClinicConsentTemplate, as: 'clinicTemplate', required: false, include: [{ model: db.ClinicConsentTemplateVersion, as: 'versions', required: false }] },
            { model: db.ConsentTemplateCatalog, as: 'catalogTemplate', required: false, include: [{ model: db.ConsentTemplateCatalogVersion, as: 'versions', required: false }] },
        ],
        order: [['sort_order', 'ASC'], ['id', 'ASC']],
    });
}

async function saveTreatmentRequirements(tratamientoIdRaw, payload = {}, transaction = null) {
    const tratamientoId = toIntOrNull(tratamientoIdRaw);
    if (!tratamientoId) {
        const err = new Error('tratamiento_id_required');
        err.statusCode = 400;
        throw err;
    }
    const clinicId = toIntOrNull(payload.clinic_id ?? payload.clinica_id);
    const requirements = Array.isArray(payload.requirements) ? payload.requirements : [];
    const normalized = requirements
        .map((item, index) => ({
            tratamiento_id: tratamientoId,
            clinica_id: clinicId || null,
            clinic_template_id: toIntOrNull(item.clinic_template_id ?? item.plantilla_clinica_id),
            catalog_template_id: toIntOrNull(item.catalog_template_id ?? item.plantilla_admin_id),
            requirement_scope: normalizeEnum(item.requirement_scope ?? item.alcance, new Set(['area', 'treatment', 'conditional']), 'treatment'),
            condition_key: toCleanString(item.condition_key ?? item.condicion),
            required: normalizeBoolean(item.required ?? item.obligatorio, true),
            blocking_policy: normalizeEnum(item.blocking_policy ?? item.bloqueo, BLOCKING_VALUES, 'hard'),
            sort_order: toIntOrNull(item.sort_order ?? item.orden) || index,
        }))
        .filter((item) => item.clinic_template_id || item.catalog_template_id);

    const execute = async tx => {
        // The clinical start/completion reader takes a SHARE lock on this same
        // anchor before reading requirements. It must never observe the gap
        // between replacement's DELETE and INSERT, including the empty set.
        const treatment = await db.Tratamiento.findByPk(tratamientoId, {
            attributes: ['id_tratamiento'], transaction: tx, lock: tx.LOCK.UPDATE,
        });
        if (!treatment) throw Object.assign(new Error('treatment_not_found'), { statusCode: 404 });
        await db.TreatmentConsentRequirement.destroy({
            where: { tratamiento_id: tratamientoId, clinica_id: clinicId || null },
            transaction: tx,
        });
        if (normalized.length) await db.TreatmentConsentRequirement.bulkCreate(normalized, { transaction: tx });
        return getTreatmentRequirements({ tratamientoId, clinicaId: clinicId, transaction: tx });
    };
    return transaction ? execute(transaction)
        : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute);
}

async function findAppointment(citaIdRaw, transaction = null) {
    const citaId = toIntOrNull(citaIdRaw);
    if (!citaId) return null;
    return db.CitaPaciente.findByPk(citaId, {
        transaction,
        include: [
            {
                model: db.Paciente,
                as: 'paciente',
                required: false,
                include: [
                    db.PacienteRelacion ? { model: db.PacienteRelacion, as: 'relaciones', required: false } : null,
                ].filter(Boolean),
            },
            { model: db.Clinica, as: 'clinica', required: false },
            { model: db.Tratamiento, as: 'tratamiento', required: false },
            db.Usuario ? { model: db.Usuario, as: 'doctor', required: false } : null,
        ].filter(Boolean),
    });
}

function pickLatestVersion(versions = []) {
    if (!Array.isArray(versions) || !versions.length) return null;
    return [...versions].sort((a, b) => {
        const av = Number(a.version || 0);
        const bv = Number(b.version || 0);
        if (av !== bv) return bv - av;
        return Number(b.id || 0) - Number(a.id || 0);
    })[0];
}

function requirementTemplateIdentity(requirement) {
    const plain = getPlain(requirement);
    if (plain.clinicTemplate) return { source: 'clinic', template: plain.clinicTemplate };
    if (plain.catalogTemplate) return { source: 'catalog', template: plain.catalogTemplate };
    return null;
}

async function getOperationalConsentVersion(resolved, transaction) {
    // Publication/locale selection belongs to NEW patient-document issuance,
    // not to editing, numbering, previewing or historically frozen evidence.
    // "published" is the existing operational state; this does not infer a
    // separate medical approval workflow or change an already-issued snapshot.
    const clinicSource = resolved.source === 'clinic';
    const model = clinicSource ? db.ClinicConsentTemplateVersion : db.ConsentTemplateCatalogVersion;
    // Hold the selected revision until this issuance commits/rolls back. This
    // protects its row from concurrent mutation/deletion, not the template or
    // the publication of a different revision (no new approval workflow).
    return model.findOne({ transaction,
        ...(transaction ? { lock: transaction.LOCK.SHARE } : {}),
        where: { [clinicSource ? 'clinic_template_id' : 'catalog_id']: resolved.template.id,
            status: 'published', locale: 'es' },
        order: [['version', 'DESC'], ['id', 'DESC']],
    });
}

async function resolveRequirementTemplate(requirement, transaction = null) {
    const resolved = requirementTemplateIdentity(requirement);
    if (!resolved) return null;
    // A summary may propose a version not yet emitted, but must not present
    // editable draft/archived/foreign text as the document awaiting signature.
    const versions = Array.isArray(resolved.template.versions) ? resolved.template.versions : [];
    const version = pickLatestVersion(versions.filter(row => {
        const value = getPlain(row); return value.status === 'published' && value.locale === 'es';
    })) || await getOperationalConsentVersion(resolved, transaction);
    return { ...resolved, version: getPlain(version) };
}

function isReusableSignedConsentTemplate(template = {}) {
    const purpose = String(template.purpose || '').trim();
    const validityMode = String(template.validity_mode || '').trim();
    return purpose === 'data_protection' || validityMode === 'manual';
}

function buildTemplateDocumentWhere(resolved = {}) {
    if (resolved.source === 'clinic') {
        return { clinic_template_id: resolved.template?.id || null };
    }
    return { catalog_template_id: resolved.template?.id || null };
}

async function findSignedReusableConsent({ pacienteId, clinicaId, resolved, transaction = null }) {
    if (!pacienteId || !clinicaId || !resolved?.template || !isReusableSignedConsentTemplate(resolved.template)) {
        return null;
    }
    return db.PatientConsentDocument.findOne({
        transaction,
        where: {
            paciente_id: pacienteId,
            clinica_id: clinicaId,
            status: 'signed',
            purpose: resolved.template.purpose || 'data_protection',
            ...buildTemplateDocumentWhere(resolved),
        },
        order: [['signed_at', 'DESC'], ['id', 'DESC']],
    });
}

function pendingReusableConsentWhere({ pacienteId, clinicaId, resolved, exceptId = null }) {
    if (!pacienteId || !clinicaId || !resolved?.template || !isReusableSignedConsentTemplate(resolved.template)) {
        return null;
    }
    const where = {
        paciente_id: pacienteId,
        clinica_id: clinicaId,
        status: { [Op.in]: Array.from(DOCUMENT_PENDING_STATUSES) },
        purpose: resolved.template.purpose || 'data_protection',
        ...buildTemplateDocumentWhere(resolved),
    };
    if (exceptId) {
        where.id = { [Op.ne]: exceptId };
    }
    return where;
}

async function pendingReusableConsentCandidates(options, transaction) {
    const where = pendingReusableConsentWhere(options);
    return where ? db.PatientConsentDocument.findAll({ where, attributes: ['id', 'package_id'], raw: true, transaction }) : [];
}

async function lockConsentPackages(packageIds, transaction) {
    const ids = [...new Set(packageIds.map(toIntOrNull).filter(Boolean))].sort((a, b) => a - b);
    // Child UPDATE/INSERT takes FK locks on its parent. Lock every known parent
    // in one stable order BEFORE writing any child, not while refreshing counts.
    for (const id of ids) await db.ConsentSignaturePackage.findByPk(id, {
        attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE,
    });
}

async function supersedePendingReusableConsents({ pacienteId, clinicaId, resolved, exceptId = null, candidates = [], transaction }) {
    const where = pendingReusableConsentWhere({ pacienteId, clinicaId, resolved, exceptId });
    if (!where || !candidates.length) return;
    // Never widen to documents born in a new, unlocked package; never overwrite
    // a candidate that signed/revoked while we were acquiring its package lock.
    where.id = { [Op.in]: candidates.map(row => row.id) };
    await db.PatientConsentDocument.update(
        { status: 'superseded', delivery_status: 'superseded' },
        { where, transaction }
    );
    for (const packageId of [...new Set(candidates.map(row => toIntOrNull(row.package_id)).filter(Boolean))].sort((a, b) => a - b)) {
        await refreshPackageCounts(packageId, transaction);
    }
}

function isReusableSignedConsentDocument(documentLike) {
    const doc = getPlain(documentLike);
    const snapshot = doc?.snapshot_json && typeof doc.snapshot_json === 'object' ? doc.snapshot_json : {};
    return isReusableSignedConsentTemplate({
        purpose: doc?.purpose || snapshot?.template?.purpose,
        validity_mode: snapshot?.template?.validity_mode,
    });
}

function reusableDocumentOptions(documentLike) {
    const doc = getPlain(documentLike);
    if (!doc?.id || !doc?.paciente_id || !doc?.clinica_id || !isReusableSignedConsentDocument(doc)) {
        return null;
    }
    const templateId = doc.clinic_template_id || doc.catalog_template_id;
    if (!templateId) return null;
    return { pacienteId: doc.paciente_id, clinicaId: doc.clinica_id, exceptId: doc.id,
        resolved: { source: doc.clinic_template_id ? 'clinic' : 'catalog', template: {
            id: templateId, purpose: doc.purpose || 'data_protection',
            validity_mode: doc.snapshot_json?.template?.validity_mode,
        } } };
}

async function resolveRequirementsForAppointment(citaLike, transaction = null) {
    const plain = getPlain(citaLike);
    const tratamientoId = toIntOrNull(plain?.tratamiento_id || plain?.tratamiento?.id_tratamiento);
    const clinicId = toIntOrNull(plain?.clinica_id || plain?.clinica?.id_clinica);
    if (!tratamientoId || !clinicId) return [];
    let tratamientoIds = [tratamientoId];
    // Look up the canonical purchased unit, never take treatment IDs from HTTP
    // metadata. Ordinary appointments retain their existing single-treatment path.
    if (require('../lib/program-appointment-context').hasProgramAppointmentReference(plain)) {
        const frozen = await require('../lib/program-appointment-context').programAppointmentContext(db, plain, transaction);
        tratamientoIds = frozen.treatment_ids;
    }
    const directRequirements = await getTreatmentRequirements({ tratamientoIds, clinicaId: clinicId, transaction });
    return directRequirements.filter((requirement) => {
        const plainRequirement = getPlain(requirement);
        const clinicTemplate = plainRequirement.clinicTemplate;
        const catalogTemplate = plainRequirement.catalogTemplate;
        const status = clinicTemplate?.status || catalogTemplate?.status || 'active';
        return status === 'active';
    });
}

async function listPatientDocuments(identifier, filters = {}) {
    const paciente = await findPacienteByIdentifier(identifier);
    if (!paciente) {
        const err = new Error('patient_not_found');
        err.statusCode = 404;
        throw err;
    }
    const where = { paciente_id: paciente.id_paciente };
    const clinicId = toIntOrNull(filters.clinic_id ?? filters.clinica_id);
    if (clinicId) where.clinica_id = clinicId;
    const status = toCleanString(filters.status ?? filters.estado);
    if (status && status !== 'all') {
        where.status = status;
    } else {
        where.status = { [Op.notIn]: ['cancelled', 'voided', 'superseded'] };
    }
    const documents = await db.PatientConsentDocument.findAll({
        where,
        include: [
            { model: db.ConsentSignaturePackage, as: 'package', required: false },
            { model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica', 'configuracion'] },
            { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre', 'disciplina'] },
        ],
        order: [['createdAt', 'DESC']],
    });
    const legacyItems = db.PacienteConsentimiento
        ? await db.PacienteConsentimiento.findAll({
            where: { paciente_id: paciente.id_paciente },
            order: [['createdAt', 'DESC']],
        })
        : [];
    return {
        paciente: getPlain(paciente),
        items: documents.map(doc => ({ ...withConsentClinicTime(doc), ...documentCompletion.publicFields(doc) })),
        legacy_items: legacyItems,
        summary: summarizeDocuments(documents),
    };
}

async function listPatientExternalAttestations(identifier, filters = {}) {
    const paciente = await findPacienteByIdentifier(identifier);
    if (!paciente) {
        const err = new Error('patient_not_found');
        err.statusCode = 404;
        throw err;
    }
    if (!db.PatientConsentExternalAttestation) return [];

    const where = { paciente_id: paciente.id_paciente };
    const clinicId = toIntOrNull(filters.clinic_id ?? filters.clinica_id);
    if (clinicId) where.clinica_id = clinicId;
    const status = toCleanString(filters.status ?? filters.estado);
    if (status && status !== 'all') where.status = status;

    const rows = await db.PatientConsentExternalAttestation.findAll({
        where,
        include: [
            { model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica', 'configuracion'] },
            { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre', 'disciplina'] },
            db.Usuario ? { model: db.Usuario, as: 'attestedByUser', required: false, attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario'] } : null,
            db.Usuario ? { model: db.Usuario, as: 'revokedByUser', required: false, attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario'] } : null,
        ].filter(Boolean),
        order: [['attested_at', 'DESC'], ['id', 'DESC']],
    });
    return rows.map(withConsentClinicTime);
}

async function createPatientExternalAttestation(identifier, payload = {}, actorId = null) {
    // Registration-paper evidence is created only by the appointment-scoped,
    // audited staff action. A generic external-note API cannot manufacture it.
    if (String(payload.source ?? payload.origen ?? '').trim().startsWith('registration_privacy_paper/')) {
        throw Object.assign(new Error('Registra la protección de datos en papel desde la cita.'), {
            code: 'privacy_paper_requires_appointment', statusCode: 400,
        });
    }
    const paciente = await findPacienteByIdentifier(identifier);
    if (!paciente) {
        const err = new Error('patient_not_found');
        err.statusCode = 404;
        throw err;
    }
    if (!db.PatientConsentExternalAttestation) {
        const err = new Error('external_consent_attestation_unavailable');
        err.statusCode = 500;
        throw err;
    }

    const clinicId = toIntOrNull(payload.clinic_id ?? payload.clinica_id) || toIntOrNull(paciente.clinica_id);
    if (!clinicId) {
        const err = new Error('clinic_id_required');
        err.statusCode = 400;
        throw err;
    }

    const purpose = normalizeEnum(payload.purpose ?? payload.tipo, PURPOSE_VALUES, 'clinical');
    const title = toCleanString(payload.title ?? payload.nombre)
        || (purpose === 'data_protection'
            ? 'Consentimiento externo de protección de datos'
            : 'Consentimiento escrito externo');
    return db.PatientConsentExternalAttestation.create({
        public_id: await generateUniquePublicId(db.PatientConsentExternalAttestation, 'cext'),
        paciente_id: paciente.id_paciente,
        clinica_id: clinicId,
        tratamiento_id: toIntOrNull(payload.tratamiento_id),
        purpose,
        title,
        note: toCleanString(payload.note ?? payload.descripcion),
        source: toCleanString(payload.source ?? payload.origen) || 'external_written',
        status: 'active',
        attested_by: toIntOrNull(actorId),
        attested_at: new Date(),
    });
}

async function revokePatientExternalAttestation(identifier, payload = {}, actorId = null) {
    if (!db.PatientConsentExternalAttestation) {
        const err = new Error('external_consent_attestation_unavailable');
        err.statusCode = 500;
        throw err;
    }

    const value = toCleanString(identifier);
    const where = /^\d+$/.test(value || '') ? { id: Number(value) } : { public_id: value };
    const attestation = await db.PatientConsentExternalAttestation.findOne({ where });
    if (!attestation) {
        const err = new Error('external_consent_attestation_not_found');
        err.statusCode = 404;
        throw err;
    }

    if (attestation.status === 'revoked') return attestation;
    const reason = toCleanString(payload.reason ?? payload.motivo);
    await attestation.update({
        status: 'revoked',
        revoked_by: toIntOrNull(actorId),
        revoked_at: new Date(),
        note: reason
            ? `${attestation.note || ''}\n\nRetirada: ${reason}`.trim()
            : attestation.note,
    });
    return attestation;
}

function serializeAppointmentLite(citaLike) {
    const cita = getPlain(citaLike);
    if (!cita?.id_cita) return null;
    return {
        id_cita: cita.id_cita,
        inicio: cita.inicio || null,
        fin: cita.fin || null,
        estado: cita.estado || null,
        titulo: cita.titulo || cita.motivo || null,
    };
}

function isRequirementActive(requirementLike) {
    const requirement = getPlain(requirementLike);
    const clinicTemplate = requirement?.clinicTemplate;
    const catalogTemplate = requirement?.catalogTemplate;
    const status = clinicTemplate?.status || catalogTemplate?.status || 'active';
    return status === 'active';
}

async function listPatientTreatmentsWithoutConsentRequirements(identifier, filters = {}) {
    const paciente = await findPacienteByIdentifier(identifier);
    if (!paciente) {
        const err = new Error('patient_not_found');
        err.statusCode = 404;
        throw err;
    }

    const where = {
        paciente_id: paciente.id_paciente,
        tratamiento_id: { [Op.ne]: null },
        estado: { [Op.notIn]: ['cancelada', 'reprogramada'] },
    };
    const clinicId = toIntOrNull(filters.clinic_id ?? filters.clinica_id);
    if (clinicId) where.clinica_id = clinicId;

    const citas = await db.CitaPaciente.findAll({
        where,
        attributes: ['id_cita', 'clinica_id', 'paciente_id', 'tratamiento_id', 'estado', 'inicio', 'fin', 'titulo', 'motivo'],
        include: [
            { model: db.Tratamiento, as: 'tratamiento', required: true, attributes: ['id_tratamiento', 'nombre', 'disciplina', 'especialidad', 'categoria', 'origen'] },
            { model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica'] },
        ],
        order: [['inicio', 'DESC']],
        limit: 1000,
    });

    const now = Date.now();
    const grouped = new Map();
    for (const citaRow of citas) {
        const cita = getPlain(citaRow);
        const tratamientoId = toIntOrNull(cita.tratamiento_id || cita.tratamiento?.id_tratamiento);
        const clinicaId = toIntOrNull(cita.clinica_id || cita.clinica?.id_clinica);
        if (!tratamientoId || !clinicaId) continue;
        const key = `${clinicaId}:${tratamientoId}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                clinica_id: clinicaId,
                tratamiento_id: tratamientoId,
                clinica: cita.clinica ? {
                    id_clinica: cita.clinica.id_clinica,
                    nombre_clinica: cita.clinica.nombre_clinica,
                } : null,
                tratamiento: cita.tratamiento ? {
                    id_tratamiento: cita.tratamiento.id_tratamiento,
                    nombre: cita.tratamiento.nombre,
                    disciplina: cita.tratamiento.disciplina,
                    especialidad: cita.tratamiento.especialidad,
                    categoria: cita.tratamiento.categoria,
                    origen: cita.tratamiento.origen,
                } : null,
                appointments_count: 0,
                next_appointment: null,
                last_appointment: null,
            });
        }
        const item = grouped.get(key);
        item.appointments_count += 1;
        const inicioMs = cita.inicio ? new Date(cita.inicio).getTime() : NaN;
        if (!Number.isFinite(inicioMs)) continue;
        const current = serializeAppointmentLite(cita);
        if (inicioMs >= now) {
            const previousNextMs = item.next_appointment?.inicio ? new Date(item.next_appointment.inicio).getTime() : Infinity;
            if (inicioMs < previousNextMs) item.next_appointment = current;
        } else {
            const previousLastMs = item.last_appointment?.inicio ? new Date(item.last_appointment.inicio).getTime() : -Infinity;
            if (inicioMs > previousLastMs) item.last_appointment = current;
        }
    }

    const result = [];
    for (const item of grouped.values()) {
        const requirements = await getTreatmentRequirements({
            tratamientoId: item.tratamiento_id,
            clinicaId: item.clinica_id,
        });
        if (requirements.some(isRequirementActive)) continue;
        const recommended = item.next_appointment || item.last_appointment || null;
        result.push({
            ...item,
            recommended_appointment_id: recommended?.id_cita || null,
        });
    }

    return result.sort((a, b) => {
        const aNext = a.next_appointment?.inicio ? new Date(a.next_appointment.inicio).getTime() : Infinity;
        const bNext = b.next_appointment?.inicio ? new Date(b.next_appointment.inicio).getTime() : Infinity;
        if (aNext !== bNext) return aNext - bNext;
        return String(a.tratamiento?.nombre || '').localeCompare(String(b.tratamiento?.nombre || ''), 'es');
    });
}

function summarizeDocuments(documents = [], missingRequired = 0, missingOptional = 0, missingBlocking = missingRequired) {
    const items = documents.map(getPlain);
    const now = new Date();
    const signed = item => require('./appointmentConsentEligibility.service').isCurrentSignedDocument(item, {}, now);
    const satisfied = item => signed(item) || documentCompletion.isCompleted(item, now);
    const requiredItems = items.filter((item) => item.required);
    const optionalItems = items.filter((item) => !item.required);
    const signedRequired = requiredItems.filter(signed).length;
    const completedRequired = requiredItems.filter(item => documentCompletion.isCompleted(item, now)).length;
    const pendingRequired = requiredItems.filter((item) => !satisfied(item)).length + missingRequired;
    const pendingOptional = optionalItems.filter((item) => DOCUMENT_PENDING_STATUSES.has(item.status)).length + missingOptional;
    const blockingPending = requiredItems.filter((item) => item.purpose === 'clinical' && item.blocking_policy === 'hard' && !signed(item)).length + missingBlocking;
    return {
        status: pendingRequired > 0 ? 'pending' : 'ok',
        required_total: requiredItems.length + missingRequired,
        signed_required: signedRequired,
        completed_required: completedRequired,
        pending_required: pendingRequired,
        pending_optional: pendingOptional,
        blocking_pending: blockingPending,
        total: items.length + missingRequired + missingOptional,
        has_pending: pendingRequired > 0 || pendingOptional > 0,
        has_blocking_pending: blockingPending > 0,
    };
}

async function getConsentSummaryForAppointment(citaLike) {
    const cita = getPlain(citaLike);
    if (!cita?.id_cita || !cita?.paciente_id || !cita?.clinica_id || !cita?.tratamiento_id) {
        return {
            status: 'none',
            required_total: 0,
            signed_required: 0,
            pending_required: 0,
            pending_optional: 0,
            blocking_pending: 0,
            total: 0,
            has_pending: false,
            has_blocking_pending: false,
            package_id: null,
            package_public_id: null,
        };
    }
    const requirements = await resolveRequirementsForAppointment(citaLike);
    if (!requirements.length) {
        return {
            status: 'none',
            required_total: 0,
            signed_required: 0,
            pending_required: 0,
            pending_optional: 0,
            blocking_pending: 0,
            total: 0,
            has_pending: false,
            has_blocking_pending: false,
            package_id: null,
            package_public_id: null,
        };
    }
    const documents = await db.PatientConsentDocument.findAll({
        where: {
            paciente_id: cita.paciente_id,
            clinica_id: cita.clinica_id,
            cita_id: cita.id_cita,
            tratamiento_id: { [Op.in]: [...new Set(requirements.map(row => Number(getPlain(row).tratamiento_id)).filter(Boolean))] },
            status: { [Op.notIn]: ['cancelled', 'voided', 'superseded'] },
        },
        include: [{ model: db.ConsentSignaturePackage, as: 'package', required: false }],
    });

    // Choose the same effective attempt used by the counts before deriving
    // display metadata. A newer catalog version must not rename/re-time the
    // frozen document the patient or professional is actually being shown.
    const latest = new Map();
    const now = new Date();
    const signed = item => require('./appointmentConsentEligibility.service').isCurrentSignedDocument(item, {}, now);
    for (const row of documents) {
        const item = getPlain(row);
        const key = `${item.tratamiento_id}:` + (item.clinic_template_id ? `clinic:${item.clinic_template_id}` : `catalog:${item.catalog_template_id}`);
        const previous = latest.get(key);
        if (!previous || (signed(item) && !signed(previous)) || (signed(item) === signed(previous) && item.id > previous.id)) latest.set(key, item);
    }

    const existingKeys = new Set(documents.map((doc) => {
        const plain = getPlain(doc);
        return `${plain.tratamiento_id}:` + (plain.clinic_template_id ? `clinic:${plain.clinic_template_id}` : `catalog:${plain.catalog_template_id}`);
    }));
    let missingRequired = 0;
    let missingOptional = 0;
    let missingBlocking = 0;
    const signingPolicies = [];
    const requirementTitles = new Map();
    for (const requirement of requirements) {
        const plain = getPlain(requirement);
        const key = `${plain.tratamiento_id}:` + (plain.clinic_template_id ? `clinic:${plain.clinic_template_id}` : `catalog:${plain.catalog_template_id}`);
        const emitted = latest.get(key);
        const resolved = emitted ? requirementTemplateIdentity(requirement) : await resolveRequirementTemplate(requirement);
        if (emitted) {
            const frozen = parseJsonObject(emitted.snapshot_json);
            requirementTitles.set(key, { title: frozen.version?.title || emitted.title || frozen.template?.name || 'Consentimiento', required: !!plain.required });
            signingPolicies.push(getSigningPolicyFromDocument(emitted));
        } else {
            if (resolved?.template) requirementTitles.set(key, { title: resolved.version?.title || resolved.template.name, required: !!plain.required });
            if (resolved?.template && resolved?.version) signingPolicies.push(getSigningPolicyFromVersion(resolved.version, resolved.template));
        }
        if (existingKeys.has(key)) continue;
        if (plain.required) {
            missingRequired += 1;
            if (plain.blocking_policy === 'hard' && resolved?.template?.purpose === 'clinical') missingBlocking += 1;
        }
        else missingOptional += 1;
    }
    const summary = summarizeDocuments([...latest.values()], missingRequired, missingOptional, missingBlocking);
    const packageRow = documents.map((doc) => getPlain(doc).package).find(Boolean) || null;
    const signingPolicy = pickSigningPolicy(signingPolicies);
    return {
        ...summary,
        pending_document_titles: [...requirementTitles].filter(([key]) => !latest.has(key) || !signed(latest.get(key))).map(([key, item]) => {
            const doc = latest.get(key);
            const patientSigned = doc && require('./appointmentConsentEligibility.service').isCurrentSignedDocument({
                ...doc, snapshot_json: { ...doc.snapshot_json, template: { ...doc.snapshot_json?.template, requires_professional_signature: false } },
            }, {}, now);
            return { ...item, document_id: doc?.id || null,
                pending_party: patientSigned && documentRequiresProfessionalSignature(doc) ? 'professional' : 'patient' };
        }),
        status: summary.has_pending ? 'pending' : 'ok',
        package_id: packageRow?.id || null,
        package_public_id: packageRow?.public_id || null,
        due_policy: signingPolicy.due_policy,
        signing_timing: signingPolicy.signing_timing,
        signing_timing_label: signingPolicy.signing_timing_label,
        recommended_min_hours_before: signingPolicy.recommended_min_hours_before,
        recommendation: summary.has_pending ? signingPolicy.recommendation : null,
    };
}

async function attachConsentSummaryToCitas(citas) {
    const list = Array.isArray(citas) ? citas : (citas ? [citas] : []);
    if (!list.length) return citas;
    // Privacy belongs to patient+clinic, not to a treatment. Resolve the whole
    // authorized page in one bounded snapshot instead of N reads per card.
    let privacyContext = null, privacyError = false;
    try {
        privacyContext = await db.sequelize.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, transaction =>
            require('./patientPrivacyStatus.service').loadPrivacyContext({ db, appointments: list, transaction }));
    } catch { privacyError = true; }
    await Promise.all(list.map(async (cita) => {
        try {
            const summary = await getConsentSummaryForAppointment(cita);
            if (privacyError) summary.privacy_error = true;
            else {
                try { summary.privacy = require('./patientPrivacyStatus.service').privacyStateFromContext({ appointment: cita, context: privacyContext }); }
                catch { summary.privacy_error = true; }
            }
            if (typeof cita?.setDataValue === 'function') {
                cita.setDataValue('consent_summary', summary);
            } else if (cita && typeof cita === 'object') {
                cita.consent_summary = summary;
            }
        } catch (error) {
            if (typeof cita?.setDataValue === 'function') {
                cita.setDataValue('consent_summary', null);
            } else if (cita && typeof cita === 'object') {
                cita.consent_summary = null;
            }
        }
    }));
    return citas;
}

async function createPatientIntakePackage(identifier, options = {}) {
    const patient = await findPacienteByIdentifier(identifier);
    if (!patient) throw Object.assign(new Error('patient_not_found'), { statusCode: 404 });
    return require('../lib/patient-intake-consents').preparePatientIntake({
        db, patientId: patient.id_paciente, clinicId: options.clinicId, actorId: options.createdBy,
        structuredQuestionnaire: options.structuredQuestionnaire === true,
        privacyOnly: options.privacyOnly === true,
        additionalTemplateId: options.additionalTemplateId ?? null,
        allowLinkedClinic: options.allowLinkedClinic === true,
        transaction: options.transaction || null,
        snapshot: ({ template: templateRow, version: versionRow, patient: patientRow, clinic: clinicRow }) => {
            const template = getPlain(templateRow), version = getPlain(versionRow), paciente = getPlain(patientRow);
            documentCompletion.policy(version, template);
            const context = buildTemplateContext({ paciente, clinica: getPlain(clinicRow) });
            const html = renderConsentVersionHtml(version, context, renderTemplateHtml);
            const policy = getSigningPolicyFromVersion(version, template);
            const snapshot = {
                template_source: 'clinic', template,
                version: { id: version.id, version: version.version, locale: version.locale,
                    title: version.title, body_json: version.body_json || null, variable_schema: version.variable_schema || null,
                    ...(require('../lib/registration-privacy-template').schema(version.body_json) || documentBlocks.versionBlocks(version, template)
                        ? { body_html: version.body_html || '' } : {}) },
                context, patient_flags: { is_minor: isMinorPatient(paciente, getPlain(clinicRow)), representatives: getRepresentativeSnapshot(paciente) },
                document_branding: documentBranding.buildDocumentBranding(getPlain(clinicRow), {
                    purpose: template.purpose, configuration: parseJsonObject(version.body_json).document_branding,
                    baseUrl: process.env.FRONTEND_PUBLIC_URL || 'https://crm.clinicaclick.com' }),
                clinical_policy: { ...policy, pdf_strategy: 'json_snapshot_printable_on_demand' },
                generated_at: new Date().toISOString(),
            };
            return { snapshot_json: snapshot, snapshot_html: html, snapshot_hash: hashRenderedSnapshot(snapshot, html) };
        },
    });
}

async function createPackageForAppointment(citaIdRaw, options = {}, transaction = null) {
    const execute = async tx => {
        // Lock only the appointment, not every joined patient/clinic/template.
        // All entry points use this lock before deriving the document snapshot.
        const id = toIntOrNull(citaIdRaw);
        const locked = id ? await db.CitaPaciente.findByPk(id, {
            attributes: ['id_cita'], transaction: tx, lock: tx.LOCK.UPDATE,
        }) : null;
        if (!locked) throw Object.assign(new Error('appointment_not_found'), { statusCode: 404 });
        return createPackageForLockedAppointment(await findAppointment(id, tx), options, tx);
    };
    return transaction ? execute(transaction)
        : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute);
}

async function createPackageForLockedAppointment(cita, options, transaction) {
    if (!cita) {
        const err = new Error('appointment_not_found');
        err.statusCode = 404;
        throw err;
    }

    const plainCita = getPlain(cita);
    if (!plainCita.paciente_id || !plainCita.clinica_id || !plainCita.tratamiento_id) {
        const err = new Error('appointment_missing_patient_clinic_or_treatment');
        err.statusCode = 400;
        throw err;
    }

    const requirements = await resolveRequirementsForAppointment(cita, transaction);
    if (!requirements.length) {
        const err = new Error('appointment_has_no_consent_requirements');
        err.statusCode = 400;
        throw err;
    }

    const preparedRequirements = [];
    for (const requirement of requirements) {
        // The template identity is sufficient to locate existing/reusable
        // evidence. A newer draft, archive or removed published version must
        // not force regeneration of the document already frozen for this act.
        const resolved = requirementTemplateIdentity(requirement);
        if (!resolved?.template) throw Object.assign(new Error('consent_template_version_unavailable'), { statusCode: 409 });
        const reusableOptions = { pacienteId: plainCita.paciente_id, clinicaId: plainCita.clinica_id, resolved };
        preparedRequirements.push({ requirement, resolved,
            candidates: await pendingReusableConsentCandidates(reusableOptions, transaction),
            signedReusable: await findSignedReusableConsent({ ...reusableOptions, transaction }) });
    }

    let packageRow = await db.ConsentSignaturePackage.findOne({
        transaction,
        where: {
            cita_id: plainCita.id_cita,
            paciente_id: plainCita.paciente_id,
            clinica_id: plainCita.clinica_id,
            tratamiento_id: plainCita.tratamiento_id,
            status: { [Op.notIn]: ['cancelled', 'expired'] },
        },
    });
    await lockConsentPackages([packageRow?.id, ...preparedRequirements.flatMap(row => [row.signedReusable?.package_id,
        ...row.candidates.map(candidate => candidate.package_id)])], transaction);
    // A known package may have been cancelled while this preparation waited.
    if (packageRow) packageRow = await db.ConsentSignaturePackage.findOne({ transaction,
        where: { id: packageRow.id, status: { [Op.notIn]: ['cancelled', 'expired'] } } });
    if (!packageRow) {
        const appointmentStart = plainCita.inicio ? new Date(plainCita.inicio) : null;
        const dueAt = appointmentStart && Number.isFinite(appointmentStart.getTime()) ? appointmentStart : null;
        const expiresAt = dueAt ? new Date(dueAt.getTime() + 30 * 24 * 60 * 60 * 1000) : addHours(new Date(), 24 * 30);
        packageRow = await db.ConsentSignaturePackage.create({
            public_id: await generateUniquePublicId(db.ConsentSignaturePackage, 'cpkg', transaction),
            paciente_id: plainCita.paciente_id,
            clinica_id: plainCita.clinica_id,
            cita_id: plainCita.id_cita,
            tratamiento_id: plainCita.tratamiento_id,
            status: 'pending',
            due_at: dueAt,
            expires_at: expiresAt,
            trigger_source: toCleanString(options.triggerSource) || 'manual',
            created_by: toIntOrNull(options.createdBy),
        }, { transaction });
    }

    const context = buildTemplateContext({
        paciente: plainCita.paciente,
        clinica: plainCita.clinica,
        tratamiento: plainCita.tratamiento,
        cita: plainCita,
        profesional: plainCita.doctor,
    });

    const requirementTreatmentIds = [...new Set(requirements.map(row => Number(getPlain(row).tratamiento_id)).filter(Boolean))];
    const requirementTreatments = requirementTreatmentIds.some(id => id !== Number(plainCita.tratamiento_id)) ? await db.Tratamiento.findAll({ where: { id_tratamiento: { [Op.in]: requirementTreatmentIds } }, transaction }) : [];
    const programContext = require('../lib/program-appointment-context').hasProgramAppointmentReference(plainCita)
        ? await require('../lib/program-appointment-context').programAppointmentContext(db, plainCita, transaction) : null;
    const doctorsByTreatment = new Map(programContext ? requirementTreatmentIds.map(id => [id,
        require('../lib/program-appointment-context').programTreatmentDoctorIds(programContext, plainCita, id)]) : []);
    const programDoctorIds = [...new Set([...doctorsByTreatment.values()].flat())];
    const programDoctors = programDoctorIds.length ? await db.Usuario.findAll({ where: { id_usuario: { [Op.in]: programDoctorIds } }, attributes: ['id_usuario', 'nombre', 'apellidos'], transaction }) : [];

    for (const { requirement, resolved, candidates } of preparedRequirements) {
        const plainRequirement = getPlain(requirement);
        const requirementTreatmentId = toIntOrNull(plainRequirement.tratamiento_id) || plainCita.tratamiento_id;
        const requirementTreatment = requirementTreatments.find(row => Number(row.id_tratamiento) === Number(requirementTreatmentId));
        const assignedDoctors = doctorsByTreatment.get(requirementTreatmentId) || [];
        // A multi-professional team cannot be represented by a guessed singular
        // signer. Keep that placeholder empty instead of naming another phase's doctor.
        const professional = programContext ? (assignedDoctors.length === 1 ? getPlain(programDoctors.find(row => row.id_usuario === assignedDoctors[0])) : null) : plainCita.doctor;
        const documentContext = requirementTreatment || programContext ? buildTemplateContext({ paciente: plainCita.paciente, clinica: plainCita.clinica,
            tratamiento: getPlain(requirementTreatment) || plainCita.tratamiento, cita: { ...plainCita, tratamiento_id: requirementTreatmentId }, profesional: professional }) : context;
        const signedReusable = await findSignedReusableConsent({
            pacienteId: plainCita.paciente_id,
            clinicaId: plainCita.clinica_id,
            resolved,
            transaction,
        });
        if (signedReusable) {
            await supersedePendingReusableConsents({
                pacienteId: plainCita.paciente_id,
                clinicaId: plainCita.clinica_id,
                resolved,
                exceptId: signedReusable.id,
                candidates,
                transaction,
            });
            continue;
        }

        const existingWhere = {
            package_id: packageRow.id,
            paciente_id: plainCita.paciente_id,
            cita_id: plainCita.id_cita,
            tratamiento_id: requirementTreatmentId,
            status: { [Op.notIn]: ['cancelled', 'voided', 'superseded', 'rejected', 'revoked', 'expired'] },
            revoked_at: null,
        };
        if (plainRequirement.clinic_template_id) {
            existingWhere.clinic_template_id = plainRequirement.clinic_template_id;
        } else {
            existingWhere.catalog_template_id = plainRequirement.catalog_template_id;
        }
        const existing = await db.PatientConsentDocument.findOne({ where: existingWhere, transaction });
        // Signed documents belong to this same act. A refresh/retry must never
        // replace them with another pending signature (including dual signing).
        if (existing) continue;

        resolved.version = getPlain(await getOperationalConsentVersion(resolved, transaction));
        if (!resolved.version) throw Object.assign(new Error('consent_template_version_unavailable'), { statusCode: 409 });
        documentCompletion.policy(resolved.version, resolved.template);
        if (require('../lib/registration-privacy-template').schema(resolved.version.body_json)) {
            require('../lib/registration-privacy-configuration').assertLegalControllerForIssue(plainCita.clinica);
        }
        const title = resolved.version.title || resolved.template.name;
        const renderedHtml = renderConsentVersionHtml({ ...resolved.version,
            body_html: resolved.version.body_html || buildDefaultBodyHtml(title) }, documentContext, renderTemplateHtml);
        const signingPolicy = getSigningPolicyFromVersion(resolved.version, resolved.template);
        const snapshot = {
            template_source: resolved.source,
            template: {
                id: resolved.template.id,
                public_id: resolved.template.public_id || null,
                name: resolved.template.name,
                clinic_id: resolved.source === 'clinic' ? resolved.template.clinic_id : null,
                catalog_key: resolved.source === 'clinic' ? resolved.template.catalog_key : null,
                purpose: resolved.template.purpose,
                blocking_policy: resolved.template.blocking_policy,
                validity_mode: resolved.template.validity_mode,
                requires_patient_signature: resolved.template.requires_patient_signature !== false,
                requires_representative_when_minor: resolved.template.requires_representative_when_minor !== false,
                requires_professional_signature: !!resolved.template.requires_professional_signature,
            },
            version: {
                id: resolved.version.id,
                version: resolved.version.version,
                locale: resolved.version.locale,
                title,
                body_json: resolved.version.body_json || null,
                ...(require('../lib/registration-privacy-template').schema(resolved.version.body_json) || documentBlocks.versionBlocks(resolved.version, resolved.template)
                    ? { body_html: resolved.version.body_html || '' } : {}),
                variable_schema: resolved.version.variable_schema || null,
            },
            context: documentContext,
            document_branding: documentBranding.buildDocumentBranding(plainCita.clinica, {
                purpose: resolved.template.purpose, configuration: parseJsonObject(resolved.version.body_json).document_branding,
                baseUrl: process.env.FRONTEND_PUBLIC_URL || 'https://crm.clinicaclick.com' }),
            patient_flags: {
                is_minor: isMinorPatient(plainCita.paciente, plainCita.clinica),
                representatives: getRepresentativeSnapshot(plainCita.paciente),
            },
            clinical_policy: {
                due_policy: signingPolicy.due_policy,
                signing_timing: signingPolicy.signing_timing,
                signing_timing_label: signingPolicy.signing_timing_label,
                recommended_min_hours_before: signingPolicy.recommended_min_hours_before,
                pdf_strategy: 'json_snapshot_printable_on_demand',
            },
            generated_at: new Date().toISOString(),
        };

        await db.PatientConsentDocument.create({
            public_id: await generateUniquePublicId(db.PatientConsentDocument, 'cdoc', transaction),
            package_id: packageRow.id,
            paciente_id: plainCita.paciente_id,
            clinica_id: plainCita.clinica_id,
            cita_id: plainCita.id_cita,
            tratamiento_id: requirementTreatmentId,
            clinic_template_id: resolved.source === 'clinic' ? resolved.template.id : null,
            clinic_template_version_id: resolved.source === 'clinic' ? resolved.version.id : null,
            catalog_template_id: resolved.source === 'catalog' ? resolved.template.id : null,
            catalog_template_version_id: resolved.source === 'catalog' ? resolved.version.id : null,
            purpose: resolved.template.purpose || 'clinical',
            status: 'pending',
            required: !!plainRequirement.required,
            blocking_policy: plainRequirement.blocking_policy || resolved.template.blocking_policy || 'hard',
            locale: resolved.version.locale || 'es',
            title,
            snapshot_json: snapshot,
            snapshot_html: renderedHtml,
            snapshot_hash: hashRenderedSnapshot(snapshot, renderedHtml),
            expires_at: packageRow.expires_at || null,
        }, { transaction });
    }

    await refreshPackageCounts(packageRow.id, transaction);
    return db.ConsentSignaturePackage.findByPk(packageRow.id, {
        transaction,
        include: [
            { model: db.PatientConsentDocument, as: 'documents', required: false },
            { model: db.Paciente, as: 'paciente', required: false },
            { model: db.Tratamiento, as: 'tratamiento', required: false },
        ],
    });
}

async function refreshPackageCounts(packageIdRaw, transaction = null) {
    const packageId = toIntOrNull(packageIdRaw);
    if (!packageId) return null;
    if (!transaction) return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' },
        tx => refreshPackageCounts(packageId, tx));
    await lockConsentPackages([packageId], transaction);
    const packageRow = await db.ConsentSignaturePackage.findByPk(packageId, { attributes: ['id', 'status', 'clinica_id'], transaction });
    if (!packageRow) return null;
    const documents = await db.PatientConsentDocument.findAll({
        transaction,
        where: { package_id: packageId, status: { [Op.notIn]: ['cancelled', 'voided', 'superseded'] } },
        raw: true,
    });
    // A revoked/rejected attempt stays in history, but its replacement must
    // not double the obligation or make completion impossible forever.
    const latest = new Map();
    for (const doc of documents) {
        const template = doc.clinic_template_id ? `clinic:${doc.clinic_template_id}`
            : doc.catalog_template_id ? `catalog:${doc.catalog_template_id}` : `document:${doc.id}`;
        const key = `${doc.tratamiento_id || 0}:${template}`;
        if (!latest.has(key) || Number(doc.id) > Number(latest.get(key).id)) latest.set(key, doc);
    }
    const currentDocuments = [...latest.values()];
    const requiredCount = currentDocuments.filter((doc) => !!doc.required).length;
    const signedCount = currentDocuments.filter((doc) => !!doc.required && doc.status === 'signed' && !doc.revoked_at).length;
    const completedCount = currentDocuments.filter((doc) => !!doc.required && documentCompletion.isCompleted(doc)).length;
    const hasCompleted = currentDocuments.some(doc => documentCompletion.isCompleted(doc));
    const pending = currentDocuments.some((doc) => DOCUMENT_PENDING_STATUSES.has(doc.status));
    const intakeRequest = await db.PatientIntakeRequest.findOne({ where: { package_id: packageId }, transaction });
    const intake = intakeRequest && await clinicMedicalQuestionnaireEnabled({ db, clinicId: packageRow.clinica_id, transaction })
        ? intakeRequest : null;
    const status = ['cancelled', 'expired'].includes(packageRow.status) ? packageRow.status
        : intake?.status === 'pending' ? 'pending'
        : !currentDocuments.length && intake ? 'signed'
        : requiredCount > 0 && signedCount + completedCount >= requiredCount ? (hasCompleted ? 'completed' : 'signed')
        : !pending && hasCompleted ? 'completed'
        : (pending ? 'pending' : 'draft');
    await db.ConsentSignaturePackage.update(
        { required_count: requiredCount, signed_count: signedCount, status },
        { where: { id: packageId }, transaction }
    );
    return { required_count: requiredCount, signed_count: signedCount, completed_count: completedCount,
        satisfied_count: signedCount + completedCount, status };
}

async function markPendingConsentDocument(docLike, values, transaction) {
    const doc = getPlain(docLike);
    if (!DOCUMENT_PENDING_STATUSES.has(doc.status)) return false;
    const [changed] = await db.PatientConsentDocument.update(values, { transaction,
        where: { id: doc.id, package_id: doc.package_id, paciente_id: doc.paciente_id, clinica_id: doc.clinica_id,
            status: { [Op.in]: Array.from(DOCUMENT_PENDING_STATUSES) }, signed_at: null, revoked_at: null } });
    return changed === 1;
}

async function requireCurrentActiveConsentPackage(packageId, transaction) {
    const current = await db.ConsentSignaturePackage.findByPk(packageId, {
        attributes: ['id', 'status', 'expires_at'], transaction,
    });
    if (!current) throw Object.assign(new Error('consent_package_not_found'), { statusCode: 404 });
    requireActiveConsentPackage(current);
    return current;
}

async function sendPackageMock(packageIdRaw, payload = {}) {
    const packageId = toIntOrNull(packageIdRaw);
    const channel = normalizeEnum(payload.channel, CHANNEL_VALUES, 'email');
    const packageRow = packageId ? await db.ConsentSignaturePackage.findByPk(packageId, {
        include: [
            { model: db.PatientConsentDocument, as: 'documents', required: false },
            { model: db.Paciente, as: 'paciente', required: false },
        ],
    }) : null;
    if (!packageRow) {
        const err = new Error('consent_package_not_found');
        err.statusCode = 404;
        throw err;
    }
    const plain = getPlain(packageRow);
    if (['email', 'whatsapp'].includes(channel)) {
        // Sending is not enabled for these clinics yet. The stored package
        // owns the clinic scope; a caller cannot move it with payload metadata.
        // Stop before minting a public token or recording a simulated delivery.
        require('../lib/whatsappAppointmentEligibility').assertClinicNonOperationalAllowed(plain.clinica_id, {
            metadata: { communication_purpose: 'consent', consent_package_id: plain.id },
        });
    }
    const recipient = toCleanString(payload.recipient)
        || (channel === 'email' ? plain.paciente?.email : plain.paciente?.telefono_movil)
        || null;
    const eventStatus = channel === 'tablet' ? 'viewed' : 'mock_sent';
    const documentStatus = channel === 'tablet' ? 'viewed' : 'sent';
    const token = signPackageToken(packageRow, {
        channel,
        ttlHours: payload.ttl_hours ?? payload.validez_horas,
    });
    const publicUrl = buildPublicConsentUrl(token, payload.base_url ?? payload.baseUrl);

    const documents = Array.isArray(packageRow.documents) ? packageRow.documents : [];
    const pendingDocuments = documents.filter((doc) => DOCUMENT_PENDING_STATUSES.has(getPlain(doc).status));
    pendingDocuments.forEach(doc => documentCompletion.documentPolicy(doc));
    await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
        await lockConsentPackages([packageRow.id], transaction);
        await requireCurrentActiveConsentPackage(packageRow.id, transaction);
        const intakeRequest = await db.PatientIntakeRequest.findOne({ where: { package_id: packageRow.id, status: 'pending' }, transaction });
        const intake = intakeRequest && await clinicMedicalQuestionnaireEnabled({ db, clinicId: packageRow.clinica_id, transaction })
            ? intakeRequest : null;
        let changed = 0;
        for (const doc of pendingDocuments) {
            const plainDoc = getPlain(doc);
            if (!await markPendingConsentDocument(doc, { status: documentStatus, channel, delivery_status: eventStatus }, transaction)) continue;
            changed++;
            await db.ConsentDeliveryEvent.create({
                package_id: packageRow.id,
                patient_consent_document_id: plainDoc.id,
                channel,
                status: eventStatus,
                recipient,
                event_payload: {
                    mocked: true,
                    reason: 'Email/WhatsApp provider pendiente de conectar al motor de automatizaciones',
                    public_url: publicUrl,
                    token_expires_in_hours: getLinkTtlHours(payload.ttl_hours ?? payload.validez_horas),
                    created_at: new Date().toISOString(),
                },
            }, { transaction });
        }
        if (!changed && !intake) throw Object.assign(new Error('consent_package_has_no_pending_documents'), { statusCode: 409 });
        await db.ConsentSignaturePackage.update({ status: channel === 'tablet' ? 'viewed' : 'sent' }, {
            where: { id: packageRow.id, status: { [Op.in]: ['draft', 'pending', 'sent', 'viewed'] } }, transaction,
        });
        await refreshPackageCounts(packageRow.id, transaction);
    });
    return db.ConsentSignaturePackage.findByPk(packageRow.id, {
        include: [
            { model: db.PatientConsentDocument, as: 'documents', required: false },
            { model: db.ConsentDeliveryEvent, as: 'deliveryEvents', required: false },
        ],
    }).then((updatedPackage) => {
        const result = getPlain(updatedPackage);
        result.public_url = publicUrl;
        result.public_token = token;
        return result;
    });
}

async function getPackageWithDocumentsByPublicId(publicIdRaw) {
    const publicId = toCleanString(publicIdRaw);
    if (!publicId) return null;
    return db.ConsentSignaturePackage.findOne({
        where: { public_id: publicId },
        include: [
            { model: db.PatientConsentDocument, as: 'documents', required: false },
            { model: db.Paciente, as: 'paciente', required: false },
            consentPresentationClinicInclude('clinica'),
            { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre', 'disciplina'] },
        ],
    });
}

async function getPackageWithDocumentsById(packageIdRaw) {
    const packageId = toIntOrNull(packageIdRaw);
    if (!packageId) return null;
    return db.ConsentSignaturePackage.findByPk(packageId, {
        include: [
            { model: db.PatientConsentDocument, as: 'documents', required: false },
            { model: db.Paciente, as: 'paciente', required: false },
            consentPresentationClinicInclude('clinica'),
            { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre', 'disciplina'] },
        ],
    });
}

// Read-only preparation for the real automation transport. Unlike send-mock
// or a tablet-session action, it does not mark a document sent or enqueue it.
async function prepareAutomationPackageContext(scope = {}) {
    const { assertConsentAutomationScope, assertConsentAutomationConfiguration } = require('../lib/consent-automation-link');
    const configuredSecret = toCleanString(process.env.CONSENT_PUBLIC_TOKEN_SECRET || process.env.JWT_SECRET);
    const baseUrl = assertConsentAutomationConfiguration({
        baseUrl: getTabletBaseUrl(),
        secretConfigured: !!configuredSecret && configuredSecret !== 'clinicaclick-dev-consentimientos',
        runtimeNamespace: process.env.RUNTIME_NAMESPACE,
    });
    const packageRow = await getPackageWithDocumentsById(scope.packageId);
    const appointment = toIntOrNull(scope.appointmentId) ? await db.CitaPaciente.findByPk(scope.appointmentId, {
        attributes: ['id_cita', 'clinica_id', 'paciente_id', 'tratamiento_id', 'estado', 'inicio', 'es_provisional'],
        raw: true,
    }) : null;
    const pack = getPlain(packageRow);
    const documents = assertConsentAutomationScope({ packageRow: pack, appointment, scope });
    // This method creates a WhatsApp automation link, not an in-clinic tablet
    // session. Keep on-site preparation/signing APIs separate and unchanged.
    require('../lib/whatsappAppointmentEligibility').assertClinicNonOperationalAllowed(pack.clinica_id, {
        metadata: { communication_purpose: 'consent', consent_package_id: pack.id },
    });
    const treatmentName = toCleanString(pack.tratamiento?.nombre);
    if (!treatmentName) throw Object.assign(new Error('consent_automation_treatment_not_found'), { statusCode: 409 });
    requireActiveConsentPackage(packageRow);
    const token = signPackageToken(packageRow, { channel: 'whatsapp' });
    return {
        consentimiento: {
            package_id: pack.id,
            package_public_id: pack.public_id,
            pending_count: documents.length,
            enlace_publico: buildPublicConsentUrl(token, baseUrl),
        },
        tratamiento: { id: pack.tratamiento_id, nombre: treatmentName },
    };
}

async function createTabletSession(packageIdRaw, payload = {}) {
    const packageRow = await getPackageWithDocumentsById(packageIdRaw);
    if (!packageRow) {
        const err = new Error('consent_package_not_found');
        err.statusCode = 404;
        throw err;
    }
    requireActiveConsentPackage(packageRow);
    const token = signPackageToken(packageRow, {
        channel: 'tablet',
        ttlHours: payload.ttl_hours ?? payload.validez_horas ?? 12,
    });
    const publicUrl = buildPublicConsentUrl(token, payload.base_url ?? payload.baseUrl);
    const documents = Array.isArray(packageRow.documents) ? packageRow.documents : [];
    const pendingDocuments = documents.filter((doc) => DOCUMENT_PENDING_STATUSES.has(getPlain(doc).status));
    pendingDocuments.forEach(doc => documentCompletion.documentPolicy(doc));
    const pendingIntake = !pendingDocuments.length && db.PatientIntakeRequest
        && await clinicMedicalQuestionnaireEnabled({ db, clinicId: packageRow.clinica_id })
        ? await db.PatientIntakeRequest.findOne({ where: {
            package_id: packageRow.id, patient_id: packageRow.paciente_id,
            clinic_id: packageRow.clinica_id, status: 'pending',
        }, attributes: ['id'] }) : null;
    if (!pendingDocuments.length && !pendingIntake) {
        const err = new Error('consent_package_has_no_pending_documents');
        err.statusCode = 409;
        throw err;
    }
    await Promise.all(pendingDocuments.map(async (doc) => {
        const plainDoc = getPlain(doc);
        const existingQueuedEvent = await db.ConsentDeliveryEvent.findOne({
            where: {
                package_id: packageRow.id,
                patient_consent_document_id: plainDoc.id,
                channel: 'tablet',
                status: 'queued',
            },
            attributes: ['id'],
        });
        if (!existingQueuedEvent) {
            await db.ConsentDeliveryEvent.create({
                package_id: packageRow.id,
                patient_consent_document_id: plainDoc.id,
                channel: 'tablet',
                status: 'queued',
                recipient: 'tablet_clinica',
                event_payload: {
                    public_url: publicUrl,
                    token_expires_in_hours: getLinkTtlHours(payload.ttl_hours ?? payload.validez_horas ?? 12),
                    created_at: new Date().toISOString(),
                },
            });
        }
        if (plainDoc.status === 'pending') {
            await doc.update({ channel: 'tablet', delivery_status: 'queued' });
        }
    }));
    return {
        package_id: packageRow.id,
        package_public_id: packageRow.public_id,
        public_token: token,
        public_url: publicUrl,
        expires_at: jwt.decode(token)?.exp ? new Date(jwt.decode(token).exp * 1000).toISOString() : null,
    };
}

function serializeKioskAccess(kiosk, includePassword = null) {
    const plain = kiosk ? getPlain(kiosk) : null;
    if (!plain) return null;
    const response = {
        id: plain.id,
        public_id: plain.public_id,
        clinic_id: plain.clinic_id,
        include_group_consents: !!plain.consent_group_id,
        username: plain.username,
        display_name: plain.display_name || 'Tablet recepción',
        status: plain.status,
        last_login_at: plain.last_login_at || null,
        last_used_at: plain.last_used_at || null,
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt,
    };
    if (includePassword) response.one_time_password = includePassword;
    return response;
}

async function getClinicKioskAccess(clinicIdRaw) {
    const clinicId = toIntOrNull(clinicIdRaw);
    if (!clinicId) {
        const err = new Error('clinic_id_required');
        err.statusCode = 400;
        throw err;
    }
    const clinic = await db.Clinica.findByPk(clinicId, { raw: true });
    if (!clinic) {
        const err = new Error('clinic_not_found');
        err.statusCode = 404;
        throw err;
    }
    const kiosks = await db.ClinicTabletKiosk.findAll({
        where: { clinic_id: clinicId },
        order: [
            [db.sequelize.literal("CASE WHEN status = 'active' THEN 0 ELSE 1 END"), 'ASC'],
            ['id', 'ASC'],
        ],
    });
    const serialized = kiosks.map((kiosk) => serializeKioskAccess(kiosk));
    return {
        exists: serialized.length > 0,
        time_zone: consentClinicTime.resolveClinicTimezone(clinic),
        suggested_username: `tablet-${clinicId}-${slugifyKioskPart(clinic.nombre_clinica) || 'clinica'}`,
        kiosk: serialized.find((item) => item.status === 'active') || serialized[0] || null,
        kiosks: serialized,
    };
}

async function buildUniqueKioskUsername(clinicId, clinicName, preferred = null) {
    const base = slugifyKioskPart(preferred) || `tablet-${clinicId}-${slugifyKioskPart(clinicName) || 'clinica'}`;
    let candidate = base;
    let index = 1;
    while (await db.ClinicTabletKiosk.findOne({ where: { username: candidate }, attributes: ['id'] })) {
        index += 1;
        candidate = `${base}-${index}`;
    }
    return candidate;
}

async function updateClinicKioskScope(clinicId, kioskId, actorId, payload = {}) {
    await setConsentGroupScope({ db, assertAccess: require('../lib/access-policy').assertUserCanAccessFeature,
        clinicId, kioskId, actorId, enabled: payload.include_group_consents });
    return getClinicKioskAccess(clinicId);
}

async function createClinicKioskAccess(clinicIdRaw, userId = null, payload = {}) {
    const clinicId = toIntOrNull(clinicIdRaw);
    if (!clinicId) {
        const err = new Error('clinic_id_required');
        err.statusCode = 400;
        throw err;
    }
    const clinic = await db.Clinica.findByPk(clinicId, { raw: true });
    if (!clinic) {
        const err = new Error('clinic_not_found');
        err.statusCode = 404;
        throw err;
    }
    const password = generateReadablePassword();
    const passwordHash = await bcrypt.hash(password, 12);
    const existingCount = await db.ClinicTabletKiosk.count({ where: { clinic_id: clinicId } });
    const displayName = toCleanString(payload.display_name ?? payload.nombre)
        || (existingCount ? `Tablet ${existingCount + 1}` : 'Tablet recepción');
    const username = await buildUniqueKioskUsername(
        clinicId,
        clinic.nombre_clinica,
        payload.username || `tablet-${clinicId}-${displayName}`
    );
    const kiosk = await db.ClinicTabletKiosk.create({
        public_id: await generateUniquePublicId(db.ClinicTabletKiosk, 'kiosk'),
        clinic_id: clinicId,
        username,
        password_hash: passwordHash,
        display_name: displayName,
        status: 'active',
        created_by: toIntOrNull(userId),
    });
    const access = await getClinicKioskAccess(clinicId);
    return {
        ...access,
        exists: true,
        kiosk: serializeKioskAccess(kiosk, password),
        kiosks: access.kiosks.map((item) => item.id === kiosk.id ? serializeKioskAccess(kiosk, password) : item),
    };
}

async function regenerateClinicKioskAccess(clinicIdRaw, kioskIdRaw, userId = null) {
    const clinicId = toIntOrNull(clinicIdRaw);
    const kioskId = toIntOrNull(kioskIdRaw);
    if (!clinicId || !kioskId) {
        const err = new Error('tablet_kiosk_id_required');
        err.statusCode = 400;
        throw err;
    }
    const kiosk = await db.ClinicTabletKiosk.findOne({ where: { id: kioskId, clinic_id: clinicId } });
    if (!kiosk) {
        const err = new Error('tablet_kiosk_not_found');
        err.statusCode = 404;
        throw err;
    }
    const password = generateReadablePassword();
    const passwordHash = await bcrypt.hash(password, 12);
    await kiosk.update({
        password_hash: passwordHash,
        status: 'active',
        created_by: toIntOrNull(userId) || kiosk.created_by || null,
    });
    const access = await getClinicKioskAccess(clinicId);
    return {
        ...access,
        exists: true,
        kiosk: serializeKioskAccess(kiosk, password),
        kiosks: access.kiosks.map((item) => item.id === kiosk.id ? serializeKioskAccess(kiosk, password) : item),
    };
}

async function resetClinicKioskAccess(clinicIdRaw, userId = null) {
    const clinicId = toIntOrNull(clinicIdRaw);
    if (!clinicId) {
        const err = new Error('clinic_id_required');
        err.statusCode = 400;
        throw err;
    }
    const existing = await db.ClinicTabletKiosk.findOne({
        where: { clinic_id: clinicId },
        order: [
            [db.sequelize.literal("CASE WHEN status = 'active' THEN 0 ELSE 1 END"), 'ASC'],
            ['id', 'ASC'],
        ],
    });
    if (existing) {
        return regenerateClinicKioskAccess(clinicId, existing.id, userId);
    }
    return createClinicKioskAccess(clinicId, userId);
}

function consentPresentationClinicInclude(as) {
    return { model: db.Clinica, as, required: false,
        attributes: ['id_clinica', 'nombre_clinica', 'url_avatar', 'configuracion', 'grupoClinicaId'],
        include: [{ model: db.GrupoClinica, as: 'grupoClinica', required: false, attributes: ['id_grupo', 'nombre_grupo'] }] };
}

async function tabletPresentationForClinic(clinicRow) {
    const clinic = getPlain(clinicRow) || {};
    return require('./consentTabletBranding.service').resolveTabletBrandingForClinic(clinic, clinic.grupoClinica,
        { baseUrl: process.env.FRONTEND_PUBLIC_URL || 'https://crm.clinicaclick.com' });
}

function serializeTabletClinic(clinicRow, clinicId) {
    const clinic = getPlain(clinicRow) || {};
    return { id_clinica: clinic.id_clinica || clinicId, nombre_clinica: clinic.nombre_clinica || '',
        url_avatar: clinic.url_avatar || null, time_zone: consentClinicTime.resolveClinicTimezone(clinic) };
}

function withConsentClinicTime(row) {
    const value = getPlain(row), clinic = value.clinica;
    const timeZone = consentClinicTime.documentTimezone(value);
    // Configuration is read only to resolve clinic-local display. Do not add
    // it to the pre-existing staff document DTO or alter stored evidence.
    const { configuracion: _configuration, ...publicClinic } = clinic || {};
    return { ...value, time_zone: timeZone,
        ...(clinic ? { clinica: { ...publicClinic, time_zone: timeZone } } : {}) };
}

async function loginTabletKiosk(payload = {}) {
    const username = toCleanString(payload.username ?? payload.usuario);
    const password = toCleanString(payload.password ?? payload.contrasena ?? payload.contraseña);
    if (!username || !password) {
        const err = new Error('tablet_kiosk_credentials_required');
        err.statusCode = 400;
        throw err;
    }
    const kiosk = await db.ClinicTabletKiosk.findOne({
        where: { username, status: 'active' },
        include: [consentPresentationClinicInclude('clinic')],
    });
    const passwordMatches = kiosk ? await bcrypt.compare(password, kiosk.password_hash) : false;
    if (!kiosk || !passwordMatches) {
        const err = new Error('invalid_tablet_kiosk_credentials');
        err.statusCode = 401;
        throw err;
    }
    const token = jwt.sign({
        type: 'clinic_tablet_kiosk',
        kiosk_id: kiosk.id,
        kiosk_public_id: kiosk.public_id,
        clinic_id: kiosk.clinic_id,
        username: kiosk.username,
        scope: 'consent_kiosk',
    }, KIOSK_TOKEN_SECRET, { expiresIn: KIOSK_TOKEN_TTL });
    await kiosk.update({ last_login_at: new Date(), last_used_at: new Date() });
    const decoded = jwt.decode(token);
    return {
        token,
        expires_at: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null,
        kiosk: serializeKioskAccess(kiosk),
        clinic: serializeTabletClinic(kiosk.clinic, kiosk.clinic_id),
        tablet_branding: await tabletPresentationForClinic(kiosk.clinic),
    };
}

async function requireKioskSession(tokenRaw) {
    const payload = verifyKioskToken(tokenRaw);
    const kiosk = await db.ClinicTabletKiosk.findOne({
        where: { id: payload.kiosk_id, clinic_id: payload.clinic_id, status: 'active' },
        include: [consentPresentationClinicInclude('clinic')],
    });
    if (!kiosk) {
        const err = new Error('tablet_kiosk_not_found');
        err.statusCode = 401;
        throw err;
    }
    await kiosk.update({ last_used_at: new Date() });
    return kiosk;
}

async function getTabletKioskSession(tokenRaw) {
    const kiosk = await requireKioskSession(tokenRaw);
    return {
        kiosk: serializeKioskAccess(kiosk),
        clinic: serializeTabletClinic(kiosk.clinic, kiosk.clinic_id),
        tablet_branding: await tabletPresentationForClinic(kiosk.clinic),
    };
}

function serializeKioskPackage(packageRow) {
    const plain = getPlain(packageRow);
    const documents = Array.isArray(plain.documents) ? plain.documents : [];
    const patientName = [plain.paciente?.nombre, plain.paciente?.apellidos].filter(Boolean).join(' ').trim();
    const pendingDocuments = documents.filter((doc) => DOCUMENT_PENDING_STATUSES.has(doc.status)
        && Number(doc.package_id) === Number(plain.id) && Number(doc.paciente_id) === Number(plain.paciente_id)
        && Number(doc.clinica_id) === Number(plain.clinica_id) && !doc.signed_at && !doc.revoked_at
        && (!doc.expires_at || new Date(doc.expires_at).getTime() > Date.now()));
    const blockingPending = pendingDocuments.filter((doc) => doc.required && doc.blocking_policy === 'hard').length;
    return {
        id: plain.id,
        public_id: plain.public_id,
        status: plain.status,
        due_at: plain.due_at || null,
        expires_at: plain.expires_at || null,
        required_count: plain.required_count,
        signed_count: plain.signed_count,
        completed_count: documents.filter(doc => documentCompletion.isCompleted(doc)).length,
        satisfied_count: documents.filter(doc => doc.status === 'signed' || documentCompletion.isCompleted(doc)).length,
        pending_count: pendingDocuments.length,
        intake_pending: medicalQuestionnaireEnabled(plain.clinica?.configuracion) && plain.intakeRequest?.status === 'pending',
        time_zone: consentClinicTime.resolveClinicTimezone(plain.clinica),
        blocking_pending: blockingPending,
        clinic: { id_clinica: plain.clinica_id, nombre_clinica: plain.clinica?.nombre_clinica || '',
            time_zone: consentClinicTime.resolveClinicTimezone(plain.clinica) },
        paciente: {
            id_paciente: plain.paciente?.id_paciente || null,
            public_id: plain.paciente?.public_id || null,
            nombre_completo: patientName || plain.paciente?.nombre || '',
            telefono: plain.paciente?.telefono_movil || plain.paciente?.telefono || null,
        },
        tratamiento: {
            id_tratamiento: plain.tratamiento?.id_tratamiento || null,
            nombre: plain.tratamiento?.nombre || '',
        },
        cita: {
            id_cita: plain.cita?.id_cita || null,
            inicio: plain.cita?.inicio || null,
            estado: plain.cita?.estado || null,
        },
        documents: documents.map((doc) => ({
            id: doc.id,
            public_id: doc.public_id,
            title: doc.title,
            purpose: doc.purpose,
            status: doc.status,
            required: !!doc.required,
            blocking_policy: doc.blocking_policy,
            ...documentCompletion.publicFields(doc),
        })),
    };
}

function publicSignatureEvidenceForDocument(doc) {
    const plain = getPlain(doc);
    const snapshot = parseJsonObject(plain.snapshot_json);
    const evidence = parseJsonObject(snapshot.signature_evidence);
    if (!evidence?.signed_at && !plain.signed_at) return null;
    return {
        signer_name: evidence.signer_name || null,
        signer_role: evidence.signer_role || null,
        representative_name: evidence.representative_name || null,
        relationship: evidence.relationship || null,
        method: evidence.method || null,
        signed_at: evidence.signed_at || plain.signed_at || null,
        ip: evidence.ip || null,
        user_agent: evidence.user_agent || null,
        accepted_statement: evidence.accepted_statement ?? null,
        signature_data_url: evidence.signature_data_url || null,
    };
}

async function listTabletKioskPackages(tokenRaw, filters = {}) {
    const kiosk = await requireKioskSession(tokenRaw);
    const clinicIds = await consentClinicIds(db, kiosk);
    const limit = Math.min(toIntOrNull(filters.limit) || 80, 150);
    const q = toCleanString(filters.q)?.toLowerCase() || null;
    const packageRows = await db.ConsentSignaturePackage.findAll({
        where: {
            clinica_id: { [Op.in]: clinicIds },
            status: { [Op.in]: ['pending', 'sent', 'viewed', 'signed', 'completed'] },
            [Op.or]: [
                { expires_at: null },
                { expires_at: { [Op.gt]: new Date() } },
            ],
            // Required documents may have closed the parent while an optional
            // signature/acknowledgement remains pending. Select live children
            // in SQL BEFORE LIMIT: fully resolved parents must not starve the
            // queue, and cancelled/revoked/expired children never reopen it.
            [Op.and]: require('sequelize').literal(`(
                EXISTS (SELECT 1 FROM PatientConsentDocuments AS kiosk_pending_document
                    WHERE kiosk_pending_document.package_id = ConsentSignaturePackage.id
                    AND kiosk_pending_document.paciente_id = ConsentSignaturePackage.paciente_id
                    AND kiosk_pending_document.clinica_id = ConsentSignaturePackage.clinica_id
                    AND kiosk_pending_document.status IN ('pending','sent','viewed')
                    AND kiosk_pending_document.signed_at IS NULL AND kiosk_pending_document.revoked_at IS NULL
                    AND (kiosk_pending_document.expires_at IS NULL OR kiosk_pending_document.expires_at > UTC_TIMESTAMP()))
                OR EXISTS (SELECT 1 FROM PatientIntakeRequests AS kiosk_pending_intake
                    INNER JOIN Clinicas AS kiosk_intake_clinic ON kiosk_intake_clinic.id_clinica = kiosk_pending_intake.clinic_id
                    WHERE kiosk_pending_intake.package_id = ConsentSignaturePackage.id
                    AND kiosk_pending_intake.patient_id = ConsentSignaturePackage.paciente_id
                    AND kiosk_pending_intake.clinic_id = ConsentSignaturePackage.clinica_id
                    AND kiosk_pending_intake.status = 'pending'
                    AND (JSON_TYPE(JSON_EXTRACT(kiosk_intake_clinic.configuracion, '$.patient_intake.medical_questionnaire_enabled')) IS NULL
                        OR JSON_TYPE(JSON_EXTRACT(kiosk_intake_clinic.configuracion, '$.patient_intake.medical_questionnaire_enabled')) <> 'BOOLEAN'
                        OR JSON_UNQUOTE(JSON_EXTRACT(kiosk_intake_clinic.configuracion, '$.patient_intake.medical_questionnaire_enabled')) <> 'false'))
            )`),
        },
        include: [
            { model: db.PatientConsentDocument, as: 'documents', required: false },
            { model: db.PatientIntakeRequest, as: 'intakeRequest', required: false, attributes: ['id', 'status'] },
            consentPresentationClinicInclude('clinica'),
            { model: db.Paciente, as: 'paciente', required: false },
            { model: db.CitaPaciente, as: 'cita', required: false },
            { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre'] },
        ],
        order: [
            ['due_at', 'ASC'],
            ['createdAt', 'DESC'],
        ],
        limit,
    });
    const items = packageRows
        .map(serializeKioskPackage)
        .filter((item) => item.pending_count > 0 || item.intake_pending)
        .filter((item) => {
            if (!q) return true;
            const haystack = [
                item.paciente.nombre_completo,
                item.tratamiento.nombre,
                item.public_id,
            ].filter(Boolean).join(' ').toLowerCase();
            return q.split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
        });
    const budgetItems = await require('./patientEconomics.service').listTabletBudgetSignatureRequestsForClinic({
        clinicId: kiosk.clinic_id,
        q,
        limit,
    });
    const mergedItems = [...items.map((item) => ({ type: 'consent', ...item })), ...budgetItems]
        .sort((a, b) => new Date(a.due_at || a.created_at || 0).getTime() - new Date(b.due_at || b.created_at || 0).getTime());
    return {
        clinic_id: kiosk.clinic_id,
        include_group_consents: clinicIds.length > 1,
        items: mergedItems,
        total: mergedItems.length,
    };
}

async function createTabletSessionForKiosk(packageIdRaw, tokenRaw, payload = {}) {
    const kiosk = await requireKioskSession(tokenRaw);
    const packageRow = await getPackageWithDocumentsById(packageIdRaw);
    if (!packageRow) {
        const err = new Error('consent_package_not_found');
        err.statusCode = 404;
        throw err;
    }
    const clinicIds = await consentClinicIds(db, kiosk);
    if (!clinicIds.includes(Number(packageRow.clinica_id))) {
        const err = new Error('tablet_kiosk_package_forbidden');
        err.statusCode = 403;
        throw err;
    }
    return createTabletSession(packageRow.id, payload);
}

async function createTabletBudgetSignatureSessionForKiosk(requestIdRaw, tokenRaw, payload = {}) {
    const kiosk = await requireKioskSession(tokenRaw);
    return require('./patientEconomics.service').createTabletBudgetSignatureSession({
        requestId: requestIdRaw,
        clinicId: kiosk.clinic_id,
        payload,
    });
}

async function serializePublicPackage(packageRow) {
    const plain = getPlain(packageRow);
    const documents = Array.isArray(plain.documents) ? plain.documents : [];
    const identityForm = documents.length === 1
        ? consentDocumentPersonalData.publicDocumentPersonalData(documents[0]).personal_data_form : null;
    // In a standalone corrected LOPD the public heading must match the frozen
    // identity being signed, not silently look as if reception edits were lost.
    // This is presentation only; it never updates the patient's master record.
    const patientName = identityForm?.confirmed
        ? [identityForm.values.nombre, identityForm.values.apellidos].filter(Boolean).join(' ').trim()
        : [plain.paciente?.nombre, plain.paciente?.apellidos].filter(Boolean).join(' ').trim();
    return {
        package: {
            id: plain.id,
            public_id: plain.public_id,
            status: plain.status,
            required_count: plain.required_count,
            signed_count: plain.signed_count,
            completed_count: documents.filter(doc => documentCompletion.isCompleted(doc)).length,
            satisfied_count: documents.filter(doc => doc.status === 'signed' || documentCompletion.isCompleted(doc)).length,
            due_at: plain.due_at || null,
            expires_at: plain.expires_at || null,
        },
        paciente: {
            nombre_completo: patientName || plain.paciente?.nombre || '',
        },
        clinica: {
            nombre: plain.clinica?.nombre_clinica || '',
            time_zone: consentClinicTime.resolveClinicTimezone(plain.clinica),
        },
        tablet_branding: await tabletPresentationForClinic(plain.clinica),
        tratamiento: {
            nombre: plain.tratamiento?.nombre || '',
        },
        documents: documents.map((doc) => ({
            id: doc.id,
            public_id: doc.public_id,
            title: doc.title,
            purpose: doc.purpose,
            status: doc.status,
            required: !!doc.required,
            blocking_policy: doc.blocking_policy,
            locale: doc.locale,
            snapshot_html: doc.snapshot_html,
            snapshot_hash: doc.snapshot_hash,
            signed_at: doc.signed_at || null,
            revoked_at: doc.revoked_at || null,
            requires_representative: requiresRepresentative(doc),
            signature_evidence: publicSignatureEvidenceForDocument(doc),
            ...documentCompletion.publicFields(doc),
            ...consentDocumentChoices.publicDocumentChoices(doc),
            ...consentDocumentPersonalData.publicDocumentPersonalData(doc),
            ...documentBlocks.publicFields(doc),
            document_branding: documentBranding.brandingFromSnapshot(doc),
        })),
    };
}

async function resolveActivePublicPackage(tokenRaw) {
    const token = verifyPackageToken(tokenRaw);
    const packageRow = await getPackageWithDocumentsByPublicId(token.package_public_id);
    if (!packageRow) throw Object.assign(new Error('consent_package_not_found'), { statusCode: 404 });
    requireActiveConsentPackage(packageRow);
    return packageRow;
}

async function getPublicPackage(tokenRaw, requestMeta = {}) {
    const token = verifyPackageToken(tokenRaw);
    const packageRow = await getPackageWithDocumentsByPublicId(token.package_public_id);
    if (!packageRow) {
        const err = new Error('consent_package_not_found');
        err.statusCode = 404;
        throw err;
    }
    requireActiveConsentPackage(packageRow);
    const documents = Array.isArray(packageRow.documents) ? packageRow.documents : [];
    await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
        await lockConsentPackages([packageRow.id], transaction);
        await requireCurrentActiveConsentPackage(packageRow.id, transaction);
        for (const doc of documents) {
            const plainDoc = getPlain(doc);
            if (!await markPendingConsentDocument(doc, { status: 'viewed', channel: token.channel || 'tablet', delivery_status: 'viewed' }, transaction)) continue;
            await db.ConsentDeliveryEvent.create({
                package_id: packageRow.id,
                patient_consent_document_id: plainDoc.id,
                channel: token.channel || 'tablet',
                status: 'viewed',
                recipient: token.channel === 'email' ? packageRow.paciente?.email : packageRow.paciente?.telefono_movil,
                event_payload: {
                    event: 'public_package_viewed',
                    viewed_at: new Date().toISOString(),
                    ip: toCleanString(requestMeta.ip),
                    user_agent: toCleanString(requestMeta.userAgent),
                },
            }, { transaction });
        }
        await db.ConsentSignaturePackage.update({ status: 'viewed' }, {
            where: { id: packageRow.id, status: { [Op.in]: ['draft', 'pending', 'sent', 'viewed'] } }, transaction,
        });
        await refreshPackageCounts(packageRow.id, transaction);
    });
    const refreshed = await getPackageWithDocumentsById(packageRow.id);
    return { ...(await serializePublicPackage(refreshed)), intake: await require('./patientIntake.service').publicView(refreshed) };
}

async function updatePublicDocumentPersonalData(tokenRaw, identifier, payload = {}, requestMeta = {}) {
    const token = verifyPackageToken(tokenRaw);
    const packageRow = await getPackageWithDocumentsByPublicId(token.package_public_id);
    if (!packageRow) throw Object.assign(new Error('consent_package_not_found'), { statusCode: 404 });
    requireActiveConsentPackage(packageRow);
    // Resolve exclusively within this issued package. A valid bearer for one
    // patient never permits probing/editing another patient's document.
    const selected = (packageRow.documents || []).map(getPlain).find(doc => String(doc.id) === String(identifier)
        || String(doc.public_id) === String(identifier));
    if (!selected) throw Object.assign(new Error('consent_document_not_found'), { statusCode: 404 });
    await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
        await lockConsentPackages([packageRow.id], transaction);
        await requireCurrentActiveConsentPackage(packageRow.id, transaction);
        const current = await db.PatientConsentDocument.findByPk(selected.id, { transaction, lock: transaction.LOCK.UPDATE });
        const doc = getPlain(current);
        if (!doc || Number(doc.package_id) !== Number(packageRow.id)
            || Number(doc.paciente_id) !== Number(packageRow.paciente_id)
            || Number(doc.clinica_id) !== Number(packageRow.clinica_id)) {
            throw Object.assign(new Error('consent_document_not_found'), { statusCode: 404 });
        }
        if (!DOCUMENT_PENDING_STATUSES.has(doc.status) || doc.signed_at || doc.revoked_at) {
            throw Object.assign(new Error('El documento ya está cerrado y no se puede modificar.'), {
                statusCode: 409, code: 'consent_document_already_closed', details: { reason_code: 'consent_document_already_closed' },
            });
        }
        if (doc.expires_at && new Date(doc.expires_at).getTime() <= Date.now()) {
            throw Object.assign(new Error('El documento ha caducado. Solicita uno nuevo en recepción.'), {
                statusCode: 410, code: 'consent_document_expired', details: { reason_code: 'consent_document_expired' },
            });
        }
        const corrected = consentDocumentPersonalData.correctedSnapshot({ ...doc, clinica: getPlain(packageRow).clinica }, payload, requestMeta);
        const [changed] = await db.PatientConsentDocument.update(corrected, { transaction, where: {
            id: doc.id, package_id: packageRow.id, paciente_id: packageRow.paciente_id, clinica_id: packageRow.clinica_id,
            status: doc.status, signed_at: null, revoked_at: null, snapshot_hash: payload.snapshot_hash,
        } });
        if (changed !== 1) throw Object.assign(new Error('El documento ha cambiado. Vuelve a abrirlo antes de guardar los datos.'), {
            statusCode: 409, code: 'consent_personal_data_changed', details: { reason_code: 'consent_personal_data_changed' },
        });
        await db.ConsentDeliveryEvent.create({ package_id: packageRow.id, patient_consent_document_id: doc.id,
            channel: token.channel || 'tablet', status: 'viewed', recipient: null,
            event_payload: { event: 'document_personal_data_confirmed', schema_version: consentDocumentPersonalData.SCHEMA_VERSION,
                previous_snapshot_hash: doc.snapshot_hash, snapshot_hash: corrected.snapshot_hash, profile_updated: false },
        }, { transaction });
    });
    const refreshed = await getPackageWithDocumentsById(packageRow.id);
    return { ...(await serializePublicPackage(refreshed)), intake: await require('./patientIntake.service').publicView(refreshed) };
}

async function findDocumentByIdentifier(identifier) {
    const value = toCleanString(identifier);
    if (!value) return null;
    if (/^\d+$/.test(value)) return db.PatientConsentDocument.findByPk(Number(value), {
        include: [
            { model: db.ConsentSignaturePackage, as: 'package', required: false },
            { model: db.Paciente, as: 'paciente', required: false },
            { model: db.Clinica, as: 'clinica', required: false },
            { model: db.Tratamiento, as: 'tratamiento', required: false },
        ],
    });
    return db.PatientConsentDocument.findOne({
        where: { public_id: value },
        include: [
            { model: db.ConsentSignaturePackage, as: 'package', required: false },
            { model: db.Paciente, as: 'paciente', required: false },
            { model: db.Clinica, as: 'clinica', required: false },
            { model: db.Tratamiento, as: 'tratamiento', required: false },
        ],
    });
}

async function signConsentDocument(identifier, payload = {}, requestMeta = {}, options = {}) {
    const doc = await findDocumentByIdentifier(identifier);
    if (!doc) {
        const err = new Error('consent_document_not_found');
        err.statusCode = 404;
        throw err;
    }
    const plainDoc = getPlain(doc);
    if (DOCUMENT_CLOSED_STATUSES.has(plainDoc.status) || (plainDoc.expires_at && new Date(plainDoc.expires_at).getTime() <= Date.now())) {
        const err = new Error('consent_document_already_closed');
        err.statusCode = 409;
        throw err;
    }
    const evidence = normalizeSignatureEvidence(payload, requestMeta);
    requireSignatureEvidence(evidence, plainDoc);
    consentDocumentChoices.validateDocumentChoiceMap(payload, [plainDoc]);
    consentDocumentPersonalData.validateSnapshotMap(payload, [plainDoc]);
    consentDocumentPersonalData.assertReadyToSign(plainDoc, payload);
    documentBlocks.validateAnswerMap(payload, [plainDoc]);
    const blockAnswers = documentBlocks.answerEvidence(plainDoc, payload);
    const choiceEvidence = consentDocumentChoices.documentChoiceEvidence(plainDoc, payload);
    if (choiceEvidence) evidence.consent_choices = choiceEvidence;
    if (plainDoc.package) requireActiveConsentPackage(plainDoc.package);
    if (requiresRepresentative(plainDoc) && evidence.signer_role !== 'representative') {
        const err = new Error('representative_signature_required');
        err.statusCode = 400;
        throw err;
    }
    const snapshot = plainDoc.snapshot_json && typeof plainDoc.snapshot_json === 'object' ? plainDoc.snapshot_json : {};
    const nextSnapshot = {
        ...snapshot,
        ...(blockAnswers ? { document_block_answers: blockAnswers } : {}),
        ...(choiceEvidence ? { integrity: { algorithm: consentDocumentChoices.CHOICE_HASH_ALGORITHM } } : {}),
        signature_evidence: evidence,
        signed_copy: {
            signed_at: evidence.signed_at,
            snapshot_hash_before_signature: plainDoc.snapshot_hash || null,
        },
    };
    const signedHtml = documentBlocks.renderVersion(snapshot.version, snapshot.context,
        { answers: blockAnswers?.answers || {}, choiceEvidence })
        ?? consentDocumentChoices.appendSignedChoiceHtml(plainDoc.snapshot_html || '', plainDoc, choiceEvidence);
    const nextHash = hashRenderedSnapshot(nextSnapshot, signedHtml);
    const signedValues = {
        status: 'signed',
        signed_at: new Date(evidence.signed_at),
        signed_by_patient_id: evidence.signer_role === 'patient' ? plainDoc.paciente_id : null,
        signed_by_representative_id: toIntOrNull(payload.representative_id ?? payload.representante_id),
        channel: evidence.method === 'tablet_signature' ? 'tablet' : (plainDoc.channel || 'internal'),
        delivery_status: 'signed',
        snapshot_json: nextSnapshot,
        ...(choiceEvidence || documentBlocks.documentBlocks(plainDoc) ? { snapshot_html: signedHtml } : {}),
        snapshot_hash: nextHash,
    };
    const executeSignature = async transaction => {
        const profileSync = require('./patientPrivacyProfile.service');
        if (!options.profileAnchorsLocked && consentDocumentPersonalData.isIdentityDocument(plainDoc)) {
            await profileSync.lockAutofillAnchors({ db, documents: [plainDoc], transaction });
        }
        const reusableOptions = reusableDocumentOptions(plainDoc);
        const candidates = options.reusableCandidates !== undefined ? options.reusableCandidates
            : reusableOptions ? await pendingReusableConsentCandidates(reusableOptions, transaction) : [];
        await lockConsentPackages([plainDoc.package_id, ...candidates.map(row => row.package_id)], transaction);
        // The package displayed by the tablet may have been cancelled or
        // expired while evidence was captured. Recheck its current lifecycle
        // under the package anchor before any document, event or count write.
        if (plainDoc.package_id) await requireCurrentActiveConsentPackage(plainDoc.package_id, transaction);
        const locked = getPlain(await db.PatientConsentDocument.findByPk(plainDoc.id,
            { transaction, lock: transaction.LOCK?.UPDATE }));
        if (!locked || ['id', 'package_id', 'paciente_id', 'clinica_id', 'status', 'snapshot_hash']
            .some(key => String(locked[key] ?? '') !== String(plainDoc[key] ?? ''))
            || locked.signed_at || locked.revoked_at) {
            throw Object.assign(new Error('consent_document_signature_conflict'), { statusCode: 409 });
        }
        if (locked.expires_at && new Date(locked.expires_at).getTime() <= Date.now()) {
            throw Object.assign(new Error('consent_document_expired'), { statusCode: 410 });
        }
        // Identity and guardian rules are checked again on the locked current
        // row. A second editor cannot change them while this signature commits.
        consentDocumentPersonalData.assertReadyToSign(locked, payload);
        documentBlocks.answerEvidence(locked, payload);
        requireSignatureEvidence(evidence, locked);
        // A second device, revocation or countersignature may have changed the
        // document since it was displayed. The captured snapshot hash is the
        // compare-and-swap receipt; never replace a committed signature.
        const [changed] = await db.PatientConsentDocument.update(signedValues, {
            where: { id: plainDoc.id, status: plainDoc.status, signed_at: null,
                revoked_at: plainDoc.revoked_at || null, snapshot_hash: plainDoc.snapshot_hash || null },
            transaction,
        });
        if (changed !== 1) throw Object.assign(new Error('consent_document_signature_conflict'), { statusCode: 409 });
        await db.ConsentDeliveryEvent.create({
            package_id: plainDoc.package_id || null,
            patient_consent_document_id: plainDoc.id,
            channel: evidence.method === 'tablet_signature' ? 'tablet' : (plainDoc.channel || 'internal'),
            status: 'viewed',
            recipient: evidence.signer_name || null,
            event_payload: {
                event: 'document_signed',
                evidence: {
                    ...evidence,
                    signature_data_url: evidence.signature_data_url ? '[captured]' : null,
                },
                snapshot_hash: nextHash,
            },
        }, { transaction });
        if (reusableOptions) await supersedePendingReusableConsents({ ...reusableOptions, candidates, transaction });
        if (plainDoc.package_id) await refreshPackageCounts(plainDoc.package_id, transaction);
        if (plainDoc.purpose === 'data_protection' && consentDocumentPersonalData.isIdentityDocument(plainDoc)) {
            await profileSync.autofillEmptyFromDocument({ db, documentId: plainDoc.id, transaction, anchorsLocked: true });
        }
    };
    if (options.transaction) await executeSignature(options.transaction);
    else await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, executeSignature);
    if (options.transaction) return { ...plainDoc, ...signedValues };
    return findDocumentByIdentifier(plainDoc.id);
}

function documentRequiresProfessionalSignature(documentLike) {
    const doc = getPlain(documentLike);
    const snapshot = doc?.snapshot_json && typeof doc.snapshot_json === 'object' ? doc.snapshot_json : {};
    return !!snapshot?.template?.requires_professional_signature;
}

async function signProfessionalConsentDocument(identifier, payload = {}, userId = null, requestMeta = {}) {
    const doc = await findDocumentByIdentifier(identifier);
    if (!doc) {
        const err = new Error('consent_document_not_found');
        err.statusCode = 404;
        throw err;
    }
    const plainDoc = getPlain(doc);
    if (!documentRequiresProfessionalSignature(plainDoc)) {
        const err = new Error('professional_signature_not_required');
        err.statusCode = 400;
        throw err;
    }
    if ((DOCUMENT_CLOSED_STATUSES.has(plainDoc.status) && plainDoc.status !== 'signed')
        || (plainDoc.expires_at && new Date(plainDoc.expires_at).getTime() <= Date.now())) {
        const err = new Error('consent_document_already_closed');
        err.statusCode = 409;
        throw err;
    }
    const evidence = normalizeProfessionalSignatureEvidence(payload, requestMeta, userId);
    if (plainDoc.professional_signed_at) {
        return findDocumentByIdentifier(plainDoc.id);
    }

    const snapshot = plainDoc.snapshot_json && typeof plainDoc.snapshot_json === 'object' ? plainDoc.snapshot_json : {};
    const nextSnapshot = {
        ...snapshot,
        professional_signature_evidence: evidence,
    };
    const nextHash = hashRenderedSnapshot(nextSnapshot, plainDoc.snapshot_html || '');
    await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
        await lockConsentPackages([plainDoc.package_id], transaction);
        // A patient-signed package is still active for its professional
        // countersignature; cancelled and expired packages are not.
        if (plainDoc.package_id) await requireCurrentActiveConsentPackage(plainDoc.package_id, transaction);
        const [changed] = await db.PatientConsentDocument.update({
            professional_signed_by: evidence.professional_id || null,
            professional_signed_at: new Date(evidence.signed_at),
            snapshot_json: nextSnapshot,
            snapshot_hash: nextHash,
        }, { where: { id: plainDoc.id, status: plainDoc.status,
            professional_signed_at: null, revoked_at: plainDoc.revoked_at || null,
            snapshot_hash: plainDoc.snapshot_hash || null }, transaction });
        if (changed !== 1) throw Object.assign(new Error('consent_document_signature_conflict'), { statusCode: 409 });
        await db.ConsentDeliveryEvent.create({
            package_id: plainDoc.package_id || null,
            patient_consent_document_id: plainDoc.id,
            channel: 'internal',
            status: 'viewed',
            recipient: evidence.professional_name || (evidence.professional_id ? `usuario:${evidence.professional_id}` : 'professional'),
            event_payload: { event: 'professional_signed_document', evidence, snapshot_hash: nextHash },
        }, { transaction });
        if (plainDoc.package_id) await refreshPackageCounts(plainDoc.package_id, transaction);
    });
    return findDocumentByIdentifier(plainDoc.id);
}

async function listProfessionalPendingDocuments(filters = {}, userId = null) {
    const clinicId = toIntOrNull(filters.clinic_id ?? filters.clinica_id);
    const where = {
        status: 'signed',
        professional_signed_at: null,
    };
    if (clinicId) where.clinica_id = clinicId;

    const documents = await db.PatientConsentDocument.findAll({
        where,
        include: [
            { model: db.ConsentSignaturePackage, as: 'package', required: false },
            { model: db.Paciente, as: 'paciente', required: false, attributes: ['id_paciente', 'public_id', 'nombre', 'apellidos'] },
            { model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica', 'configuracion'] },
            { model: db.CitaPaciente, as: 'cita', required: false, attributes: ['id_cita', 'inicio', 'doctor_id'] },
            { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre', 'disciplina'] },
        ],
        order: [['updatedAt', 'DESC']],
        limit: Math.min(toIntOrNull(filters.limit) || 100, 200),
    });

    return documents
        .map(withConsentClinicTime)
        .filter((doc) => documentRequiresProfessionalSignature(doc))
        .filter((doc) => {
            const filterUserId = toIntOrNull(userId);
            if (!filterUserId || !normalizeBoolean(filters.only_mine ?? filters.solo_mios, false)) return true;
            return toIntOrNull(doc.cita?.doctor_id) === filterUserId;
        });
}

async function listClinicPendingPatientDocuments(filters = {}, userId = null) {
    const clinicId = toIntOrNull(filters.clinic_id ?? filters.clinica_id);
    const limit = Math.min(toIntOrNull(filters.limit) || 100, 200);
    const where = {
        status: { [Op.in]: Array.from(DOCUMENT_PENDING_STATUSES) },
    };
    if (clinicId) where.clinica_id = clinicId;

    const documents = await db.PatientConsentDocument.findAll({
        where,
        include: [
            { model: db.ConsentSignaturePackage, as: 'package', required: false },
            { model: db.Paciente, as: 'paciente', required: false, attributes: ['id_paciente', 'public_id', 'nombre', 'apellidos'] },
            { model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica', 'configuracion'] },
            { model: db.CitaPaciente, as: 'cita', required: false, attributes: ['id_cita', 'inicio', 'doctor_id', 'estado'] },
            { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre', 'disciplina'] },
        ],
        order: [['updatedAt', 'DESC']],
        limit,
    });

    return documents
        .map(withConsentClinicTime)
        .filter((doc) => {
            const filterUserId = toIntOrNull(userId);
            if (!filterUserId || !normalizeBoolean(filters.only_mine ?? filters.solo_mios, false)) return true;
            return toIntOrNull(doc.cita?.doctor_id) === filterUserId;
        });
}

async function signPublicPackage(tokenRaw, payload = {}, requestMeta = {}) {
    const token = verifyPackageToken(tokenRaw);
    const packageRow = await getPackageWithDocumentsByPublicId(token.package_public_id);
    if (!packageRow) {
        const err = new Error('consent_package_not_found');
        err.statusCode = 404;
        throw err;
    }
    requireActiveConsentPackage(packageRow);
    const intake = await db.PatientIntakeRequest.findOne({ where: { package_id: packageRow.id } });
    if (intake?.status === 'pending' && await clinicMedicalQuestionnaireEnabled({ db, clinicId: packageRow.clinica_id })) {
        throw Object.assign(new Error('Completa primero tus datos y el formulario de salud.'), { statusCode: 409 });
    }
    const plain = getPlain(packageRow);
    const documents = Array.isArray(plain.documents) ? plain.documents : [];
    const requestedDocumentIds = Array.isArray(payload.document_ids)
        ? new Set(payload.document_ids.map((item) => String(item)))
        : null;
    const pending = documents.filter((doc) => !DOCUMENT_CLOSED_STATUSES.has(doc.status)
        && (!requestedDocumentIds || requestedDocumentIds.has(String(doc.id)) || requestedDocumentIds.has(String(doc.public_id))));
    if (!pending.length) {
        const error = new Error('consent_package_has_no_pending_documents');
        error.statusCode = 409;
        throw error;
    }
    // Validate the whole selected package before recording its first signature.
    consentDocumentChoices.validateDocumentChoiceMap(payload, pending);
    consentDocumentPersonalData.validateSnapshotMap(payload, pending);
    documentBlocks.validateAnswerMap(payload, pending);
    const evidence = normalizeSignatureEvidence(payload, requestMeta);
    for (const doc of pending) {
        requireSignatureEvidence(evidence, doc);
        consentDocumentChoices.documentChoiceEvidence(doc, payload);
        consentDocumentPersonalData.assertReadyToSign(doc, payload);
        documentBlocks.answerEvidence(doc, payload);
        if (doc.expires_at && new Date(doc.expires_at).getTime() <= Date.now()) {
            const error = new Error('consent_document_expired');
            error.statusCode = 410;
            throw error;
        }
    }
    const signed = [];
    // A batch containing identity edits must commit as one operation: a race
    // against a second device cannot leave the earlier documents signed while
    // the changed LOPD fails its final CAS. The outer transaction is reused by
    // each document, including its events and reusable-document supersession.
    const signSelected = async transaction => {
        const candidatesByDocument = new Map();
        if (transaction) {
            await require('./patientPrivacyProfile.service').lockAutofillAnchors({ db, documents: pending, transaction });
            const otherParents = [];
            for (const doc of pending) {
                const reusable = reusableDocumentOptions(doc);
                const candidates = reusable ? await pendingReusableConsentCandidates(reusable, transaction) : [];
                candidatesByDocument.set(doc.id, candidates);
                otherParents.push(...candidates.map(row => row.package_id));
            }
            await lockConsentPackages([...pending.map(doc => doc.package_id), ...otherParents], transaction);
        }
        for (const doc of pending) {
            signed.push(await signConsentDocument(doc.public_id,
                { ...documentBlocks.payloadForDocument(doc, consentDocumentPersonalData.payloadForDocument(doc, consentDocumentChoices.payloadForDocument(doc, payload))),
                    method: payload.method || `${token.channel || 'tablet'}_signature` }, requestMeta,
                { transaction, ...(transaction ? { reusableCandidates: candidatesByDocument.get(doc.id), profileAnchorsLocked: true } : {}) }));
        }
    };
    if (pending.some(doc => consentDocumentPersonalData.isIdentityDocument(doc) || documentBlocks.documentBlocks(doc))) {
        await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, signSelected);
    } else await signSelected(null);
    const refreshed = await getPackageWithDocumentsById(packageRow.id);
    return {
        signed_count: signed.length,
        ...(await serializePublicPackage(refreshed)),
    };
}

// Reception of an explicitly informational document is NOT a signature. The
// capability is frozen into a new version, scoped to the token's package and
// committed atomically with a distinct immutable receipt and CAS hash.
async function completePublicPackage(tokenRaw, payload = {}, requestMeta = {}) {
    const token = verifyPackageToken(tokenRaw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !['document_ids', 'document_snapshot_hashes', 'document_block_answers', 'acknowledged'].includes(key))
        || payload.acknowledged !== true || !Array.isArray(payload.document_ids) || !payload.document_ids.length
        || payload.document_ids.length > 100 || payload.document_ids.some(id => !Number.isSafeInteger(id) || id <= 0)
        || new Set(payload.document_ids).size !== payload.document_ids.length) {
        throw Object.assign(new Error('consent_document_completion_payload_invalid'), { statusCode: 400 });
    }
    const hashes = payload.document_snapshot_hashes;
    if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || Object.keys(hashes).length !== payload.document_ids.length
        || Object.keys(hashes).some(id => !payload.document_ids.includes(Number(id)) || String(Number(id)) !== id || !/^[a-f0-9]{64}$/.test(hashes[id]))) {
        throw Object.assign(new Error('consent_document_completion_payload_invalid'), { statusCode: 400 });
    }
    const packageRow = await getPackageWithDocumentsByPublicId(token.package_public_id);
    if (!packageRow) throw Object.assign(new Error('consent_package_not_found'), { statusCode: 404 });
    requireActiveConsentPackage(packageRow);
    let completedCount = 0;
    await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
        await lockConsentPackages([packageRow.id], transaction);
        const currentPackage = await requireCurrentActiveConsentPackage(packageRow.id, transaction);
        // Fetch ownership afresh while the parent anchor serializes completion
        // with cancellation and signing, rather than trusting a stale join.
        const docs = await db.PatientConsentDocument.findAll({ where: { id: { [Op.in]: payload.document_ids }, package_id: currentPackage.id,
            paciente_id: packageRow.paciente_id, clinica_id: packageRow.clinica_id }, order: [['id', 'ASC']],
            transaction, lock: transaction.LOCK.UPDATE });
        if (docs.length !== payload.document_ids.length) throw Object.assign(new Error('consent_document_completion_scope_invalid'), { statusCode: 404 });
        documentBlocks.validateAnswerMap(payload, docs);
        const updates = [];
        for (const row of docs) {
            const doc = getPlain(row);
            documentCompletion.assertUnsigned(doc);
            if (documentCompletion.isCompleted(doc)) {
                const previous = doc.snapshot_json.completion_evidence.snapshot_hash_before_completion;
                if (![doc.snapshot_hash, previous].includes(hashes[String(doc.id)])) throw Object.assign(new Error('consent_document_completion_changed'), { statusCode: 409 });
                const savedAnswers = doc.snapshot_json.document_block_answers?.answers;
                const repeatedAnswers = payload.document_block_answers?.[String(doc.id)]?.answers;
                if ((savedAnswers || repeatedAnswers) && consentDocumentChoices.choiceSnapshotHash({ answers: savedAnswers }, '')
                    !== consentDocumentChoices.choiceSnapshotHash({ answers: repeatedAnswers }, '')) {
                    throw Object.assign(new Error('consent_document_already_closed'), { statusCode: 409 });
                }
                continue; // The same double-click is an idempotent read.
            }
            updates.push({ doc, values: documentCompletion.completedValues(doc, documentBlocks.payloadForDocument(doc, payload), requestMeta) });
        }
        // Validate every selected document before the first write. Any failure
        // or concurrent change rolls back documents, counts AND delivery events.
        for (const { doc, values } of updates) {
            const [changed] = await db.PatientConsentDocument.update(values, { transaction, where: { id: doc.id,
                package_id: packageRow.id, paciente_id: packageRow.paciente_id, clinica_id: packageRow.clinica_id,
                status: doc.status, signed_at: null, revoked_at: null, snapshot_hash: hashes[String(doc.id)] } });
            if (changed !== 1) throw Object.assign(new Error('consent_document_completion_changed'), { statusCode: 409 });
            await db.ConsentDeliveryEvent.create({ package_id: packageRow.id, patient_consent_document_id: doc.id,
                channel: token.channel || 'tablet', status: 'viewed', recipient: null,
                event_payload: { event: 'document_completed_without_signature', completion_evidence: values.snapshot_json.completion_evidence,
                    snapshot_hash: values.snapshot_hash } }, { transaction });
            completedCount++;
        }
        if (updates.length) await refreshPackageCounts(packageRow.id, transaction);
    });
    return { completed_count: completedCount, ...(await serializePublicPackage(await getPackageWithDocumentsById(packageRow.id))) };
}

async function revokeConsentDocument(identifier, payload = {}, requestMeta = {}) {
    const doc = await findDocumentByIdentifier(identifier);
    if (!doc) {
        const err = new Error('consent_document_not_found');
        err.statusCode = 404;
        throw err;
    }
    const displayed = getPlain(doc);
    await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
        await lockConsentPackages([displayed.package_id], transaction);
        const current = await db.PatientConsentDocument.findByPk(displayed.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!current) throw Object.assign(new Error('consent_document_not_found'), { statusCode: 404 });
        const plainDoc = getPlain(current);
        if (plainDoc.package_id !== displayed.package_id || plainDoc.paciente_id !== displayed.paciente_id || plainDoc.clinica_id !== displayed.clinica_id) {
            throw Object.assign(new Error('consent_document_changed'), { statusCode: 409 });
        }
        if (!['signed', 'completed', 'sent', 'viewed', 'pending'].includes(plainDoc.status) || plainDoc.revoked_at) {
            throw Object.assign(new Error('consent_document_cannot_be_revoked'), { statusCode: 409 });
        }
        // Revocation appends to CURRENT evidence under the document lock. The
        // snapshot first displayed may predate either actual signature.
        const evidence = normalizeRevocationEvidence(payload, requestMeta);
        const snapshot = plainDoc.snapshot_json && typeof plainDoc.snapshot_json === 'object' ? plainDoc.snapshot_json : {};
        const nextSnapshot = { ...snapshot, revocation_evidence: evidence };
        const nextHash = hashRenderedSnapshot(nextSnapshot, plainDoc.snapshot_html || '');
        await current.update({ status: 'revoked', revoked_at: new Date(evidence.revoked_at), snapshot_json: nextSnapshot,
            snapshot_hash: nextHash, delivery_status: 'revoked' }, { transaction });
        await db.ConsentDeliveryEvent.create({
            package_id: plainDoc.package_id || null,
            patient_consent_document_id: plainDoc.id,
            channel: plainDoc.channel || 'internal',
            status: 'viewed',
            recipient: evidence.revoked_by,
            event_payload: { event: 'document_revoked', evidence, snapshot_hash: nextHash },
        }, { transaction });
        if (plainDoc.package_id) await refreshPackageCounts(plainDoc.package_id, transaction);
    });
    return findDocumentByIdentifier(displayed.id);
}

async function renderConsentDocument(identifier) {
    const doc = await findDocumentByIdentifier(identifier);
    if (!doc) {
        const err = new Error('consent_document_not_found');
        err.statusCode = 404;
        throw err;
    }
    return buildPrintableHtml(doc);
}

async function generateConsentDocumentPdf(identifier) {
    const doc = await findDocumentByIdentifier(identifier);
    if (!doc) {
        const err = new Error('consent_document_not_found');
        err.statusCode = 404;
        throw err;
    }
    const html = buildPrintableHtml(doc);
    const plain = getPlain(doc);
    return {
        filename: `${String(plain.public_id || plain.id || 'consentimiento')}.pdf`,
        buffer: await htmlToPdfBuffer(html, plain.public_id || plain.id || 'consentimiento'),
    };
}

async function getConsentDocument(identifier) {
    const doc = await findDocumentByIdentifier(identifier);
    if (!doc) {
        const err = new Error('consent_document_not_found');
        err.statusCode = 404;
        throw err;
    }
    return { ...withConsentClinicTime(doc), ...documentCompletion.publicFields(doc) };
}

async function ensurePackageForAppointment(citaIdRaw, options = {}) {
    try {
        const packageRow = await createPackageForAppointment(citaIdRaw, options);
        const summary = await getConsentSummaryForAppointment(getPlain(packageRow)?.cita || await findAppointment(citaIdRaw));
        return { package: packageRow, summary, created_or_existing: true };
    } catch (error) {
        if (error?.message === 'appointment_has_no_consent_requirements') {
            return { package: null, summary: null, created_or_existing: false, reason: error.message };
        }
        throw error;
    }
}

async function exportPatientConsentAudit(identifier, filters = {}) {
    const response = await listPatientDocuments(identifier, filters);
    const documents = response.items || [];
    const documentIds = documents.map((doc) => doc.id);
    const events = documentIds.length
        ? await db.ConsentDeliveryEvent.findAll({
            where: { patient_consent_document_id: { [Op.in]: documentIds } },
            order: [['createdAt', 'ASC']],
        })
        : [];
    return {
        paciente: response.paciente,
        summary: response.summary,
        documents: documents.map((doc) => {
            const plain = getPlain(doc);
            return {
                id: plain.id,
                public_id: plain.public_id,
                title: plain.title,
                status: plain.status,
                purpose: plain.purpose,
                required: plain.required,
                snapshot_hash: plain.snapshot_hash,
                signed_at: plain.signed_at || null,
                revoked_at: plain.revoked_at || null,
                createdAt: plain.createdAt,
                updatedAt: plain.updatedAt,
            };
        }),
        events: events.map((event) => getPlain(event)),
    };
}

module.exports = {
    resolveActivePublicPackage,
    refreshPackageCounts,
    listAdminTemplates,
    createAdminTemplate,
    updateAdminTemplate,
    propagateAdminTemplateToClinics,
    listClinicTemplates,
    createClinicTemplate,
    updateClinicTemplate,
    syncClinicTemplatesFromCatalog,
    getTreatmentRequirements,
    saveTreatmentRequirements,
    listPatientDocuments,
    listPatientExternalAttestations,
    createPatientExternalAttestation,
    revokePatientExternalAttestation,
    listPatientTreatmentsWithoutConsentRequirements,
    getConsentSummaryForAppointment,
    attachConsentSummaryToCitas,
    createPackageForAppointment,
    prepareAutomationPackageContext,
    createPatientIntakePackage,
    ensurePackageForAppointment,
    sendPackageMock,
    createTabletSession,
    getClinicKioskAccess,
    createClinicKioskAccess,
    regenerateClinicKioskAccess,
    updateClinicKioskScope,
    resetClinicKioskAccess,
    loginTabletKiosk,
    getTabletKioskSession,
    listTabletKioskPackages,
    createTabletSessionForKiosk,
    createTabletBudgetSignatureSessionForKiosk,
    getPublicPackage,
    updatePublicDocumentPersonalData,
    signPublicPackage,
    completePublicPackage,
    getConsentDocument,
    renderConsentDocument,
    generateConsentDocumentPdf,
    signConsentDocument,
    signProfessionalConsentDocument,
    listProfessionalPendingDocuments,
    listClinicPendingPatientDocuments,
    revokeConsentDocument,
    exportPatientConsentAudit,
};
