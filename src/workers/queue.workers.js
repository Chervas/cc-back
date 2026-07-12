'use strict';
const { QueryTypes } = require('sequelize');
const { createWorker } = require('../services/queue.service');
const whatsappService = require('../services/whatsapp.service');
const groqAudioService = require('../services/groqAudio.service');
const whatsappTemplatesService = require('../services/whatsappTemplates.service');
const whatsappPhonesService = require('../services/whatsappPhones.service');
const automationDefaultsService = require('../services/automationDefaults.service');
const automationsV2ResumeService = require('../services/automationsV2Resume.service');
const marketingOptOutService = require('../services/marketingOptOut.service');
const marketingBulkSendsService = require('../services/marketingBulkSends.service');
const notificationService = require('../services/notifications.service');
const whatsappPaymentStatusService = require('../services/whatsappPaymentStatus.service');
const whatsappConnectionStatusService = require('../services/whatsappConnectionStatus.service');
const { getIO } = require('../services/socket.service');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');
const db = require('../../models');

const { Conversation, Message, ClinicMetaAsset, Clinica, WhatsAppWebOrigin } = db;

const CHAT_DEBUG = process.env.CHAT_DEBUG === 'true';
const dlog = (...args) => {
    if (CHAT_DEBUG) {
        console.log('[CHAT]', ...args);
    }
};

const CC_WEB_REF_CAPTURE_REGEX = /\[cc_ref:([a-f0-9]{8,64})\]/i;
const CC_WEB_REF_STRIP_REGEX = /\[cc_ref:[a-f0-9]{8,64}\]/ig;
function extractAndStripWebOriginRef(rawContent) {
    const content = typeof rawContent === 'string' ? rawContent : '';
    if (!content) {
        return { ref: null, content: '' };
    }
    const match = content.match(CC_WEB_REF_CAPTURE_REGEX);
    const ref = match?.[1] ? String(match[1]).toLowerCase() : null;
    const cleaned = content
        .replace(CC_WEB_REF_STRIP_REGEX, '')
        .replace(/\s+\n/g, '\n')
        .replace(/\n\s+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    return { ref, content: cleaned };
}

function cleanString(value) {
    if (value === undefined || value === null) {
        return '';
    }
    return String(value).trim();
}

const RUNTIME_ROLE = cleanString(process.env.RUNTIME_ROLE).toLowerCase();
const IS_GATEWAY_RUNTIME = RUNTIME_ROLE === 'gateway';
const WHATSAPP_PAYMENT_MISSING_ERROR_CODE = whatsappPaymentStatusService.PAYMENT_MISSING_ERROR_CODE;

function truncateText(value, max = 120) {
    const normalized = cleanString(value);
    if (!normalized || normalized.length <= max) {
        return normalized;
    }
    return `${normalized.slice(0, max - 1)}…`;
}

function normalizeMimeType(value) {
    return cleanString(value).split(';')[0].trim().toLowerCase() || 'audio/ogg';
}

function extensionForMimeType(mimeType) {
    const normalized = normalizeMimeType(mimeType);
    if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
    if (normalized.includes('mp4') || normalized.includes('m4a')) return 'm4a';
    if (normalized.includes('wav')) return 'wav';
    if (normalized.includes('webm')) return 'webm';
    if (normalized.includes('ogg') || normalized.includes('opus')) return 'ogg';
    return 'audio';
}

function serializeError(error) {
    const message = cleanString(error?.message || error);
    return message || 'unknown_error';
}

function buildAudioTranscriptionContent(transcriptionText) {
    const text = cleanString(transcriptionText);
    return text
        ? text
        : 'Audio recibido. No se pudo transcribir automáticamente.';
}

async function buildAudioInboundDescriptor({ msg, clinicId, normalizedType }) {
    const audio = msg?.audio || {};
    const mediaId = cleanString(audio?.id) || null;
    const mimeType = normalizeMimeType(audio?.mime_type);
    const sha256 = cleanString(audio?.sha256) || null;
    const metadataExtra = {
        media: {
            kind: 'audio',
            id: mediaId,
            mime_type: mimeType,
            sha256,
            voice: audio?.voice === true,
            provider: 'whatsapp',
            stored: false,
            playable: false,
        },
        audio_transcribed: false,
    };

    const markFailed = (reason, error = null) => {
        const content = buildAudioTranscriptionContent('');
        metadataExtra.audio_transcription = {
            status: 'failed',
            provider: 'groq',
            model: cleanString(process.env.GROQ_STT_MODEL) || 'whisper-large-v3-turbo',
            reason,
            error: error ? serializeError(error) : null,
            transcribed_at: new Date().toISOString(),
        };
        metadataExtra.resume_text = content;
        return {
            rawType: 'audio',
            messageType: normalizedType,
            content,
            webOriginRef: null,
            resumeText: content,
            metadataExtra,
        };
    };

    if (!mediaId) {
        return markFailed('missing_media_id');
    }

    try {
        const clinicConfig = await whatsappService.getClinicConfig(clinicId);
        if (!clinicConfig?.accessToken) {
            return markFailed('missing_whatsapp_access_token');
        }

        const download = await whatsappService.downloadMediaBuffer({
            mediaId,
            accessToken: clinicConfig.accessToken,
        });
        const mediaInfo = download?.mediaInfo || {};
        const resolvedMimeType = normalizeMimeType(download?.contentType || mediaInfo?.mime_type || mimeType);
        metadataExtra.media = {
            ...metadataExtra.media,
            mime_type: resolvedMimeType,
            sha256: cleanString(mediaInfo?.sha256) || sha256,
            file_size: Number(mediaInfo?.file_size || 0) || null,
            url_available: Boolean(mediaInfo?.url),
        };

        const transcription = await groqAudioService.transcribeAudioBuffer({
            buffer: download.buffer,
            mimeType: resolvedMimeType,
            fileName: `whatsapp-${mediaId}.${extensionForMimeType(resolvedMimeType)}`,
        });
        const transcriptionText = cleanString(transcription?.text);
        const content = buildAudioTranscriptionContent(transcriptionText);
        metadataExtra.audio_transcribed = true;
        metadataExtra.audio_transcription = {
            status: 'success',
            provider: transcription.provider || 'groq',
            model: transcription.model || cleanString(process.env.GROQ_STT_MODEL) || 'whisper-large-v3-turbo',
            text: transcriptionText,
            transcribed_at: new Date().toISOString(),
        };
        metadataExtra.resume_text = transcriptionText;

        return {
            rawType: 'audio',
            messageType: normalizedType,
            content,
            webOriginRef: null,
            resumeText: transcriptionText,
            metadataExtra,
        };
    } catch (error) {
        console.error('[whatsapp] Error transcribiendo audio inbound', {
            clinicId,
            mediaId,
            error: serializeError(error),
        });
        return markFailed('transcription_failed', error);
    }
}

function normalizeInboundMessageType(rawType) {
    const normalized = cleanString(rawType).toLowerCase();
    if (['text', 'image', 'template', 'event', 'reaction'].includes(normalized)) {
        return normalized;
    }
    return 'text';
}

async function buildInboundMessageDescriptor({ msg, clinicId }) {
    const rawType = cleanString(msg?.type).toLowerCase() || 'text';
    const normalizedType = normalizeInboundMessageType(rawType);

    if (rawType === 'audio') {
        return buildAudioInboundDescriptor({ msg, clinicId, normalizedType });
    }

    if (rawType === 'reaction') {
        const emoji = cleanString(msg?.reaction?.emoji);
        const targetWamid = cleanString(msg?.reaction?.message_id) || null;

        let targetPreview = null;
        let targetMessageId = null;
        let targetDirection = null;
        let targetType = null;

        if (targetWamid) {
            const targetRef = await findMessageByWamid(targetWamid);
            if (targetRef?.id && Number(targetRef.clinic_id) === Number(clinicId)) {
                const targetMessage = await Message.findByPk(targetRef.id, {
                    attributes: ['id', 'content', 'direction', 'message_type'],
                    raw: true,
                });
                if (targetMessage) {
                    targetMessageId = targetMessage.id;
                    targetDirection = targetMessage.direction || null;
                    targetType = targetMessage.message_type || null;
                    targetPreview = truncateText(targetMessage.content, 120) || null;
                }
            }
        }

        const resumeText = targetPreview
            ? `El paciente reaccionó ${emoji || 'con un emoji'} al mensaje: ${targetPreview}`
            : `El paciente reaccionó ${emoji || 'con un emoji'} a tu mensaje`;

        return {
            rawType,
            messageType: normalizedType,
            content: emoji || 'Reacción',
            webOriginRef: null,
            resumeText,
            metadataExtra: {
                kind: 'whatsapp_reaction',
                resume_text: resumeText,
                reaction: {
                    emoji: emoji || null,
                    message_id: targetWamid,
                    target_message_id: targetMessageId,
                    target_message_preview: targetPreview,
                    target_message_direction: targetDirection,
                    target_message_type: targetType,
                },
            },
        };
    }

    const rawContent = msg?.text?.body || msg?.button?.text || msg?.interactive?.text || msg?.image?.caption || msg?.document?.caption || msg?.video?.caption || '';
    const stripped = extractAndStripWebOriginRef(rawContent);
    const content = stripped.content;
    const metadataExtra = {};
    const mediaPayload = getWhatsAppMediaPayload(msg);

    if (mediaPayload) {
        metadataExtra.media = mediaPayload;
    } else if (rawType && !['text', 'button', 'interactive'].includes(rawType)) {
        metadataExtra.media = { kind: rawType };
    }

    return {
        rawType,
        messageType: normalizedType,
        content,
        webOriginRef: stripped.ref || null,
        resumeText: content,
        metadataExtra,
    };
}

function mapWhatsAppStatus(status) {
    switch ((status || '').toLowerCase()) {
        case 'sent':
            return 'sent';
        case 'delivered':
            return 'delivered';
        case 'read':
            return 'read';
        case 'failed':
            return 'failed';
        default:
            return null;
    }
}

function normalizePhoneDigits(value) {
    return cleanString(value).replace(/\D/g, '');
}

function normalizeWhatsappContactId(value) {
    const digits = normalizePhoneDigits(value);
    return digits ? `+${digits}` : null;
}

function parseWhatsappTimestamp(value, fallback = new Date()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
        const ms = numeric > 100000000000 ? numeric : numeric * 1000;
        const date = new Date(ms);
        if (!Number.isNaN(date.getTime())) {
            return date;
        }
    }
    const parsed = value ? new Date(value) : null;
    if (parsed && !Number.isNaN(parsed.getTime())) {
        return parsed;
    }
    return fallback;
}

function isDateAfter(left, right) {
    const leftTs = left ? new Date(left).getTime() : 0;
    const rightTs = right ? new Date(right).getTime() : 0;
    return Number.isFinite(leftTs) && leftTs > (Number.isFinite(rightTs) ? rightTs : 0);
}

function mapWhatsAppHistoryStatus(status) {
    const normalized = cleanString(status).toLowerCase();
    if (['sent', 'delivered', 'read', 'failed'].includes(normalized)) {
        return normalized;
    }
    if (['pending', 'played', 'error'].includes(normalized)) {
        return normalized === 'error' ? 'failed' : 'sent';
    }
    return 'sent';
}

function getWhatsAppInteractiveText(interactive) {
    if (!interactive || typeof interactive !== 'object') {
        return '';
    }
    return cleanString(
        interactive?.button_reply?.title ||
        interactive?.list_reply?.title ||
        interactive?.nfm_reply?.body ||
        interactive?.text ||
        interactive?.title ||
        ''
    );
}

function getWhatsAppMessageText(message) {
    const rawType = cleanString(message?.type).toLowerCase() || 'text';
    const text = cleanString(
        message?.text?.body ||
        message?.button?.text ||
        getWhatsAppInteractiveText(message?.interactive) ||
        message?.image?.caption ||
        message?.document?.caption ||
        message?.video?.caption ||
        message?.template?.name ||
        ''
    );
    if (text) {
        return text;
    }
    switch (rawType) {
        case 'audio':
            return 'Audio enviado desde WhatsApp';
        case 'image':
            return 'Imagen enviada desde WhatsApp';
        case 'document':
            return 'Documento enviado desde WhatsApp';
        case 'video':
            return 'Video enviado desde WhatsApp';
        case 'sticker':
            return 'Sticker enviado desde WhatsApp';
        case 'location':
            return 'Ubicación enviada desde WhatsApp';
        case 'media_placeholder':
            return 'Mensaje multimedia importado del historial';
        default:
            return rawType ? `Mensaje ${rawType} de WhatsApp` : 'Mensaje de WhatsApp';
    }
}

function getWhatsAppMediaPayload(message) {
    const rawType = cleanString(message?.type).toLowerCase();
    const media = message?.[rawType] || {};
    if (!rawType || ['text', 'button', 'interactive', 'template', 'reaction', 'edit', 'revoke'].includes(rawType)) {
        return null;
    }
    return {
        kind: rawType,
        id: cleanString(media?.id) || null,
        mime_type: cleanString(media?.mime_type) || null,
        sha256: cleanString(media?.sha256) || null,
        provider: 'whatsapp',
        stored: false,
        playable: Boolean(cleanString(media?.id)),
    };
}

function buildCoexistenceMessageDescriptor({ message, origin, sourceEvent, extra = {} }) {
    const rawType = cleanString(message?.type).toLowerCase() || 'text';
    const messageType = normalizeInboundMessageType(rawType);
    const content = getWhatsAppMessageText(message);
    const media = getWhatsAppMediaPayload(message);
    return {
        rawType,
        messageType,
        content,
        metadataExtra: {
            origin,
            source_event: sourceEvent,
            raw_type: rawType,
            coexistence: {
                source_event: sourceEvent,
                imported_at: new Date().toISOString(),
                ...extra,
            },
            ...(media ? { media } : {}),
        },
    };
}

async function findMessageByWamid(wamid) {
    if (!wamid) return null;
    const rows = await db.sequelize.query(
        `
        SELECT m.id, m.conversation_id, c.clinic_id
        FROM Messages m
        JOIN Conversations c ON c.id = m.conversation_id
        WHERE JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.wamid')) = :wamid
        ORDER BY m.id DESC
        LIMIT 1
        `,
        {
            replacements: { wamid },
            type: QueryTypes.SELECT,
        }
    );
    return rows?.[0] || null;
}

async function findWhatsappPhoneAssetForMetadata({ phoneId = null, wabaId = null, phoneNumber = null, clinicId = null } = {}) {
    if (!ClinicMetaAsset) {
        return null;
    }
    const baseWhere = {
        assetType: 'whatsapp_phone_number',
        isActive: true,
    };
    if (phoneId) {
        const asset = await ClinicMetaAsset.findOne({
            where: { ...baseWhere, phoneNumberId: phoneId },
        });
        if (asset) return asset;
    }
    if (wabaId) {
        const asset = await ClinicMetaAsset.findOne({
            where: { ...baseWhere, wabaId },
        });
        if (asset) return asset;
    }
    if (clinicId) {
        const asset = await ClinicMetaAsset.findOne({
            where: { ...baseWhere, clinicaId: clinicId },
            order: [['updatedAt', 'DESC']],
        });
        if (asset) return asset;
    }

    const phoneDigits = normalizePhoneDigits(phoneNumber);
    if (phoneDigits) {
        const localDigits = phoneDigits.length > 9 ? phoneDigits.slice(-9) : phoneDigits;
        const assets = await ClinicMetaAsset.findAll({ where: baseWhere });
        return assets.find((asset) => {
            const haystack = JSON.stringify({
                metaAssetName: asset.metaAssetName,
                phoneNumberId: asset.phoneNumberId,
                wabaId: asset.wabaId,
                additionalData: asset.additionalData,
            }).replace(/\D/g, '');
            return haystack.includes(phoneDigits) || (localDigits && haystack.includes(localDigits));
        }) || null;
    }

    return null;
}

async function updateWhatsappAssetCoexistenceMetadata({ phoneId = null, wabaId = null, phoneNumber = null, clinicId = null, patch }) {
    if (!ClinicMetaAsset) {
        return;
    }
    try {
        const asset = await findWhatsappPhoneAssetForMetadata({ phoneId, wabaId, phoneNumber, clinicId });
        if (!asset) {
            return;
        }
        const additionalData = asset.additionalData || {};
        asset.additionalData = {
            ...additionalData,
            coexistence: {
                ...(additionalData.coexistence || {}),
                ...patch,
                updated_at: new Date().toISOString(),
            },
        };
        await asset.save();
    } catch (error) {
        console.warn('[whatsapp coexistence] No se pudo actualizar metadata del activo', {
            phoneId,
            wabaId,
            phoneNumber,
            clinicId,
            error: serializeError(error),
        });
    }
}

async function emitMessageCreated({ message, conversation, clinicId, content, messageType, resumeText = null }) {
    const io = getIO();
    if (!io || !message || !conversation) {
        return;
    }
    const rooms = new Set();
    if (clinicId) rooms.add(`clinic:${clinicId}`);
    if (conversation?.clinic_id && Number(conversation.clinic_id) !== Number(clinicId)) {
        rooms.add(`clinic:${conversation.clinic_id}`);
    }
    if (conversation?.assignee_id) rooms.add(`user:${conversation.assignee_id}`);

    const payload = {
        id: message.id,
        conversation_id: String(conversation.id),
        content,
        direction: message.direction,
        message_type: messageType || message.message_type,
        status: message.status,
        sent_at: message.sent_at,
        metadata: message.metadata || null,
        ...(resumeText ? { resume_text: resumeText } : {}),
    };

    if (rooms.size === 0) {
        io.emit('message:created', payload);
        dlog('Emit message:created broadcast', { convId: conversation.id, clinicId, payload });
    } else {
        rooms.forEach((room) => io.to(room).emit('message:created', payload));
        dlog('Emit message:created rooms', { rooms: Array.from(rooms), payload });
    }
}

async function emitMessageUpdated({ message, clinicId }) {
    const io = getIO();
    if (!io || !message) {
        return;
    }
    const rooms = new Set();
    if (clinicId) rooms.add(`clinic:${clinicId}`);

    const payload = {
        id: message.id,
        conversation_id: String(message.conversation_id),
        status: message.status,
        content: message.content,
        message_type: message.message_type,
        sent_at: message.sent_at,
        metadata: message.metadata || null,
    };

    if (rooms.size === 0) {
        io.emit('message:updated', payload);
        dlog('Emit message:updated broadcast', { payload, rooms: [] });
    } else {
        rooms.forEach((room) => io.to(room).emit('message:updated', payload));
        dlog('Emit message:updated rooms', { rooms: Array.from(rooms), payload });
    }
}

async function updateConversationLastMessage(conversation, date, { inbound = false, incrementUnread = false } = {}) {
    if (!conversation) {
        return;
    }
    const patch = {};
    if (date && (!conversation.last_message_at || isDateAfter(date, conversation.last_message_at))) {
        patch.last_message_at = date;
    }
    if (inbound && date && (!conversation.last_inbound_at || isDateAfter(date, conversation.last_inbound_at))) {
        patch.last_inbound_at = date;
    }
    if (incrementUnread) {
        patch.unread_count = (conversation.unread_count || 0) + 1;
    }
    if (Object.keys(patch).length) {
        await conversation.update(patch);
        Object.assign(conversation, patch);
    }
}

function mergeStatusMetadata(existingMetadata, status) {
    const metadata = existingMetadata || {};
    const history = Array.isArray(metadata.wa_status_history)
        ? metadata.wa_status_history
        : [];
    const statusTimestamps = metadata.wa_status_timestamps && typeof metadata.wa_status_timestamps === 'object'
        ? { ...metadata.wa_status_timestamps }
        : {};
    const entry = {
        status: status.status,
        timestamp: status.timestamp,
        recipient_id: status.recipient_id || null,
        conversation: status.conversation || null,
        pricing: status.pricing || null,
        errors: status.errors || null,
    };
    history.push(entry);
    const normalizedStatus = mapWhatsAppStatus(status.status);
    if (normalizedStatus && status.timestamp) {
        statusTimestamps[normalizedStatus] = status.timestamp;
    }
    return {
        ...metadata,
        wa_status: entry,
        wa_status_history: history,
        wa_status_timestamps: statusTimestamps,
        wa_error: status.errors || metadata.wa_error || null,
    };
}

function getWhatsappStatusErrors(status) {
    return Array.isArray(status?.errors) ? status.errors : [];
}

function findWhatsappPaymentMissingError(status) {
    return getWhatsappStatusErrors(status).find((error) => Number(error?.code) === WHATSAPP_PAYMENT_MISSING_ERROR_CODE) || null;
}

async function notifyWhatsappPaymentMissing({ status, message, clinicId }) {
    const paymentError = findWhatsappPaymentMissingError(status);
    if (!paymentError || !message) {
        return;
    }

    const metadata = message.metadata || {};
    const resolvedClinicId = Number(clinicId || 0) || null;
    const phoneId = metadata.phoneId || metadata.phoneNumberId || null;
    const wabaId = metadata.wabaId || null;
    const href = cleanString(paymentError.href);
    const errorMessage = cleanString(paymentError?.error_data?.details)
        || cleanString(paymentError.message)
        || 'Meta indica que falta un método de pago en WhatsApp Business.';

    try {
        const asset = await findWhatsappPhoneAssetForMetadata({
            phoneId,
            wabaId,
            clinicId: resolvedClinicId,
        });
        if (asset) {
            const additionalData = asset.additionalData || {};
            asset.additionalData = {
                ...additionalData,
                payment: {
                    ...(additionalData.payment || {}),
                    status: 'missing_payment_method',
                    last_error_code: WHATSAPP_PAYMENT_MISSING_ERROR_CODE,
                    last_error_message: errorMessage,
                    last_error_href: href || null,
                    last_detected_at: new Date().toISOString(),
                    last_message_id: message.id,
                    last_wamid: cleanString(metadata.wamid),
                },
            };
            await asset.save();
        }
    } catch (assetError) {
        console.warn('[whatsapp] No se pudo marcar falta de método de pago en el asset', {
            clinicId: resolvedClinicId,
            phoneId,
            wabaId,
            error: serializeError(assetError),
        });
    }

    try {
        const clinic = resolvedClinicId && Clinica
            ? await Clinica.findByPk(resolvedClinicId, {
                attributes: ['id_clinica', 'nombre_clinica'],
                raw: true,
            })
            : null;

        await notificationService.dispatchEvent({
            event: 'whatsapp.payment_missing',
            clinicId: resolvedClinicId,
            data: {
                clinicId: resolvedClinicId,
                clinicName: cleanString(clinic?.nombre_clinica),
                phoneNumber: cleanString(metadata.recipient) || cleanString(status?.recipient_id),
                phoneNumberId: phoneId,
                wabaId,
                messageId: message.id,
                wamid: cleanString(metadata.wamid),
                errorCode: WHATSAPP_PAYMENT_MISSING_ERROR_CODE,
                errorMessage,
                href: href || null,
            },
        });
    } catch (notificationError) {
        console.warn('[whatsapp] No se pudo crear notificación por método de pago ausente', {
            clinicId: resolvedClinicId,
            messageId: message.id,
            error: serializeError(notificationError),
        });
    }
}

function createBusinessWorker(name, processor) {
    if (IS_GATEWAY_RUNTIME) {
        console.log(`[Queue ${name}] worker deshabilitado en runtime gateway`);
        return null;
    }
    return createWorker(name, processor);
}

// Procesa envíos salientes de WhatsApp
createBusinessWorker('outbound_whatsapp', async (job) => {
    const {
        messageId,
        conversationId,
        to,
        body,
        useTemplate,
        templateName,
        templateLanguage,
        templateParams,
        templateComponents,
        clinicConfig,
    } = job.data;

    const msg = await Message.findByPk(messageId);
    if (!msg) {
        throw new Error(`Mensaje ${messageId} no encontrado`);
    }
    const currentStatus = String(msg.status || '').toLowerCase();
    if (['sent', 'delivered', 'read'].includes(currentStatus)) {
        console.log(`[outbound_whatsapp] Mensaje ${messageId} ya enviado; se omite job pendiente`);
        return;
    }

    msg.status = 'sending';
    await msg.save();

    try {
        const waResponse = await whatsappService.sendMessage({
            to,
            body,
            useTemplate,
            templateName,
            templateLanguage,
            templateParams,
            templateComponents,
            clinicConfig,
        });
        msg.status = 'sent';
        msg.metadata = { ...(msg.metadata || {}), wa_response: waResponse, wamid: waResponse?.messages?.[0]?.id };
        msg.sent_at = new Date();
        await msg.save();

        await whatsappConnectionStatusService.clearDisconnectedAfterSuccess({
            clinicId: clinicConfig?.clinicId || null,
            phoneId: clinicConfig?.phoneNumberId || msg.metadata?.phoneNumberId || msg.metadata?.phoneId || null,
            wabaId: clinicConfig?.wabaId || msg.metadata?.wabaId || null,
            messageId: msg.id,
            source: 'outbound_whatsapp_worker',
        }).catch(() => null);

        const conv = await Conversation.findByPk(conversationId);
        if (conv) {
            conv.last_message_at = new Date();
            await conv.save();
        }

        const io = getIO();
        if (io) {
            const room = conv ? `clinic:${conv.clinic_id}` : null;
            if (room) {
                io.to(room).emit('message:updated', { id: msg.id, conversation_id: conversationId, status: msg.status });
            } else {
                io.emit('message:updated', { id: msg.id, conversation_id: conversationId, status: msg.status });
            }
        }
    } catch (err) {
        msg.status = 'failed';
        msg.metadata = { ...(msg.metadata || {}), error: err?.response?.data || err.message };
        await msg.save();

        // Si Meta indica que el numero no esta registrado, marcamos el estado
        // para forzar el paso de registro en el frontend.
        try {
            const rawError = err?.response?.data;
            const nestedError = rawError?.error?.error || rawError?.error || {};
            const errorCode = nestedError?.code || null;
            const errorMessage = nestedError?.message || err?.message || 'whatsapp_send_failed';
            if (errorCode === 133010 && clinicConfig?.phoneNumberId) {
                const asset = await ClinicMetaAsset.findOne({
                    where: {
                        assetType: 'whatsapp_phone_number',
                        phoneNumberId: clinicConfig.phoneNumberId,
                        isActive: true,
                    },
                });
                if (asset) {
                    const additionalData = asset.additionalData || {};
                    additionalData.registration = {
                        ...(additionalData.registration || {}),
                        status: 'not_registered',
                        requiresPin: true,
                        lastAttemptAt: new Date().toISOString(),
                        lastErrorCode: errorCode,
                        lastErrorMessage: errorMessage,
                    };
                    asset.additionalData = additionalData;
                    await asset.save();
                }
            }

            await whatsappConnectionStatusService.markDisconnectedAfterProviderError({
                error: rawError || err,
                clinicId: clinicConfig?.clinicId || null,
                phoneId: clinicConfig?.phoneNumberId || msg.metadata?.phoneNumberId || msg.metadata?.phoneId || null,
                wabaId: clinicConfig?.wabaId || msg.metadata?.wabaId || null,
                messageId: msg.id,
                recipient: to || msg.metadata?.recipient || null,
                source: 'outbound_whatsapp_worker',
            });
        } catch (regErr) {
            console.warn('[outbound_whatsapp] No se pudo actualizar estado de registro', regErr?.message || regErr);
        }

        const io = getIO();
        if (io) {
            io.emit('message:updated', { id: msg.id, conversation_id: conversationId, status: msg.status, error: msg.metadata?.error });
        }
        // No re-lanzamos para evitar reintentos infinitos con token inválido
    }
});

async function handleWhatsappMessageEdit({ msg, clinicId }) {
    const originalWamid = cleanString(msg?.edit?.original_message_id);
    if (!originalWamid) {
        return;
    }
    const messageRef = await findMessageByWamid(originalWamid);
    if (!messageRef) {
        return;
    }
    const message = await Message.findByPk(messageRef.id);
    if (!message) {
        return;
    }
    const editedPayload = msg?.edit?.message || {};
    const descriptor = buildCoexistenceMessageDescriptor({
        message: editedPayload,
        origin: message.metadata?.origin || null,
        sourceEvent: 'edit',
    });
    const editedAt = parseWhatsappTimestamp(msg?.timestamp);
    const currentMetadata = message.metadata || {};
    message.content = descriptor.content || message.content;
    message.metadata = {
        ...currentMetadata,
        edited_at: editedAt.toISOString(),
        edit: {
            wamid: cleanString(msg?.id) || null,
            original_message_id: originalWamid,
            raw_type: descriptor.rawType,
        },
        coexistence: {
            ...(currentMetadata.coexistence || {}),
            last_event: 'edit',
            edited_at: editedAt.toISOString(),
        },
    };
    await message.save();
    await emitMessageUpdated({ message, clinicId: messageRef.clinic_id || clinicId });
}

async function handleWhatsappMessageRevoke({ msg, clinicId }) {
    const originalWamid = cleanString(msg?.revoke?.original_message_id);
    if (!originalWamid) {
        return;
    }
    const messageRef = await findMessageByWamid(originalWamid);
    if (!messageRef) {
        return;
    }
    const message = await Message.findByPk(messageRef.id);
    if (!message) {
        return;
    }
    const revokedAt = parseWhatsappTimestamp(msg?.timestamp);
    const currentMetadata = message.metadata || {};
    message.metadata = {
        ...currentMetadata,
        revoked_at: revokedAt.toISOString(),
        revoke: {
            wamid: cleanString(msg?.id) || null,
            original_message_id: originalWamid,
        },
        coexistence: {
            ...(currentMetadata.coexistence || {}),
            last_event: 'revoke',
            revoked_at: revokedAt.toISOString(),
        },
    };
    await message.save();
    await emitMessageUpdated({ message, clinicId: messageRef.clinic_id || clinicId });
}

async function createCoexistenceConversationMessage({
    rawMessage,
    clinicId,
    patientId = null,
    leadId = null,
    contactId,
    direction,
    origin,
    sourceEvent,
    sentAt,
    phoneId,
    extraMetadata = {},
    status = 'sent',
    updateUnread = false,
}) {
    const wamid = cleanString(rawMessage?.id);
    if (!wamid) {
        return null;
    }

    const existingRef = await findMessageByWamid(wamid);
    if (existingRef) {
        return null;
    }

    const normalizedContactId = normalizeWhatsappContactId(contactId);
    if (!normalizedContactId) {
        return null;
    }

    const descriptor = buildCoexistenceMessageDescriptor({
        message: rawMessage,
        origin,
        sourceEvent,
        extra: extraMetadata?.coexistence || {},
    });

    const conv = await findCanonicalWhatsappConversation({
        clinicId,
        contactId: normalizedContactId,
        patientId,
        leadId,
        createIfMissing: true,
        lastMessageAt: sentAt,
    });
    if (!conv) {
        return null;
    }

    const message = await Message.create({
        conversation_id: conv.id,
        sender_id: null,
        direction,
        content: descriptor.content,
        message_type: descriptor.messageType,
        status,
        metadata: {
            wamid,
            phoneId,
            ...descriptor.metadataExtra,
            ...extraMetadata,
            coexistence: {
                ...(descriptor.metadataExtra.coexistence || {}),
                ...(extraMetadata.coexistence || {}),
            },
        },
        sent_at: sentAt,
    });

    await updateConversationLastMessage(conv, sentAt, {
        inbound: direction === 'inbound' && updateUnread,
        incrementUnread: updateUnread,
    });
    await emitMessageCreated({
        message,
        conversation: conv,
        clinicId,
        content: descriptor.content,
        messageType: descriptor.messageType,
    });

    return { message, conversation: conv };
}

async function handleWhatsappCoexistenceEchoes({ echoes, value, clinicId, patientId, leadId }) {
    if (!Array.isArray(echoes) || !echoes.length) {
        return;
    }
    const phoneId = value?.metadata?.phone_number_id || null;
    let imported = 0;
    for (const echo of echoes) {
        const sentAt = parseWhatsappTimestamp(echo?.timestamp);
        const result = await createCoexistenceConversationMessage({
            rawMessage: echo,
            clinicId,
            patientId,
            leadId,
            contactId: echo?.to,
            direction: 'outbound',
            origin: 'mobile_app',
            sourceEvent: 'smb_message_echoes',
            sentAt,
            phoneId,
            extraMetadata: {
                coexistence: {
                    from_business_phone: echo?.from || null,
                },
            },
            status: 'sent',
            updateUnread: false,
        });
        if (result) {
            imported += 1;
        }
    }
    await updateWhatsappAssetCoexistenceMetadata({
        phoneId,
        patch: {
            last_echo_at: new Date().toISOString(),
            last_echo_imported_count: imported,
        },
    });
}

async function handleWhatsappHistoryBlocks({ historyBlocks, value, clinicId, patientId, leadId }) {
    if (!Array.isArray(historyBlocks) || !historyBlocks.length) {
        return;
    }
    const phoneId = value?.metadata?.phone_number_id || null;
    let imported = 0;
    let rejectedError = null;

    for (const block of historyBlocks) {
        const errors = Array.isArray(block?.errors) ? block.errors : [];
        if (errors.length) {
            rejectedError = errors[0] || null;
            continue;
        }

        const metadata = block?.metadata || {};
        const threads = Array.isArray(block?.threads) ? block.threads : [];
        for (const thread of threads) {
            const threadContactId = thread?.id;
            const messages = Array.isArray(thread?.messages) ? thread.messages : [];
            for (const historyMessage of messages) {
                const sentAt = parseWhatsappTimestamp(historyMessage?.timestamp);
                const businessDigits = normalizePhoneDigits(value?.metadata?.display_phone_number);
                const fromDigits = normalizePhoneDigits(historyMessage?.from);
                const isOutbound = Boolean(historyMessage?.to) || (businessDigits && fromDigits === businessDigits);
                const contactId = isOutbound
                    ? (historyMessage?.to || threadContactId)
                    : (historyMessage?.from || threadContactId);
                const status = mapWhatsAppHistoryStatus(historyMessage?.history_context?.status);

                const result = await createCoexistenceConversationMessage({
                    rawMessage: historyMessage,
                    clinicId,
                    // Un webhook history puede traer miles de hilos; no heredamos
                    // patientId/leadId del primer contacto resuelto por la ruta.
                    patientId: null,
                    leadId: null,
                    contactId,
                    direction: isOutbound ? 'outbound' : 'inbound',
                    origin: 'history_import',
                    sourceEvent: 'history',
                    sentAt,
                    phoneId,
                    extraMetadata: {
                        history_context: historyMessage?.history_context || null,
                        coexistence: {
                            history_phase: metadata?.phase ?? null,
                            history_chunk_order: metadata?.chunk_order ?? null,
                            history_progress: metadata?.progress ?? null,
                        },
                    },
                    status,
                    updateUnread: false,
                });
                if (result) {
                    imported += 1;
                }
            }
        }
    }

    await updateWhatsappAssetCoexistenceMetadata({
        phoneId,
        patch: rejectedError
            ? {
                history_sync_status: 'rejected',
                history_sync_error: rejectedError,
                history_sync_last_at: new Date().toISOString(),
            }
            : {
                history_sync_status: 'syncing',
                history_sync_last_at: new Date().toISOString(),
                history_sync_last_imported_count: imported,
                ...(historyBlocks.some((block) => Number(block?.metadata?.progress) >= 100)
                    ? { history_sync_status: 'completed' }
                    : {}),
            },
    });
}

async function handleWhatsappStateSync({ stateSync, value }) {
    if (!Array.isArray(stateSync) || !stateSync.length) {
        return;
    }
    const phoneId = value?.metadata?.phone_number_id || null;
    await updateWhatsappAssetCoexistenceMetadata({
        phoneId,
        patch: {
            contacts_sync_status: 'completed',
            contacts_sync_last_at: new Date().toISOString(),
            contacts_sync_last_count: stateSync.length,
        },
    });
}

function normalizeWhatsappAccountEvent(value) {
    const event = cleanString(value?.event).toUpperCase();
    if (event === 'PARTNER_REMOVED' || event === 'ACCOUNT_OFFBOARDED') {
        return {
            event,
            status: 'disconnected',
            canSendApi: false,
            severity: 'error',
        };
    }
    if (event === 'ACCOUNT_RECONNECTED') {
        return {
            event,
            status: 'active',
            canSendApi: true,
            severity: 'info',
        };
    }
    return {
        event: event || 'ACCOUNT_UPDATE',
        status: 'updated',
        canSendApi: null,
        severity: 'info',
    };
}

async function handleWhatsappAccountUpdate({ entry, changes, value, clinicId }) {
    const field = cleanString(changes?.field).toLowerCase();
    const event = cleanString(value?.event).toUpperCase();
    if (field !== 'account_update' && !['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED'].includes(event)) {
        return;
    }

    const phoneId = value?.metadata?.phone_number_id || null;
    const wabaId = entry?.id || value?.waba_id || null;
    const phoneNumber = value?.phone_number || value?.metadata?.display_phone_number || null;
    const normalized = normalizeWhatsappAccountEvent(value);
    const disconnectionInfo = value?.disconnection_info || null;

    const patch = {
        account_update_last_at: new Date().toISOString(),
        account_update_last_event: normalized.event,
        coexistence_status: normalized.status,
        can_send_api: normalized.canSendApi,
        last_account_update: {
            event: normalized.event,
            field: field || null,
            phone_number: phoneNumber || null,
            disconnection_info: disconnectionInfo,
            raw: value || null,
        },
    };

    if (normalized.status === 'disconnected') {
        patch.disconnected_at = new Date().toISOString();
        patch.last_coexistence_error = {
            event: normalized.event,
            reason: disconnectionInfo?.reason || null,
            initiated_by: disconnectionInfo?.initiated_by || null,
        };
    }
    if (normalized.status === 'active') {
        patch.reconnected_at = new Date().toISOString();
        patch.last_coexistence_error = null;
    }

    if (normalized.status === 'active') {
        try {
            await whatsappConnectionStatusService.clearDisconnectedAfterSuccess({
                clinicId,
                phoneId,
                wabaId,
                source: 'whatsapp_account_update',
            });
        } catch (cleanupError) {
            console.warn('[whatsapp coexistence] No se pudo limpiar alertas tras account_update activo', {
                clinicId,
                phoneId,
                wabaId,
                error: serializeError(cleanupError),
            });
        }
    }

    await updateWhatsappAssetCoexistenceMetadata({
        phoneId,
        wabaId,
        phoneNumber,
        clinicId,
        patch,
    });

    if (normalized.status === 'disconnected') {
        try {
            const clinic = clinicId && Clinica
                ? await Clinica.findByPk(clinicId, {
                    attributes: ['id_clinica', 'nombre_clinica'],
                    raw: true,
                })
                : null;
            const params = new URLSearchParams();
            params.set('tab', 'whatsapp');
            params.set('action', 'reconnect_whatsapp');
            if (phoneId) params.set('phoneNumberId', String(phoneId));
            if (wabaId) params.set('wabaId', String(wabaId));

            await notificationService.dispatchEvent({
                event: 'whatsapp.coexistence_disconnected',
                clinicId: clinicId || null,
                data: {
                    clinicId: clinicId || null,
                    clinicName: clinic?.nombre_clinica || null,
                    phoneNumberId: phoneId || null,
                    wabaId: wabaId || null,
                    phoneNumber: phoneNumber || null,
                    disconnectReason: disconnectionInfo?.reason || null,
                    disconnectInitiatedBy: disconnectionInfo?.initiated_by || null,
                    source: 'whatsapp_account_update',
                    link: `/ajustes?${params.toString()}`,
                    useRouter: true,
                    actionLabel: 'Reconectar WhatsApp',
                    actionIcon: 'heroicons_outline:arrow-path',
                },
            });
        } catch (notificationError) {
            console.warn('[whatsapp coexistence] No se pudo crear notificación de account_update', {
                clinicId,
                phoneId,
                wabaId,
                error: serializeError(notificationError),
            });
        }
        console.warn('[whatsapp coexistence] Cuenta desconectada por Meta', {
            clinicId,
            phoneId,
            wabaId,
            phoneNumber,
            event: normalized.event,
            disconnectionInfo,
        });
    } else {
        dlog('[whatsapp coexistence] account_update procesado', {
            clinicId,
            phoneId,
            wabaId,
            phoneNumber,
            event: normalized.event,
        });
    }
}

// Procesa webhooks entrantes de WhatsApp
createWorker('webhook_whatsapp', async (job) => {
    const payload = job.data?.body;
    const clinicId = job.data?.clinic_id;
    const patientId = job.data?.patient_id || null;
    const leadId = job.data?.lead_id || null;
    const webOriginRefFromJob = job.data?.web_origin_ref || null;

    if (!payload || !clinicId) {
        throw new Error('Payload o clinic_id ausente en webhook de WhatsApp');
    }

    const entry = payload?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages || [];
    const statuses = value?.statuses || [];
    const historyBlocks = value?.history || [];
    const echoes = value?.message_echoes || [];
    const stateSync = value?.state_sync || [];

    let webOrigin = null;
    if (webOriginRefFromJob && WhatsAppWebOrigin) {
        try {
            webOrigin = await WhatsAppWebOrigin.findOne({ where: { ref: String(webOriginRefFromJob).toLowerCase() }, raw: true });
            if (webOrigin?.expires_at && new Date(webOrigin.expires_at).getTime() < Date.now()) {
                webOrigin = null;
            }
        } catch (e) {
            webOrigin = null;
        }
    }

    await handleWhatsappAccountUpdate({ entry, changes, value, clinicId });
    await handleWhatsappStateSync({ stateSync, value });
    await handleWhatsappHistoryBlocks({ historyBlocks, value, clinicId, patientId, leadId });
    await handleWhatsappCoexistenceEchoes({ echoes, value, clinicId, patientId, leadId });

    for (const msg of messages) {
        const phoneId = value?.metadata?.phone_number_id;
        const from = msg.from;
        const wamid = msg.id;
        const rawType = cleanString(msg?.type).toLowerCase();

        if (rawType === 'edit') {
            await handleWhatsappMessageEdit({ msg, clinicId });
            continue;
        }
        if (rawType === 'revoke') {
            await handleWhatsappMessageRevoke({ msg, clinicId });
            continue;
        }

        if (!wamid) {
            continue;
        }
        if (!from) {
            continue;
        }
        const existingMessage = await findMessageByWamid(wamid);
        if (existingMessage) {
            continue;
        }

        const descriptor = await buildInboundMessageDescriptor({ msg, clinicId });
        const webOriginRefFromMsg = descriptor.webOriginRef || null;
        const content = descriptor.content;
        const resumeText = descriptor.resumeText;

        // Si no venía en el job, intentamos recuperar por token del propio mensaje (primer mensaje típicamente).
        if (!webOrigin && webOriginRefFromMsg && WhatsAppWebOrigin) {
            try {
                webOrigin = await WhatsAppWebOrigin.findOne({ where: { ref: String(webOriginRefFromMsg).toLowerCase() }, raw: true });
                if (webOrigin?.expires_at && new Date(webOrigin.expires_at).getTime() < Date.now()) {
                    webOrigin = null;
                }
            } catch (e) {
                webOrigin = null;
            }
        }

        const conv = await findCanonicalWhatsappConversation({
            clinicId,
            contactId: `+${from}`.replace('++', '+'),
            patientId,
            leadId,
            createIfMissing: true,
            lastMessageAt: new Date(),
        });

        const inboundMsg = await Message.create({
            conversation_id: conv.id,
            sender_id: null,
            direction: 'inbound',
            content,
            message_type: descriptor.messageType,
            status: 'sent',
            metadata: {
                wamid,
                phoneId,
                ...descriptor.metadataExtra,
                ...(webOrigin ? { web_origin_ref: webOrigin.ref, web_origin: {
                    id: webOrigin.id || null,
                    clinic_id: webOrigin.clinic_id || null,
                    group_id: webOrigin.group_id || null,
                    domain: webOrigin.domain || null,
                    page_url: webOrigin.page_url || null,
                    referrer: webOrigin.referrer || null,
                    utm_source: webOrigin.utm_source || null,
                    utm_medium: webOrigin.utm_medium || null,
                    utm_campaign: webOrigin.utm_campaign || null,
                    gclid: webOrigin.gclid || null,
                    gbraid: webOrigin.gbraid || null,
                    wbraid: webOrigin.wbraid || null,
                    ga_client_id: webOrigin.ga_client_id || null,
                    fbclid: webOrigin.fbclid || null,
                    ttclid: webOrigin.ttclid || null,
                } } : {}),
            },
            sent_at: new Date(),
        });

        try {
            const optOutResult = await marketingOptOutService.applyInboundOptOutIfNeeded({
                clinicId: conv.clinic_id || clinicId,
                conversation: conv,
                inboundMessage: inboundMsg,
                rawText: resumeText || content,
                patientId: conv.patient_id || patientId || null,
            });
            if (optOutResult?.applied) {
                inboundMsg.metadata = {
                    ...(inboundMsg.metadata || {}),
                    marketing_opt_out: optOutResult,
                };
                await inboundMsg.save();
            }
        } catch (optOutErr) {
            console.warn('[marketing opt-out] No se pudo procesar baja por WhatsApp', {
                clinicId: conv.clinic_id || clinicId,
                conversationId: conv.id,
                inboundMessageId: inboundMsg.id,
                error: serializeError(optOutErr),
            });
        }

        try {
            await marketingBulkSendsService.materializeInboundReply({
                conversation: conv,
                inboundMessage: inboundMsg,
            });
        } catch (bulkReplyErr) {
            console.warn('[marketing bulk sends] No se pudo materializar respuesta inbound', {
                clinicId: conv.clinic_id || clinicId,
                conversationId: conv.id,
                inboundMessageId: inboundMsg.id,
                error: serializeError(bulkReplyErr),
            });
        }

        // Marcar el origen como "usado" para depuración/dedupe. No bloqueamos si falla.
        if (webOrigin && WhatsAppWebOrigin && !webOrigin.used_at) {
            try {
                await WhatsAppWebOrigin.update(
                    {
                        used_at: new Date(),
                        used_conversation_id: conv.id,
                        used_message_id: inboundMsg.id,
                        from_phone: from || null,
                        phone_number_id: phoneId || null,
                    },
                    { where: { id: webOrigin.id, used_at: null } }
                );
                webOrigin.used_at = new Date();
            } catch (e) {
                // ignore
            }
        }

        conv.last_message_at = new Date();
        conv.last_inbound_at = new Date();
        conv.unread_count = (conv.unread_count || 0) + 1;
        await conv.save();

        try {
            let resumeResult = await automationsV2ResumeService.enqueueInboundResponseResume({
                clinicId: conv.clinic_id || clinicId,
                conversationId: conv.id,
                patientId: conv.patient_id || null,
                leadId: conv.lead_id || null,
                messageText: resumeText,
                inboundMessageId: inboundMsg.id,
                channel: 'whatsapp',
            });

            if ((!resumeResult?.matched || resumeResult?.errors?.length) && conv?.id) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                const retryResult = await automationsV2ResumeService.enqueueInboundResponseResume({
                    clinicId: conv.clinic_id || clinicId,
                    conversationId: conv.id,
                    patientId: conv.patient_id || null,
                    leadId: conv.lead_id || null,
                    messageText: resumeText,
                    inboundMessageId: inboundMsg.id,
                    channel: 'whatsapp',
                });
                resumeResult = retryResult;
            }

            dlog('Automations v2 inbound auto-resume', {
                conversationId: conv.id,
                clinicId: conv.clinic_id || clinicId,
                ...resumeResult,
            });

            if (!resumeResult?.matched || resumeResult?.errors?.length) {
                console.warn('[automations-v2] Inbound auto-resume without effective match', {
                    conversationId: conv.id,
                    clinicId: conv.clinic_id || clinicId,
                    patientId: conv.patient_id || null,
                    leadId: conv.lead_id || null,
                    matched: resumeResult?.matched || 0,
                    errors: resumeResult?.errors || [],
                });
            }
        } catch (resumeErr) {
            console.error('[automations-v2] Error en auto-resume inbound', resumeErr?.message || resumeErr);
        }

        const io = getIO();
        if (io) {
            const rooms = new Set();
            if (clinicId) rooms.add(`clinic:${clinicId}`);
            if (conv?.clinic_id && conv.clinic_id !== clinicId) rooms.add(`clinic:${conv.clinic_id}`);
            if (conv?.assignee_id) rooms.add(`user:${conv.assignee_id}`);

            const payload = {
                id: inboundMsg.id,
                conversation_id: String(conv.id),
                content,
                direction: 'inbound',
                message_type: descriptor.messageType,
                status: 'sent',
                sent_at: inboundMsg.sent_at,
                metadata: inboundMsg.metadata || null,
                resume_text: resumeText,
            };

            if (rooms.size === 0) {
                io.emit('message:created', payload);
                dlog('Emit inbound message:created broadcast', { convId: conv.id, clinicId, assignee: conv.assignee_id, payload });
            } else {
                rooms.forEach((r) => io.to(r).emit('message:created', payload));
                dlog('Emit inbound message:created rooms', { rooms: Array.from(rooms), payload });
            }
        } else {
            dlog('Inbound message created but IO not available', conv.id);
        }
    }

    // Procesar estados de entrega/lectura/fallo
    for (const status of statuses) {
        const wamid = status?.id;
        const mappedStatus = mapWhatsAppStatus(status?.status);
        if (!wamid || !mappedStatus) {
            continue;
        }

        const messageRef = await findMessageByWamid(wamid);
        if (!messageRef) {
            continue;
        }

        const message = await Message.findByPk(messageRef.id);
        if (!message) {
            continue;
        }

        // No degradar estados: solo avanzamos
        const currentStatus = (message.status || '').toLowerCase();
        const nextStatus = mappedStatus;
        const order = ['pending', 'sending', 'sent', 'delivered', 'read', 'failed'];
        const currentIdx = order.indexOf(currentStatus);
        const nextIdx = order.indexOf(nextStatus);
        if (currentIdx !== -1 && nextIdx !== -1 && nextIdx < currentIdx) {
            continue;
        }

        message.status = nextStatus;
        if (nextStatus === 'sent' && status?.timestamp && !message.sent_at) {
            const tsMs = Number(status.timestamp) * 1000;
            if (!Number.isNaN(tsMs)) {
                message.sent_at = new Date(tsMs);
            }
        }
        message.metadata = mergeStatusMetadata(message.metadata, status);
        await message.save();

        if (['sent', 'delivered', 'read'].includes(nextStatus)) {
            try {
                await whatsappPaymentStatusService.clearMissingPaymentAfterSuccessfulStatus({
                    clinicId: messageRef.clinic_id || clinicId,
                    phoneId: message.metadata?.phoneId || message.metadata?.phoneNumberId || null,
                    wabaId: message.metadata?.wabaId || null,
                    messageId: message.id,
                    wamid,
                    status: nextStatus,
                });
            } catch (paymentClearError) {
                console.warn('[whatsapp] No se pudo limpiar estado de pago tras status correcto', {
                    clinicId: messageRef.clinic_id || clinicId,
                    messageId: message.id,
                    status: nextStatus,
                    error: serializeError(paymentClearError),
                });
            }
            try {
                await whatsappConnectionStatusService.clearDisconnectedAfterSuccess({
                    clinicId: messageRef.clinic_id || clinicId,
                    phoneId: message.metadata?.phoneId || message.metadata?.phoneNumberId || null,
                    wabaId: message.metadata?.wabaId || null,
                    messageId: message.id,
                    source: `whatsapp_status_${nextStatus}`,
                });
            } catch (connectionClearError) {
                console.warn('[whatsapp] No se pudo limpiar desconexión coexistence tras status correcto', {
                    clinicId: messageRef.clinic_id || clinicId,
                    messageId: message.id,
                    status: nextStatus,
                    error: serializeError(connectionClearError),
                });
            }
        }

        if (nextStatus === 'failed') {
            await notifyWhatsappPaymentMissing({
                status,
                message,
                clinicId: messageRef.clinic_id || clinicId,
            });
        }

        try {
            await marketingBulkSendsService.materializeMessageStatusFromWebhook({
                message,
                status,
                mappedStatus: nextStatus,
            });
        } catch (bulkStatusErr) {
            console.warn('[marketing bulk sends] No se pudo materializar estado WhatsApp', {
                clinicId: messageRef.clinic_id || clinicId,
                messageId: message.id,
                wamid,
                status: nextStatus,
                error: serializeError(bulkStatusErr),
            });
        }

        await emitMessageUpdated({ message, clinicId: messageRef.clinic_id || clinicId });
    }
});

// Crea plantillas desde catálogo para un WABA
createBusinessWorker('whatsapp_template_create', async (job) => {
    if (job.name === 'propagate_catalog_item') {
        await whatsappTemplatesService.propagateCatalogTemplateToAllClinics(job.data || {});
        return;
    }
    await whatsappTemplatesService.createTemplatesFromCatalog(job.data || {});
});

// Sincroniza estados de plantillas desde Meta
createBusinessWorker('whatsapp_template_sync', async (job) => {
    await whatsappTemplatesService.syncTemplatesForWaba(job.data || {});
});

// Sincroniza numeros de telefono desde Meta para evitar estados stale
createBusinessWorker('whatsapp_phone_sync', async (job) => {
    await whatsappPhonesService.syncPhonesForWaba(job.data || {});
});

// Crea automatizaciones y plantillas predefinidas al crear clínica
createBusinessWorker('automation_defaults', async (job) => {
    await automationDefaultsService.createDefaultAutomationsForClinic(job.data || {});
});
