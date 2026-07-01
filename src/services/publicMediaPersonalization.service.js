'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const db = require('../../models');
const publicMediaStorage = require('./publicMediaStorage.service');

const { PublicMediaAsset } = db;

const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024;
const OUTPUT_WIDTH = 1200;
const OUTPUT_HEIGHT = 675;
const DEFAULT_OVERLAY_COLOR = '#4f46e5';
const SAFE_OVERLAY_TEXT = '¡Hola!';

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

function buildOverlaySvg({ color }) {
  const message = SAFE_OVERLAY_TEXT;
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

function buildPersonalizedObjectKey({ clinicId, groupId, sourceUrl, color }) {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const scope = clinicId ? `clinic-${clinicId}` : (groupId ? `group-${groupId}` : 'global');
  const digest = crypto
    .createHash('sha256')
    .update([sourceUrl, normalizeHexColor(color)].join('|'))
    .digest('hex')
    .slice(0, 24);
  return `whatsapp/reviews/personalized/${scope}/${yyyy}/${mm}/${digest}.webp`;
}

async function persistAsset({ upload, clinicId, groupId, ownerType, ownerId, sourceUrl, color, userId }) {
  if (!PublicMediaAsset) return null;
  const scopeType = clinicId ? 'clinic' : (groupId ? 'group' : 'global');
  return PublicMediaAsset.create({
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
      greeting_template: SAFE_OVERLAY_TEXT,
      patient_name_present: false,
      patient_data_in_public_media: false,
      non_clinical_asserted: true
    },
    created_by: userId || null
  });
}

async function buildPersonalizedReviewTeamPhoto(options = {}) {
  const sourceUrl = assertAllowedSourceUrl(options.sourceUrl || options.source_url);
  const color = normalizeHexColor(options.overlayColor || options.overlay_color);
  const clinicId = Number.isInteger(Number(options.clinicId || options.clinic_id))
    ? Number(options.clinicId || options.clinic_id)
    : null;
  const groupId = Number.isInteger(Number(options.groupId || options.group_id))
    ? Number(options.groupId || options.group_id)
    : null;
  const key = buildPersonalizedObjectKey({ clinicId, groupId, sourceUrl, color });
  const sourceBuffer = await fetchSourceImage(sourceUrl);
  const outputBuffer = await sharp(sourceBuffer, { failOn: 'none' })
    .rotate()
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: 'cover', position: 'center' })
    .composite([{ input: buildOverlaySvg({ color }), top: 0, left: 0 }])
    .webp({ quality: 88 })
    .toBuffer();

  const upload = await publicMediaStorage.uploadPublicMedia({
    purpose: 'whatsapp_image',
    contentType: 'image/webp',
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
  SAFE_OVERLAY_TEXT,
  normalizeHexColor,
  buildPersonalizedReviewTeamPhoto
};
