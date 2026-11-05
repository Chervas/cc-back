'use strict';
const { createHash } = require('node:crypto');
const imageContract = require('../../services/integrations-broker/src/whatsapp-image');
function fail(code) { throw Object.assign(new Error(code), { code, status: 400 }); }
function parse(body) {
  const input = body?.attachment;
  if (!input || Object.keys(input).sort().join(',') !== 'base64,mime_type'
    || typeof input.base64 !== 'string' || input.base64.length > Math.ceil(imageContract.MAX_BYTES / 3) * 4
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.attachmentRequestId || '')) fail('quickchat_image_invalid');
  const caption = String(body.message || '').trim();
  if ([...caption].length > 1024) fail('quickchat_image_caption_too_long');
  const bytes = Buffer.from(input.base64, 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex'); bytes.fill(0);
  const image = { base64: input.base64, mime_type: input.mime_type, sha256, ...(caption ? { caption } : {}) };
  try { imageContract.validate(image); } catch { fail('quickchat_image_invalid'); }
  return { image, caption, requestId: body.attachmentRequestId };
}
function metadata(value) { return { kind: 'quickchat_outbound_image',
  outbound_attachment_request_id: value.requestId,
  outbound_attachment: { sha256: value.image.sha256, mime_type: value.image.mime_type },
  media: { kind: 'image', mime_type: value.image.mime_type, sha256: value.image.sha256 } }; }
function isReceipt(message) {
  const m = message?.metadata;
  return message?.direction === 'outbound' && message?.message_type === 'image'
    && m?.kind === 'quickchat_outbound_image' && m.transport_origin === 'clinicaclick'
    && typeof m.media?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(m.media.sha256)
    && m.media.sha256 === m.outbound_attachment?.sha256
    && m.media.mime_type === m.outbound_attachment?.mime_type;
}
module.exports = { parse, metadata, isReceipt, MAX_BYTES: imageContract.MAX_BYTES };
