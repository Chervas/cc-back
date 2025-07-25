// controllers/metasynccontroller.js
const metaSyncService = require('../services/metasyncservice');
const models = require('../models');
const { SyncLog, TokenValidation } = models;

/**
 * Controlador para la sincronización con la API de Meta
 */
class MetaSyncController {
    /**
     * Iniciar sincronización de una clínica
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async syncClinica(req, res) {
        try {
            const { clinicaId } = req.params;
            const { startDate, endDate } = req.body;
            
            // Validar parámetros
            if (!clinicaId) {
                return res.status(400).json({
                    success: false,
                    message: 'ID de clínica no proporcionado'
                });
            }
            
            // Validar fechas
            const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto
            const end = endDate ? new Date(endDate) : new Date(); // Hoy por defecto
            
            if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                return res.status(400).json({
                    success: false,
                    message: 'Fechas inválidas'
                });
            }
            
            // Verificar que la clínica existe
            const clinica = await models.Clinica.findByPk(clinicaId);
            
            if (!clinica) {
                return res.status(404).json({
                    success: false,
                    message: `No se encontró la clínica con ID ${clinicaId}`
                });
            }
            
            // Iniciar sincronización en segundo plano
            const syncProcess = metaSyncService.syncClinicaAssets(clinicaId, start, end);
            
            // Responder inmediatamente
            res.status(202).json({
                success: true,
                message: `Sincronización iniciada para la clínica ${clinicaId}`,
                clinicaId,
                startDate: start,
                endDate: end
            });
            
            // Esperar a que termine la sincronización (no afecta la respuesta)
            await syncProcess;
        } catch (error) {
            console.error(`❌ [MetaSyncController] Error al sincronizar clínica: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al iniciar sincronización',
                error: error.message
            });
        }
    }

    /**
     * Iniciar sincronización de un activo específico
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async syncAsset(req, res) {
        try {
            const { assetId } = req.params;
            const { startDate, endDate } = req.body;
            
            // Validar parámetros
            if (!assetId) {
                return res.status(400).json({
                    success: false,
                    message: 'ID de activo no proporcionado'
                });
            }
            
            // Validar fechas
            const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto
            const end = endDate ? new Date(endDate) : new Date(); // Hoy por defecto
            
            if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                return res.status(400).json({
                    success: false,
                    message: 'Fechas inválidas'
                });
            }
            
            // Verificar que el activo existe
            const asset = await models.ClinicMetaAsset.findByPk(assetId);
            
            if (!asset) {
                return res.status(404).json({
                    success: false,
                    message: `No se encontró el activo con ID ${assetId}`
                });
            }
            
            // Iniciar sincronización en segundo plano
            const syncProcess = metaSyncService.syncAsset(assetId, start, end);
            
            // Responder inmediatamente
            res.status(202).json({
                success: true,
                message: `Sincronización iniciada para el activo ${assetId}`,
                assetId,
                startDate: start,
                endDate: end
            });
            
            // Esperar a que termine la sincronización (no afecta la respuesta)
            await syncProcess;
        } catch (error) {
            console.error(`❌ [MetaSyncController] Error al sincronizar activo: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al iniciar sincronización',
                error: error.message
            });
        }
    }

    /**
     * Obtener logs de sincronización
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async getSyncLogs(req, res) {
        try {
            const { limit, jobType, status, clinicaId, assetId } = req.query;
            
            const logs = await SyncLog.getLatestLogs({
                limit: limit ? parseInt(limit) : 50,
                jobType,
                status,
                clinicaId: clinicaId ? parseInt(clinicaId) : null,
                assetId: assetId ? parseInt(assetId) : null
            });
            
            res.status(200).json({
                success: true,
                count: logs.length,
                logs
            });
        } catch (error) {
            console.error(`❌ [MetaSyncController] Error al obtener logs: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al obtener logs de sincronización',
                error: error.message
            });
        }
    }

    /**
     * Obtener estadísticas de sincronización
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async getSyncStats(req, res) {
        try {
            const stats = await SyncLog.getSyncStats();
            
            res.status(200).json({
                success: true,
                stats
            });
        } catch (error) {
            console.error(`❌ [MetaSyncController] Error al obtener estadísticas: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al obtener estadísticas de sincronización',
                error: error.message
            });
        }
    }

    /**
     * Validar tokens de conexión
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async validateTokens(req, res) {
        try {
            const { connectionId } = req.params;
            
            if (connectionId) {
                // Validar un token específico
                const connection = await models.MetaConnection.findByPk(connectionId);
                
                if (!connection) {
                    return res.status(404).json({
                        success: false,
                        message: `No se encontró la conexión con ID ${connectionId}`
                    });
                }
                
                const validation = await metaSyncService.validateToken(connection);
                
                return res.status(200).json({
                    success: true,
                    connectionId,
                    isValid: validation.isValid,
                    expiresAt: validation.expiresAt,
                    message: validation.isValid ? 'Token válido' : 'Token inválido'
                });
            } else {
                // Validar todos los tokens que necesitan validación
                const connections = await TokenValidation.getConnectionsNeedingValidation(30); // 30 días
                
                const results = [];
                
                for (const connection of connections) {
                    try {
                        const fullConnection = await models.MetaConnection.findByPk(connection.id);
                        const validation = await metaSyncService.validateToken(fullConnection);
                        
                        results.push({
                            connectionId: connection.id,
                            userName: connection.userName,
                            isValid: validation.isValid,
                            expiresAt: validation.expiresAt
                        });
                    } catch (error) {
                        results.push({
                            connectionId: connection.id,
                            userName: connection.userName,
                            isValid: false,
                            error: error.message
                        });
                    }
                }
                
                return res.status(200).json({
                    success: true,
                    count: results.length,
                    validations: results
                });
            }
        } catch (error) {
            console.error(`❌ [MetaSyncController] Error al validar tokens: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al validar tokens',
                error: error.message
            });
        }
    }

    /**
     * Obtener estadísticas de validación de tokens
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async getTokenValidationStats(req, res) {
        try {
            const stats = await TokenValidation.getValidationStats();
            
            res.status(200).json({
                success: true,
                stats
            });
        } catch (error) {
            console.error(`❌ [MetaSyncController] Error al obtener estadísticas de validación: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al obtener estadísticas de validación de tokens',
                error: error.message
            });
        }
    }
}

module.exports = new MetaSyncController();

