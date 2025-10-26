const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsapp.service');

/**
 * POST /api/whatsapp/messages
 * Enviar un mensaje de WhatsApp usando la API de Meta
 */
router.post('/messages', async (req, res) => {
    try {
        const {
            to,
            message,
            previewUrl = false,
            metadata = {},
            useTemplate,
            templateName,
            templateLanguage,
        } = req.body;

        if (!to) {
            return res.status(400).json({
                success: false,
                error: 'El campo "to" es obligatorio.',
            });
        }

        if (!message && !useTemplate) {
            return res.status(400).json({
                success: false,
                error: 'Debes proporcionar un "message" o habilitar "useTemplate".',
            });
        }

        const normalized = whatsappService.normalizePhoneNumber(to);
        if (!normalized) {
            return res.status(400).json({
                success: false,
                error: 'No se pudo normalizar el número de destino.',
            });
        }

        const response = await whatsappService.sendMessage({
            to: normalized,
            body: message,
            previewUrl,
            useTemplate,
            templateName,
            templateLanguage,
        });

        res.status(200).json({
            success: true,
            messageId: response.messages?.[0]?.id || null,
            to: normalized,
            metadata,
        });
    } catch (error) {
        const statusCode = error.response?.status || 500;
        const errorBody = error.response?.data || {
            message: error.message || 'Error desconocido enviando WhatsApp',
        };

        res.status(statusCode).json({
            success: false,
            error: errorBody,
        });
    }
});

module.exports = router;
