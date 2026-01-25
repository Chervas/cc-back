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

// Plantillas del WABA según clinic_id o phone_number_id
router.get('/templates', authMiddleware, whatsappController.listTemplatesForClinic);

// Catálogo maestro (solo admins)
router.get('/template-catalog', authMiddleware, whatsappController.listCatalog);
router.post('/template-catalog', authMiddleware, whatsappController.createCatalog);
router.put('/template-catalog/:id', authMiddleware, whatsappController.updateCatalog);
router.delete('/template-catalog/:id', authMiddleware, whatsappController.deleteCatalog);
router.put('/template-catalog/:id/toggle', authMiddleware, whatsappController.toggleCatalog);
router.post('/template-catalog/:id/disciplines', authMiddleware, whatsappController.setCatalogDisciplines);

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

// Desconectar número (desactiva y desasigna)
router.delete('/phones/:phoneNumberId', authMiddleware, whatsappController.deletePhone);

module.exports = router;
