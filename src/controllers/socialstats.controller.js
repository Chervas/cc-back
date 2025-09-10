'use strict';
const { 
    SocialStatsDaily, 
    SocialPosts, 
    SocialPostStatsDaily, 
    ClinicMetaAsset,
    SocialAdsInsightsDaily,
    SocialAdsActionsDaily,
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
        
        // Convertir fechas a objetos Date y a cadenas YYYY-MM-DD (evita desfases de TZ con DATEONLY)
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const end = endDate ? new Date(endDate) : new Date();
        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const startStr = startDate || fmt(start);
        const endStr = endDate || fmt(end);
        
        // Construir condiciones de búsqueda
        const where = {
            clinica_id: clinicaId,
            date: { [Op.between]: [startStr, endStr] }
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
                    [sequelize.fn('SUM', sequelize.literal('COALESCE(reach_total, reach)')), 'reach'],
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
        
        // Convertir fechas a objetos Date y a cadenas YYYY-MM-DD (evita desfases de TZ con DATEONLY)
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const end = endDate ? new Date(endDate) : new Date();
        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const startStr = startDate || fmt(start);
        const endStr = endDate || fmt(end);
        
        // Construir condiciones de búsqueda
        const where = {
            asset_id: assetId,
            date: { [Op.between]: [startStr, endStr] }
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
                    [sequelize.fn('SUM', sequelize.literal('COALESCE(reach_total, reach)')), 'reach'],
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
        
        // Convertir fechas y filtrar por día completo usando DATE(published_at)
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto
        const end = endDate ? new Date(endDate) : new Date();

        // Fechas en formato YYYY-MM-DD (local) para evitar desfases por UTC
        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const startStr = startDate || fmt(start);
        const endStr = endDate || fmt(end);

        // Filtro base por clínica (y tipo de asset opcional)
        const where = { clinica_id: clinicaId };
        if (assetType) { where.asset_type = assetType; }

        // Filtro por día completo en base de datos: DATE(published_at) BETWEEN startStr AND endStr
        const dateFilter = sequelize.where(
            sequelize.fn('DATE', sequelize.col('published_at')),
            { [Op.between]: [startStr, endStr] }
        );
        
        if (assetType) {
            where.asset_type = assetType;
        }
        
        // Obtener publicaciones
        const posts = await SocialPosts.findAndCountAll({
            where: { ...where, [Op.and]: [dateFilter] },
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

        // Calcular alcance ORGÁNICO por publicación en el rango
        const postIds = posts.rows.map(p => p.id);
        const organicAggByPost = {};
        if (postIds.length > 0) {
            const organicAgg = await SocialPostStatsDaily.findAll({
                where: {
                    post_id: { [Op.in]: postIds },
                    date: { [Op.between]: [startStr, endStr] }
                },
                attributes: [
                    'post_id',
                    [sequelize.fn('SUM', sequelize.col('reach')), 'reach'],
                    [sequelize.fn('SUM', sequelize.col('impressions')), 'impressions'],
                    [sequelize.fn('SUM', sequelize.col('engagement')), 'engagement'],
                    [sequelize.fn('SUM', sequelize.col('video_views')), 'video_views']
                ],
                group: ['post_id'],
                raw: true
            });
            for (const r of organicAgg) {
                organicAggByPost[r.post_id] = {
                    reach: parseInt(r.reach, 10) || 0,
                    impressions: parseInt(r.impressions, 10) || 0,
                    engagement: parseInt(r.engagement, 10) || 0,
                    video_views: parseInt(r.video_views, 10) || 0
                };
            }
        }

        // Calcular alcance de pago por publicación (si hay vínculos con anuncios)
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
                        date: { [Op.between]: [startStr, endStr] }
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

        // Adjuntar agregados orgánicos y paid_reach en la salida
        const rows = posts.rows.map(p => {
            const json = p.toJSON();
            const o = organicAggByPost[p.id] || { reach: 0, impressions: 0, engagement: 0, video_views: 0 };
            json.organic_reach = o.reach;
            json.organic_impressions = o.impressions;
            json.organic_engagement = o.engagement;
            json.organic_video_views = o.video_views;
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

// ==============================
// Salud de campañas (Meta Ads)
// ==============================
exports.getAdsHealth = async (req, res) => {
    try {
        const { clinicaId } = req.params;
        const { startDate, endDate, platform = 'meta' } = req.query;
        if (!clinicaId) return res.status(400).json({ message: 'ID de clínica requerido' });
        if (platform !== 'meta') {
            return res.status(200).json({ platform, period: { start: startDate, end: endDate }, cards: [] });
        }

        // Rango (por defecto últimos 7 días)
        const end = endDate ? new Date(endDate) : new Date();
        end.setHours(0,0,0,0);
        const start = startDate ? new Date(startDate) : new Date(end.getTime() - 6*86400000);
        start.setHours(0,0,0,0);
        const prevEnd = new Date(start.getTime() - 86400000);
        const prevStart = new Date(prevEnd.getTime() - (end.getTime() - start.getTime()));
        const fmt = (d)=> d.toISOString().slice(0,10);

        // Ad accounts de la clínica
        const accounts = await ClinicMetaAsset.findAll({ where: { clinicaId, isActive: true, assetType: 'ad_account' } });
        const accIds = accounts.map(a => a.metaAssetId);
        if (!accIds.length) return res.status(200).json({ platform:'meta', period: { start: fmt(start), end: fmt(end) }, cards: [] });

        // Umbrales parametrizables (querystring) con defaults desde .env
        const num = (v) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : undefined; };
        const envFreq = num(process.env.ADS_HEALTH_FREQ_MAX) ?? 3;
        const envCtr = num(process.env.ADS_HEALTH_CTR_MIN) ?? 0.005;
        const envCpl = num(process.env.ADS_HEALTH_CPL_MAX) ?? 15;
        const envGrowth = num(process.env.ADS_HEALTH_CPL_GROWTH) ?? 0.4;
        const freq = Math.max(0.1, num(req.query.freq) ?? envFreq);
        const ctr = Math.min(0.5, Math.max(0, num(req.query.ctr) ?? envCtr));
        const cpl = Math.max(0, num(req.query.cpl) ?? envCpl);
        const growth = Math.max(0, num(req.query.growth) ?? envGrowth);
        const growthM = 1 + growth; // multiplicador

        const replacements = { accs: accIds, s: fmt(start), e: fmt(end), ps: fmt(prevStart), pe: fmt(prevEnd), freq, ctr, cpl, growthM };

        // Helper: condición de activos (excluir pausados/archivados/eliminados)
        const notInactive = `UPPER(IFNULL(%s.status,'')) NOT IN ('PAUSED','ARCHIVED','DELETED','INACTIVE')
                             AND UPPER(IFNULL(%s.effective_status,'')) NOT IN ('PAUSED','ARCHIVED','DELETED','INACTIVE')`;

        // 1) Grupos de anuncios sin leads 48h (spend>0 y leads=0) — sólo adsets/campaigns activos
        const [noLeads48h] = await SocialAdsInsightsDaily.sequelize.query(`
            SELECT se.ad_account_id,
                   se.name as adset_name, se.entity_id as adset_id,
                   camp.name as campaign_name, camp.entity_id as campaign_id,
                   cl.nombre_clinica as clinic_name,
                   x.entity_id, x.spend, IFNULL(l.leads,0) leads
            FROM (
              SELECT d.entity_id, SUM(d.spend) spend
              FROM SocialAdsInsightsDaily d
              WHERE d.ad_account_id IN (:accs) AND d.level='adset' AND d.date BETWEEN DATE_SUB(:e, INTERVAL 1 DAY) AND :e
              GROUP BY d.entity_id
            ) x
            LEFT JOIN (
              SELECT a.entity_id, SUM(a.value) leads
              FROM SocialAdsActionsDaily a
              WHERE a.action_type IN ('lead','offsite_conversion.fb_pixel_lead') AND a.date BETWEEN DATE_SUB(:e, INTERVAL 1 DAY) AND :e
              GROUP BY a.entity_id
            ) l ON l.entity_id = x.entity_id
            LEFT JOIN SocialAdsEntities se ON se.entity_id = x.entity_id
            LEFT JOIN SocialAdsEntities camp ON camp.entity_id = se.parent_id
            LEFT JOIN ClinicMetaAssets cma ON cma.assetType='ad_account' AND cma.metaAssetId = se.ad_account_id
            LEFT JOIN Clinicas cl ON cl.id_clinica = cma.clinicaId
            WHERE IFNULL(l.leads,0)=0 AND x.spend>0
              AND ${notInactive.replace(/%s/g, 'se')}
              AND ${notInactive.replace(/%s/g, 'camp')}
            ORDER BY x.spend DESC
            LIMIT 50;`, { replacements });

        // 2) Frecuencia > 3 (anuncios) — sólo anuncios y sus padres activos
        const [highFreq] = await SocialAdsInsightsDaily.sequelize.query(`
            SELECT se.ad_account_id,
                   se.name as ad_name, se.entity_id as ad_id,
                   aset.name as adset_name, aset.entity_id as adset_id,
                   camp.name as campaign_name, camp.entity_id as campaign_id,
                   cl.nombre_clinica as clinic_name,
                   x.entity_id, x.avg_freq
            FROM (
                SELECT d.entity_id, AVG(d.frequency) avg_freq
                FROM SocialAdsInsightsDaily d
                WHERE d.ad_account_id IN (:accs) AND d.level='ad' AND d.date BETWEEN :s AND :e
                GROUP BY d.entity_id
            ) x
            LEFT JOIN SocialAdsEntities se ON se.entity_id = x.entity_id
            LEFT JOIN SocialAdsEntities aset ON aset.entity_id = se.parent_id
            LEFT JOIN SocialAdsEntities camp ON camp.entity_id = aset.parent_id
            LEFT JOIN ClinicMetaAssets cma ON cma.assetType='ad_account' AND cma.metaAssetId = se.ad_account_id
            LEFT JOIN Clinicas cl ON cl.id_clinica = cma.clinicaId
            WHERE x.avg_freq > :freq
              AND ${notInactive.replace(/%s/g, 'se')}
              AND ${notInactive.replace(/%s/g, 'aset')}
              AND ${notInactive.replace(/%s/g, 'camp')}
            ORDER BY x.avg_freq DESC
            LIMIT 50;`, { replacements });

        // 3) CPL muy alto (>=40% sobre la semana previa)
        const [cplGrowth] = await SocialAdsInsightsDaily.sequelize.query(`
          SELECT cur.entity_id,
                 se.ad_account_id,
                 se.name as adset_name, se.entity_id as adset_id,
                 camp.name as campaign_name, camp.entity_id as campaign_id,
                 cl.nombre_clinica as clinic_name,
                 CASE WHEN cur.leads>0 THEN cur.spend/cur.leads ELSE NULL END cpl_cur,
                 CASE WHEN prev.leads>0 THEN prev.spend/prev.leads ELSE NULL END cpl_prev
          FROM (
            SELECT d.entity_id, SUM(d.spend) spend, IFNULL(SUM(a.value),0) leads
            FROM SocialAdsInsightsDaily d
            LEFT JOIN SocialAdsActionsDaily a ON a.entity_id=d.entity_id AND a.date=d.date AND a.action_type IN ('lead','offsite_conversion.fb_pixel_lead')
            WHERE d.ad_account_id IN (:accs) AND d.level='adset' AND d.date BETWEEN :s AND :e
            GROUP BY d.entity_id
          ) cur
          LEFT JOIN (
            SELECT d.entity_id, SUM(d.spend) spend, IFNULL(SUM(a.value),0) leads
            FROM SocialAdsInsightsDaily d
            LEFT JOIN SocialAdsActionsDaily a ON a.entity_id=d.entity_id AND a.date=d.date AND a.action_type IN ('lead','offsite_conversion.fb_pixel_lead')
            WHERE d.ad_account_id IN (:accs) AND d.level='adset' AND d.date BETWEEN :ps AND :pe
            GROUP BY d.entity_id
          ) prev ON prev.entity_id=cur.entity_id
          LEFT JOIN SocialAdsEntities se ON se.entity_id=cur.entity_id
          LEFT JOIN SocialAdsEntities camp ON camp.entity_id=se.parent_id
          LEFT JOIN ClinicMetaAssets cma ON cma.assetType='ad_account' AND cma.metaAssetId = se.ad_account_id
          LEFT JOIN Clinicas cl ON cl.id_clinica = cma.clinicaId
          WHERE cur.leads>0 AND prev.leads>0 AND (cur.spend/cur.leads) >= :growthM * (prev.spend/prev.leads)
            AND ${notInactive.replace(/%s/g, 'se')}
            AND ${notInactive.replace(/%s/g, 'camp')}
          ORDER BY (cur.spend/cur.leads) DESC
          LIMIT 50;`, { replacements });

        // 4) CPL > 15€
        const [cplOver15] = await SocialAdsInsightsDaily.sequelize.query(`
          SELECT cur.entity_id,
                 se.ad_account_id,
                 se.name as adset_name, se.entity_id as adset_id,
                 camp.name as campaign_name, camp.entity_id as campaign_id,
                 cl.nombre_clinica as clinic_name,
                 CASE WHEN cur.leads>0 THEN cur.spend/cur.leads ELSE NULL END cpl
          FROM (
            SELECT d.entity_id, SUM(d.spend) spend, IFNULL(SUM(a.value),0) leads
            FROM SocialAdsInsightsDaily d
            LEFT JOIN SocialAdsActionsDaily a ON a.entity_id=d.entity_id AND a.date=d.date AND a.action_type IN ('lead','offsite_conversion.fb_pixel_lead')
            WHERE d.ad_account_id IN (:accs) AND d.level='adset' AND d.date BETWEEN :s AND :e
            GROUP BY d.entity_id
          ) cur
          LEFT JOIN SocialAdsEntities se ON se.entity_id=cur.entity_id
          LEFT JOIN SocialAdsEntities camp ON camp.entity_id=se.parent_id
          LEFT JOIN ClinicMetaAssets cma ON cma.assetType='ad_account' AND cma.metaAssetId = se.ad_account_id
          LEFT JOIN Clinicas cl ON cl.id_clinica = cma.clinicaId
          WHERE cur.leads>0 AND (cur.spend/cur.leads) > :cpl
            AND ${notInactive.replace(/%s/g, 'se')}
            AND ${notInactive.replace(/%s/g, 'camp')}
          ORDER BY cpl DESC
          LIMIT 50;`, { replacements });

        const cards = [
            { id: 'no-leads-48h', title: 'Grupos de anuncios sin leads en las últimas 48 horas', status: noLeads48h.length ? 'error' : 'ok', items: noLeads48h },
            { id: 'frequency-gt-3', title: 'Frecuencia del anuncio > 3', status: highFreq.length ? 'warning' : 'ok', items: highFreq },
            { id: 'cpl-growth', title: 'Precio del lead muy alto (≥40% vs. semana previa)', status: cplGrowth.length ? 'error' : 'ok', items: cplGrowth },
            { id: 'cpl-over-15', title: 'Alerta de lead por encima de 15€', status: cplOver15.length ? 'error' : 'ok', items: cplOver15 }
        ];

        // 5) CTR bajo (<0.5%) en el rango (anuncios)
        const [lowCtr] = await SocialAdsInsightsDaily.sequelize.query(`
            SELECT se.ad_account_id,
                   se.name as ad_name, se.entity_id as ad_id,
                   aset.name as adset_name, aset.entity_id as adset_id,
                   camp.name as campaign_name, camp.entity_id as campaign_id,
                   cl.nombre_clinica as clinic_name,
                   x.entity_id, x.clicks, x.impressions,
                   CASE WHEN x.impressions>0 THEN x.clicks/x.impressions ELSE 0 END ctr
            FROM (
                SELECT d.entity_id, SUM(d.clicks) clicks, SUM(d.impressions) impressions
                FROM SocialAdsInsightsDaily d
                WHERE d.ad_account_id IN (:accs) AND d.level='ad' AND d.date BETWEEN :s AND :e
                GROUP BY d.entity_id
            ) x
            LEFT JOIN SocialAdsEntities se ON se.entity_id = x.entity_id
            LEFT JOIN SocialAdsEntities aset ON aset.entity_id = se.parent_id
            LEFT JOIN SocialAdsEntities camp ON camp.entity_id = aset.parent_id
            LEFT JOIN ClinicMetaAssets cma ON cma.assetType='ad_account' AND cma.metaAssetId = se.ad_account_id
            LEFT JOIN Clinicas cl ON cl.id_clinica = cma.clinicaId
            WHERE x.impressions >= 100 AND (x.clicks/x.impressions) < :ctr
              AND ${notInactive.replace(/%s/g, 'se')}
              AND ${notInactive.replace(/%s/g, 'aset')}
              AND ${notInactive.replace(/%s/g, 'camp')}
            ORDER BY ctr ASC
            LIMIT 50;`, { replacements });
        cards.push({ id: 'low-ctr', title: 'CTR bajo (<0,5%)', status: lowCtr.length ? 'warning' : 'ok', items: lowCtr });

        // 6) Learning limited (adset)
        const [learningLimited] = await SocialAdsInsightsDaily.sequelize.query(`
            SELECT se.ad_account_id,
                   se.name as adset_name, se.entity_id as adset_id,
                   camp.name as campaign_name, camp.entity_id as campaign_id,
                   cl.nombre_clinica as clinic_name,
                   se.entity_id, se.effective_status
            FROM SocialAdsEntities se
            LEFT JOIN SocialAdsEntities camp ON camp.entity_id = se.parent_id
            LEFT JOIN ClinicMetaAssets cma ON cma.assetType='ad_account' AND cma.metaAssetId = se.ad_account_id
            LEFT JOIN Clinicas cl ON cl.id_clinica = cma.clinicaId
            WHERE se.ad_account_id IN (:accs) AND se.level='adset' AND se.effective_status LIKE 'LEARNING_LIMITED%'
              AND ${notInactive.replace(/%s/g, 'se')}
              AND ${notInactive.replace(/%s/g, 'camp')}
            ORDER BY se.updated_at DESC
            LIMIT 50;`, { replacements });
        cards.push({ id: 'learning-limited', title: 'Conjunto en aprendizaje limitado', status: learningLimited.length ? 'warning' : 'ok', items: learningLimited });

        // 7) Anuncios rechazados
        const [rejectedAds] = await SocialAdsInsightsDaily.sequelize.query(`
            SELECT se.ad_account_id,
                   se.name as ad_name, se.entity_id as ad_id,
                   aset.name as adset_name, aset.entity_id as adset_id,
                   camp.name as campaign_name, camp.entity_id as campaign_id,
                   cl.nombre_clinica as clinic_name,
                   se.entity_id, se.status, se.effective_status
            FROM SocialAdsEntities se
            LEFT JOIN SocialAdsEntities aset ON aset.entity_id = se.parent_id
            LEFT JOIN SocialAdsEntities camp ON camp.entity_id = aset.parent_id
            LEFT JOIN ClinicMetaAssets cma ON cma.assetType='ad_account' AND cma.metaAssetId = se.ad_account_id
            LEFT JOIN Clinicas cl ON cl.id_clinica = cma.clinicaId
            WHERE se.ad_account_id IN (:accs) AND se.level='ad' AND (
                UPPER(se.status) LIKE '%REJECT%' OR UPPER(se.status) LIKE '%DISAPPROV%'
                OR UPPER(se.effective_status) LIKE '%REJECT%' OR UPPER(se.effective_status) LIKE '%DISAPPROV%'
            )
              AND ${notInactive.replace(/%s/g, 'se')}
              AND ${notInactive.replace(/%s/g, 'aset')}
              AND ${notInactive.replace(/%s/g, 'camp')}
            ORDER BY se.updated_at DESC
            LIMIT 50;`, { replacements });
        cards.push({ id: 'rejected-ads', title: 'Anuncios rechazados', status: rejectedAds.length ? 'error' : 'ok', items: rejectedAds });

        // Añadir ui_link en items
        function linkFor(level, acc, id, adsetId, campaignId) {
            if (!acc || !id) return null;
            const act = String(acc).replace(/^act_/, '');
            const base = 'https://adsmanager.facebook.com/adsmanager/manage/ads?act=' + act;
            const params = [];
            if (campaignId) params.push(`selected_campaign_ids=${campaignId}`);
            if (adsetId) params.push(`selected_adset_ids=${adsetId}`);
            if (level === 'ad') params.push(`selected_ad_ids=${id}`);
            return base + (params.length ? '&' + params.join('&') : '');
        }
        const mapLink = (arr, level) => (arr || []).map(it => ({ ...it, ui_link: linkFor(level, it.ad_account_id, it.entity_id, it.adset_id, it.campaign_id) }));
        const cardsLinked = cards.map(c => {
            let level = 'adset';
            if (c.id === 'frequency-gt-3' || c.id === 'low-ctr' || c.id === 'rejected-ads') level = 'ad';
            return { ...c, items: mapLink(c.items, level) };
        });

        return res.status(200).json({ platform:'meta', period: { start: fmt(start), end: fmt(end) }, cards: cardsLinked });
    } catch (error) {
        console.error('❌ getAdsHealth error:', error);
        return res.status(500).json({ message: 'Error obteniendo salud de campañas', error: error.message });
    }
}

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
        
        // Convertir fechas y preparar cadenas YYYY-MM-DD
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const end = endDate ? new Date(endDate) : new Date();
        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const startStr = startDate || fmt(start);
        const endStr = endDate || fmt(end);
        
        // Validar métrica
        const validMetrics = ['engagement', 'likes', 'comments', 'shares', 'impressions', 'reach'];
        if (!validMetrics.includes(metric)) {
            return res.status(400).json({ 
                message: `Métrica inválida. Valores permitidos: ${validMetrics.join(', ')}` 
            });
        }
        
        // Construir condiciones de búsqueda
        const postWhere = { clinica_id: clinicaId };
        const dateFilter = sequelize.where(
            sequelize.fn('DATE', sequelize.col('published_at')),
            { [Op.between]: [startStr, endStr] }
        );
        
        if (assetType) {
            postWhere.asset_type = assetType;
        }
        
        // Obtener publicaciones más populares
        const topPosts = await SocialPosts.findAll({
            where: { ...postWhere, [Op.and]: [dateFilter] },
            include: [
                {
                    model: SocialPostStatsDaily,
                    as: 'stats',
                    required: true,
                    attributes: [[sequelize.fn('SUM', sequelize.col(`stats.${metric}`)), 'total']],
                    where: { date: { [Op.between]: [startStr, endStr] } }
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
        
        // Convertir fechas y preparar cadenas YYYY-MM-DD
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const startStr = startDate || fmt(start);
        const endStr = endDate || fmt(end);
        
        // Calcular período de comparación (mismo número de días antes del período actual)
        const daysDiff = Math.floor((end - start) / (24 * 60 * 60 * 1000));
        const msDay = 24 * 60 * 60 * 1000;
        const compareEndDate = new Date(start.getTime() - msDay);
        const compareStartDate = new Date(compareEndDate.getTime() - (daysDiff - 1) * msDay);
        const compareStartStr = fmt(compareStartDate);
        const compareEndStr = fmt(compareEndDate);
        
        // Obtener métricas del período actual
        const currentStats = await SocialStatsDaily.findAll({
            attributes: [
                'asset_type',
                [sequelize.fn('SUM', sequelize.col('impressions')), 'impressions'],
                [sequelize.fn('SUM', sequelize.literal('COALESCE(reach_total, reach)')), 'reach'],
                [sequelize.fn('SUM', sequelize.col('engagement')), 'engagement'],
                [sequelize.fn('SUM', sequelize.col('clicks')), 'clicks'],
                [sequelize.fn('AVG', sequelize.col('followers')), 'followers'],
                [sequelize.fn('SUM', sequelize.col('followers_day')), 'followers_day'],
                [sequelize.fn('SUM', sequelize.col('profile_visits')), 'profile_visits']
            ],
            where: {
                clinica_id: clinicaId,
                date: { [Op.between]: [startStr, endStr] }
            },
            group: ['asset_type']
        });
        
        // Obtener métricas del período de comparación
        const compareStats = await SocialStatsDaily.findAll({
            attributes: [
                'asset_type',
                [sequelize.fn('SUM', sequelize.col('impressions')), 'impressions'],
                [sequelize.fn('SUM', sequelize.literal('COALESCE(reach_total, reach)')), 'reach'],
                [sequelize.fn('SUM', sequelize.col('engagement')), 'engagement'],
                [sequelize.fn('SUM', sequelize.col('clicks')), 'clicks'],
                [sequelize.fn('AVG', sequelize.col('followers')), 'followers'],
                [sequelize.fn('SUM', sequelize.col('followers_day')), 'followers_day'],
                [sequelize.fn('SUM', sequelize.col('profile_visits')), 'profile_visits']
            ],
            where: {
                clinica_id: clinicaId,
                date: { [Op.between]: [compareStartStr, compareEndStr] }
            },
            group: ['asset_type']
        });
        
        // Obtener publicaciones del período actual
        const dateFilterCurrent = sequelize.where(
            sequelize.fn('DATE', sequelize.col('published_at')),
            { [Op.between]: [startStr, endStr] }
        );
        const posts = await SocialPosts.count({ where: { clinica_id: clinicaId, [Op.and]: [dateFilterCurrent] } });
        
        // Obtener publicaciones del período de comparación
        const dateFilterCompare = sequelize.where(
            sequelize.fn('DATE', sequelize.col('published_at')),
            { [Op.between]: [compareStartStr, compareEndStr] }
        );
        const comparePosts = await SocialPosts.count({ where: { clinica_id: clinicaId, [Op.and]: [dateFilterCompare] } });
        
        // Obtener publicaciones más populares
        const topPostsResult = await exports.getTopPosts({
            params: { clinicaId },
            query: { startDate: startStr, endDate: endStr, limit: 3 }
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
            period: { start: startStr, end: endStr, days: daysDiff },
            comparePeriod: { start: compareStartStr, end: compareEndStr, days: daysDiff },
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
        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const startStr = startDate || fmt(start);
        const endStr = endDate || fmt(end);

        // TOTAL (Meta): sumar reach_total por día desde SocialStatsDaily (alcance total de la cuenta)
        const organicWhere = {
            clinica_id: clinicaId,
            date: { [Op.between]: [startStr, endStr] },
            ...(assetType
                ? { asset_type: assetType }
                : { asset_type: { [Op.in]: ['instagram_business', 'facebook_page'] } })
        };
        const organicRows = await SocialStatsDaily.findAll({
            // Usar COALESCE(reach_total, reach) para abarcar FB (total) e IG (reach = total)
            attributes: ['date', [sequelize.fn('SUM', sequelize.literal('COALESCE(reach_total, reach)')), 'reach']],
            where: organicWhere,
            group: ['date'],
            order: [['date','ASC']],
            raw: true
        });
        // Índice del total "Meta" por fecha (no suma orgánico+paid)
        const metaByDate = new Map();
        for (const r of organicRows) {
            metaByDate.set(r.date, parseInt(r.reach, 10) || 0);
        }

        // DE PAGO: reach por día desde SocialAdsInsightsDaily filtrando ad accounts de la clínica y plataforma
        const adAccounts = await ClinicMetaAsset.findAll({ where: { clinicaId, assetType: 'ad_account', isActive: true }, raw: true });
        const adAccountIds = adAccounts.map(a => a.metaAssetId);
        let paidRows = [];
        if (adAccountIds.length > 0) {
            const wherePaid = {
                ad_account_id: { [Op.in]: adAccountIds },
                date: { [Op.between]: [startStr, endStr] }
            };
            // Atribuir anuncios solo a la plataforma seleccionada; si no hay assetType, IG+FB
            if (assetType === 'instagram_business') wherePaid.publisher_platform = 'instagram';
            else if (assetType === 'facebook_page') wherePaid.publisher_platform = 'facebook';
            else wherePaid.publisher_platform = { [Op.in]: ['instagram','facebook'] };

            paidRows = await SocialAdsInsightsDaily.findAll({
                attributes: ['date', [sequelize.fn('SUM', sequelize.col('reach')), 'reach']],
                where: wherePaid,
                group: ['date'],
                order: [['date','ASC']],
                raw: true
            });
        }

        // Unificar por fecha
        const paidByDate = new Map();
        for (const r of paidRows) {
            const d = r.date; const v = parseInt(r.reach, 10) || 0;
            paidByDate.set(d, (paidByDate.get(d) || 0) + v);
        }
        const dates = new Set([...metaByDate.keys(), ...paidByDate.keys()]);
        const series = Array.from(dates).sort((a,b) => a < b ? -1 : 1).map(d => {
            const meta = metaByDate.get(d) || 0;
            const paid = paidByDate.get(d) || 0;
            // orgánico estimado = meta − paid (no negativo)
            const organic = (assetType === 'instagram_business' || assetType === 'facebook_page')
                ? Math.max(0, meta - paid)
                : Math.max(0, meta - paid); // mismo criterio cuando no se filtra
            return { date: d, organic, paid, total: meta };
        });

        return res.status(200).json({ startDate: startStr, endDate: endStr, assetType: assetType || null, series });
    } catch (error) {
        console.error('❌ Error en getOrganicVsPaidByDay:', error);
        return res.status(500).json({ message: 'Error interno', error: error.message });
    }
};

// Serie diaria: visualizaciones orgánico vs. de pago por clínica
exports.getViewsOrganicVsPaidByDay = async (req, res) => {
    try {
        const { clinicaId } = req.params;
        const { startDate, endDate, assetType } = req.query;
        if (!clinicaId) return res.status(400).json({ message: 'ID de clínica no proporcionado' });

        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30*24*60*60*1000);
        const end = endDate ? new Date(endDate) : new Date();
        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const startStr = startDate || fmt(start);
        const endStr = endDate || fmt(end);

        // TOTAL (Meta): visualizaciones/impresiones por día desde SocialStatsDaily
        const organicWhere = {
            clinica_id: clinicaId,
            date: { [Op.between]: [startStr, endStr] },
            ...(assetType
                ? { asset_type: assetType }
                : { asset_type: { [Op.in]: ['instagram_business', 'facebook_page'] } })
        };
        const organicRows = await SocialStatsDaily.findAll({
            // Para "visualizaciones totales": usar COALESCE(views, impressions)
            attributes: ['date', [sequelize.fn('SUM', sequelize.literal('COALESCE(views, impressions)')), 'views']],
            where: organicWhere,
            group: ['date'],
            order: [['date','ASC']],
            raw: true
        });

        // DE PAGO: impresiones por día desde SocialAdsInsightsDaily
        // Modo Meta-like por contenido: si hay mapeo de anuncios→posts de la plataforma (PostPromotions),
        // filtrar por esos ad_ids (entity_id) y sumar IG+FB; fallback: IG+FB sin mapeo
        const adAccounts = await ClinicMetaAsset.findAll({ where: { clinicaId, assetType: 'ad_account', isActive: true }, raw: true });
        const adAccountIds = adAccounts.map(a => a.metaAssetId);
        let paidRows = [];
        if (adAccountIds.length > 0) {
            const wherePaid = {
                ad_account_id: { [Op.in]: adAccountIds },
                date: { [Op.between]: [startStr, endStr] },
                level: 'ad'
            };
            if (assetType === 'instagram_business') wherePaid["publisher_platform"] = 'instagram';
            else if (assetType === 'facebook_page') wherePaid["publisher_platform"] = 'facebook';
            else wherePaid["publisher_platform"] = { [Op.in]: ['instagram','facebook'] };

            paidRows = await SocialAdsInsightsDaily.findAll({
                attributes: ['date', [sequelize.fn('SUM', sequelize.col('impressions')), 'views']],
                where: wherePaid,
                group: ['date'], order: [['date','ASC']], raw: true
            });
        }

        // Unificar por fecha (orgánico estimado = total − paid). total = total Meta (no suma de series)
        const map = new Map();
        const metaByDate = new Map();
        for (const r of organicRows) { metaByDate.set(r.date, parseInt(r.views,10) || 0); }
        const paidByDate = new Map();
        for (const r of paidRows) { paidByDate.set(r.date, (paidByDate.get(r.date) || 0) + (parseInt(r.views,10) || 0)); }
        const dates = new Set([...metaByDate.keys(), ...paidByDate.keys()]);
        for (const d of dates) {
            const meta = metaByDate.get(d) || 0;
            const paid = paidByDate.get(d) || 0;
            const organic = Math.max(0, meta - paid);
            map.set(d, { date: d, organic, paid, total: meta });
        }
        const series = Array.from(map.values()).sort((a,b)=> a.date < b.date ? -1 : 1);

        return res.status(200).json({ startDate: startStr, endDate: endStr, assetType: assetType || null, series });
    } catch (error) {
        console.error('❌ Error en getViewsOrganicVsPaidByDay:', error);
        return res.status(500).json({ message: 'Error interno', error: error.message });
    }
};

// Desglose de visualizaciones de pago por plataforma/posición (Meta Ads)
exports.getPaidViewsBreakdown = async (req, res) => {
    try {
        const { clinicaId } = req.params;
        const { startDate, endDate, includeAllPlatforms, platform, assetType } = req.query;
        if (!clinicaId) return res.status(400).json({ message: 'ID de clínica no proporcionado' });

        // Fechas (por defecto últimos 30 días)
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30*24*60*60*1000);
        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const startStr = startDate || fmt(start);
        const endStr = endDate || fmt(end);

        // Obtener ad accounts de la clínica
        const adAccounts = await ClinicMetaAsset.findAll({ where: { clinicaId, assetType: 'ad_account', isActive: true }, raw: true });
        const adAccountIds = adAccounts.map(a => a.metaAssetId);
        if (adAccountIds.length === 0) {
            return res.status(200).json({
                clinicaId,
                period: { start: startStr, end: endStr },
                metric: 'paid_views',
                totals: { impressions: 0, spend: 0, cpm: null },
                byPlatform: []
            });
        }

        // Filtro de plataformas (por defecto IG+FB)
        // Filtro por plataforma seleccionada (pestaña). Permitir assetType mapping.
        let platformFilter = platform;
        if (!platformFilter && assetType) {
            if (assetType === 'instagram_business') platformFilter = 'instagram';
            if (assetType === 'facebook_page') platformFilter = 'facebook';
        }
        const wherePlatform = platformFilter
            ? { publisher_platform: platformFilter }
            : (includeAllPlatforms === 'true' ? {} : { publisher_platform: { [Op.in]: ['instagram', 'facebook'] } });

        // Query agregada
        let rows = await SocialAdsInsightsDaily.findAll({
            attributes: [
                'publisher_platform',
                'platform_position',
                [sequelize.fn('SUM', sequelize.col('impressions')), 'impressions'],
                [sequelize.fn('SUM', sequelize.col('spend')), 'spend']
            ],
            where: {
                ad_account_id: { [Op.in]: adAccountIds },
                level: 'ad',
                date: { [Op.between]: [startStr, endStr] },
                ...wherePlatform
            },
            group: ['publisher_platform', 'platform_position'],
            raw: true
        });

        // Si hay posiciones específicas, ignorar 'unknown' para evitar mezclar
        const hasSpecific = rows.some(r => (r.platform_position || '').toLowerCase() !== 'unknown' && r.platform_position !== null);
        if (hasSpecific) {
            rows = rows.filter(r => (r.platform_position || '').toLowerCase() !== 'unknown');
        }

        // Totales y estructura
        let totalImpr = 0; let totalSpend = 0;
        const platforms = new Map();
        for (const r of rows) {
            const platform = r.publisher_platform || 'unknown';
            const position = r.platform_position || 'unknown';
            const impressions = parseInt(r.impressions, 10) || 0;
            const spend = parseFloat(r.spend) || 0;
            totalImpr += impressions; totalSpend += spend;
            if (!platforms.has(platform)) {
                platforms.set(platform, { platform, impressions: 0, spend: 0, positions: [] });
            }
            const p = platforms.get(platform);
            p.impressions += impressions; p.spend += spend;
            p.positions.push({ position, impressions, spend, cpm: impressions > 0 ? (spend/impressions)*1000 : null });
        }
        const byPlatform = Array.from(platforms.values()).map(p => ({ ...p, cpm: p.impressions > 0 ? (p.spend/p.impressions)*1000 : null }));

        return res.status(200).json({
            clinicaId,
            period: { start: startStr, end: endStr },
            metric: 'paid_views',
            totals: { impressions: totalImpr, spend: totalSpend, cpm: totalImpr > 0 ? (totalSpend/totalImpr)*1000 : null },
            byPlatform
        });
    } catch (error) {
        console.error('❌ Error en getPaidViewsBreakdown:', error);
        return res.status(500).json({ message: 'Error interno', error: error.message });
    }
};

// Desglose de alcance de pago por plataforma/posición (Meta Ads)
exports.getPaidReachBreakdown = async (req, res) => {
    try {
        const { clinicaId } = req.params;
        const { startDate, endDate, includeAllPlatforms, platform, assetType } = req.query;
        if (!clinicaId) return res.status(400).json({ message: 'ID de clínica no proporcionado' });

        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30*24*60*60*1000);
        const fmt = (d) => { const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; };
        const startStr = startDate || fmt(start);
        const endStr = endDate || fmt(end);

        const adAccounts = await ClinicMetaAsset.findAll({ where: { clinicaId, assetType: 'ad_account', isActive: true }, raw: true });
        const adAccountIds = adAccounts.map(a => a.metaAssetId);
        if (adAccountIds.length === 0) {
            return res.status(200).json({
                clinicaId,
                period: { start: startStr, end: endStr },
                metric: 'paid_reach',
                totals: { reach: 0, spend: 0 },
                byPlatform: []
            });
        }

        let platformFilter = platform;
        if (!platformFilter && assetType) {
            if (assetType === 'instagram_business') platformFilter = 'instagram';
            if (assetType === 'facebook_page') platformFilter = 'facebook';
        }
        const wherePlatform = platformFilter
            ? { publisher_platform: platformFilter }
            : (includeAllPlatforms === 'true' ? {} : { publisher_platform: { [Op.in]: ['instagram', 'facebook'] } });

        let rows = await SocialAdsInsightsDaily.findAll({
            attributes: [
                'publisher_platform',
                'platform_position',
                [sequelize.fn('SUM', sequelize.col('reach')), 'reach'],
                [sequelize.fn('SUM', sequelize.col('spend')), 'spend']
            ],
            where: {
                ad_account_id: { [Op.in]: adAccountIds },
                level: 'ad',
                date: { [Op.between]: [startStr, endStr] },
                ...wherePlatform
            },
            group: ['publisher_platform', 'platform_position'],
            raw: true
        });

        const hasSpecific = rows.some(r => (r.platform_position || '').toLowerCase() !== 'unknown' && r.platform_position !== null);
        if (hasSpecific) {
            rows = rows.filter(r => (r.platform_position || '').toLowerCase() !== 'unknown');
        }

        let totalReach = 0; let totalSpend = 0;
        const platforms = new Map();
        for (const r of rows) {
            const platform = r.publisher_platform || 'unknown';
            const position = r.platform_position || 'unknown';
            const reach = parseInt(r.reach, 10) || 0;
            const spend = parseFloat(r.spend) || 0;
            totalReach += reach; totalSpend += spend;
            if (!platforms.has(platform)) {
                platforms.set(platform, { platform, reach: 0, spend: 0, positions: [] });
            }
            const p = platforms.get(platform);
            p.reach += reach; p.spend += spend;
            p.positions.push({ position, reach, spend });
        }
        const byPlatform = Array.from(platforms.values());

        return res.status(200).json({
            clinicaId,
            period: { start: startStr, end: endStr },
            metric: 'paid_reach',
            totals: { reach: totalReach, spend: totalSpend },
            byPlatform
        });
    } catch (error) {
        console.error('❌ Error en getPaidReachBreakdown:', error);
        return res.status(500).json({ message: 'Error interno', error: error.message });
    }
};
