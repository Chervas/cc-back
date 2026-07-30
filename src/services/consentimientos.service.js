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
const { Op } = db.Sequelize;
const execFileAsync = promisify(execFile);

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
const DOCUMENT_CLOSED_STATUSES = new Set(['signed', 'rejected', 'revoked', 'expired', 'cancelled', 'superseded', 'voided']);
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

async function generateUniquePublicId(model, prefix) {
    for (let i = 0; i < 8; i += 1) {
        const publicId = generatePublicId(prefix);
        const existing = await model.findOne({ where: { public_id: publicId }, attributes: ['id'], raw: true });
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
    return {
        version: toIntOrNull(payload.version) || fallback.version || 1,
        locale: toCleanString(payload.locale ?? payload.idioma) || fallback.locale || 'es',
        title: toCleanString(payload.title ?? payload.titulo) || fallback.title || toCleanString(payload.name ?? payload.nombre) || 'Consentimiento',
        body_json: payload.body_json ?? payload.contenido_json ?? fallback.body_json ?? null,
        body_html: toCleanString(payload.body_html ?? payload.contenido_html) ?? fallback.body_html ?? null,
        variable_schema: payload.variable_schema ?? payload.variables ?? fallback.variable_schema ?? null,
        status: normalizeEnum(payload.version_status ?? payload.status_version ?? payload.estado_version, VERSION_STATUS_VALUES, fallback.status || 'published'),
        published_at: payload.published_at ?? fallback.published_at ?? new Date(),
    };
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

function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function buildTemplateContext({ paciente, clinica, tratamiento, cita, profesional } = {}) {
    const patientName = [paciente?.nombre, paciente?.apellidos].filter(Boolean).join(' ').trim();
    const professionalName = [profesional?.nombre, profesional?.apellidos].filter(Boolean).join(' ').trim();
    return {
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
            fecha_nacimiento: paciente?.fecha_nacimiento || null,
        },
        clinica: {
            id: clinica?.id_clinica || clinica?.id || null,
            nombre: clinica?.nombre_clinica || clinica?.nombre || '',
            email: clinica?.email || '',
            telefono: clinica?.telefono_whatsapp || clinica?.telefono_movil || clinica?.telefono || '',
            direccion: clinica?.direccion || '',
        },
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
            fecha: formatDateTime(cita?.inicio),
        },
        profesional: {
            id: profesional?.id_usuario || profesional?.id || null,
            nombre: professionalName || profesional?.nombre || '',
            email: profesional?.email_usuario || profesional?.email || '',
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

function getDocumentAssetBaseUrl() {
    return (toCleanString(process.env.CONSENT_DOCUMENT_ASSET_BASE_URL)
        || toCleanString(process.env.FRONTEND_PUBLIC_URL)
        || toCleanString(process.env.FRONTEND_URL)
        || 'http://localhost:4203').replace(/\/+$/, '');
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

function isMinorPatient(paciente) {
    const birthValue = paciente?.fecha_nacimiento;
    if (!birthValue) return false;
    const birth = new Date(birthValue);
    if (!Number.isFinite(birth.getTime())) return false;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDelta = today.getMonth() - birth.getMonth();
    if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birth.getDate())) age -= 1;
    return age < 18;
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
        accepted_statement: normalizeBoolean(payload.accepted_statement ?? payload.declaracion_aceptada, true),
        signature_data_url: signatureDataUrl && signatureDataUrl.length < 250000 ? signatureDataUrl : null,
        signed_at: new Date().toISOString(),
        ip: toCleanString(requestMeta.ip),
        user_agent: toCleanString(requestMeta.userAgent),
        device_label: toCleanString(payload.device_label ?? payload.dispositivo),
    };
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
    return {
        method: toCleanString(payload.method ?? payload.metodo) || 'professional_confirmation',
        professional_id: toIntOrNull(payload.professional_id ?? payload.profesional_id) || toIntOrNull(userId),
        professional_name: toCleanString(payload.professional_name ?? payload.nombre_profesional),
        accepted_statement: normalizeBoolean(payload.accepted_statement ?? payload.declaracion_aceptada, true),
        signed_at: new Date().toISOString(),
        ip: toCleanString(requestMeta.ip),
        user_agent: toCleanString(requestMeta.userAgent),
    };
}

function buildPrintableHtml(documentRow) {
    const doc = getPlain(documentRow);
    const snapshot = doc.snapshot_json && typeof doc.snapshot_json === 'object' ? doc.snapshot_json : {};
    const evidence = snapshot.signature_evidence || null;
    const professionalEvidence = snapshot.professional_signature_evidence || null;
    const revocation = snapshot.revocation_evidence || null;
    const patient = snapshot.context?.paciente || {};
    const clinic = snapshot.context?.clinica || {};
    const treatment = snapshot.context?.tratamiento || {};
    const appointment = snapshot.context?.cita || {};
    const professional = snapshot.context?.profesional || {};
    const safeHtml = doc.snapshot_html || '';
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
        revoked: 'Revocado',
        rejected: 'Rechazado',
        expired: 'Caducado',
        cancelled: 'Cancelado',
        superseded: 'Sustituido',
        voided: 'Anulado',
    }[status] || status || 'Sin estado');
    const brandLogo = `<img class="brand-logo" alt="ClinicaClick" src="${escapeHtml(getDocumentAssetBaseUrl())}/assets/images/logo/logo-text-on-dark.svg" />`;
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
                    <div><dt>Fecha</dt><dd>${escapeHtml(formatDateTime(evidence.signed_at || doc.signed_at))}</dd></div>
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
                <div><dt>Fecha</dt><dd>${escapeHtml(formatDateTime(professionalEvidence.signed_at || doc.professional_signed_at))}</dd></div>
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
            <p>Revocado el ${escapeHtml(formatDateTime(revocation.revoked_at || doc.revoked_at))}. Motivo: ${escapeHtml(revocation.reason || 'No indicado')}.</p>
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
    .content h1, .content h2 { margin: 24px 0 10px; }
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
          <div class="document-kicker">Consentimiento informado</div>
          <div class="document-title">CONSENTIMIENTO</div>
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
    <h1>${escapeHtml(doc.title || 'Consentimiento')}</h1>
    <section class="content">${safeHtml}</section>
    ${signatureBlock}
    ${professionalSignatureBlock}
    ${revocationBlock}
    <footer>
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

async function getLatestCatalogVersion(catalogId, locale = 'es') {
    return db.ConsentTemplateCatalogVersion.findOne({
        where: {
            catalog_id: catalogId,
            locale,
            status: { [Op.in]: ['published', 'draft'] },
        },
        order: [['version', 'DESC'], ['id', 'DESC']],
    });
}

async function getLatestClinicVersion(templateId, locale = 'es') {
    return db.ClinicConsentTemplateVersion.findOne({
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

async function getTreatmentRequirements({ tratamientoId, clinicaId = null }) {
    const parsedTreatmentId = toIntOrNull(tratamientoId);
    if (!parsedTreatmentId) return [];
    const where = { tratamiento_id: parsedTreatmentId };
    const parsedClinicId = toIntOrNull(clinicaId);
    if (parsedClinicId) {
        where[Op.or] = [{ clinica_id: parsedClinicId }, { clinica_id: null }];
    }
    return db.TreatmentConsentRequirement.findAll({
        where,
        include: [
            { model: db.ClinicConsentTemplate, as: 'clinicTemplate', required: false, include: [{ model: db.ClinicConsentTemplateVersion, as: 'versions', required: false }] },
            { model: db.ConsentTemplateCatalog, as: 'catalogTemplate', required: false, include: [{ model: db.ConsentTemplateCatalogVersion, as: 'versions', required: false }] },
        ],
        order: [['sort_order', 'ASC'], ['id', 'ASC']],
    });
}

async function saveTreatmentRequirements(tratamientoIdRaw, payload = {}) {
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

    await db.TreatmentConsentRequirement.destroy({
        where: {
            tratamiento_id: tratamientoId,
            clinica_id: clinicId || null,
        },
    });
    if (normalized.length) {
        await db.TreatmentConsentRequirement.bulkCreate(normalized);
    }
    return getTreatmentRequirements({ tratamientoId, clinicaId });
}

async function findAppointment(citaIdRaw) {
    const citaId = toIntOrNull(citaIdRaw);
    if (!citaId) return null;
    return db.CitaPaciente.findByPk(citaId, {
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

async function resolveRequirementTemplate(requirement) {
    const plain = getPlain(requirement);
    if (plain.clinicTemplate) {
        const version = pickLatestVersion(plain.clinicTemplate.versions) || await getLatestClinicVersion(plain.clinicTemplate.id, 'es');
        return {
            source: 'clinic',
            template: plain.clinicTemplate,
            version: getPlain(version),
        };
    }
    if (plain.catalogTemplate) {
        const version = pickLatestVersion(plain.catalogTemplate.versions) || await getLatestCatalogVersion(plain.catalogTemplate.id, 'es');
        return {
            source: 'catalog',
            template: plain.catalogTemplate,
            version: getPlain(version),
        };
    }
    return null;
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

async function findSignedReusableConsent({ pacienteId, clinicaId, resolved }) {
    if (!pacienteId || !clinicaId || !resolved?.template || !isReusableSignedConsentTemplate(resolved.template)) {
        return null;
    }
    return db.PatientConsentDocument.findOne({
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

async function supersedePendingReusableConsents({ pacienteId, clinicaId, resolved, exceptId = null }) {
    if (!pacienteId || !clinicaId || !resolved?.template || !isReusableSignedConsentTemplate(resolved.template)) {
        return;
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
    await db.PatientConsentDocument.update(
        { status: 'superseded', delivery_status: 'superseded' },
        { where }
    );
}

function isReusableSignedConsentDocument(documentLike) {
    const doc = getPlain(documentLike);
    const snapshot = doc?.snapshot_json && typeof doc.snapshot_json === 'object' ? doc.snapshot_json : {};
    return isReusableSignedConsentTemplate({
        purpose: doc?.purpose || snapshot?.template?.purpose,
        validity_mode: snapshot?.template?.validity_mode,
    });
}

async function supersedePendingReusableConsentDocuments(documentLike) {
    const doc = getPlain(documentLike);
    if (!doc?.id || !doc?.paciente_id || !doc?.clinica_id || !isReusableSignedConsentDocument(doc)) {
        return;
    }
    const where = {
        paciente_id: doc.paciente_id,
        clinica_id: doc.clinica_id,
        status: { [Op.in]: Array.from(DOCUMENT_PENDING_STATUSES) },
        purpose: doc.purpose || 'data_protection',
        id: { [Op.ne]: doc.id },
    };
    if (doc.clinic_template_id) {
        where.clinic_template_id = doc.clinic_template_id;
    } else if (doc.catalog_template_id) {
        where.catalog_template_id = doc.catalog_template_id;
    } else {
        return;
    }

    const affected = await db.PatientConsentDocument.findAll({
        where,
        attributes: ['id', 'package_id'],
        raw: true,
    });
    if (!affected.length) return;

    await db.PatientConsentDocument.update(
        { status: 'superseded', delivery_status: 'superseded' },
        { where: { id: affected.map((item) => item.id) } }
    );

    const packageIds = Array.from(new Set(affected.map((item) => toIntOrNull(item.package_id)).filter(Boolean)));
    await Promise.all(packageIds.map((packageId) => refreshPackageCounts(packageId)));
}

async function resolveRequirementsForAppointment(citaLike) {
    const plain = getPlain(citaLike);
    const tratamientoId = toIntOrNull(plain?.tratamiento_id || plain?.tratamiento?.id_tratamiento);
    const clinicId = toIntOrNull(plain?.clinica_id || plain?.clinica?.id_clinica);
    if (!tratamientoId || !clinicId) return [];
    const directRequirements = await getTreatmentRequirements({ tratamientoId, clinicaId: clinicId });
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
            { model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica'] },
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
        items: documents,
        legacy_items: legacyItems,
        summary: summarizeDocuments(documents),
    };
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

function summarizeDocuments(documents = [], missingRequired = 0, missingOptional = 0) {
    const items = documents.map(getPlain);
    const requiredItems = items.filter((item) => item.required);
    const optionalItems = items.filter((item) => !item.required);
    const signedRequired = requiredItems.filter((item) => item.status === 'signed').length;
    const pendingRequired = requiredItems.filter((item) => DOCUMENT_PENDING_STATUSES.has(item.status)).length + missingRequired;
    const pendingOptional = optionalItems.filter((item) => DOCUMENT_PENDING_STATUSES.has(item.status)).length + missingOptional;
    const blockingPending = requiredItems.filter((item) => item.blocking_policy === 'hard' && DOCUMENT_PENDING_STATUSES.has(item.status)).length + missingRequired;
    return {
        status: pendingRequired > 0 ? 'pending' : 'ok',
        required_total: requiredItems.length + missingRequired,
        signed_required: signedRequired,
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
            tratamiento_id: cita.tratamiento_id,
            status: { [Op.notIn]: ['cancelled', 'voided', 'superseded'] },
        },
        include: [{ model: db.ConsentSignaturePackage, as: 'package', required: false }],
    });

    const existingKeys = new Set(documents.map((doc) => {
        const plain = getPlain(doc);
        return plain.clinic_template_id ? `clinic:${plain.clinic_template_id}` : `catalog:${plain.catalog_template_id}`;
    }));
    let missingRequired = 0;
    let missingOptional = 0;
    const signingPolicies = [];
    for (const requirement of requirements) {
        const plain = getPlain(requirement);
        const key = plain.clinic_template_id ? `clinic:${plain.clinic_template_id}` : `catalog:${plain.catalog_template_id}`;
        const resolved = await resolveRequirementTemplate(requirement);
        if (resolved?.template && resolved?.version) {
            signingPolicies.push(getSigningPolicyFromVersion(resolved.version, resolved.template));
        }
        if (existingKeys.has(key)) continue;
        if (plain.required) missingRequired += 1;
        else missingOptional += 1;
    }
    const summary = summarizeDocuments(documents, missingRequired, missingOptional);
    const packageRow = documents.map((doc) => getPlain(doc).package).find(Boolean) || null;
    const signingPolicy = pickSigningPolicy(signingPolicies);
    return {
        ...summary,
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
    await Promise.all(list.map(async (cita) => {
        try {
            const summary = await getConsentSummaryForAppointment(cita);
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

async function createPackageForAppointment(citaIdRaw, options = {}) {
    const cita = await findAppointment(citaIdRaw);
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

    const requirements = await resolveRequirementsForAppointment(cita);
    if (!requirements.length) {
        const err = new Error('appointment_has_no_consent_requirements');
        err.statusCode = 400;
        throw err;
    }

    let packageRow = await db.ConsentSignaturePackage.findOne({
        where: {
            cita_id: plainCita.id_cita,
            paciente_id: plainCita.paciente_id,
            clinica_id: plainCita.clinica_id,
            tratamiento_id: plainCita.tratamiento_id,
            status: { [Op.notIn]: ['cancelled', 'expired'] },
        },
    });
    if (!packageRow) {
        const appointmentStart = plainCita.inicio ? new Date(plainCita.inicio) : null;
        const dueAt = appointmentStart && Number.isFinite(appointmentStart.getTime()) ? appointmentStart : null;
        const expiresAt = dueAt ? new Date(dueAt.getTime() + 30 * 24 * 60 * 60 * 1000) : addHours(new Date(), 24 * 30);
        packageRow = await db.ConsentSignaturePackage.create({
            public_id: await generateUniquePublicId(db.ConsentSignaturePackage, 'cpkg'),
            paciente_id: plainCita.paciente_id,
            clinica_id: plainCita.clinica_id,
            cita_id: plainCita.id_cita,
            tratamiento_id: plainCita.tratamiento_id,
            status: 'pending',
            due_at: dueAt,
            expires_at: expiresAt,
            trigger_source: toCleanString(options.triggerSource) || 'manual',
            created_by: toIntOrNull(options.createdBy),
        });
    }

    const context = buildTemplateContext({
        paciente: plainCita.paciente,
        clinica: plainCita.clinica,
        tratamiento: plainCita.tratamiento,
        cita: plainCita,
        profesional: plainCita.doctor,
    });

    for (const requirement of requirements) {
        const plainRequirement = getPlain(requirement);
        const resolved = await resolveRequirementTemplate(requirement);
        if (!resolved?.template || !resolved?.version) continue;

        const signedReusable = await findSignedReusableConsent({
            pacienteId: plainCita.paciente_id,
            clinicaId: plainCita.clinica_id,
            resolved,
        });
        if (signedReusable) {
            await supersedePendingReusableConsents({
                pacienteId: plainCita.paciente_id,
                clinicaId: plainCita.clinica_id,
                resolved,
                exceptId: signedReusable.id,
            });
            continue;
        }

        const existingWhere = {
            package_id: packageRow.id,
            paciente_id: plainCita.paciente_id,
            cita_id: plainCita.id_cita,
            tratamiento_id: plainCita.tratamiento_id,
            status: { [Op.notIn]: ['cancelled', 'voided', 'superseded'] },
        };
        if (plainRequirement.clinic_template_id) {
            existingWhere.clinic_template_id = plainRequirement.clinic_template_id;
        } else {
            existingWhere.catalog_template_id = plainRequirement.catalog_template_id;
        }
        const existing = await db.PatientConsentDocument.findOne({ where: existingWhere });
        if (existing && !DOCUMENT_CLOSED_STATUSES.has(existing.status)) continue;

        const title = resolved.version.title || resolved.template.name;
        const renderedHtml = renderTemplateHtml(resolved.version.body_html || buildDefaultBodyHtml(title), context);
        const signingPolicy = getSigningPolicyFromVersion(resolved.version, resolved.template);
        const snapshot = {
            template_source: resolved.source,
            template: {
                id: resolved.template.id,
                public_id: resolved.template.public_id || null,
                name: resolved.template.name,
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
                variable_schema: resolved.version.variable_schema || null,
            },
            context,
            patient_flags: {
                is_minor: isMinorPatient(plainCita.paciente),
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
            public_id: await generateUniquePublicId(db.PatientConsentDocument, 'cdoc'),
            package_id: packageRow.id,
            paciente_id: plainCita.paciente_id,
            clinica_id: plainCita.clinica_id,
            cita_id: plainCita.id_cita,
            tratamiento_id: plainCita.tratamiento_id,
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
            snapshot_hash: hashSnapshot({ ...snapshot, rendered_html: renderedHtml }),
            expires_at: packageRow.expires_at || null,
        });
    }

    await refreshPackageCounts(packageRow.id);
    return db.ConsentSignaturePackage.findByPk(packageRow.id, {
        include: [
            { model: db.PatientConsentDocument, as: 'documents', required: false },
            { model: db.Paciente, as: 'paciente', required: false },
            { model: db.Tratamiento, as: 'tratamiento', required: false },
        ],
    });
}

async function refreshPackageCounts(packageIdRaw) {
    const packageId = toIntOrNull(packageIdRaw);
    if (!packageId) return null;
    const documents = await db.PatientConsentDocument.findAll({
        where: { package_id: packageId, status: { [Op.notIn]: ['cancelled', 'voided', 'superseded'] } },
        raw: true,
    });
    const requiredCount = documents.filter((doc) => !!doc.required).length;
    const signedCount = documents.filter((doc) => !!doc.required && doc.status === 'signed').length;
    const pending = documents.some((doc) => DOCUMENT_PENDING_STATUSES.has(doc.status));
    const status = requiredCount > 0 && signedCount >= requiredCount ? 'signed' : (pending ? 'pending' : 'draft');
    await db.ConsentSignaturePackage.update(
        { required_count: requiredCount, signed_count: signedCount, status },
        { where: { id: packageId } }
    );
    return { required_count: requiredCount, signed_count: signedCount, status };
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
    if (!pendingDocuments.length) {
        const err = new Error('consent_package_has_no_pending_documents');
        err.statusCode = 409;
        throw err;
    }
    for (const doc of pendingDocuments) {
        const plainDoc = getPlain(doc);
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
        });
        await doc.update({ status: documentStatus, channel, delivery_status: eventStatus });
    }
    await packageRow.update({ status: channel === 'tablet' ? 'viewed' : 'sent' });
    await refreshPackageCounts(packageRow.id);
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
            { model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica'] },
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
            { model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica'] },
            { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre', 'disciplina'] },
        ],
    });
}

async function createTabletSession(packageIdRaw, payload = {}) {
    const packageRow = await getPackageWithDocumentsById(packageIdRaw);
    if (!packageRow) {
        const err = new Error('consent_package_not_found');
        err.statusCode = 404;
        throw err;
    }
    const token = signPackageToken(packageRow, {
        channel: 'tablet',
        ttlHours: payload.ttl_hours ?? payload.validez_horas ?? 12,
    });
    const publicUrl = buildPublicConsentUrl(token, payload.base_url ?? payload.baseUrl);
    const documents = Array.isArray(packageRow.documents) ? packageRow.documents : [];
    const pendingDocuments = documents.filter((doc) => DOCUMENT_PENDING_STATUSES.has(getPlain(doc).status));
    if (!pendingDocuments.length) {
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
        include: [{ model: db.Clinica, as: 'clinic', required: false, attributes: ['id_clinica', 'nombre_clinica', 'url_avatar'] }],
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
        clinic: {
            id_clinica: kiosk.clinic?.id_clinica || kiosk.clinic_id,
            nombre_clinica: kiosk.clinic?.nombre_clinica || '',
            url_avatar: kiosk.clinic?.url_avatar || null,
        },
    };
}

async function requireKioskSession(tokenRaw) {
    const payload = verifyKioskToken(tokenRaw);
    const kiosk = await db.ClinicTabletKiosk.findOne({
        where: { id: payload.kiosk_id, clinic_id: payload.clinic_id, status: 'active' },
        include: [{ model: db.Clinica, as: 'clinic', required: false, attributes: ['id_clinica', 'nombre_clinica', 'url_avatar'] }],
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
        clinic: {
            id_clinica: kiosk.clinic?.id_clinica || kiosk.clinic_id,
            nombre_clinica: kiosk.clinic?.nombre_clinica || '',
            url_avatar: kiosk.clinic?.url_avatar || null,
        },
    };
}

function serializeKioskPackage(packageRow) {
    const plain = getPlain(packageRow);
    const documents = Array.isArray(plain.documents) ? plain.documents : [];
    const patientName = [plain.paciente?.nombre, plain.paciente?.apellidos].filter(Boolean).join(' ').trim();
    const pendingDocuments = documents.filter((doc) => DOCUMENT_PENDING_STATUSES.has(doc.status));
    const blockingPending = pendingDocuments.filter((doc) => doc.required && doc.blocking_policy === 'hard').length;
    return {
        id: plain.id,
        public_id: plain.public_id,
        status: plain.status,
        due_at: plain.due_at || null,
        expires_at: plain.expires_at || null,
        required_count: plain.required_count,
        signed_count: plain.signed_count,
        pending_count: pendingDocuments.length,
        blocking_pending: blockingPending,
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
    const limit = Math.min(toIntOrNull(filters.limit) || 80, 150);
    const q = toCleanString(filters.q)?.toLowerCase() || null;
    const packageRows = await db.ConsentSignaturePackage.findAll({
        where: {
            clinica_id: kiosk.clinic_id,
            status: { [Op.in]: ['pending', 'sent', 'viewed'] },
            [Op.or]: [
                { expires_at: null },
                { expires_at: { [Op.gt]: new Date() } },
            ],
        },
        include: [
            { model: db.PatientConsentDocument, as: 'documents', required: true },
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
        .filter((item) => item.pending_count > 0)
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
    if (Number(packageRow.clinica_id) !== Number(kiosk.clinic_id)) {
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

function serializePublicPackage(packageRow) {
    const plain = getPlain(packageRow);
    const documents = Array.isArray(plain.documents) ? plain.documents : [];
    const patientName = [plain.paciente?.nombre, plain.paciente?.apellidos].filter(Boolean).join(' ').trim();
    return {
        package: {
            id: plain.id,
            public_id: plain.public_id,
            status: plain.status,
            required_count: plain.required_count,
            signed_count: plain.signed_count,
            due_at: plain.due_at || null,
            expires_at: plain.expires_at || null,
        },
        paciente: {
            nombre_completo: patientName || plain.paciente?.nombre || '',
        },
        clinica: {
            nombre: plain.clinica?.nombre_clinica || '',
        },
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
        })),
    };
}

async function getPublicPackage(tokenRaw, requestMeta = {}) {
    const token = verifyPackageToken(tokenRaw);
    const packageRow = await getPackageWithDocumentsByPublicId(token.package_public_id);
    if (!packageRow) {
        const err = new Error('consent_package_not_found');
        err.statusCode = 404;
        throw err;
    }
    const documents = Array.isArray(packageRow.documents) ? packageRow.documents : [];
    await Promise.all(documents.map(async (doc) => {
        const plainDoc = getPlain(doc);
        if (!DOCUMENT_PENDING_STATUSES.has(plainDoc.status)) return;
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
        });
        await doc.update({ status: 'viewed', channel: token.channel || 'tablet', delivery_status: 'viewed' });
    }));
    await packageRow.update({ status: 'viewed' });
    await refreshPackageCounts(packageRow.id);
    const refreshed = await getPackageWithDocumentsById(packageRow.id);
    return serializePublicPackage(refreshed);
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

async function signConsentDocument(identifier, payload = {}, requestMeta = {}) {
    const doc = await findDocumentByIdentifier(identifier);
    if (!doc) {
        const err = new Error('consent_document_not_found');
        err.statusCode = 404;
        throw err;
    }
    const plainDoc = getPlain(doc);
    if (DOCUMENT_CLOSED_STATUSES.has(plainDoc.status)) {
        const err = new Error('consent_document_already_closed');
        err.statusCode = 409;
        throw err;
    }
    const evidence = normalizeSignatureEvidence(payload, requestMeta);
    if (requiresRepresentative(plainDoc) && evidence.signer_role !== 'representative') {
        const err = new Error('representative_signature_required');
        err.statusCode = 400;
        throw err;
    }
    const snapshot = plainDoc.snapshot_json && typeof plainDoc.snapshot_json === 'object' ? plainDoc.snapshot_json : {};
    const nextSnapshot = {
        ...snapshot,
        signature_evidence: evidence,
        signed_copy: {
            signed_at: evidence.signed_at,
            snapshot_hash_before_signature: plainDoc.snapshot_hash || null,
        },
    };
    const nextHash = hashSnapshot({ ...nextSnapshot, rendered_html: plainDoc.snapshot_html || '' });
    await doc.update({
        status: 'signed',
        signed_at: new Date(evidence.signed_at),
        signed_by_patient_id: evidence.signer_role === 'patient' ? plainDoc.paciente_id : null,
        signed_by_representative_id: toIntOrNull(payload.representative_id ?? payload.representante_id),
        channel: evidence.method === 'tablet_signature' ? 'tablet' : (plainDoc.channel || 'internal'),
        delivery_status: 'signed',
        snapshot_json: nextSnapshot,
        snapshot_hash: nextHash,
    });
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
    });
    await supersedePendingReusableConsentDocuments({ ...plainDoc, status: 'signed' });
    if (plainDoc.package_id) await refreshPackageCounts(plainDoc.package_id);
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
    if (DOCUMENT_CLOSED_STATUSES.has(plainDoc.status) && plainDoc.status !== 'signed') {
        const err = new Error('consent_document_already_closed');
        err.statusCode = 409;
        throw err;
    }
    if (plainDoc.professional_signed_at) {
        return findDocumentByIdentifier(plainDoc.id);
    }

    const snapshot = plainDoc.snapshot_json && typeof plainDoc.snapshot_json === 'object' ? plainDoc.snapshot_json : {};
    const evidence = normalizeProfessionalSignatureEvidence(payload, requestMeta, userId);
    const nextSnapshot = {
        ...snapshot,
        professional_signature_evidence: evidence,
    };
    const nextHash = hashSnapshot({ ...nextSnapshot, rendered_html: plainDoc.snapshot_html || '' });
    await doc.update({
        professional_signed_by: evidence.professional_id || null,
        professional_signed_at: new Date(evidence.signed_at),
        snapshot_json: nextSnapshot,
        snapshot_hash: nextHash,
    });
    await db.ConsentDeliveryEvent.create({
        package_id: plainDoc.package_id || null,
        patient_consent_document_id: plainDoc.id,
        channel: 'internal',
        status: 'viewed',
        recipient: evidence.professional_name || (evidence.professional_id ? `usuario:${evidence.professional_id}` : 'professional'),
        event_payload: {
            event: 'professional_signed_document',
            evidence,
            snapshot_hash: nextHash,
        },
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
            { model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica'] },
            { model: db.CitaPaciente, as: 'cita', required: false, attributes: ['id_cita', 'inicio', 'doctor_id'] },
            { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre', 'disciplina'] },
        ],
        order: [['updatedAt', 'DESC']],
        limit: Math.min(toIntOrNull(filters.limit) || 100, 200),
    });

    return documents
        .map(getPlain)
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
            { model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica'] },
            { model: db.CitaPaciente, as: 'cita', required: false, attributes: ['id_cita', 'inicio', 'doctor_id', 'estado'] },
            { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre', 'disciplina'] },
        ],
        order: [['updatedAt', 'DESC']],
        limit,
    });

    return documents
        .map(getPlain)
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
    const plain = getPlain(packageRow);
    const documents = Array.isArray(plain.documents) ? plain.documents : [];
    const requestedDocumentIds = Array.isArray(payload.document_ids)
        ? new Set(payload.document_ids.map((item) => String(item)))
        : null;
    const signed = [];
    for (const doc of documents) {
        if (requestedDocumentIds && !requestedDocumentIds.has(String(doc.id)) && !requestedDocumentIds.has(String(doc.public_id))) {
            continue;
        }
        if (DOCUMENT_CLOSED_STATUSES.has(doc.status)) continue;
        signed.push(await signConsentDocument(doc.public_id, {
            ...payload,
            method: payload.method || `${token.channel || 'tablet'}_signature`,
        }, requestMeta));
    }
    const refreshed = await getPackageWithDocumentsById(packageRow.id);
    return {
        signed_count: signed.length,
        ...serializePublicPackage(refreshed),
    };
}

async function revokeConsentDocument(identifier, payload = {}, requestMeta = {}) {
    const doc = await findDocumentByIdentifier(identifier);
    if (!doc) {
        const err = new Error('consent_document_not_found');
        err.statusCode = 404;
        throw err;
    }
    const plainDoc = getPlain(doc);
    if (!['signed', 'sent', 'viewed', 'pending'].includes(plainDoc.status)) {
        const err = new Error('consent_document_cannot_be_revoked');
        err.statusCode = 409;
        throw err;
    }
    const evidence = normalizeRevocationEvidence(payload, requestMeta);
    const snapshot = plainDoc.snapshot_json && typeof plainDoc.snapshot_json === 'object' ? plainDoc.snapshot_json : {};
    const nextSnapshot = {
        ...snapshot,
        revocation_evidence: evidence,
    };
    const nextHash = hashSnapshot({ ...nextSnapshot, rendered_html: plainDoc.snapshot_html || '' });
    await doc.update({
        status: 'revoked',
        revoked_at: new Date(evidence.revoked_at),
        snapshot_json: nextSnapshot,
        snapshot_hash: nextHash,
        delivery_status: 'revoked',
    });
    await db.ConsentDeliveryEvent.create({
        package_id: plainDoc.package_id || null,
        patient_consent_document_id: plainDoc.id,
        channel: plainDoc.channel || 'internal',
        status: 'viewed',
        recipient: evidence.revoked_by,
        event_payload: {
            event: 'document_revoked',
            evidence,
            snapshot_hash: nextHash,
        },
    });
    if (plainDoc.package_id) await refreshPackageCounts(plainDoc.package_id);
    return findDocumentByIdentifier(plainDoc.id);
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
    return doc;
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
    listPatientTreatmentsWithoutConsentRequirements,
    getConsentSummaryForAppointment,
    attachConsentSummaryToCitas,
    createPackageForAppointment,
    ensurePackageForAppointment,
    sendPackageMock,
    createTabletSession,
    getClinicKioskAccess,
    createClinicKioskAccess,
    regenerateClinicKioskAccess,
    resetClinicKioskAccess,
    loginTabletKiosk,
    getTabletKioskSession,
    listTabletKioskPackages,
    createTabletSessionForKiosk,
    createTabletBudgetSignatureSessionForKiosk,
    getPublicPackage,
    signPublicPackage,
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
