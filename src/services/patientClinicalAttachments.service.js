'use strict';

const path = require('path');
const { Op } = require('sequelize');
const db = require('../../models');
const clinicalPrivateStorage = require('./clinicalPrivateStorage.service');
const { canUserAccessFeature } = require('../lib/access-policy');

const PURPOSE_CONFIG = {
  nutrition_report_pdf: {
    category: 'informes',
    featureKey: 'nutrition.workspace.view',
    title: 'Informe de Nutricion',
    icon: 'heroicons_outline:document-chart-bar',
  },
  nutrition_clinical_photo: {
    category: 'pruebas',
    featureKey: 'nutrition.workspace.view',
    title: 'Foto clinica de Nutricion',
    icon: 'heroicons_outline:photo',
  },
  consent_document_pdf: {
    category: 'consentimientos',
    featureKey: 'consents.view',
    title: 'Consentimiento informado',
    icon: 'heroicons_outline:document-check',
  },
  clinical_attachment: {
    category: 'otros',
    featureKey: 'patients.sensitive.view',
    title: 'Adjunto clinico',
    icon: 'heroicons_outline:paper-clip',
  },
};

const UPLOAD_CATEGORIES = new Set(['pruebas', 'informes', 'otros']);
const MAX_GENERAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

function toPlain(row) {
  return row && typeof row.toJSON === 'function' ? row.toJSON() : row;
}

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanFilename(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/\0]/g, '-')
    .slice(0, 180);
}

function normalizeUploadCategory(value) {
  const category = String(value || '').trim().toLowerCase();
  return UPLOAD_CATEGORIES.has(category) ? category : 'pruebas';
}

function decodeBase64Payload(value) {
  const raw = String(value || '').trim();
  const base64 = raw.includes(',') ? raw.split(',').pop() : raw;
  if (!base64) {
    const error = new Error('clinical_attachment_empty_payload');
    error.status = 400;
    throw error;
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    const error = new Error('clinical_attachment_empty_payload');
    error.status = 400;
    throw error;
  }
  if (buffer.length > MAX_GENERAL_ATTACHMENT_BYTES) {
    const error = new Error('clinical_attachment_file_size_not_allowed');
    error.status = 413;
    error.details = { maxBytes: MAX_GENERAL_ATTACHMENT_BYTES, sizeBytes: buffer.length };
    throw error;
  }
  return buffer;
}

function contentTypeToFileType(contentType, filename = '') {
  const lower = String(contentType || '').toLowerCase();
  if (lower === 'application/pdf') return 'pdf';
  if (lower.includes('word')) return 'doc';
  if (lower.includes('excel') || lower.includes('spreadsheet')) return 'xls';
  if (lower === 'image/png') return 'png';
  if (lower === 'image/webp') return 'webp';
  if (lower.startsWith('image/')) return 'jpg';
  const ext = path.extname(String(filename || '')).replace('.', '').toLowerCase();
  if (['pdf', 'doc', 'xls', 'txt', 'jpg'].includes(ext)) return ext;
  if (['jpeg', 'png', 'webp'].includes(ext)) return 'jpg';
  return 'txt';
}

function formatDefaultName(asset, config) {
  const metadata = asset.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
  if (asset.original_filename) return asset.original_filename;
  if (asset.purpose === 'nutrition_report_pdf') {
    const measurement = metadata.measurement_id ? ` #${metadata.measurement_id}` : '';
    return `${config.title}${measurement}.pdf`;
  }
  if (asset.purpose === 'nutrition_clinical_photo') {
    const measurement = asset.owner_id ? ` #${asset.owner_id}` : '';
    return `${config.title}${measurement}`;
  }
  return config.title;
}

function clinicalAttachmentToJson(row) {
  const asset = toPlain(row);
  const config = PURPOSE_CONFIG[asset.purpose] || PURPOSE_CONFIG.clinical_attachment;
  const filename = formatDefaultName(asset, config);
  const metadata = asset.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
  const appointmentId = toIntOrNull(metadata.appointment_id)
    || (asset.owner_type === 'patient_appointment' ? toIntOrNull(asset.owner_id) : null);
  const category = asset.purpose === 'clinical_attachment'
    ? normalizeUploadCategory(metadata.category)
    : config.category;

  return {
    id: asset.id,
    public_id: asset.public_id,
    name: filename,
    purpose: asset.purpose,
    category,
    content_type: asset.content_type,
    file_type: contentTypeToFileType(asset.content_type, filename),
    size_bytes: Number(asset.size_bytes || 0),
    original_filename: asset.original_filename || null,
    patient_id: asset.patient_id || null,
    clinic_id: asset.clinic_id || null,
    owner_type: asset.owner_type || null,
    owner_id: asset.owner_id || null,
    measurement_id: toIntOrNull(metadata.measurement_id) || (asset.owner_type === 'patient_nutrition_measurement' ? toIntOrNull(asset.owner_id) : null),
    appointment_id: appointmentId,
    report_public_id: metadata.report_public_id || null,
    snapshot_hash: metadata.snapshot_hash || null,
    formula_version: metadata.formula_version || null,
    icon: config.icon,
    created_at: asset.created_at || null,
    updated_at: asset.updated_at || null,
    private_storage: {
      sensitivity: asset.sensitivity || 'clinical_private',
      provider: asset.provider || null,
      public_media: false,
    },
    actions: {
      can_download: true,
      download_path: `/api/pacientes/${asset.patient_id}/clinical-attachments/${asset.public_id}`,
    },
  };
}

async function findPatient(patientIdentifier) {
  const raw = String(patientIdentifier || '').trim();
  if (!raw || !db.Paciente) return null;
  const where = /^\d+$/.test(raw)
    ? { id_paciente: Number(raw) }
    : { public_id: raw };
  return db.Paciente.findOne({
    where,
    attributes: ['id_paciente', 'public_id', 'clinica_id'],
    include: db.Clinica
      ? [{ model: db.Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'grupoClinicaId'] }]
      : [],
  });
}

async function allowedPurposesForActor({ actorId, clinicId }) {
  const entries = await Promise.all(Object.entries(PURPOSE_CONFIG).map(async ([purpose, config]) => {
    const allowed = await canUserAccessFeature({ actorId, featureKey: config.featureKey, clinicId });
    return allowed ? purpose : null;
  }));
  return entries.filter(Boolean);
}

async function listPatientClinicalAttachments(patientIdentifier, actorId) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }

  if (!db.ClinicalPrivateAsset) {
    return {
      patient_id: patient.id_paciente,
      items: [],
      summary: { total: 0, by_category: {} },
    };
  }

  const clinicId = Number(patient.clinica_id);
  const allowedPurposes = await allowedPurposesForActor({ actorId, clinicId });
  if (!allowedPurposes.length) {
    return {
      patient_id: patient.id_paciente,
      items: [],
      summary: { total: 0, by_category: {} },
    };
  }

  const rows = await db.ClinicalPrivateAsset.findAll({
    where: {
      patient_id: Number(patient.id_paciente),
      status: 'active',
      purpose: { [Op.in]: allowedPurposes },
    },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: 200,
  });

  const items = rows.map(clinicalAttachmentToJson);
  const byCategory = items.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {});

  return {
    patient_id: patient.id_paciente,
    items,
    summary: {
      total: items.length,
      by_category: byCategory,
    },
  };
}

async function readPatientClinicalAttachment(patientIdentifier, attachmentIdentifier, actorId) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }

  const rawAttachmentId = String(attachmentIdentifier || '').trim();
  const where = /^\d+$/.test(rawAttachmentId)
    ? { id: Number(rawAttachmentId) }
    : { public_id: rawAttachmentId };

  const asset = db.ClinicalPrivateAsset
    ? await db.ClinicalPrivateAsset.findOne({
      where: {
        ...where,
        patient_id: Number(patient.id_paciente),
        status: 'active',
      },
    })
    : null;

  if (!asset) {
    const error = new Error('clinical_attachment_not_found');
    error.status = 404;
    throw error;
  }

  const plain = toPlain(asset);
  const config = PURPOSE_CONFIG[plain.purpose] || PURPOSE_CONFIG.clinical_attachment;
  const allowed = await canUserAccessFeature({
    actorId,
    featureKey: config.featureKey,
    clinicId: Number(patient.clinica_id),
  });
  if (!allowed) {
    const error = new Error('access_policy_forbidden');
    error.status = 403;
    error.details = { feature_key: config.featureKey, clinic_id: Number(patient.clinica_id) };
    throw error;
  }

  return clinicalPrivateStorage.readClinicalPrivateAsset(asset);
}

async function createPatientClinicalAttachment(patientIdentifier, actorId, payload = {}) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }

  const clinicId = Number(patient.clinica_id);
  const canEdit = await canUserAccessFeature({ actorId, featureKey: 'patients.edit', clinicId });
  if (!canEdit) {
    const error = new Error('access_policy_forbidden');
    error.status = 403;
    error.details = { feature_key: 'patients.edit', clinic_id: clinicId };
    throw error;
  }

  const contentType = String(payload.content_type || payload.contentType || '').trim().toLowerCase();
  const allowedContentTypes = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
  if (!allowedContentTypes.has(contentType)) {
    const error = new Error('clinical_attachment_content_type_not_allowed');
    error.status = 400;
    error.details = { allowed: [...allowedContentTypes] };
    throw error;
  }

  const appointmentId = toIntOrNull(payload.appointment_id || payload.appointmentId);
  if (appointmentId) {
    const appointment = await db.CitaPaciente.findOne({
      where: {
        id_cita: appointmentId,
        paciente_id: Number(patient.id_paciente),
        clinica_id: clinicId,
      },
      attributes: ['id_cita'],
    });
    if (!appointment) {
      const error = new Error('appointment_not_found');
      error.status = 404;
      throw error;
    }
  }

  const category = normalizeUploadCategory(payload.category);
  const filename = cleanFilename(payload.filename || payload.original_filename) || 'adjunto-clinico';
  const buffer = decodeBase64Payload(payload.data_base64 || payload.base64 || payload.dataUrl);
  const asset = await clinicalPrivateStorage.storeClinicalPrivateAsset({
    purpose: 'clinical_attachment',
    clinicId,
    patientId: Number(patient.id_paciente),
    ownerType: appointmentId ? 'patient_appointment' : 'patient',
    ownerId: appointmentId ? String(appointmentId) : String(patient.id_paciente),
    originalFilename: filename,
    contentType,
    buffer,
    metadata: {
      category,
      appointment_id: appointmentId,
      uploaded_from: 'patient_attachments',
      notes: String(payload.notes || '').trim().slice(0, 1000) || null,
    },
    createdBy: actorId,
  });

  return clinicalAttachmentToJson(asset);
}

module.exports = {
  PURPOSE_CONFIG,
  clinicalAttachmentToJson,
  listPatientClinicalAttachments,
  readPatientClinicalAttachment,
  createPatientClinicalAttachment,
};
