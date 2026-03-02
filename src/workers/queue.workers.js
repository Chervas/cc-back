'use strict';
const axios = require('axios');
const { QueryTypes } = require('sequelize');
const { createWorker } = require('../services/queue.service');
const whatsappService = require('../services/whatsapp.service');
const whatsappTemplatesService = require('../services/whatsappTemplates.service');
const whatsappPhonesService = require('../services/whatsappPhones.service');
const automationDefaultsService = require('../services/automationDefaults.service');
const automationsV2ResumeService = require('../services/automationsV2Resume.service');
const { getIO } = require('../services/socket.service');
const db = require('../../models');

const { Conversation, Message, ClinicMetaAsset, WhatsAppWebOrigin } = db;
const GROQ_API_BASE_URL = (process.env.GROQ_API_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const META_API_VERSION = process.env.META_API_VERSION || 'v22.0';

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

function cleanString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function normalizeInboundMessageType(rawType) {
    const type = String(rawType || '').toLowerCase();
    if (type === 'image') return 'image';
    if (type === 'template') return 'template';
    if (type === 'event') return 'event';
    return 'text';
}

async function fetchWhatsAppMediaMeta({ mediaId, accessToken }) {
    if (!mediaId || !accessToken) {
        throw new Error('media_meta_missing_params');
    }
    const url = `https://graph.facebook.com/${META_API_VERSION}/${mediaId}`;
    const { data } = await axios.get(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
        params: {
            fields: 'id,mime_type,sha256,file_size,url',
        },
    });
    return data || {};
}

async function downloadWhatsAppMediaBuffer({ mediaUrl, accessToken }) {
    if (!mediaUrl || !accessToken) {
        throw new Error('media_download_missing_params');
    }
    const { data } = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });
    return Buffer.from(data);
}

async function transcribeAudioWithGroq({ audioBuffer, mimeType = 'audio/ogg', fileName = 'audio.ogg' }) {
    const apiKey = cleanString(process.env.GROQ_API_KEY);
    if (!apiKey) {
        return { ok: false, error: 'groq_api_key_not_configured', text: '' };
    }
    if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
        return { ok: false, error: 'audio_buffer_empty', text: '' };
    }

    const form = new FormData();
    form.append('model', GROQ_STT_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    form.append('file', new Blob([audioBuffer], { type: mimeType }), fileName);

    const response = await fetch(`${GROQ_API_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
        body: form,
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return {
            ok: false,
            error: `groq_stt_failed:${response.status}:${cleanString(errText) || 'unknown'}`,
            text: '',
        };
    }

    const payload = await response.json().catch(() => ({}));
    const text = cleanString(payload?.text);
    return {
        ok: Boolean(text),
        text,
        language: cleanString(payload?.language) || null,
        duration: payload?.duration ?? null,
        provider_payload: payload,
    };
}

function buildImageContent(image = {}) {
    const caption = cleanString(image.caption);
    return caption ? `[Imagen recibida]\n${caption}` : '[Imagen recibida]';
}

function buildDocumentContent(document = {}) {
    const fileName = cleanString(document.filename);
    return fileName ? `[Documento recibido] ${fileName}` : '[Documento recibido]';
}

function buildGenericMediaContent(rawType) {
    const type = String(rawType || '').toLowerCase();
    if (type === 'audio') return '[Audio recibido]';
    if (type === 'video') return '[Video recibido]';
    if (type === 'sticker') return '[Sticker recibido]';
    if (type === 'document') return '[Documento recibido]';
    if (type === 'image') return '[Imagen recibida]';
    return '[Mensaje recibido]';
}

async function resolveInboundMessagePayload({ msg, clinicId }) {
    const rawType = String(msg?.type || 'text').toLowerCase();
    const rawText = msg?.text?.body || msg?.button?.text || msg?.interactive?.text || '';
    const stripped = extractAndStripWebOriginRef(rawText);
    const out = {
        content: cleanString(stripped.content),
        resumeText: cleanString(stripped.content),
        messageType: normalizeInboundMessageType(rawType),
        metadataPatch: {},
        webOriginRefFromMsg: stripped.ref || null,
    };

    if (rawType === 'image') {
        const image = msg?.image || {};
        out.content = buildImageContent(image);
        out.resumeText = out.content;
        out.messageType = 'image';
        out.metadataPatch = {
            media: {
                kind: 'image',
                media_id: image.id || null,
                mime_type: image.mime_type || null,
                sha256: image.sha256 || null,
                caption: cleanString(image.caption) || null,
                hosting: 'pending_static_hosting',
            },
        };
        return out;
    }

    if (rawType === 'document') {
        const document = msg?.document || {};
        out.content = buildDocumentContent(document);
        out.resumeText = out.content;
        out.metadataPatch = {
            media: {
                kind: 'document',
                media_id: document.id || null,
                mime_type: document.mime_type || null,
                sha256: document.sha256 || null,
                filename: cleanString(document.filename) || null,
                caption: cleanString(document.caption) || null,
                hosting: 'pending_static_hosting',
            },
        };
        return out;
    }

    if (rawType === 'audio') {
        const audio = msg?.audio || {};
        const mediaId = cleanString(audio.id);
        out.content = '[Audio recibido: procesando transcripción]';
        out.resumeText = out.content;
        out.metadataPatch = {
            media: {
                kind: 'audio',
                media_id: mediaId || null,
                mime_type: audio.mime_type || null,
                sha256: audio.sha256 || null,
            },
            audio_transcribed: false,
            audio_transcription: {
                provider: 'groq',
                model: GROQ_STT_MODEL,
                status: 'pending',
            },
        };

        try {
            const clinicConfig = await whatsappService.getClinicConfig(clinicId);
            const accessToken = cleanString(clinicConfig?.accessToken);
            if (!mediaId || !accessToken) {
                throw new Error('audio_media_or_token_missing');
            }

            const mediaMeta = await fetchWhatsAppMediaMeta({ mediaId, accessToken });
            const mediaUrl = cleanString(mediaMeta?.url);
            const mediaMime = cleanString(audio.mime_type || mediaMeta?.mime_type) || 'audio/ogg';
            const fileExt = mediaMime.includes('/') ? mediaMime.split('/')[1] : 'ogg';
            const fileName = `wa-audio-${mediaId || Date.now()}.${fileExt || 'ogg'}`;
            const mediaBuffer = await downloadWhatsAppMediaBuffer({ mediaUrl, accessToken });
            const transcription = await transcribeAudioWithGroq({
                audioBuffer: mediaBuffer,
                mimeType: mediaMime,
                fileName,
            });

            if (transcription.ok && cleanString(transcription.text)) {
                out.content = transcription.text;
                out.resumeText = transcription.text;
                out.metadataPatch = {
                    ...out.metadataPatch,
                    media: {
                        ...(out.metadataPatch.media || {}),
                        mime_type: mediaMime || null,
                        file_size: mediaMeta?.file_size || null,
                        sha256: mediaMeta?.sha256 || audio.sha256 || null,
                        hosting: 'external_meta_pending_static',
                    },
                    audio_transcribed: true,
                    audio_transcription: {
                        provider: 'groq',
                        model: GROQ_STT_MODEL,
                        status: 'success',
                        language: transcription.language || null,
                        duration: transcription.duration || null,
                    },
                };
            } else {
                out.content = '[Audio recibido: transcripción no disponible]';
                out.resumeText = out.content;
                out.metadataPatch = {
                    ...out.metadataPatch,
                    audio_transcribed: false,
                    audio_transcription: {
                        provider: 'groq',
                        model: GROQ_STT_MODEL,
                        status: 'failed',
                        error: transcription.error || 'transcription_failed',
                    },
                };
            }
        } catch (error) {
            out.content = '[Audio recibido: transcripción no disponible]';
            out.resumeText = out.content;
            out.metadataPatch = {
                ...out.metadataPatch,
                audio_transcribed: false,
                audio_transcription: {
                    provider: 'groq',
                    model: GROQ_STT_MODEL,
                    status: 'failed',
                    error: cleanString(error?.message) || 'transcription_failed',
                },
            };
        }

        return out;
    }

    if (!out.content) {
        out.content = buildGenericMediaContent(rawType);
        out.resumeText = out.content;
        if (rawType && rawType !== 'text') {
            out.metadataPatch = {
                media: {
                    kind: rawType,
                    hosting: 'pending_static_hosting',
                },
            };
        }
    }

    return out;
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
        msg.metadata = {
            ...(msg.metadata || {}),
            wa_response: waResponse,
            wamid: waResponse?.messages?.[0]?.id,
            phoneId: clinicConfig?.phoneNumberId || msg?.metadata?.phoneId || null,
        };
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
    const routing = job.data?.routing || null;
    const matchedConversationId = Number(routing?.matched_conversation_id || 0) || null;

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
        const inboundPayload = await resolveInboundMessagePayload({
            msg,
            clinicId,
        });
        const webOriginRefFromMsg = inboundPayload.webOriginRefFromMsg || null;
        const content = inboundPayload.content;
        const resumeText = cleanString(inboundPayload.resumeText || inboundPayload.content);
        const inboundMessageType = inboundPayload.messageType || 'text';
        const inboundMetadataPatch = inboundPayload.metadataPatch || {};

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

        const normalizedContact = `+${from}`.replace('++', '+');
        let conv = null;
        let created = false;

        // Si el router ya encontró conversación exacta (por contexto/outbound), priorizarla.
        // Evita enrutados cruzados cuando el mismo teléfono existe en varias clínicas del grupo.
        if (matchedConversationId) {
            const matched = await Conversation.findOne({
                where: {
                    id: matchedConversationId,
                    channel: 'whatsapp',
                },
            });

            if (matched && (!normalizedContact || matched.contact_id === normalizedContact)) {
                conv = matched;
            }
        }

        if (!conv) {
            const tuple = await Conversation.findOrCreate({
                where: { contact_id: normalizedContact, channel: 'whatsapp', clinic_id: clinicId },
                defaults: {
                    clinic_id: clinicId,
                    channel: 'whatsapp',
                    contact_id: normalizedContact,
                    last_message_at: new Date(),
                    last_inbound_at: new Date(),
                    unread_count: 1,
                    patient_id: patientId,
                    lead_id: leadId,
                },
            });
            conv = tuple[0];
            created = tuple[1];
        }

        if (!created && (patientId || leadId)) {
            let updated = false;
            if (patientId && !conv.patient_id) {
                conv.patient_id = patientId;
                updated = true;
            }
            if (leadId && !conv.lead_id) {
                conv.lead_id = leadId;
                updated = true;
            }
            if (updated) {
                await conv.save();
            }
        }

        const inboundMsg = await Message.create({
            conversation_id: conv.id,
            sender_id: null,
            direction: 'inbound',
            content,
            message_type: inboundMessageType,
            status: 'sent',
            metadata: {
                wamid,
                phoneId,
                routing: routing || null,
                ...inboundMetadataPatch,
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
            const resumeResult = await automationsV2ResumeService.enqueueInboundResponseResume({
                clinicId: conv.clinic_id || clinicId,
                conversationId: conv.id,
                patientId: conv.patient_id || null,
                leadId: conv.lead_id || null,
                messageText: resumeText || content,
                inboundMessageId: inboundMsg.id,
                channel: 'whatsapp',
            });

            dlog('Automations v2 inbound auto-resume', {
                conversationId: conv.id,
                clinicId: conv.clinic_id || clinicId,
                ...resumeResult,
            });
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
                message_type: inboundMessageType,
                status: 'sent',
                sent_at: inboundMsg.sent_at,
                metadata: inboundMsg.metadata || null,
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
