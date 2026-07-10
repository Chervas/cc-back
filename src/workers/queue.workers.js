'use strict';
const { QueryTypes } = require('sequelize');
const { createWorker } = require('../services/queue.service');
const whatsappService = require('../services/whatsapp.service');
const groqAudioService = require('../services/groqAudio.service');
const whatsappTemplatesService = require('../services/whatsappTemplates.service');
const whatsappPhonesService = require('../services/whatsappPhones.service');
const automationDefaultsService = require('../services/automationDefaults.service');
const automationsV2ResumeService = require('../services/automationsV2Resume.service');
const { getIO } = require('../services/socket.service');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');
const db = require('../../models');

const { Conversation, Message, ClinicMetaAsset, WhatsAppWebOrigin } = db;

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

    if (rawType && !['text', 'button', 'interactive'].includes(rawType)) {
        metadataExtra.media = {
            kind: rawType,
        };
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

function mergeStatusMetadata(existingMetadata, status) {
    const metadata = existingMetadata || {};
    const history = Array.isArray(metadata.wa_status_history)
        ? metadata.wa_status_history
        : [];
    const entry = {
        status: status.status,
        timestamp: status.timestamp,
        recipient_id: status.recipient_id || null,
        conversation: status.conversation || null,
        pricing: status.pricing || null,
        errors: status.errors || null,
    };
    history.push(entry);
    return {
        ...metadata,
        wa_status: entry,
        wa_status_history: history,
        wa_error: status.errors || metadata.wa_error || null,
    };
}

// Procesa envíos salientes de WhatsApp
createWorker('outbound_whatsapp', async (job) => {
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

    for (const msg of messages) {
        const phoneId = value?.metadata?.phone_number_id;
        const from = msg.from;
        const wamid = msg.id;
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
                    fbclid: webOrigin.fbclid || null,
                    ttclid: webOrigin.ttclid || null,
                } } : {}),
            },
            sent_at: new Date(),
        });

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
        if (status?.timestamp) {
            const tsMs = Number(status.timestamp) * 1000;
            if (!Number.isNaN(tsMs)) {
                message.sent_at = new Date(tsMs);
            }
        }
        message.metadata = mergeStatusMetadata(message.metadata, status);
        await message.save();

        const io = getIO();
        if (io) {
            const rooms = new Set();
            const roomClinicId = messageRef.clinic_id || clinicId;
            if (roomClinicId) rooms.add(`clinic:${roomClinicId}`);
            if (messageRef.assignee_id) rooms.add(`user:${messageRef.assignee_id}`);

            const payload = {
                id: message.id,
                conversation_id: String(message.conversation_id),
                status: message.status,
            };

            if (rooms.size === 0) {
                io.emit('message:updated', payload);
                dlog('Emit message:updated broadcast', { payload, rooms: [] });
            } else {
                rooms.forEach((r) => io.to(r).emit('message:updated', payload));
                dlog('Emit message:updated rooms', { rooms: Array.from(rooms), payload });
            }
        }
    }
});

// Crea plantillas desde catálogo para un WABA
createWorker('whatsapp_template_create', async (job) => {
    if (job.name === 'propagate_catalog_item') {
        await whatsappTemplatesService.propagateCatalogTemplateToAllClinics(job.data || {});
        return;
    }
    await whatsappTemplatesService.createTemplatesFromCatalog(job.data || {});
});

// Sincroniza estados de plantillas desde Meta
createWorker('whatsapp_template_sync', async (job) => {
    await whatsappTemplatesService.syncTemplatesForWaba(job.data || {});
});

// Sincroniza numeros de telefono desde Meta para evitar estados stale
createWorker('whatsapp_phone_sync', async (job) => {
    await whatsappPhonesService.syncPhonesForWaba(job.data || {});
});

// Crea automatizaciones y plantillas predefinidas al crear clínica
createWorker('automation_defaults', async (job) => {
    await automationDefaultsService.createDefaultAutomationsForClinic(job.data || {});
});
