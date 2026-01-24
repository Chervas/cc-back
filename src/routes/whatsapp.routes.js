const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsapp.service');
const authMiddleware = require('./auth.middleware');
const whatsappController = require('../controllers/whatsapp.controller');

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

/**
 * GET /api/whatsapp/templates
 * Devuelve plantillas disponibles (placeholder hasta integrar con Meta)
 */
router.get('/templates', authMiddleware, async (req, res) => {
    try {
        // TODO: integrar con Meta usando token por clínica.
        const sample = [
            { name: 'hello_world', language: 'en_US', category: 'UTILITY', status: 'approved', components: [], preview: 'Hello World' },
        ];
        return res.json(sample);
    } catch (error) {
        return res.status(500).json({ error: 'Error recuperando plantillas' });
    }
});

// Estado WABA por clínica
router.get('/status', authMiddleware, whatsappController.getStatus);

// Listado de cuentas WABA accesibles por el usuario
router.get('/accounts', authMiddleware, whatsappController.listAccounts);

// Resumen de plantillas por clínica
router.get('/templates/summary', authMiddleware, whatsappController.templatesSummary);

// Listado de números de WhatsApp (con estado de asignación)
router.get('/phones', authMiddleware, whatsappController.listPhones);

// Asignar número a grupo o clínica
router.post('/phones/:phoneNumberId/assign', authMiddleware, whatsappController.assignPhone);

module.exports = router;
