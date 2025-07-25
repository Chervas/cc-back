// controllers/socialstatscontroller.js
const models = require('../models');
const { SocialStatDaily, SocialPost, SocialPostStatDaily } = models;
const { Op } = require('sequelize');

/**
 * Controlador para las métricas de redes sociales
 */
class SocialStatsController {
    /**
     * Obtener métricas diarias de una clínica
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async getClinicaStats(req, res) {
        try {
            const { clinicaId } = req.params;
            const { startDate, endDate, period, assetId, assetType } = req.query;
            
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
            
            // Construir condiciones de consulta
            const whereConditions = {
                clinica_id: clinicaId,
                date: {
                    [Op.between]: [start, end]
                }
            };
            
            // Filtrar por tipo de activo si se proporciona
            if (assetType) {
                whereConditions.asset_type = assetType;
            }
            
            // Filtrar por ID de activo si se proporciona
            if (assetId) {
                whereConditions.asset_id = assetId;
            }
            
            let stats;
            
            // Obtener estadísticas según el período solicitado
            if (period && ['week', 'month', 'year'].includes(period)) {
                stats = await SocialStatDaily.getAggregatedStats(clinicaId, period, start, end);
            } else {
                // Obtener estadísticas diarias
                stats = await SocialStatDaily.findAll({
                    where: whereConditions,
                    order: [['date', 'ASC']],
                    include: [
                        {
                            model: models.ClinicMetaAsset,
                            as: 'asset',
                            attributes: ['id', 'assetType', 'metaAssetName']
                        }
                    ]
                });
            }
            
            res.status(200).json({
                success: true,
                clinicaId,
                startDate: start,
                endDate: end,
                period: period || 'day',
                count: stats.length,
                stats
            });
        } catch (error) {
            console.error(`❌ [SocialStatsController] Error al obtener estadísticas: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al obtener estadísticas',
                error: error.message
            });
        }
    }

    /**
     * Obtener métricas diarias de un activo específico
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async getAssetStats(req, res) {
        try {
            const { assetId } = req.params;
            const { startDate, endDate } = req.query;
            
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
            
            // Obtener estadísticas
            const stats = await SocialStatDaily.getStatsByAsset(assetId, start, end);
            
            res.status(200).json({
                success: true,
                assetId,
                assetType: asset.assetType,
                assetName: asset.metaAssetName,
                startDate: start,
                endDate: end,
                count: stats.length,
                stats
            });
        } catch (error) {
            console.error(`❌ [SocialStatsController] Error al obtener estadísticas de activo: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al obtener estadísticas de activo',
                error: error.message
            });
        }
    }

    /**
     * Obtener publicaciones de una clínica
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async getClinicaPosts(req, res) {
        try {
            const { clinicaId } = req.params;
            const { startDate, endDate, limit, offset, assetId, assetType } = req.query;
            
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
            
            // Construir opciones de consulta
            const options = {
                limit: limit ? parseInt(limit) : 10,
                offset: offset ? parseInt(offset) : 0,
                startDate: start,
                endDate: end
            };
            
            // Construir condiciones de consulta
            const whereConditions = {
                clinica_id: clinicaId,
                published_at: {
                    [Op.between]: [start, end]
                }
            };
            
            // Filtrar por tipo de activo si se proporciona
            if (assetType) {
                whereConditions.asset_type = assetType;
            }
            
            // Filtrar por ID de activo si se proporciona
            if (assetId) {
                whereConditions.asset_id = assetId;
            }
            
            // Obtener publicaciones
            const { count, rows } = await SocialPost.findAndCountAll({
                where: whereConditions,
                limit: options.limit,
                offset: options.offset,
                order: [['published_at', 'DESC']],
                include: [
                    {
                        model: models.ClinicMetaAsset,
                        as: 'asset',
                        attributes: ['id', 'assetType', 'metaAssetName']
                    },
                    {
                        model: SocialPostStatDaily,
                        as: 'stats',
                        limit: 1,
                        order: [['date', 'DESC']]
                    }
                ]
            });
            
            res.status(200).json({
                success: true,
                clinicaId,
                startDate: start,
                endDate: end,
                total: count,
                limit: options.limit,
                offset: options.offset,
                posts: rows
            });
        } catch (error) {
            console.error(`❌ [SocialStatsController] Error al obtener publicaciones: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al obtener publicaciones',
                error: error.message
            });
        }
    }

    /**
     * Obtener una publicación específica con sus estadísticas
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async getPost(req, res) {
        try {
            const { postId } = req.params;
            
            // Validar parámetros
            if (!postId) {
                return res.status(400).json({
                    success: false,
                    message: 'ID de publicación no proporcionado'
                });
            }
            
            // Obtener publicación con estadísticas
            const post = await SocialPost.getPostWithStats(postId);
            
            if (!post) {
                return res.status(404).json({
                    success: false,
                    message: `No se encontró la publicación con ID ${postId}`
                });
            }
            
            res.status(200).json({
                success: true,
                post
            });
        } catch (error) {
            console.error(`❌ [SocialStatsController] Error al obtener publicación: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al obtener publicación',
                error: error.message
            });
        }
    }

    /**
     * Obtener las publicaciones más populares de una clínica
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async getTopPosts(req, res) {
        try {
            const { clinicaId } = req.params;
            const { startDate, endDate, metric, limit, assetType } = req.query;
            
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
            
            // Validar métrica
            const validMetrics = ['engagement', 'reach', 'impressions', 'likes', 'comments', 'shares'];
            const selectedMetric = metric && validMetrics.includes(metric) ? metric : 'engagement';
            
            // Construir condiciones adicionales
            const additionalConditions = {};
            
            if (assetType) {
                additionalConditions.asset_type = assetType;
            }
            
            // Obtener publicaciones más populares
            const topPosts = await SocialPostStatDaily.getTopPosts(
                clinicaId,
                selectedMetric,
                start,
                end,
                limit ? parseInt(limit) : 5,
                additionalConditions
            );
            
            res.status(200).json({
                success: true,
                clinicaId,
                startDate: start,
                endDate: end,
                metric: selectedMetric,
                count: topPosts.length,
                posts: topPosts
            });
        } catch (error) {
            console.error(`❌ [SocialStatsController] Error al obtener publicaciones populares: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al obtener publicaciones populares',
                error: error.message
            });
        }
    }

    /**
     * Obtener resumen de métricas para el dashboard
     * @param {Object} req - Objeto de solicitud
     * @param {Object} res - Objeto de respuesta
     */
    async getDashboardSummary(req, res) {
        try {
            const { clinicaId } = req.params;
            const { startDate, endDate, compareStartDate, compareEndDate } = req.query;
            
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
            
            // Fechas para comparación (período anterior)
            const compareStart = compareStartDate ? new Date(compareStartDate) : new Date(start.getTime() - (end.getTime() - start.getTime()));
            const compareEnd = compareEndDate ? new Date(compareEndDate) : new Date(end.getTime() - (end.getTime() - start.getTime()));
            
            if (isNaN(compareStart.getTime()) || isNaN(compareEnd.getTime())) {
                return res.status(400).json({
                    success: false,
                    message: 'Fechas de comparación inválidas'
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
            
            // Obtener activos de la clínica
            const assets = await models.ClinicMetaAsset.findAll({
                where: {
                    clinicaId,
                    isActive: true
                },
                attributes: ['id', 'assetType', 'metaAssetName']
            });
            
            // Obtener métricas del período actual
            const currentStats = await SocialStatDaily.findAll({
                where: {
                    clinica_id: clinicaId,
                    date: {
                        [Op.between]: [start, end]
                    }
                },
                attributes: [
                    [models.sequelize.fn('SUM', models.sequelize.col('impressions')), 'total_impressions'],
                    [models.sequelize.fn('SUM', models.sequelize.col('reach')), 'total_reach'],
                    [models.sequelize.fn('SUM', models.sequelize.col('engagement')), 'total_engagement'],
                    [models.sequelize.fn('SUM', models.sequelize.col('clicks')), 'total_clicks'],
                    [models.sequelize.fn('MAX', models.sequelize.col('followers')), 'total_followers'],
                    [models.sequelize.fn('SUM', models.sequelize.col('profile_visits')), 'total_profile_visits'],
                    'asset_type'
                ],
                group: ['asset_type'],
                raw: true
            });
            
            // Obtener métricas del período de comparación
            const compareStats = await SocialStatDaily.findAll({
                where: {
                    clinica_id: clinicaId,
                    date: {
                        [Op.between]: [compareStart, compareEnd]
                    }
                },
                attributes: [
                    [models.sequelize.fn('SUM', models.sequelize.col('impressions')), 'total_impressions'],
                    [models.sequelize.fn('SUM', models.sequelize.col('reach')), 'total_reach'],
                    [models.sequelize.fn('SUM', models.sequelize.col('engagement')), 'total_engagement'],
                    [models.sequelize.fn('SUM', models.sequelize.col('clicks')), 'total_clicks'],
                    [models.sequelize.fn('MAX', models.sequelize.col('followers')), 'total_followers'],
                    [models.sequelize.fn('SUM', models.sequelize.col('profile_visits')), 'total_profile_visits'],
                    'asset_type'
                ],
                group: ['asset_type'],
                raw: true
            });
            
            // Obtener publicaciones más populares
            const topPosts = await SocialPostStatDaily.getTopPosts(clinicaId, 'engagement', start, end, 5);
            
            // Obtener estadísticas diarias para gráficos
            const dailyStats = await SocialStatDaily.findAll({
                where: {
                    clinica_id: clinicaId,
                    date: {
                        [Op.between]: [start, end]
                    }
                },
                attributes: [
                    'date',
                    'asset_type',
                    [models.sequelize.fn('SUM', models.sequelize.col('impressions')), 'impressions'],
                    [models.sequelize.fn('SUM', models.sequelize.col('reach')), 'reach'],
                    [models.sequelize.fn('SUM', models.sequelize.col('engagement')), 'engagement']
                ],
                group: ['date', 'asset_type'],
                order: [['date', 'ASC']],
                raw: true
            });
            
            // Calcular totales y variaciones
            const summary = {
                facebook: this._calculateSummary(currentStats, compareStats, 'facebook_page'),
                instagram: this._calculateSummary(currentStats, compareStats, 'instagram_business'),
                total: this._calculateTotalSummary(currentStats, compareStats)
            };
            
            res.status(200).json({
                success: true,
                clinicaId,
                period: {
                    startDate: start,
                    endDate: end
                },
                comparePeriod: {
                    startDate: compareStart,
                    endDate: compareEnd
                },
                assets,
                summary,
                topPosts,
                dailyStats
            });
        } catch (error) {
            console.error(`❌ [SocialStatsController] Error al obtener resumen: ${error.message}`);
            
            res.status(500).json({
                success: false,
                message: 'Error al obtener resumen',
                error: error.message
            });
        }
    }

    /**
     * Calcular resumen de métricas para un tipo de activo
     * @param {Array} currentStats - Estadísticas del período actual
     * @param {Array} compareStats - Estadísticas del período de comparación
     * @param {string} assetType - Tipo de activo
     * @returns {Object} - Resumen de métricas
     * @private
     */
    _calculateSummary(currentStats, compareStats, assetType) {
        // Encontrar estadísticas para el tipo de activo
        const current = currentStats.find(stat => stat.asset_type === assetType) || {
            total_impressions: 0,
            total_reach: 0,
            total_engagement: 0,
            total_clicks: 0,
            total_followers: 0,
            total_profile_visits: 0
        };
        
        const compare = compareStats.find(stat => stat.asset_type === assetType) || {
            total_impressions: 0,
            total_reach: 0,
            total_engagement: 0,
            total_clicks: 0,
            total_followers: 0,
            total_profile_visits: 0
        };
        
        // Calcular variaciones
        const calculateVariation = (current, previous) => {
            if (previous === 0) return current > 0 ? 100 : 0;
            return ((current - previous) / previous) * 100;
        };
        
        return {
            impressions: {
                current: parseInt(current.total_impressions) || 0,
                previous: parseInt(compare.total_impressions) || 0,
                variation: calculateVariation(
                    parseInt(current.total_impressions) || 0,
                    parseInt(compare.total_impressions) || 0
                )
            },
            reach: {
                current: parseInt(current.total_reach) || 0,
                previous: parseInt(compare.total_reach) || 0,
                variation: calculateVariation(
                    parseInt(current.total_reach) || 0,
                    parseInt(compare.total_reach) || 0
                )
            },
            engagement: {
                current: parseInt(current.total_engagement) || 0,
                previous: parseInt(compare.total_engagement) || 0,
                variation: calculateVariation(
                    parseInt(current.total_engagement) || 0,
                    parseInt(compare.total_engagement) || 0
                )
            },
            clicks: {
                current: parseInt(current.total_clicks) || 0,
                previous: parseInt(compare.total_clicks) || 0,
                variation: calculateVariation(
                    parseInt(current.total_clicks) || 0,
                    parseInt(compare.total_clicks) || 0
                )
            },
            followers: {
                current: parseInt(current.total_followers) || 0,
                previous: parseInt(compare.total_followers) || 0,
                variation: calculateVariation(
                    parseInt(current.total_followers) || 0,
                    parseInt(compare.total_followers) || 0
                )
            },
            profile_visits: {
                current: parseInt(current.total_profile_visits) || 0,
                previous: parseInt(compare.total_profile_visits) || 0,
                variation: calculateVariation(
                    parseInt(current.total_profile_visits) || 0,
                    parseInt(compare.total_profile_visits) || 0
                )
            }
        };
    }

    /**
     * Calcular resumen total de métricas
     * @param {Array} currentStats - Estadísticas del período actual
     * @param {Array} compareStats - Estadísticas del período de comparación
     * @returns {Object} - Resumen total de métricas
     * @private
     */
    _calculateTotalSummary(currentStats, compareStats) {
        // Calcular totales para el período actual
        const currentTotal = {
            total_impressions: currentStats.reduce((sum, stat) => sum + parseInt(stat.total_impressions || 0), 0),
            total_reach: currentStats.reduce((sum, stat) => sum + parseInt(stat.total_reach || 0), 0),
            total_engagement: currentStats.reduce((sum, stat) => sum + parseInt(stat.total_engagement || 0), 0),
            total_clicks: currentStats.reduce((sum, stat) => sum + parseInt(stat.total_clicks || 0), 0),
            total_followers: currentStats.reduce((sum, stat) => sum + parseInt(stat.total_followers || 0), 0),
            total_profile_visits: currentStats.reduce((sum, stat) => sum + parseInt(stat.total_profile_visits || 0), 0)
        };
        
        // Calcular totales para el período de comparación
        const compareTotal = {
            total_impressions: compareStats.reduce((sum, stat) => sum + parseInt(stat.total_impressions || 0), 0),
            total_reach: compareStats.reduce((sum, stat) => sum + parseInt(stat.total_reach || 0), 0),
            total_engagement: compareStats.reduce((sum, stat) => sum + parseInt(stat.total_engagement || 0), 0),
            total_clicks: compareStats.reduce((sum, stat) => sum + parseInt(stat.total_clicks || 0), 0),
            total_followers: compareStats.reduce((sum, stat) => sum + parseInt(stat.total_followers || 0), 0),
            total_profile_visits: compareStats.reduce((sum, stat) => sum + parseInt(stat.total_profile_visits || 0), 0)
        };
        
        // Calcular variaciones
        const calculateVariation = (current, previous) => {
            if (previous === 0) return current > 0 ? 100 : 0;
            return ((current - previous) / previous) * 100;
        };
        
        return {
            impressions: {
                current: currentTotal.total_impressions,
                previous: compareTotal.total_impressions,
                variation: calculateVariation(currentTotal.total_impressions, compareTotal.total_impressions)
            },
            reach: {
                current: currentTotal.total_reach,
                previous: compareTotal.total_reach,
                variation: calculateVariation(currentTotal.total_reach, compareTotal.total_reach)
            },
            engagement: {
                current: currentTotal.total_engagement,
                previous: compareTotal.total_engagement,
                variation: calculateVariation(currentTotal.total_engagement, compareTotal.total_engagement)
            },
            clicks: {
                current: currentTotal.total_clicks,
                previous: compareTotal.total_clicks,
                variation: calculateVariation(currentTotal.total_clicks, compareTotal.total_clicks)
            },
            followers: {
                current: currentTotal.total_followers,
                previous: compareTotal.total_followers,
                variation: calculateVariation(currentTotal.total_followers, compareTotal.total_followers)
            },
            profile_visits: {
                current: currentTotal.total_profile_visits,
                previous: compareTotal.total_profile_visits,
                variation: calculateVariation(currentTotal.total_profile_visits, compareTotal.total_profile_visits)
            }
        };
    }
}

module.exports = new SocialStatsController();

