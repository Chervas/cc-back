'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const db = require('../../models');

const DEFAULT_PROVIDER = 'local_private';
const DEFAULT_BUCKET = 'clinicaclick-clinical-private-local';
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BINARY_BYTES = 50 * 1024 * 1024;
const MAX_ACCOUNTING_DOCUMENT_BYTES = 18 * 1024 * 1024;

const ALLOWED_PURPOSES = new Set([
  'nutrition_report_pdf',
  'nutrition_clinical_photo',
  'clinical_attachment',
  'consent_document_pdf',
  'accounting_expense_document',
  'accounting_payroll_document',
  'fiscal_document_pdf',
]);

const CONTENT_TYPE_EXTENSIONS = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

function cleanText(value) {
  return String(value || '').trim();
}

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function defaultStorageRoot() {
  return path.resolve(__dirname, '..', '..', '..', 'clinical-private-storage');
}

function getConfig() {
  return {
    provider: cleanText(process.env.CLINICAL_PRIVATE_STORAGE_PROVIDER || DEFAULT_PROVIDER),
    bucket: cleanText(process.env.CLINICAL_PRIVATE_STORAGE_BUCKET || DEFAULT_BUCKET),
    region: cleanText(process.env.CLINICAL_PRIVATE_STORAGE_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || ''),
    root: path.resolve(cleanText(process.env.CLINICAL_PRIVATE_STORAGE_ROOT || defaultStorageRoot())),
  };
}

function assertAllowedPurpose(purpose) {
  const normalized = cleanText(purpose).toLowerCase();
  if (!ALLOWED_PURPOSES.has(normalized)) {
    const err = new Error('clinical_private_asset_purpose_not_allowed');
    err.status = 400;
    throw err;
  }
  return normalized;
}

function normalizeContentType(value) {
  const contentType = cleanText(value).toLowerCase();
  return contentType || 'application/octet-stream';
}

function extensionForContentType(contentType) {
  return CONTENT_TYPE_EXTENSIONS.get(contentType) || 'bin';
}

function maxBytesFor({ purpose, contentType }) {
  if (purpose === 'accounting_expense_document' || purpose === 'accounting_payroll_document') {
    return MAX_ACCOUNTING_DOCUMENT_BYTES;
  }
  if (contentType === 'application/pdf' || purpose.endsWith('_pdf')) return MAX_PDF_BYTES;
  if (contentType.startsWith('image/')) return MAX_IMAGE_BYTES;
  return MAX_BINARY_BYTES;
}

function assertPayload({ purpose, contentType, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const err = new Error('clinical_private_asset_empty_payload');
    err.status = 400;
    throw err;
  }
  const allowedForPurpose = purpose === 'nutrition_report_pdf'
    || purpose === 'consent_document_pdf'
    || purpose === 'fiscal_document_pdf'
    ? contentType === 'application/pdf'
    : purpose === 'nutrition_clinical_photo'
      ? ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(contentType)
      : purpose === 'accounting_expense_document' || purpose === 'accounting_payroll_document'
        ? ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(contentType)
        : contentType === 'application/pdf' || contentType.startsWith('image/') || contentType === 'application/octet-stream';
  if (!allowedForPurpose) {
    const err = new Error('clinical_private_asset_content_type_not_allowed');
    err.status = 400;
    throw err;
  }

  const maxBytes = maxBytesFor({ purpose, contentType });
  if (buffer.length > maxBytes) {
    const err = new Error('clinical_private_asset_file_size_not_allowed');
    err.status = 413;
    err.details = { maxBytes, sizeBytes: buffer.length };
    throw err;
  }
}

function sanitizeKeyPart(value, fallback = 'item') {
  return cleanText(value || fallback)
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9/_\-.]/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/\.\./g, '-')
    || fallback;
}

function generatePublicId() {
  const suffix = crypto.randomBytes(10).toString('hex');
  return `cpa_${suffix}`;
}

function generateObjectKey({ purpose, contentType, clinicId = null, patientId = null }) {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const scope = clinicId ? `clinic-${clinicId}` : 'global';
  const patient = patientId ? `patient-${patientId}` : 'no-patient';
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const extension = extensionForContentType(contentType);
  return sanitizeKeyPart(`${purpose}/${scope}/${patient}/${yyyy}/${mm}/${id}.${extension}`);
}

function objectPathForKey(objectKey) {
  const { root } = getConfig();
  const cleanKey = sanitizeKeyPart(objectKey);
  const fullPath = path.resolve(root, cleanKey);
  if (!fullPath.startsWith(`${root}${path.sep}`)) {
    const err = new Error('clinical_private_asset_invalid_key');
    err.status = 400;
    throw err;
  }
  return fullPath;
}

async function writeLocalPrivateObject({ objectKey, buffer }) {
  const fullPath = objectPathForKey(objectKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(fullPath, buffer, { mode: 0o600 });
}

async function readLocalPrivateObject(objectKey) {
  return fs.readFile(objectPathForKey(objectKey));
}

async function generateUniquePublicId() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const publicId = generatePublicId();
    const exists = await db.ClinicalPrivateAsset.findOne({
      where: { public_id: publicId },
      attributes: ['id'],
      raw: true,
    });
    if (!exists) return publicId;
  }
  throw new Error('clinical_private_asset_public_id_generation_failed');
}

async function storeClinicalPrivateAsset(input = {}) {
  if (!db.ClinicalPrivateAsset) {
    const err = new Error('clinical_private_assets_table_unavailable');
    err.status = 503;
    throw err;
  }

  const config = getConfig();
  if (config.provider !== 'local_private') {
    const err = new Error('clinical_private_storage_provider_unsupported');
    err.status = 503;
    err.details = { provider: config.provider };
    throw err;
  }

  const purpose = assertAllowedPurpose(input.purpose);
  const contentType = normalizeContentType(input.contentType || input.content_type);
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer || '');
  assertPayload({ purpose, contentType, buffer });

  const clinicId = toIntOrNull(input.clinicId || input.clinic_id);
  const groupId = toIntOrNull(input.groupId || input.group_id);
  const patientId = toIntOrNull(input.patientId || input.patient_id);
  const objectKey = generateObjectKey({ purpose, contentType, clinicId, patientId });
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  await writeLocalPrivateObject({ objectKey, buffer });

  return db.ClinicalPrivateAsset.create({
    public_id: await generateUniquePublicId(),
    scope_type: clinicId ? 'clinic' : (groupId ? 'group' : 'system'),
    clinic_id: clinicId,
    group_id: groupId,
    patient_id: patientId,
    owner_type: cleanText(input.ownerType || input.owner_type) || null,
    owner_id: cleanText(input.ownerId || input.owner_id) || null,
    purpose,
    provider: config.provider,
    bucket: config.bucket,
    region: config.region || null,
    object_key: objectKey,
    original_filename: cleanText(input.originalFilename || input.original_filename) || null,
    content_type: contentType,
    size_bytes: buffer.length,
    sha256,
    encryption_status: 'filesystem_private',
    sensitivity: 'clinical_private',
    status: 'active',
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : null,
    created_by: toIntOrNull(input.createdBy || input.created_by),
  });
}

async function readClinicalPrivateAsset(assetOrId) {
  const asset = typeof assetOrId === 'object' && assetOrId !== null
    ? assetOrId
    : await db.ClinicalPrivateAsset.findByPk(assetOrId);
  if (!asset) {
    const err = new Error('clinical_private_asset_not_found');
    err.status = 404;
    throw err;
  }

  const plain = typeof asset.toJSON === 'function' ? asset.toJSON() : asset;
  if (plain.status !== 'active') {
    const err = new Error('clinical_private_asset_not_active');
    err.status = 404;
    throw err;
  }
  if (plain.provider !== 'local_private') {
    const err = new Error('clinical_private_storage_provider_unsupported');
    err.status = 503;
    err.details = { provider: plain.provider };
    throw err;
  }

  const buffer = await readLocalPrivateObject(plain.object_key);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (plain.sha256 && sha256 !== plain.sha256) {
    const err = new Error('clinical_private_asset_checksum_mismatch');
    err.status = 500;
    throw err;
  }

  return {
    asset: plain,
    buffer,
    contentType: plain.content_type,
    filename: plain.original_filename || path.basename(plain.object_key),
  };
}

function getClinicalPrivateStorageStatus() {
  const config = getConfig();
  return {
    provider: config.provider,
    bucket: config.bucket,
    region: config.region || null,
    local_root_configured: config.provider === 'local_private',
    public_media: false,
    sensitivity: 'clinical_private',
    allowed_use: 'clinical_reports_photos_and_private_attachments',
  };
}

module.exports = {
  getConfig,
  getClinicalPrivateStorageStatus,
  storeClinicalPrivateAsset,
  readClinicalPrivateAsset,
  __testing: {
    generateObjectKey,
    objectPathForKey,
    assertAllowedPurpose,
    assertPayload,
  },
};
