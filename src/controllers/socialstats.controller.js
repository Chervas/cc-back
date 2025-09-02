'use strict';
const { 
    SocialStatsDaily, 
    SocialPosts, 
    SocialPostStatsDaily, 
    ClinicMetaAsset,
    SocialAdsInsightsDaily,
    PostPromotions
} = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');

// Obtiene métricas de una clínica
exports.getClinicaStats = async (req, res) => {
    try {
        const { clinicaId } = req.params;
        const { 
            startDate, 
            endDate, 
            period = 'day', 
            assetType,
            assetId 
        } = req.query;
        
        // Validar parámetros
        if (!clinicaId) {
            return res.status(400).json({ message: 'ID de clínica no proporcionado' });
        }
        
        // Convertir fechas a objetos Date
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto
        const end = endDate ? new Date(endDate) : new Date();
        
        // Construir condiciones de búsqueda
        const where = {
            clinica_id: clinicaId,
            date: {
                [Op.between]: [start, end]
            }
        };
        
        if (assetType) {
            where.asset_type = assetType;
        }
        
        if (assetId) {
            where.asset_id = assetId;
        }
        
        // Obtener métricas según el período solicitado
        let stats;
        
        if (period === 'day') {
            // Métricas diarias (sin agregación)
            stats = await SocialStatsDaily.findAll({
                where,
                order: [['date', 'ASC']]
            });
        } else {
            // Métricas agregadas por semana o mes
            const groupByClause = period === 'week' 
                ? sequelize.fn('YEARWEEK', sequelize.col('date'), 0)
                : sequelize.fn('DATE_FORMAT', sequelize.col('date'), '%Y-%m');
            
            stats = await SocialStatsDaily.findAll({
                attributes: [
                    [groupByClause, period],
                    [sequelize.fn('MIN', sequelize.col('date')), 'start_date'],
                    [sequelize.fn('MAX', sequelize.col('date')), 'end_date'],
                    [sequelize.fn('SUM', sequelize.col('impressions')), 'impressions'],
                    [sequelize.fn('SUM', sequelize.col('reach')), 'reach'],
                    [sequelize.fn('SUM', sequelize.col('engagement')), 'engagement'],
                    [sequelize.fn('SUM', sequelize.col('clicks')), 'clicks'],
                    [sequelize.fn('AVG', sequelize.col('followers')), 'followers'],
                    [sequelize.fn('SUM', sequelize.col('followers_day')), 'followers_day'],
                    [sequelize.fn('SUM', sequelize.col('profile_visits')), 'profile_visits'],
                    'asset_type'
                ],
                where,
                group: [period, 'asset_type'],
                order: [[sequelize.col('start_date'), 'ASC']]
            });
        }
        
        // Obtener activos de la clínica para enriquecer la respuesta
        const assets = await ClinicMetaAsset.findAll({
            where: {
                clinicaId: clinicaId,
                isActive: true
            },
            attributes: ['id', 'assetType', 'metaAssetName', 'assetAvatarUrl']
        });
        
        return res.status(200).json({
            clinicaId,
            period,
            startDate: start,
            endDate: end,
            stats,
            assets
        });
    } catch (error) {
        console.error('❌ Error al obtener métricas de clínica:', error);
        return res.status(500).json({
            message: 'Error al obtener métricas de clínica',
            error: error.message
        });
    }
};

// Obtiene métricas de un activo específico
exports.getAssetStats = async (req, res) => {
    try {
        const { assetId } = req.params;
        const { startDate, endDate, period = 'day' } = req.query;
        
        // Validar parámetros
        if (!assetId) {
            return res.status(400).json({ message: 'ID de activo no proporcionado' });
        }
        
        // Verificar que el activo existe
        const asset = await ClinicMetaAsset.findByPk(assetId);
        
        if (!asset) {
            return res.status(404).json({ message: 'Activo no encontrado' });
        }
        
        // Convertir fechas a objetos Date
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto
        const end = endDate ? new Date(endDate) : new Date();
        
        // Construir condiciones de búsqueda
        const where = {
            asset_id: assetId,
            date: {
                [Op.between]: [start, end]
            }
        };
        
        // Obtener métricas según el período solicitado
        let stats;
        
        if (period === 'day') {
            // Métricas diarias (sin agregación)
            stats = await SocialStatsDaily.findAll({
                where,
                order: [['date', 'ASC']]
            });
        } else {
            // Métricas agregadas por semana o mes
            const groupByClause = period === 'week' 
                ? sequelize.fn('YEARWEEK', sequelize.col('date'), 0)
                : sequelize.fn('DATE_FORMAT', sequelize.col('date'), '%Y-%m');
            
            stats = await SocialStatsDaily.findAll({
                attributes: [
                    [groupByClause, period],
                    [sequelize.fn('MIN', sequelize.col('date')), 'start_date'],
                    [sequelize.fn('MAX', sequelize.col('date')), 'end_date'],
                    [sequelize.fn('SUM', sequelize.col('impressions')), 'impressions'],
                    [sequelize.fn('SUM', sequelize.col('reach')), 'reach'],
                    [sequelize.fn('SUM', sequelize.col('engagement')), 'engagement'],
                    [sequelize.fn('SUM', sequelize.col('clicks')), 'clicks'],
                    [sequelize.fn('AVG', sequelize.col('followers')), 'followers'],
                    [sequelize.fn('SUM', sequelize.col('followers_day')), 'followers_day'],
                    [sequelize.fn('SUM', sequelize.col('profile_visits')), 'profile_visits']
                ],
                where,
                group: [period],
                order: [[sequelize.col('start_date'), 'ASC']]
            });
        }
        
        return res.status(200).json({
            asset,
            period,
            startDate: start,
            endDate: end,
            stats
        });
    } catch (error) {
        console.error('❌ Error al obtener métricas de activo:', error);
        return res.status(500).json({
            message: 'Error al obtener métricas de activo',
            error: error.message
        });
    }
};

// Obtiene publicaciones de una clínica
exports.getClinicaPosts = async (req, res) => {
    try {
        const { clinicaId } = req.params;
        const { 
            startDate, 
            endDate, 
            limit = 10, 
            offset = 0,
            assetType,
            sortBy = 'published_at',
            sortOrder = 'DESC'
        } = req.query;
        
        // Validar parámetros
        if (!clinicaId) {
            return res.status(400).json({ message: 'ID de clínica no proporcionado' });
        }
        
        // Convertir fechas a objetos Date
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto
        const end = endDate ? new Date(endDate) : new Date();
        
        // Construir condiciones de búsqueda
        const where = {
            clinica_id: clinicaId,
            published_at: {
                [Op.between]: [start, end]
            }
        };
        
        if (assetType) {
            where.asset_type = assetType;
        }
        
        // Obtener publicaciones
        const posts = await SocialPosts.findAndCountAll({
            where,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [[sortBy, sortOrder]],
            include: [
                {
                    model: SocialPostStatsDaily,
                    as: 'stats',
                    required: false,
                    // Obtener solo la estadística más reciente de cada post
                    separate: true,
                    limit: 1,
                    order: [['date', 'DESC']]
                }
            ]
        });

        // Calcular alcance de pago por publicación (si hay vínculos con anuncios)
        const postIds = posts.rows.map(p => p.id);
        let paidReachByPost = {};
        if (postIds.length > 0) {
            // Buscar promociones vinculadas a estos posts
            const promos = await PostPromotions.findAll({ where: { post_id: { [Op.in]: postIds } }, raw: true });
            const adIds = promos.map(p => p.ad_id).filter(Boolean);
            if (adIds.length > 0) {
                // Sumar reach de insights por ad_id y rango
                const insights = await SocialAdsInsightsDaily.findAll({
                    where: {
                        level: 'ad',
                        entity_id: { [Op.in]: adIds },
                        date: { [Op.between]: [start, end] }
                    },
                    attributes: [ 'entity_id', [sequelize.fn('SUM', sequelize.col('reach')), 'reach'] ],
                    group: ['entity_id'],
                    raw: true
                });
                const reachByAd = new Map(insights.map(i => [i.entity_id, parseInt(i.reach, 10) || 0]));
                // Mapear por post
                for (const promo of promos) {
                    const r = reachByAd.get(promo.ad_id) || 0;
                    paidReachByPost[promo.post_id] = (paidReachByPost[promo.post_id] || 0) + r;
                }
            }
        }

        // Adjuntar paid_reach en la salida
        const rows = posts.rows.map(p => {
            const json = p.toJSON();
            json.paid_reach = paidReachByPost[p.id] || 0;
            return json;
        });
        
        return res.status(200).json({
            total: posts.count,
            posts: rows
        });
    } catch (error) {
        console.error('❌ Error al obtener publicaciones de clínica:', error);
        return res.status(500).json({
            message: 'Error al obtener publicaciones de clínica',
            error: error.message
        });
    }
};

// Obtiene una publicación específica con sus estadísticas
exports.getPost = async (req, res) => {
    try {
        const { postId } = req.params;
        
        // Validar parámetros
        if (!postId) {
            return res.status(400).json({ message: 'ID de publicación no proporcionado' });
        }
        
        // Obtener publicación con sus estadísticas
        const post = await SocialPosts.findByPk(postId, {
            include: [
                {
                    model: SocialPostStatsDaily,
                    as: 'stats',
                    required: false,
                    separate: true,
                    order: [['date', 'ASC']]
                }
            ]
        });
        
        if (!post) {
            return res.status(404).json({ message: 'Publicación no encontrada' });
        }
        
        return res.status(200).json(post);
    } catch (error) {
        console.error('❌ Error al obtener publicación:', error);
        return res.status(500).json({
            message: 'Error al obtener publicación',
            error: error.message
        });
    }
};

// Obtiene las publicaciones más populares de una clínica
exports.getTopPosts = async (req, res) => {
    try {
        const { clinicaId } = req.params;
        const { 
            startDate, 
            endDate, 
            metric = 'engagement', 
            limit = 5,
            assetType
        } = req.query;
        
        // Validar parámetros
        if (!clinicaId) {
            return res.status(400).json({ message: 'ID de clínica no proporcionado' });
        }
        
        // Convertir fechas a objetos Date
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto
        const end = endDate ? new Date(endDate) : new Date();
        
        // Validar métrica
        const validMetrics = ['engagement', 'likes', 'comments', 'shares', 'impressions', 'reach'];
        if (!validMetrics.includes(metric)) {
            return res.status(400).json({ 
                message: `Métrica inválida. Valores permitidos: ${validMetrics.join(', ')}` 
            });
        }
        
        // Construir condiciones de búsqueda
        const postWhere = {
            clinica_id: clinicaId,
            published_at: {
                [Op.between]: [start, end]
            }
        };
        
        if (assetType) {
            postWhere.asset_type = assetType;
        }
        
        // Obtener publicaciones más populares
        const topPosts = await SocialPosts.findAll({
            where: postWhere,
            include: [
                {
                    model: SocialPostStatsDaily,
                    as: 'stats',
                    required: true,
                    attributes: [
                        [sequelize.fn('SUM', sequelize.col(metric)), 'total']
                    ]
                }
            ],
            group: ['SocialPosts.id'],
            order: [[sequelize.literal('total'), 'DESC']],
            limit: parseInt(limit)
        });
        
        // Obtener estadísticas completas para cada publicación
        const postsWithStats = await Promise.all(
            topPosts.map(async post => {
                const fullPost = await SocialPosts.findByPk(post.id, {
                    include: [
                        {
                            model: SocialPostStatsDaily,
                            as: 'stats',
                            required: false,
                            // Obtener solo las estadísticas más recientes
                            separate: true,
                            limit: 1,
                            order: [['date', 'DESC']]
                        }
                    ]
                });
                
                return fullPost;
            })
        );
        
        return res.status(200).json({
            metric,
            posts: postsWithStats
        });
    } catch (error) {
        console.error('❌ Error al obtener publicaciones más populares:', error);
        return res.status(500).json({
            message: 'Error al obtener publicaciones más populares',
            error: error.message
        });
    }
};

// Obtiene resumen de métricas para el dashboard
exports.getDashboardSummary = async (req, res) => {
    try {
        const { clinicaId } = req.params;
        const { startDate, endDate } = req.query;
        
        // Validar parámetros
        if (!clinicaId) {
            return res.status(400).json({ message: 'ID de clínica no proporcionado' });
        }
        
        // Convertir fechas a objetos Date
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto
        
        // Calcular período de comparación (mismo número de días antes del período actual)
        const daysDiff = Math.floor((end - start) / (24 * 60 * 60 * 1000));
        const compareStart = new Date(start.getTime() - daysDiff * 24 * 60 * 60 * 1000);
        const compareEnd = new Date(start.getTime() - 1); // Un día antes del inicio del período actual
        
        // Obtener métricas del período actual
        const currentStats = await SocialStatsDaily.findAll({
            attributes: [
                'asset_type',
                [sequelize.fn('SUM', sequelize.col('impressions')), 'impressions'],
                [sequelize.fn('SUM', sequelize.col('reach')), 'reach'],
                [sequelize.fn('SUM', sequelize.col('engagement')), 'engagement'],
                [sequelize.fn('SUM', sequelize.col('clicks')), 'clicks'],
                [sequelize.fn('AVG', sequelize.col('followers')), 'followers'],
                [sequelize.fn('SUM', sequelize.col('followers_day')), 'followers_day'],
                [sequelize.fn('SUM', sequelize.col('profile_visits')), 'profile_visits']
            ],
            where: {
                clinica_id: clinicaId,
                date: {
                    [Op.between]: [start, end]
                }
            },
            group: ['asset_type']
        });
        
        // Obtener métricas del período de comparación
        const compareStats = await SocialStatsDaily.findAll({
            attributes: [
                'asset_type',
                [sequelize.fn('SUM', sequelize.col('impressions')), 'impressions'],
                [sequelize.fn('SUM', sequelize.col('reach')), 'reach'],
                [sequelize.fn('SUM', sequelize.col('engagement')), 'engagement'],
                [sequelize.fn('SUM', sequelize.col('clicks')), 'clicks'],
                [sequelize.fn('AVG', sequelize.col('followers')), 'followers'],
                [sequelize.fn('SUM', sequelize.col('followers_day')), 'followers_day'],
                [sequelize.fn('SUM', sequelize.col('profile_visits')), 'profile_visits']
            ],
            where: {
                clinica_id: clinicaId,
                date: {
                    [Op.between]: [compareStart, compareEnd]
                }
            },
            group: ['asset_type']
        });
        
        // Obtener publicaciones del período actual
        const posts = await SocialPosts.count({
            where: {
                clinica_id: clinicaId,
                published_at: {
                    [Op.between]: [start, end]
                }
            }
        });
        
        // Obtener publicaciones del período de comparación
        const comparePosts = await SocialPosts.count({
            where: {
                clinica_id: clinicaId,
                published_at: {
                    [Op.between]: [compareStart, compareEnd]
                }
            }
        });
        
        // Obtener publicaciones más populares
        const topPostsResult = await exports.getTopPosts({
            params: { clinicaId },
            query: { startDate: start, endDate: end, limit: 3 }
        }, { 
            status: () => ({ json: data => data })
        });
        
        // Obtener activos de la clínica
        const assets = await ClinicMetaAsset.findAll({
            where: {
                clinicaId: clinicaId,
                isActive: true
            },
            attributes: ['id', 'assetType', 'metaAssetName', 'assetAvatarUrl']
        });
        
        return res.status(200).json({
            clinicaId,
            period: {
                start,
                end,
                days: daysDiff
            },
            comparePeriod: {
                start: compareStart,
                end: compareEnd,
                days: daysDiff
            },
            summary: {
                currentStats,
                compareStats,
                posts,
                comparePosts,
                postsChange: posts - comparePosts,
                postsChangePercent: comparePosts > 0 ? ((posts - comparePosts) / comparePosts) * 100 : null
            },
            topPosts: topPostsResult.posts,
            assets
        });
    } catch (error) {
        console.error('❌ Error al obtener resumen del dashboard:', error);
        return res.status(500).json({
            message: 'Error al obtener resumen del dashboard',
            error: error.message
        });
    }
};
// Serie diaria: orgánico vs. de pago por clínica
exports.getOrganicVsPaidByDay = async (req, res) => {
    try {
        const { clinicaId } = req.params;
        const { startDate, endDate, assetType } = req.query;
        if (!clinicaId) return res.status(400).json({ message: 'ID de clínica no proporcionado' });

        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30*24*60*60*1000);
        const end = endDate ? new Date(endDate) : new Date();

        // ORGÁNICO: sumar reach por día desde SocialPostStatsDaily cruzado con SocialPosts
        const organicRows = await SocialPostStatsDaily.findAll({
            attributes: ['date', [sequelize.fn('SUM', sequelize.col('reach')), 'reach']],
            include: [
                { model: SocialPosts, as: 'post', attributes: [], where: { clinica_id: clinicaId, ...(assetType ? { asset_type: assetType } : {}) } }
            ],
            where: { date: { [Op.between]: [start, end] } },
            group: ['date'],
            order: [['date','ASC']],
            raw: true
        });

        // DE PAGO: reach por día desde SocialAdsInsightsDaily filtrando ad accounts de la clínica y plataforma
        const adAccounts = await ClinicMetaAsset.findAll({ where: { clinicaId, assetType: 'ad_account', isActive: true }, raw: true });
        const adAccountIds = adAccounts.map(a => a.metaAssetId);
        let paidRows = [];
        if (adAccountIds.length > 0) {
            const wherePaid = {
                ad_account_id: { [Op.in]: adAccountIds },
                date: { [Op.between]: [start, end] }
            };
            if (assetType === 'instagram_business') wherePaid.publisher_platform = 'instagram';
            if (assetType === 'facebook_page') wherePaid.publisher_platform = 'facebook';

            paidRows = await SocialAdsInsightsDaily.findAll({
                attributes: ['date', [sequelize.fn('SUM', sequelize.col('reach')), 'reach']],
                where: wherePaid,
                group: ['date'],
                order: [['date','ASC']],
                raw: true
            });
        }

        // Unificar por fecha
        const map = new Map();
        for (const r of organicRows) {
            const d = r.date; const v = parseInt(r.reach,10) || 0;
            map.set(d, { date: d, organic: v, paid: 0 });
        }
        for (const r of paidRows) {
            const d = r.date; const v = parseInt(r.reach,10) || 0;
            const row = map.get(d) || { date: d, organic: 0, paid: 0 };
            row.paid += v; map.set(d, row);
        }
        const series = Array.from(map.values()).sort((a,b)=> a.date < b.date ? -1 : 1).map(x => ({ ...x, total: x.organic + x.paid }));

        return res.status(200).json({ startDate: start, endDate: end, assetType: assetType || null, series });
    } catch (error) {
        console.error('❌ Error en getOrganicVsPaidByDay:', error);
        return res.status(500).json({ message: 'Error interno', error: error.message });
    }
};
