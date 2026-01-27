'use strict';
const { createWorker } = require('../services/queue.service');
const whatsappService = require('../services/whatsapp.service');
const whatsappTemplatesService = require('../services/whatsappTemplates.service');
const automationDefaultsService = require('../services/automationDefaults.service');
const { getIO } = require('../services/socket.service');
const db = require('../../models');

const { Conversation, Message, ClinicMetaAsset } = db;

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

    if (!payload || !clinicId) {
        throw new Error('Payload o clinic_id ausente en webhook de WhatsApp');
    }

    const entry = payload?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages || [];

    for (const msg of messages) {
        const phoneId = value?.metadata?.phone_number_id;
        const from = msg.from;
        const wamid = msg.id;
        const content = msg.text?.body || msg.button?.text || msg.interactive?.text || '';

        const [conv, created] = await Conversation.findOrCreate({
            where: { contact_id: `+${from}`.replace('++', '+'), channel: 'whatsapp', clinic_id: clinicId },
            defaults: {
                clinic_id: clinicId,
                channel: 'whatsapp',
                contact_id: `+${from}`.replace('++', '+'),
                last_message_at: new Date(),
                last_inbound_at: new Date(),
                unread_count: 1,
                patient_id: patientId,
                lead_id: leadId,
            },
        });

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

        await Message.create({
            conversation_id: conv.id,
            sender_id: null,
            direction: 'inbound',
            content,
            message_type: msg.type || 'text',
            status: 'sent',
            metadata: { wamid, phoneId },
            sent_at: new Date(),
        });

        conv.last_message_at = new Date();
        conv.last_inbound_at = new Date();
        conv.unread_count = (conv.unread_count || 0) + 1;
        await conv.save();

        const io = getIO();
        if (io) {
            const room = `clinic:${clinicId}`;
            io.to(room).emit('message:created', {
                conversation_id: conv.id,
                content,
                direction: 'inbound',
                message_type: msg.type || 'text',
                status: 'sent',
                sent_at: new Date(),
            });
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

// Crea automatizaciones y plantillas predefinidas al crear clínica
createWorker('automation_defaults', async (job) => {
    await automationDefaultsService.createDefaultAutomationsForClinic(job.data || {});
});
