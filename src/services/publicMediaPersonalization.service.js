'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const db = require('../../models');
const publicMediaStorage = require('./publicMediaStorage.service');

const { PublicMediaAsset } = db;

const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_WHATSAPP_IMAGE_BYTES = 5 * 1024 * 1024;
const WHATSAPP_IMAGE_TARGET_BYTES = MAX_WHATSAPP_IMAGE_BYTES - (128 * 1024);
const OUTPUT_WIDTH = 1200;
const OUTPUT_HEIGHT = 675;
const DEFAULT_OVERLAY_COLOR = '#4f46e5';
const OVERLAY_GREETING_TEMPLATE = '¡Hola {nombre}!';
const PERSONALIZATION_VERSION = 'review_header_jpeg_contain_v3';

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeHexColor(value, fallback = DEFAULT_OVERLAY_COLOR) {
  const raw = cleanText(value);
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return fallback;
}

function escapeXml(value) {
  return cleanText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function publicMediaHostnames() {
  const hosts = new Set();
  try {
    hosts.add(new URL(publicMediaStorage.getConfig().baseUrl).hostname);
  } catch (_) {}
  hosts.add('media.clinicaclick.com');
  hosts.add('d1b3irunkcnvha.cloudfront.net');
  return hosts;
}

function assertAllowedSourceUrl(value) {
  const raw = cleanText(value);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    const err = new Error('review_team_photo_url_invalid');
    err.status = 400;
    throw err;
  }
  if (parsed.protocol !== 'https:' || !publicMediaHostnames().has(parsed.hostname)) {
    const err = new Error('review_team_photo_must_be_public_media');
    err.status = 400;
    throw err;
  }
  return parsed.toString();
}

async function fetchSourceImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const err = new Error('review_team_photo_fetch_failed');
      err.status = 502;
      err.details = { status: response.status };
      throw err;
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_SOURCE_IMAGE_BYTES) {
      const err = new Error('review_team_photo_too_large');
      err.status = 413;
      throw err;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_SOURCE_IMAGE_BYTES) {
      const err = new Error('review_team_photo_too_large');
      err.status = 413;
      throw err;
    }
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePatientDisplayName(value) {
  const cleaned = cleanText(value)
    .replace(/\s+/g, ' ')
    .slice(0, 32);
  return cleaned.split(' ').filter(Boolean).slice(0, 1).join(' ') || 'Paciente';
}

function buildOverlaySvg({ patientName, color }) {
  const message = `¡Hola ${normalizePatientDisplayName(patientName)}!`;
  const fontSize = message.length > 25 ? 44 : message.length > 20 ? 48 : 54;
  const rectWidth = Math.min(860, Math.max(480, 260 + message.length * (fontSize * 0.48)));
  const rectHeight = 104;
  const rectX = Math.round((OUTPUT_WIDTH - rectWidth) / 2);
  const rectY = OUTPUT_HEIGHT - rectHeight - 42;
  const textY = rectY + Math.round(rectHeight / 2) + Math.round(fontSize * 0.34);

  return Buffer.from(`
<svg width="${OUTPUT_WIDTH}" height="${OUTPUT_HEIGHT}" viewBox="0 0 ${OUTPUT_WIDTH} ${OUTPUT_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${rectX}" y="${rectY}" width="${rectWidth}" height="${rectHeight}" rx="20" fill="${normalizeHexColor(color)}"/>
  <text x="${OUTPUT_WIDTH / 2}" y="${textY}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${fontSize}" font-weight="800" fill="#ffffff">${escapeXml(message)}</text>
</svg>`);
}

function buildPersonalizedObjectKey({ clinicId, groupId, sourceUrl, patientName, color }) {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const scope = clinicId ? `clinic-${clinicId}` : (groupId ? `group-${groupId}` : 'global');
  const digest = crypto
    .createHash('sha256')
    .update([PERSONALIZATION_VERSION, sourceUrl, normalizePatientDisplayName(patientName), normalizeHexColor(color)].join('|'))
    .digest('hex')
    .slice(0, 24);
  return `whatsapp/reviews/personalized/${scope}/${yyyy}/${mm}/${digest}.jpg`;
}

async function composePersonalizedReviewImage({ sourceBuffer, patientName, color }) {
  const background = await sharp(sourceBuffer, { failOn: 'none' })
    .rotate()
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: 'cover', position: 'center' })
    .blur(18)
    .modulate({ brightness: 0.78, saturation: 0.9 })
    .toBuffer();

  const foreground = await sharp(sourceBuffer, { failOn: 'none' })
    .rotate()
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });

  const composed = sharp(background)
    .composite([
      {
        input: foreground.data,
        left: Math.max(0, Math.round((OUTPUT_WIDTH - foreground.info.width) / 2)),
        top: Math.max(0, Math.round((OUTPUT_HEIGHT - foreground.info.height) / 2))
      },
      { input: buildOverlaySvg({ patientName, color }), top: 0, left: 0 }
    ])
    .flatten({ background: '#ffffff' });

  for (const quality of [84, 78, 72, 66, 60]) {
    const buffer = await composed.clone()
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer();
    if (buffer.length <= WHATSAPP_IMAGE_TARGET_BYTES) {
      return buffer;
    }
  }

  const resized = await composed
    .resize(1024, 576, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
  if (resized.length <= WHATSAPP_IMAGE_TARGET_BYTES) {
    return resized;
  }

  return composed
    .resize(900, 506, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 64, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
}

async function persistAsset({ upload, clinicId, groupId, ownerType, ownerId, sourceUrl, patientName, color, userId }) {
  if (!PublicMediaAsset) return null;
  const scopeType = clinicId ? 'clinic' : (groupId ? 'group' : 'global');
  const payload = {
    scope_type: scopeType,
    clinica_id: clinicId || null,
    grupo_clinica_id: groupId || null,
    owner_type: ownerType || 'review_request',
    owner_id: ownerId ? String(ownerId) : null,
    purpose: 'whatsapp_image',
    provider: 's3_cloudfront',
    bucket: upload.bucket,
    region: upload.region,
    object_key: upload.key,
    public_url: upload.url,
    content_type: upload.contentType,
    size_bytes: upload.sizeBytes,
    sha256: upload.sha256,
    etag: upload.etag,
    cache_control: upload.cacheControl,
    sensitivity: 'public',
    status: 'active',
    metadata: {
      source: 'review_team_photo_personalization',
      source_url: sourceUrl,
      overlay_color: normalizeHexColor(color),
      greeting_template: OVERLAY_GREETING_TEMPLATE,
      personalization_version: PERSONALIZATION_VERSION,
      image_fit: 'contain_with_blurred_cover_background',
      patient_name_present: true,
      patient_data_in_public_media: true,
      public_media_patient_data_exception: 'review_whatsapp_header_greeting',
      non_clinical_asserted: true
    },
    created_by: userId || null
  };

  const existing = await PublicMediaAsset.findOne({ where: { object_key: upload.key } });
  if (existing) {
    await existing.update(payload);
    return existing;
  }
  return PublicMediaAsset.create(payload);
}

async function buildPersonalizedReviewTeamPhoto(options = {}) {
  const sourceUrl = assertAllowedSourceUrl(options.sourceUrl || options.source_url);
  const patientName = normalizePatientDisplayName(options.patientName || options.patient_name);
  const color = normalizeHexColor(options.overlayColor || options.overlay_color);
  const clinicId = Number.isInteger(Number(options.clinicId || options.clinic_id))
    ? Number(options.clinicId || options.clinic_id)
    : null;
  const groupId = Number.isInteger(Number(options.groupId || options.group_id))
    ? Number(options.groupId || options.group_id)
    : null;
  const key = buildPersonalizedObjectKey({ clinicId, groupId, sourceUrl, patientName, color });
  const sourceBuffer = await fetchSourceImage(sourceUrl);
  const outputBuffer = await composePersonalizedReviewImage({ sourceBuffer, patientName, color });
  if (!outputBuffer.length || outputBuffer.length > MAX_WHATSAPP_IMAGE_BYTES) {
    const err = new Error('review_team_photo_output_too_large');
    err.status = 413;
    err.details = { maxBytes: MAX_WHATSAPP_IMAGE_BYTES, sizeBytes: outputBuffer.length };
    throw err;
  }

  const upload = await publicMediaStorage.uploadPublicMedia({
    purpose: 'whatsapp_image',
    contentType: 'image/jpeg',
    buffer: outputBuffer,
    clinicId,
    groupId,
    key,
    versioned: true
  });
  const asset = await persistAsset({
    upload,
    clinicId,
    groupId,
    ownerType: options.ownerType || options.owner_type || 'review_request',
    ownerId: options.ownerId || options.owner_id || null,
    sourceUrl,
    patientName,
    color,
    userId: options.userId || options.user_id || null
  });

  return {
    ...upload,
    assetId: asset?.id || null,
    overlayColor: color
  };
}

module.exports = {
  DEFAULT_OVERLAY_COLOR,
  OVERLAY_GREETING_TEMPLATE,
  normalizeHexColor,
  normalizePatientDisplayName,
  buildPersonalizedReviewTeamPhoto
};
