const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const whatsappController = require('../controllers/whatsapp.controller');

/**
 * POST /api/whatsapp/messages
 * Enviar un mensaje de WhatsApp usando la API de Meta
 */
router.post('/messages', authMiddleware, whatsappController.sendMessage);

// Plantillas del WABA según clinic_id o phone_number_id
router.get('/templates', authMiddleware, whatsappController.listTemplatesForClinic);
router.post('/templates/sync', authMiddleware, whatsappController.syncTemplates);
router.post('/templates/custom', authMiddleware, whatsappController.createCustomTemplate);
router.post('/templates/create-from-catalog', authMiddleware, whatsappController.createTemplatesFromCatalog);
router.delete('/templates/:id', authMiddleware, whatsappController.deleteTemplate);

// Catálogo maestro (solo admins)
router.get('/template-catalog', authMiddleware, whatsappController.listCatalog);
router.post('/template-catalog', authMiddleware, whatsappController.createCatalog);
router.put('/template-catalog/:id', authMiddleware, whatsappController.updateCatalog);
router.delete('/template-catalog/:id', authMiddleware, whatsappController.deleteCatalog);
router.post('/template-catalog/:id/duplicate', authMiddleware, whatsappController.duplicateCatalog);
router.put('/template-catalog/:id/toggle', authMiddleware, whatsappController.toggleCatalog);
router.post('/template-catalog/:id/disciplines', authMiddleware, whatsappController.setCatalogDisciplines);
router.post('/template-catalog/:id/propagate', authMiddleware, whatsappController.propagateCatalogToClinics);

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

// Desasignar número sin desconectarlo de Meta
router.post('/phones/:phoneNumberId/unassign', authMiddleware, whatsappController.unassignPhone);

// Registrar número en Cloud API (PIN opcional)
router.post('/phones/:phoneNumberId/register', authMiddleware, whatsappController.registerPhone);

// Solicitar cambio de nombre para mostrar (se guarda y guía al usuario)
router.post('/phones/:phoneNumberId/display-name', authMiddleware, whatsappController.updatePhoneDisplayName);

// Actualizar perfil del número (categoría, descripción, web, etc.)
router.post('/phones/:phoneNumberId/profile', authMiddleware, whatsappController.updatePhoneProfile);

// Refrescar estado del número en Meta (estado registro, nombre, calidad)
router.post('/phones/:phoneNumberId/refresh', authMiddleware, whatsappController.refreshPhoneStatus);

// Coexistencia: solicitar sync inicial de contactos e historial desde WhatsApp Business App
router.post('/phones/:phoneNumberId/coexistence/sync-initial', authMiddleware, whatsappController.enqueueCoexistenceInitialSync);

// Desconectar número (desactiva y desasigna)
router.delete('/phones/:phoneNumberId', authMiddleware, whatsappController.deletePhone);

// Pre-verified numbers (solo si está habilitado)
router.post('/preverified/start', authMiddleware, whatsappController.preverifiedStart);
router.post('/preverified/verify', authMiddleware, whatsappController.preverifiedVerify);
router.post('/preverified/profile', authMiddleware, whatsappController.preverifiedProfile);

module.exports = router;
