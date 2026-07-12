'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../models');
const consentimientosService = require('../services/consentimientos.service');
const { assertUserCanAccessFeature, canUserAccessFeature } = require('../lib/access-policy');

const { Op } = db.Sequelize;

function getUserId(req) {
    return req.userData?.userId || null;
}

function toIntOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getBearer(req) {
    return req.get('authorization') || req.headers?.authorization || '';
}

function getRequestBaseUrl(req) {
    return req.get('origin') || `${req.protocol}://${req.get('host')}`;
}

function sendError(res, error) {
    const status = error?.statusCode || error?.status || 500;
    const message = error?.message || 'consentimientos_error';
    const payload = { message };
    if (error?.details) payload.details = error.details;
    return res.status(status).json(payload);
}

function buildError(message, statusCode = 400, details = null) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (details) error.details = details;
    return error;
}

async function requireConsentFeature(req, featureKey, clinicIdRaw) {
    const actorId = toIntOrNull(getUserId(req));
    const clinicId = toIntOrNull(clinicIdRaw);
    if (!actorId) throw buildError('auth_failed', 401);
    if (!clinicId) throw buildError('clinic_id_required', 400);
    await assertUserCanAccessFeature({ actorId, featureKey, clinicId });
    return clinicId;
}

async function resolvePatientClinicId(identifier, fallbackClinicId = null) {
    const explicitClinicId = toIntOrNull(fallbackClinicId);
    if (explicitClinicId) return explicitClinicId;

    const value = String(identifier || '').trim();
    if (!value || !db.Paciente) return null;
    const where = /^\d+$/.test(value)
        ? { id_paciente: Number(value) }
        : { public_id: { [Op.in]: value.startsWith('pat_') ? [value, `pac_${value.slice(4)}`] : [value] } };
    const paciente = await db.Paciente.findOne({ where, attributes: ['id_paciente', 'clinica_id'], raw: true });
    return toIntOrNull(paciente?.clinica_id);
}

async function resolveAppointmentClinicId(appointmentId) {
    const id = toIntOrNull(appointmentId);
    if (!id || !db.CitaPaciente) return null;
    const cita = await db.CitaPaciente.findByPk(id, { attributes: ['id_cita', 'clinica_id'], raw: true });
    return toIntOrNull(cita?.clinica_id);
}

async function resolveClinicTemplateClinicId(templateId) {
    const id = toIntOrNull(templateId);
    if (!id || !db.ClinicConsentTemplate) return null;
    const template = await db.ClinicConsentTemplate.findByPk(id, { attributes: ['id', 'clinic_id'], raw: true });
    return toIntOrNull(template?.clinic_id);
}

async function resolvePackageClinicId(packageId) {
    const id = toIntOrNull(packageId);
    if (!id || !db.ConsentSignaturePackage) return null;
    const packageRow = await db.ConsentSignaturePackage.findByPk(id, { attributes: ['id', 'clinica_id'], raw: true });
    return toIntOrNull(packageRow?.clinica_id);
}

async function resolveDocumentClinicId(identifier) {
    const value = String(identifier || '').trim();
    if (!value || !db.PatientConsentDocument) return null;
    const where = /^\d+$/.test(value) ? { id: Number(value) } : { public_id: value };
    const document = await db.PatientConsentDocument.findOne({ where, attributes: ['id', 'clinica_id'], raw: true });
    return toIntOrNull(document?.clinica_id);
}

function withClinicFilter(filters = {}, clinicId) {
    return {
        ...(filters || {}),
        clinica_id: clinicId,
        clinic_id: clinicId,
    };
}

async function filterDocumentsByConsentFeature(req, items = [], featureKey = 'consents.view') {
    const actorId = toIntOrNull(getUserId(req));
    if (!actorId || !Array.isArray(items) || !items.length) return [];
    const cache = new Map();
    const allowed = [];

    for (const item of items) {
        const plain = item && typeof item.toJSON === 'function' ? item.toJSON() : item;
        const clinicId = toIntOrNull(plain?.clinica_id || plain?.clinica?.id_clinica);
        if (!clinicId) continue;
        const cacheKey = `${featureKey}:${clinicId}`;
        if (!cache.has(cacheKey)) {
            cache.set(cacheKey, await canUserAccessFeature({ actorId, featureKey, clinicId }).catch(() => false));
        }
        if (cache.get(cacheKey)) allowed.push(item);
    }

    return allowed;
}

exports.listAdminTemplates = asyncHandler(async (req, res) => {
    try {
        const items = await consentimientosService.listAdminTemplates(req.query || {});
        return res.json(items);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.createAdminTemplate = asyncHandler(async (req, res) => {
    try {
        const item = await consentimientosService.createAdminTemplate(req.body || {}, getUserId(req));
        return res.status(201).json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.updateAdminTemplate = asyncHandler(async (req, res) => {
    try {
        const item = await consentimientosService.updateAdminTemplate(req.params.id, req.body || {}, getUserId(req));
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.propagateAdminTemplate = asyncHandler(async (req, res) => {
    try {
        const result = await consentimientosService.propagateAdminTemplateToClinics(req.params.id, {
            ...(req.body || {}),
            userId: getUserId(req),
        });
        return res.json(result);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.listClinicTemplates = asyncHandler(async (req, res) => {
    try {
        const clinicId = await requireConsentFeature(
            req,
            'consents.view',
            req.query?.clinic_id ?? req.query?.clinica_id
        );
        const items = await consentimientosService.listClinicTemplates(withClinicFilter(req.query || {}, clinicId));
        return res.json(items);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.createClinicTemplate = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', req.body?.clinic_id ?? req.body?.clinica_id);
        const item = await consentimientosService.createClinicTemplate(req.body || {}, getUserId(req));
        return res.status(201).json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.updateClinicTemplate = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', await resolveClinicTemplateClinicId(req.params.id));
        const item = await consentimientosService.updateClinicTemplate(req.params.id, req.body || {}, getUserId(req));
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.syncClinicTemplates = asyncHandler(async (req, res) => {
    try {
        const clinicId = req.body?.clinic_id ?? req.body?.clinica_id ?? req.params.clinicId;
        await requireConsentFeature(req, 'consents.manage', clinicId);
        const result = await consentimientosService.syncClinicTemplatesFromCatalog(
            clinicId,
            getUserId(req)
        );
        return res.json(result);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.getTreatmentRequirements = asyncHandler(async (req, res) => {
    try {
        if (req.query?.clinic_id || req.query?.clinica_id) {
            await requireConsentFeature(req, 'consents.view', req.query?.clinic_id ?? req.query?.clinica_id);
        }
        const items = await consentimientosService.getTreatmentRequirements({
            tratamientoId: req.params.id,
            clinicaId: req.query?.clinic_id ?? req.query?.clinica_id,
        });
        return res.json(items);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.saveTreatmentRequirements = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', req.body?.clinic_id ?? req.body?.clinica_id);
        const items = await consentimientosService.saveTreatmentRequirements(req.params.id, req.body || {});
        return res.json(items);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.listPatientDocuments = asyncHandler(async (req, res) => {
    try {
        const clinicId = await requireConsentFeature(
            req,
            'consents.view',
            await resolvePatientClinicId(req.params.id, req.query?.clinic_id ?? req.query?.clinica_id)
        );
        const result = await consentimientosService.listPatientDocuments(req.params.id, withClinicFilter(req.query || {}, clinicId));
        return res.json(result);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.listPatientTreatmentsWithoutConsentRequirements = asyncHandler(async (req, res) => {
    try {
        const clinicId = await requireConsentFeature(
            req,
            'consents.view',
            await resolvePatientClinicId(req.params.id, req.query?.clinic_id ?? req.query?.clinica_id)
        );
        const items = await consentimientosService.listPatientTreatmentsWithoutConsentRequirements(req.params.id, withClinicFilter(req.query || {}, clinicId));
        return res.json(items);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.getAppointmentSummary = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.view', await resolveAppointmentClinicId(req.params.id));
        const db = require('../../models');
        const cita = await db.CitaPaciente.findByPk(req.params.id, {
            include: [
                { model: db.Paciente, as: 'paciente', required: false },
                { model: db.Clinica, as: 'clinica', required: false },
                { model: db.Tratamiento, as: 'tratamiento', required: false },
            ],
        });
        if (!cita) return res.status(404).json({ message: 'appointment_not_found' });
        const summary = await consentimientosService.getConsentSummaryForAppointment(cita);
        return res.json(summary);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.createAppointmentPackage = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', await resolveAppointmentClinicId(req.params.id));
        const item = await consentimientosService.createPackageForAppointment(req.params.id, {
            createdBy: getUserId(req),
            triggerSource: req.body?.trigger_source || req.body?.origen || 'manual',
        });
        return res.status(201).json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.sendPackageMock = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', await resolvePackageClinicId(req.params.id));
        const item = await consentimientosService.sendPackageMock(req.params.id, {
            ...(req.body || {}),
            base_url: req.body?.base_url || req.body?.baseUrl || undefined,
        });
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.createTabletSession = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', await resolvePackageClinicId(req.params.id));
        const item = await consentimientosService.createTabletSession(req.params.id, {
            ...(req.body || {}),
            base_url: req.body?.base_url || req.body?.baseUrl || undefined,
        });
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.getClinicKioskAccess = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.view', req.params.clinicId);
        const item = await consentimientosService.getClinicKioskAccess(req.params.clinicId);
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.resetClinicKioskAccess = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', req.params.clinicId);
        const item = await consentimientosService.resetClinicKioskAccess(req.params.clinicId, getUserId(req));
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.createClinicKioskAccess = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', req.params.clinicId);
        const item = await consentimientosService.createClinicKioskAccess(req.params.clinicId, getUserId(req), req.body || {});
        return res.status(201).json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.regenerateClinicKioskAccess = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', req.params.clinicId);
        const item = await consentimientosService.regenerateClinicKioskAccess(req.params.clinicId, req.params.kioskId, getUserId(req));
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.loginTabletKiosk = asyncHandler(async (req, res) => {
    try {
        const item = await consentimientosService.loginTabletKiosk(req.body || {});
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.getTabletKioskSession = asyncHandler(async (req, res) => {
    try {
        const item = await consentimientosService.getTabletKioskSession(getBearer(req));
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.listTabletKioskPackages = asyncHandler(async (req, res) => {
    try {
        const item = await consentimientosService.listTabletKioskPackages(getBearer(req), req.query || {});
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.createTabletKioskPackageSession = asyncHandler(async (req, res) => {
    try {
        const item = await consentimientosService.createTabletSessionForKiosk(req.params.id, getBearer(req), {
            ...(req.body || {}),
            base_url: req.body?.base_url || req.body?.baseUrl || undefined,
        });
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.getPublicPackage = asyncHandler(async (req, res) => {
    try {
        const item = await consentimientosService.getPublicPackage(req.params.token, {
            ip: req.ip,
            userAgent: req.get('user-agent'),
        });
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.signPublicPackage = asyncHandler(async (req, res) => {
    try {
        const item = await consentimientosService.signPublicPackage(req.params.token, req.body || {}, {
            ip: req.ip,
            userAgent: req.get('user-agent'),
        });
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.getDocument = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.view', await resolveDocumentClinicId(req.params.id));
        const item = await consentimientosService.getConsentDocument(req.params.id);
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.renderDocument = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.view', await resolveDocumentClinicId(req.params.id));
        const html = await consentimientosService.renderConsentDocument(req.params.id);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.getDocumentPdf = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.view', await resolveDocumentClinicId(req.params.id));
        const { buffer, filename } = await consentimientosService.generateConsentDocumentPdf(req.params.id);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.setHeader('Content-Length', buffer.length);
        return res.send(buffer);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.signDocument = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', await resolveDocumentClinicId(req.params.id));
        const item = await consentimientosService.signConsentDocument(req.params.id, req.body || {}, {
            ip: req.ip,
            userAgent: req.get('user-agent'),
        });
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.signProfessionalDocument = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', await resolveDocumentClinicId(req.params.id));
        const item = await consentimientosService.signProfessionalConsentDocument(req.params.id, req.body || {}, getUserId(req), {
            ip: req.ip,
            userAgent: req.get('user-agent'),
        });
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.listProfessionalPendingDocuments = asyncHandler(async (req, res) => {
    try {
        if (req.query?.clinic_id || req.query?.clinica_id) {
            await requireConsentFeature(req, 'consents.view', req.query?.clinic_id ?? req.query?.clinica_id);
        }
        const rawItems = await consentimientosService.listProfessionalPendingDocuments(req.query || {}, getUserId(req));
        const items = await filterDocumentsByConsentFeature(req, rawItems, 'consents.view');
        return res.json({ items, total: items.length });
    } catch (error) {
        return sendError(res, error);
    }
});

exports.listClinicPendingPatientDocuments = asyncHandler(async (req, res) => {
    try {
        const clinicId = await requireConsentFeature(req, 'consents.view', req.query?.clinic_id ?? req.query?.clinica_id);
        const items = await consentimientosService.listClinicPendingPatientDocuments(withClinicFilter(req.query || {}, clinicId), getUserId(req));
        return res.json({ items, total: items.length });
    } catch (error) {
        return sendError(res, error);
    }
});

exports.revokeDocument = asyncHandler(async (req, res) => {
    try {
        await requireConsentFeature(req, 'consents.manage', await resolveDocumentClinicId(req.params.id));
        const item = await consentimientosService.revokeConsentDocument(req.params.id, {
            ...(req.body || {}),
            revoked_by: req.body?.revoked_by || req.userData?.email || req.userData?.name || req.userData?.nombre || 'clinic_user',
        }, {
            ip: req.ip,
            userAgent: req.get('user-agent'),
        });
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});

exports.exportPatientAudit = asyncHandler(async (req, res) => {
    try {
        const clinicId = await requireConsentFeature(
            req,
            'consents.view',
            await resolvePatientClinicId(req.params.id, req.query?.clinic_id ?? req.query?.clinica_id)
        );
        const item = await consentimientosService.exportPatientConsentAudit(req.params.id, withClinicFilter(req.query || {}, clinicId));
        return res.json(item);
    } catch (error) {
        return sendError(res, error);
    }
});
