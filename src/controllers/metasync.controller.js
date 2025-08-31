'use strict';
const axios = require('axios');
const { 
    SocialStatsDaily, 
    SocialPosts, 
    SocialPostStatsDaily, 
    SocialAdsEntity,
    SocialAdsInsightsDaily,
    SocialAdsActionsDaily,
    PostPromotions,
    SyncLog, 
    TokenValidations,
    MetaConnection,
    ClinicMetaAsset
} = require('../../models');
const { Op } = require('sequelize');

// Constantes
const META_API_BASE_URL = process.env.META_API_BASE_URL || 'https://graph.facebook.com';

// Inicia la sincronización de todos los activos de una clínica
exports.syncClinica = async (req, res) => {
    try {
        const { clinicaId } = req.params;
        const { startDate, endDate } = req.body;
        
        // Validar parámetros
        if (!clinicaId) {
            return res.status(400).json({ message: 'ID de clínica no proporcionado' });
        }
        
        // Convertir fechas a objetos Date
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto
        const end = endDate ? new Date(endDate) : new Date();
        
        // Verificar que la clínica existe y tiene activos de Meta
        const assets = await ClinicMetaAsset.findAll({
            where: {
                clinicaId: clinicaId,
                isActive: true
            }
        });
        
        if (!assets || assets.length === 0) {
            return res.status(404).json({ message: 'No se encontraron activos de Meta para esta clínica' });
        }
        
        // Iniciar proceso de sincronización
        const syncLog = await SyncLog.create({
            job_type: 'clinica_sync',
            clinica_id: clinicaId,
            status: 'running',
            started_at: new Date()
        });
        
        // Iniciar sincronización en segundo plano
        syncClinicaAssets(clinicaId, start, end, syncLog.id)
            .then(() => {
                console.log(`✅ Sincronización de clínica ${clinicaId} completada con éxito`);
            })
            .catch(error => {
                console.error(`❌ Error en sincronización de clínica ${clinicaId}:`, error);
                SyncLog.update(
                    {
                        status: 'failed',
                        error_message: error.message,
                        completed_at: new Date()
                    },
                    { where: { id: syncLog.id } }
                );
            });
        
        // Responder inmediatamente con el ID del proceso
        return res.status(202).json({
            message: 'Proceso de sincronización iniciado',
            syncLogId: syncLog.id
        });
    } catch (error) {
        console.error('❌ Error al iniciar sincronización de clínica:', error);
        return res.status(500).json({
            message: 'Error al iniciar sincronización',
            error: error.message
        });
    }
};




// Inicia la sincronización de un activo específico
exports.syncAsset = async (req, res) => {
    try {
        const { assetId } = req.params;
        const { startDate, endDate } = req.body;
        
        // Validar parámetros
        if (!assetId) {
            return res.status(400).json({ message: 'ID de activo no proporcionado' });
        }
        
        // Convertir fechas a objetos Date
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto
        const end = endDate ? new Date(endDate) : new Date();
        
        // Verificar que el activo existe
        const asset = await ClinicMetaAsset.findByPk(assetId);
        
        if (!asset) {
            return res.status(404).json({ message: 'Activo no encontrado' });
        }
        
        // Iniciar proceso de sincronización
        const syncLog = await SyncLog.create({
            job_type: 'asset_sync',
            clinica_id: asset.clinicaId,
            asset_id: assetId,
            asset_type: asset.assetType,
            status: 'running',
            started_at: new Date()
        });
        
        // Iniciar sincronización en segundo plano
        syncAsset(asset, start, end, syncLog.id)
            .then(() => {
                console.log(`✅ Sincronización de activo ${assetId} completada con éxito`);
            })
            .catch(error => {
                console.error(`❌ Error en sincronización de activo ${assetId}:`, error);
                SyncLog.update(
                    {
                        status: 'failed',
                        error_message: error.message,
                        completed_at: new Date()
                    },
                    { where: { id: syncLog.id } }
                );
            });
        
        // Responder inmediatamente con el ID del proceso
        return res.status(202).json({
            message: 'Proceso de sincronización iniciado',
            syncLogId: syncLog.id
        });
    } catch (error) {
        console.error('❌ Error al iniciar sincronización de activo:', error);
        return res.status(500).json({
            message: 'Error al iniciar sincronización',
            error: error.message
        });
    }
};

// Obtiene los logs de sincronización
exports.getSyncLog = async (req, res) => {
    try {
        const { limit = 10, offset = 0, jobType, status, clinicaId } = req.query;
        
        // Construir condiciones de búsqueda
        const where = {};
        
        if (jobType) {
            where.job_type = jobType;
        }
        
        if (status) {
            where.status = status;
        }
        
        if (clinicaId) {
            where.clinica_id = clinicaId;
        }
        
        // Obtener logs
        const logs = await SyncLog.findAndCountAll({
            where,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['started_at', 'DESC']]
        });
        
        return res.status(200).json({
            total: logs.count,
            logs: logs.rows
        });
    } catch (error) {
        console.error('❌ Error al obtener logs de sincronización:', error);
        return res.status(500).json({
            message: 'Error al obtener logs de sincronización',
            error: error.message
        });
    }
};

// Obtiene estadísticas de sincronización
exports.getSyncStats = async (req, res) => {
    try {
        // Estadísticas generales
        const totalJobs = await SyncLog.count();
        const completedJobs = await SyncLog.count({ where: { status: 'completed' } });
        const failedJobs = await SyncLog.count({ where: { status: 'failed' } });
        const runningJobs = await SyncLog.count({ where: { status: 'running' } });
        
        // Estadísticas por tipo de trabajo
        const jobTypes = await SyncLog.findAll({
            attributes: [
                'job_type',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            group: ['job_type']
        });
        
        // Estadísticas por clínica
        const clinicaStats = await SyncLog.findAll({
            attributes: [
                'clinica_id',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            where: {
                clinica_id: {
                    [Op.ne]: null
                }
            },
            group: ['clinica_id']
        });
        
        return res.status(200).json({
            totalJobs,
            completedJobs,
            failedJobs,
            runningJobs,
            jobTypes,
            clinicaStats
        });
    } catch (error) {
        console.error('❌ Error al obtener estadísticas de sincronización:', error);
        return res.status(500).json({
            message: 'Error al obtener estadísticas de sincronización',
            error: error.message
        });
    }
};

// Sincronización histórica de una clínica mes a mes
exports.triggerHistoricalSync = async (clinicaId) => {
    const syncLog = await SyncLog.create({
        job_type: 'historical_sync',
        clinica_id: clinicaId,
        status: 'running',
        started_at: new Date(),
        records_processed: 0
    });

    const maxMonths = 12;
    let monthsProcessed = 0;
    let hasData = true;
    let currentEnd = new Date();
    let currentStart = new Date(currentEnd);
    currentStart.setMonth(currentStart.getMonth() - 1);

    try {
        while (hasData && monthsProcessed < maxMonths) {
            console.log(`🔄 Sincronización histórica: ${currentStart.toISOString()} - ${currentEnd.toISOString()}`);
            try {
                const result = await syncClinicaAssets(clinicaId, currentStart, currentEnd);
                hasData = result && result.recordsCount > 0;
                monthsProcessed++;

                await SyncLog.update({
                    status: 'running',
                    records_processed: monthsProcessed,
                    status_report: {
                        monthStart: currentStart,
                        monthEnd: currentEnd,
                        lastError: null
                    }
                }, { where: { id: syncLog.id } });
            } catch (iterationError) {
                console.error(`❌ Error en iteración ${monthsProcessed + 1}:`, iterationError);
                await SyncLog.update({
                    status: 'running',
                    status_report: {
                        monthStart: currentStart,
                        monthEnd: currentEnd,
                        lastError: iterationError.message
                    }
                }, { where: { id: syncLog.id } });
                throw iterationError;
            }

            if (hasData) {
                currentEnd = new Date(currentStart);
                currentStart = new Date(currentStart);
                currentStart.setMonth(currentStart.getMonth() - 1);
            }
        }

        await SyncLog.update({
            status: 'completed',
            completed_at: new Date(),
            records_processed: monthsProcessed
        }, { where: { id: syncLog.id } });
    } catch (error) {
        console.error('❌ Error en triggerHistoricalSync:', error);
        await SyncLog.update({
            status: 'failed',
            completed_at: new Date(),
            error_message: error.message,
            records_processed: monthsProcessed
        }, { where: { id: syncLog.id } });
    }
};

// Sincronización inicial del día actual (sin histórico)
exports.triggerInitialSync = async (clinicaId) => {
    const syncLog = await SyncLog.create({
        job_type: 'initial_sync',
        clinica_id: clinicaId,
        status: 'running',
        started_at: new Date(),
        records_processed: 0
    });

    try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(23, 59, 59, 999);

        const result = await syncClinicaAssets(clinicaId, start, end);

        await SyncLog.update({
            status: 'completed',
            completed_at: new Date(),
            records_processed: result?.recordsProcessed || 0
        }, { where: { id: syncLog.id } });
    } catch (error) {
        console.error('❌ Error en triggerInitialSync:', error);
        await SyncLog.update({
            status: 'failed',
            completed_at: new Date(),
            error_message: error.message
        }, { where: { id: syncLog.id } });
    }
};

// Valida todos los tokens que necesitan validación
exports.validateTokens = async (req, res) => {
    try {
        // Obtener conexiones que no se han validado en los últimos 7 días
        const connections = await MetaConnection.findAll({
            where: {
                [Op.or]: [
                    {
                        '$TokenValidations.id$': null
                    },
                    {
                        '$TokenValidations.validated_at$': {
                            [Op.lt]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
                        }
                    }
                ]
            },
            include: [
                {
                    model: TokenValidations,
                    as: 'TokenValidations',
                    required: false,
                    order: [['validated_at', 'DESC']],
                    limit: 1
                }
            ]
        });
        
        if (!connections || connections.length === 0) {
            return res.status(200).json({
                message: 'No hay tokens que necesiten validación',
                validatedCount: 0
            });
        }
        
        // Iniciar validación en segundo plano
        const validationPromises = connections.map(connection => 
            validateToken(connection.id)
        );
        
        // Ejecutar validaciones en paralelo
        Promise.all(validationPromises)
            .then(results => {
                console.log(`✅ Validación de ${results.length} tokens completada`);
            })
            .catch(error => {
                console.error('❌ Error en validación de tokens:', error);
            });
        
        return res.status(202).json({
            message: `Validación de ${connections.length} tokens iniciada`,
            connectionsCount: connections.length
        });
    } catch (error) {
        console.error('❌ Error al validar tokens:', error);
        return res.status(500).json({
            message: 'Error al validar tokens',
            error: error.message
        });
    }
};

// Valida un token específico
exports.validateTokenById = async (req, res) => {
    try {
        const { connectionId } = req.params;
        
        // Validar parámetros
        if (!connectionId) {
            return res.status(400).json({ message: 'ID de conexión no proporcionado' });
        }
        
        // Verificar que la conexión existe
        const connection = await MetaConnection.findByPk(connectionId);
        
        if (!connection) {
            return res.status(404).json({ message: 'Conexión no encontrada' });
        }
        
        // Validar token
        const result = await validateToken(connectionId);
        
        return res.status(200).json({
            message: 'Token validado',
            status: result.status,
            validatedAt: result.validatedAt
        });
    } catch (error) {
        console.error('❌ Error al validar token:', error);
        return res.status(500).json({
            message: 'Error al validar token',
            error: error.message
        });
    }
};

// Obtiene estadísticas de validación de tokens
exports.getTokenValidationStats = async (req, res) => {
    try {
        // Estadísticas generales
        const totalValidations = await TokenValidations.count();
        const validTokens = await TokenValidations.count({ where: { status: 'valid' } });
        const invalidTokens = await TokenValidations.count({ where: { status: 'invalid' } });
        
        // Últimas validaciones
        const latestValidations = await TokenValidations.findAll({
            limit: 10,
            order: [['validated_at', 'DESC']],
            include: [
                {
                    model: MetaConnection,
                    as: 'metaConnection'
                }
            ]
        });
        
        return res.status(200).json({
            totalValidations,
            validTokens,
            invalidTokens,
            latestValidations
        });
    } catch (error) {
        console.error('❌ Error al obtener estadísticas de validación de tokens:', error);
        return res.status(500).json({
            message: 'Error al obtener estadísticas de validación de tokens',
            error: error.message
        });
    }
};

// ========== FUNCIONES INTERNAS (NO EXPORTADAS) ==========

// Sincroniza todos los activos de una clínica
async function syncClinicaAssets(clinicaId, startDate, endDate, syncLogId) {
    try {
        console.log(`🔄 Iniciando sincronización de activos para clínica ${clinicaId}`);
        
        // Obtener activos de la clínica
        const assets = await ClinicMetaAsset.findAll({
            where: {
                clinicaId: clinicaId,
                isActive: true
            },
            include: [
                {
                    model: MetaConnection,
                    as: 'metaConnection',
                    required: true
                }
            ]
        });
        
        if (!assets || assets.length === 0) {
            throw new Error(`No se encontraron activos de Meta para la clínica ${clinicaId}`);
        }
        
        console.log(`📊 Encontrados ${assets.length} activos para sincronizar`);
        
        // Sincronizar cada activo
        let processedCount = 0;
        let errorCount = 0;
        let recordsProcessed = 0;

        for (const asset of assets) {
            try {
                const result = await syncAsset(asset, startDate, endDate);
                processedCount++;
                recordsProcessed += result?.recordsProcessed || 0;
            } catch (error) {
                console.error(`❌ Error al sincronizar activo ${asset.id}:`, error);
                errorCount++;
            }
        }
        
        // Actualizar registro de sincronización
        if (syncLogId) {
            await SyncLog.update(
                {
                    status: errorCount === assets.length ? 'failed' : (errorCount > 0 ? 'partial' : 'completed'),
                    records_processed: processedCount,
                    error_message: errorCount > 0 ? `${errorCount} activos fallaron` : null,
                    completed_at: new Date()
                },
                { where: { id: syncLogId } }
            );
        }

        console.log(`✅ Sincronización completada: ${processedCount} activos procesados, ${errorCount} errores`);

        return {
            processedCount,
            errorCount,
            recordsProcessed
        };
    } catch (error) {
        console.error('❌ Error en syncClinicaAssets:', error);
        
        // Actualizar registro de sincronización en caso de error
        if (syncLogId) {
            await SyncLog.update(
                {
                    status: 'failed',
                    error_message: error.message,
                    completed_at: new Date()
                },
                { where: { id: syncLogId } }
            );
        }
        
        throw error;
    }
}



// Sincroniza un activo específico
async function syncAsset(asset, startDate, endDate, syncLogId) {
    try {
        console.log(`🔄 Iniciando sincronización de activo ${asset.id} (${asset.assetType})`);
        
        // Verificar que el activo tiene una conexión válida
        if (!asset.MetaConnection && !asset.metaConnectionId) {
            throw new Error(`El activo ${asset.id} no tiene una conexión de Meta asociada`);
        }
        
        // Obtener la conexión si no está incluida
        let connection = asset.MetaConnection;
        if (!connection) {
            connection = await MetaConnection.findByPk(asset.metaConnectionId);
            if (!connection) {
                throw new Error(`No se encontró la conexión ${asset.metaConnectionId} para el activo ${asset.id}`);
            }
        }
        
        // Verificar que el token de acceso es válido
        if (!connection.accessToken) {
            throw new Error(`La conexión ${connection.id} no tiene un token de acceso válido`);
        }
        
        // Obtener el token de página si está disponible, o usar el token de usuario
        const accessToken = asset.pageAccessToken || connection.accessToken;
        
        // Sincronizar según el tipo de activo
        let result;
        
    switch (asset.assetType) {
        case 'facebook_page':
            result = await syncFacebookPageMetrics(asset, accessToken, startDate, endDate);
            break;
        case 'instagram_business':
            result = await syncInstagramMetrics(asset, accessToken, startDate, endDate);
            break;
        case 'ad_account':
            result = await syncAdAccountMetrics(asset, accessToken, startDate, endDate);
            break;
        default:
            console.log(`⚠️ Tipo de activo no soportado: ${asset.assetType}`);
            result = { status: 'skipped', message: `Tipo de activo no soportado: ${asset.assetType}` };
    }
        
        // Actualizar registro de sincronización
        if (syncLogId) {
            await SyncLog.update(
                {
                    status: 'completed',
                    records_processed: result.recordsProcessed || 0,
                    completed_at: new Date()
                },
                { where: { id: syncLogId } }
            );
        }
        
        console.log(`✅ Sincronización de activo ${asset.id} completada`);
        
        return result;
    } catch (error) {
        console.error(`❌ Error en syncAsset (${asset.id}):`, error);
        
        // Actualizar registro de sincronización en caso de error
        if (syncLogId) {
            await SyncLog.update(
                {
                    status: 'failed',
                    error_message: error.message,
                    completed_at: new Date()
                },
                { where: { id: syncLogId } }
            );
        }
        
        throw error;
    }
}

// Sincroniza métricas de una página de Facebook
async function syncFacebookPageMetrics(asset, accessToken, startDate, endDate) {
    try {
        console.log(`📊 Sincronizando métricas de página de Facebook ${asset.metaAssetId}`);

        // Obtener el número de seguidores actuales de la página
        const metricsResponse = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}`, {
            params: {
                fields: 'fan_count',
                access_token: accessToken
            }
        });

        if (!metricsResponse.data || metricsResponse.data.fan_count === undefined) {
            throw new Error('Respuesta de API inválida al obtener fan_count');
        }

        const fanCount = metricsResponse.data.fan_count;

        // Fecha para el registro (usamos endDate)
        const date = new Date(endDate);
        date.setHours(0, 0, 0, 0);

        // Obtener registro del día anterior para calcular followers_day
        const prevDate = new Date(date);
        prevDate.setDate(prevDate.getDate() - 1);

        const prevStats = await SocialStatsDaily.findOne({
            where: {
                clinica_id: asset.clinicaId,
                asset_id: asset.id,
                date: prevDate
            }
        });

        const followersDay = fanCount - (prevStats ? prevStats.followers : 0);

        // Preparar datos para upsert del día actual
        const statsData = {
            clinica_id: asset.clinicaId,
            asset_id: asset.id,
            asset_type: asset.assetType,
            date: date,
            followers: fanCount,
            followers_day: followersDay
        };

        let existingStats = await SocialStatsDaily.findOne({
            where: {
                clinica_id: asset.clinicaId,
                asset_id: asset.id,
                date: date
            }
        });

        if (existingStats) {
            await existingStats.update(statsData);
        } else {
            await SocialStatsDaily.create(statsData);
        }

        // Alcance orgánico diario (CSV): page_impressions_organic_unique
        try {
            const since = Math.floor(startDate.getTime() / 1000);
            const until = Math.floor(endDate.getTime() / 1000);
            const paramsBase = { since, until, period: 'day', access_token: accessToken };

            let valuesOrganic = [];
            let usedApproximation = false;

            // 1) Intentar orgánico oficial
            try {
                const reachResp = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
                    params: { ...paramsBase, metric: 'page_impressions_organic_unique' }
                });
                valuesOrganic = reachResp.data?.data?.[0]?.values || [];
                console.log('✅ FB reach orgánico (page_impressions_organic_unique) obtenido');
            } catch (e1) {
                const msg = e1.response?.data?.error?.message || e1.message;
                console.warn(`⚠️ Métrica page_impressions_organic_unique no disponible: ${msg}. Usando aproximación (total_unique - paid_unique)`);
                usedApproximation = true;
                try {
                    // 2) Aproximación: total_unique - paid_unique
                    const totalResp = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
                        params: { ...paramsBase, metric: 'page_impressions_unique' }
                    });
                    const paidResp = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
                        params: { ...paramsBase, metric: 'page_impressions_paid_unique' }
                    });
                    const totalVals = totalResp.data?.data?.[0]?.values || [];
                    const paidVals = paidResp.data?.data?.[0]?.values || [];
                    // Mapear por end_time para restar
                    const paidMap = new Map();
                    for (const p of paidVals) {
                        paidMap.set(p.end_time, p.value || 0);
                    }
                    valuesOrganic = totalVals.map(t => ({
                        end_time: t.end_time,
                        value: Math.max((t.value || 0) - (paidMap.get(t.end_time) || 0), 0)
                    }));
                } catch (e2) {
                    console.warn(`⚠️ Aproximación de orgánico falló:`, e2.response?.data || e2.message);
                    valuesOrganic = [];
                }
            }

            for (const item of valuesOrganic) {
                // Normalizar fecha: usar end_time - 1 día para etiquetar el día del periodo
                const end = new Date(item.end_time);
                const d = new Date(end);
                d.setDate(d.getDate() - 1);
                d.setHours(0,0,0,0);
                const existing = await SocialStatsDaily.findOne({ where: { clinica_id: asset.clinicaId, asset_id: asset.id, date: d } });
                const payload = {
                    clinica_id: asset.clinicaId,
                    asset_id: asset.id,
                    asset_type: asset.assetType,
                    date: d,
                    reach: item.value || 0,
                    reach_total: item.value || 0
                };
                if (existing) await existing.update(payload); else await SocialStatsDaily.create(payload);
                console.log(`📆 FB reach asignado a ${d.toISOString().slice(0,10)} (${usedApproximation ? 'aprox.' : 'orgánico oficial'})`);
            }
        } catch (reachErr) {
            console.warn(`⚠️ FB page reach orgánico falló para ${asset.metaAssetId}:`, reachErr.response?.data || reachErr.message);
        }

        // Sincronizar publicaciones (con batching + lifetime en SocialPosts)
        await syncFacebookPosts(asset, accessToken, startDate, endDate);

        console.log(`✅ Sincronización de métricas de Facebook completada: 1 día procesado`);

        return {
            status: 'completed',
            recordsProcessed: 1
        };
    } catch (error) {
        console.error('❌ Error en syncFacebookPageMetrics:', error);
        throw error;
    }
}

// Sincroniza métricas de una cuenta de Instagram
async function syncInstagramMetrics(asset, accessToken, startDate, endDate) {
    try {
        console.log(`📊 Sincronizando métricas de Instagram ${asset.metaAssetId}`);

         // Formatear fechas para la API de Meta
        const MAX_RANGE_SECONDS = 30 * 24 * 60 * 60; // 30 días
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const yesterdayUnix = Math.floor((today.getTime() - 86400000) / 1000);
        const minAllowedSince = yesterdayUnix - MAX_RANGE_SECONDS + 86400;
        const since = Math.max(Math.floor(startDate.getTime() / 1000), minAllowedSince);
        const until = Math.min(Math.floor(endDate.getTime() / 1000), yesterdayUnix);

        if (since > until) {
            console.warn('⚠️ Rango fuera de los últimos 30 días, ajustando a últimos 30 días para IG followers');
        }

        // Obtener variación diaria de seguidores en bloques de 30 días
        const statsByDate = {};
        let followerValues = [];
        {
            let chunkStart = since;
            if (chunkStart > until) {
                // Ajuste: recuperar últimos 30 días hasta ayer
                chunkStart = until - (30 * 24 * 60 * 60) + 86400; // hace 29 días de margen
            }
            while (chunkStart <= until) {
                const chunkEnd = Math.min(chunkStart + MAX_RANGE_SECONDS, until);
                const response = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
                    params: {
                        metric: 'follower_count',
                        period: 'day',
                        since: chunkStart,
                        until: chunkEnd,
                        access_token: accessToken
                    }
                });
                const values = response.data?.data?.[0]?.values || [];
                followerValues = followerValues.concat(values);
                if (chunkEnd === until) {
                    break;
                }
                chunkStart = chunkEnd + 86400; // avanzar un día para evitar solapamiento
            }
        }
        for (const value of followerValues) {
            const date = new Date(value.end_time);
            date.setHours(0, 0, 0, 0);
            const dateStr = date.toISOString().split('T')[0];

            statsByDate[dateStr] = {
                clinica_id: asset.clinicaId,
                asset_id: asset.id,
                asset_type: asset.assetType,
                date: date,
                followers_day: value.value || 0
            };
        }

        // Obtener total actual de seguidores
        const followersTotalResponse = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}`, {
            params: {
                fields: 'followers_count',

                access_token: accessToken
            }
        });

        const currentFollowers = followersTotalResponse.data?.followers_count || 0;

        // Reconstruir historial de seguidores usando la variación diaria
        const dates = Object.keys(statsByDate).sort();
        let runningTotal = currentFollowers;
        for (let i = dates.length - 1; i >= 0; i--) {
            const dateStr = dates[i];
            statsByDate[dateStr].followers = runningTotal;
            runningTotal -= statsByDate[dateStr].followers_day || 0;
        }

        // Registrar estadísticas del día actual
        const todayDate = new Date(endDate);
        todayDate.setHours(0, 0, 0, 0);
        const todayStr = todayDate.toISOString().split('T')[0];
        let yesterdayFollowers = 0;
        if (dates.length) {
            const lastDateStr = dates[dates.length - 1];
            yesterdayFollowers = statsByDate[lastDateStr]?.followers || 0;
        } else {
            const prevDate = new Date(todayDate);
            prevDate.setDate(prevDate.getDate() - 1);
            const prevStats = await SocialStatsDaily.findOne({
                where: {
                    clinica_id: asset.clinicaId,
                    asset_id: asset.id,
                    date: prevDate
                }
            });
            yesterdayFollowers = prevStats ? prevStats.followers : 0;
        }
        statsByDate[todayStr] = {
            clinica_id: asset.clinicaId,
            asset_id: asset.id,
            asset_type: asset.assetType,
            date: todayDate,
            followers: currentFollowers,
            followers_day: currentFollowers - yesterdayFollowers
        };
        dates.push(todayStr);

        // Guardar/actualizar en la base de datos
        for (const dateStr of dates) {
            const statsData = statsByDate[dateStr];

            let existingStats = await SocialStatsDaily.findOne({
                where: {
                    clinica_id: asset.clinicaId,
                    asset_id: asset.id,
                    date: statsData.date
                }
            });

            if (existingStats) {
                await existingStats.update(statsData);
            } else {
                await SocialStatsDaily.create(statsData);
            }
        }

        // IG reach (orgánico) diario
        try {
            const since = Math.floor(startDate.getTime() / 1000);
            const until = Math.floor(endDate.getTime() / 1000);
            const reachResp = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
                params: {
                    metric: 'reach',
                    period: 'day',
                    since,
                    until,
                    access_token: accessToken
                }
            });
            const values = reachResp.data?.data?.[0]?.values || [];
            for (const item of values) {
                // Normalizar fecha: end_time - 1 día
                const end = new Date(item.end_time);
                const d = new Date(end);
                d.setDate(d.getDate() - 1);
                d.setHours(0,0,0,0);
                const existing = await SocialStatsDaily.findOne({ where: { clinica_id: asset.clinicaId, asset_id: asset.id, date: d } });
                const payload = {
                    clinica_id: asset.clinicaId,
                    asset_id: asset.id,
                    asset_type: asset.assetType,
                    date: d,
                    reach: item.value || 0,
                    reach_total: item.value || 0
                };
                if (existing) await existing.update(payload); else await SocialStatsDaily.create(payload);
                console.log(`📆 IG reach asignado a ${d.toISOString().slice(0,10)}`);
            }
        } catch (reachErr) {
            console.warn(`⚠️ IG reach diario falló para ${asset.metaAssetId}:`, reachErr.response?.data || reachErr.message);
        }

        // Sincronizar publicaciones (con batching + lifetime en SocialPosts)
        await syncInstagramPosts(asset, accessToken, startDate, endDate);

        console.log(`✅ Sincronización de métricas de Instagram completada: ${dates.length} días procesados`);

        return {
            status: dates.length ? 'completed' : 'no_data',
            recordsProcessed: dates.length
        };
    } catch (error) {
        console.error('❌ Error en syncInstagramMetrics:', error);
        throw error;
    }
}

// Sincroniza publicaciones de Facebook
async function syncFacebookPosts(asset, accessToken, startDate, endDate) {
    const { graphBatch } = require('../lib/metaBatch');
    try {
        console.log(`📝 Sincronizando publicaciones de Facebook ${asset.metaAssetId}`);

        // Formatear fechas para la API de Meta
        const since = Math.floor(startDate.getTime() / 1000);
        const until = Math.floor(endDate.getTime() / 1000);

        // Obtener publicaciones por rango (usar attachments en lugar de full_picture/type para evitar deprecations)
        const { metaGet } = require('../lib/metaClient');
        const postsResponse = await metaGet(`${asset.metaAssetId}/posts`, {
            params: {
                fields: 'id,message,created_time,permalink_url,attachments{media_type,media,url,subattachments}',
                since,
                until,
                limit: 100
            },
            accessToken
        });

        if (!postsResponse.data || !postsResponse.data.data) {
            throw new Error('Respuesta de API inválida al obtener publicaciones de Facebook');
        }

        const postsInRange = postsResponse.data.data;
        console.log(`📊 FB posts en rango: ${postsInRange.length}`);

        // Siempre traer últimos N posts recientes (parametrizable)
        const recentLimit = parseInt(process.env.METASYNC_POSTS_FALLBACK_LIMIT || '30', 10);
        const recentResp = await metaGet(`${asset.metaAssetId}/posts`, {
            params: {
                fields: 'id,message,created_time,permalink_url,attachments{media_type,media,url,subattachments}',
                limit: recentLimit
            },
            accessToken
        });
        const recentPosts = recentResp.data?.data || [];
        console.log(`📊 FB posts recientes: ${recentPosts.length} (límite ${recentLimit})`);

        // Unificar y desduplicar por id
        const mapById = new Map();
        for (const p of postsInRange) mapById.set(p.id, p);
        for (const p of recentPosts) if (!mapById.has(p.id)) mapById.set(p.id, p);
        const posts = Array.from(mapById.values());
        console.log(`📊 FB posts combinados únicos: ${posts.length}`);

        // Guardar/actualizar publicaciones en bloque (lifetime en SocialPosts)
        const postIdToDbId = new Map();
        for (const post of posts) {
            // Derivar tipo/media desde attachments
            const att = post.attachments?.data?.[0];
            const mediaType = att?.media_type || null;
            const mediaUrl = att?.media?.image?.src || att?.url || null;

            const postData = {
                clinica_id: asset.clinicaId,
                asset_id: asset.id,
                asset_type: asset.assetType,
                post_id: post.id,
                post_type: mediaType ? mediaType.toLowerCase() : (post.type ? String(post.type).toLowerCase() : 'unknown'),
                title: post.message ? post.message.substring(0, 255) : null,
                content: post.message,
                media_url: mediaUrl,
                permalink_url: post.permalink_url,
                published_at: new Date(post.created_time)
            };

            let existingPost = await SocialPosts.findOne({ where: { asset_id: asset.id, post_id: post.id } });
            if (existingPost) {
                await existingPost.update(postData);
            } else {
                existingPost = await SocialPosts.create(postData);
            }
            postIdToDbId.set(post.id, existingPost.id);
        }

        if (posts.length === 0) {
            return { status: 'completed', recordsProcessed: 0 };
        }

        // Batching: insights + reactions/comm/shares summary
        const requests = [];
        for (const post of posts) {
            requests.push({ method: 'GET', relative_url: `${post.id}/insights?metric=post_impressions,post_impressions_unique,post_engaged_users,post_reactions_by_type_total` });
        }
        for (const post of posts) {
            requests.push({ method: 'GET', relative_url: `${post.id}?fields=reactions.summary(total_count),comments.summary(true),shares` });
        }

        const responses = await graphBatch(accessToken, requests, process.env.META_API_BASE_URL);

        const date = new Date(endDate);
        date.setHours(0, 0, 0, 0);
        const prevDate = new Date(date);
        prevDate.setDate(prevDate.getDate() - 1);

        // Parsear respuestas en el mismo orden
        const n = posts.length;
        let processed = 0;
        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            const dbPostId = postIdToDbId.get(post.id);

            const insightsResp = responses[i];
            const objResp = responses[i + n];
            let reactions_total = 0;
            let comments_total = 0;
            let shares_total = 0;

            if (insightsResp?.code === 200 && Array.isArray(insightsResp.body?.data)) {
                for (const metric of insightsResp.body.data) {
                    const m = metric.name;
                    const v = metric.values?.[0]?.value || 0;
                    switch (m) {
                        case 'post_impressions':
                            // Podemos usar impresiones/reach en futuros agregados si hiciera falta
                            break;
                        case 'post_impressions_unique':
                            // idem
                            break;
                        case 'post_engaged_users':
                            // idem
                            break;
                        case 'post_reactions_by_type_total':
                            if (v && typeof v === 'object') {
                                reactions_total = (v.like || 0) + (v.love || 0) + (v.wow || 0) + (v.haha || 0) + (v.care || 0) + (v.angry || 0) + (v.sad || 0);
                            }
                            break;
                    }
                }
            }
            if (objResp?.code === 200) {
                reactions_total = objResp.body?.reactions?.summary?.total_count || reactions_total;
                comments_total = objResp.body?.comments?.summary?.total_count || 0;
                shares_total = objResp.body?.shares?.count || 0;
            }

            // Actualizar SocialPosts (lifetime)
            const postModel = await SocialPosts.findByPk(dbPostId);
            if (postModel) {
                await postModel.update({
                    reactions_and_likes: reactions_total,
                    comments_count: comments_total,
                    shares_count: shares_total,
                    media_type: postModel.media_type || post.type?.toLowerCase() || null,
                    insights_synced_at: new Date(),
                    metrics_source_version: 'v23'
                });
            }
            processed++;
        }

        console.log(`✅ Sincronización de publicaciones de Facebook completada: ${processed} publicaciones procesadas`);

        // Agregados diarios a SocialStatsDaily (FB)
        await updateDailyAggregatesForAsset(asset, startDate, endDate);
        if (posts.length > 0) {
            try {
                const dates = posts.map(p => new Date(p.created_time));
                const minDate = new Date(Math.min.apply(null, dates));
                const maxDate = new Date(Math.max.apply(null, dates));
                if (minDate < startDate || maxDate > endDate) {
                    await updateDailyAggregatesForAsset(asset, minDate, maxDate);
                    console.log('📈 Agregados diarios FB recalculados con posts recientes (extendidos)');
                }
            } catch (e) {
                console.warn('⚠️ Error recalculando agregados FB (extendidos):', e.message);
            }
        }

        return { status: 'completed', recordsProcessed: processed };
    } catch (error) {
        console.error('❌ Error en syncFacebookPosts:', error);
        throw error;
    }
}

// Sincroniza publicaciones de Instagram
async function syncInstagramPosts(asset, accessToken, startDate, endDate) {
    const { graphBatch } = require('../lib/metaBatch');
    try {
        console.log(`📝 Sincronizando publicaciones de Instagram ${asset.metaAssetId}`);
        
        // Formatear fechas para la API de Meta
        const since = Math.floor(startDate.getTime() / 1000);
        const until = Math.floor(endDate.getTime() / 1000);
        
        // Obtener publicaciones por rango
        const { metaGet } = require('../lib/metaClient');
        const postsResponse = await metaGet(`${asset.metaAssetId}/media`, {
            params: {
                fields: 'id,caption,media_type,permalink,media_url,thumbnail_url,timestamp',
                since,
                until,
                limit: 100
            },
            accessToken
        });
        
        if (!postsResponse.data || !postsResponse.data.data) {
            throw new Error('Respuesta de API inválida al obtener publicaciones de Instagram');
        }
        
        const postsInRange = postsResponse.data.data;
        console.log(`📊 IG posts en rango: ${postsInRange.length}`);

        // Siempre traer últimos N posts recientes (parametrizable)
        const recentLimit = parseInt(process.env.METASYNC_POSTS_FALLBACK_LIMIT || '30', 10);
        const recentResp = await metaGet(`${asset.metaAssetId}/media`, {
            params: {
                fields: 'id,caption,media_type,permalink,media_url,thumbnail_url,timestamp',
                limit: recentLimit
            },
            accessToken
        });
        const recentPosts = recentResp.data?.data || [];
        console.log(`📊 IG posts recientes: ${recentPosts.length} (límite ${recentLimit})`);

        // Unificar y desduplicar por id
        const mapById = new Map();
        for (const p of postsInRange) mapById.set(p.id, p);
        for (const p of recentPosts) if (!mapById.has(p.id)) mapById.set(p.id, p);
        const posts = Array.from(mapById.values());
        console.log(`📊 IG posts combinados únicos: ${posts.length}`);
        
        // Guardar/actualizar publicaciones (lifetime en SocialPosts)
        const postIdToDbId = new Map();
        for (const post of posts) {
            const postData = {
                clinica_id: asset.clinicaId,
                asset_id: asset.id,
                asset_type: asset.assetType,
                post_id: post.id,
                post_type: post.media_type.toLowerCase(),
                title: post.caption ? post.caption.substring(0, 255) : null,
                content: post.caption,
                media_url: post.media_url || post.thumbnail_url,
                permalink_url: post.permalink,
                published_at: new Date(post.timestamp)
            };
            let existingPost = await SocialPosts.findOne({ where: { asset_id: asset.id, post_id: post.id } });
            if (existingPost) {
                await existingPost.update(postData);
            } else {
                existingPost = await SocialPosts.create(postData);
            }
            postIdToDbId.set(post.id, existingPost.id);
        }

        if (posts.length === 0) {
            return { status: 'completed', recordsProcessed: 0 };
        }

        // Batching: insights (views/saved/engagement) + like_count/comments_count
        const requests = [];
        for (const post of posts) {
            // Para IG orgánico 2025: usar views en lugar de impressions si está disponible
            requests.push({ method: 'GET', relative_url: `${post.id}/insights?metric=views,saved,engagement,shares,ig_reels_avg_watch_time` });
        }
        for (const post of posts) {
            requests.push({ method: 'GET', relative_url: `${post.id}?fields=like_count,comments_count` });
        }

        const responses = await graphBatch(accessToken, requests, process.env.META_API_BASE_URL);

        const date = new Date(endDate);
        date.setHours(0, 0, 0, 0);
        const prevDate = new Date(date);
        prevDate.setDate(prevDate.getDate() - 1);

        const n = posts.length;
        let processed = 0;
        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            const dbPostId = postIdToDbId.get(post.id);

            const insightsResp = responses[i];
            const countsResp = responses[i + n];

            let like_count = 0;
            let comments_count = 0;
            let saved_count = 0;
            let views_count = 0;
            let avg_watch_time_ms = 0;

            if (insightsResp?.code === 200 && Array.isArray(insightsResp.body?.data)) {
                for (const metric of insightsResp.body.data) {
                    const m = metric.name;
                    const v = metric.values?.[0]?.value || 0;
                    switch (m) {
                        case 'engagement':
                            // usamos para QA, no se guarda directamente
                            break;
                        case 'saved':
                            saved_count = v;
                            break;
                        case 'views':
                            views_count = v;
                            break;
                        case 'ig_reels_avg_watch_time':
                            avg_watch_time_ms = Math.round((v || 0) * 1000);
                            break;
                    }
                }
            }

            if (countsResp?.code === 200) {
                like_count = countsResp.body?.like_count || 0;
                comments_count = countsResp.body?.comments_count || 0;
            }

            // Actualizar SocialPosts (lifetime)
            const postModel = await SocialPosts.findByPk(dbPostId);
            if (postModel) {
                await postModel.update({
                    reactions_and_likes: like_count,
                    comments_count,
                    saved_count,
                    views_count,
                    avg_watch_time_ms,
                    media_type: post.media_type?.toLowerCase() || postModel.media_type || null,
                    insights_synced_at: new Date(),
                    metrics_source_version: 'v23'
                });
            }
            processed++;
        }

        console.log(`✅ Sincronización de publicaciones de Instagram completada: ${posts.length} publicaciones procesadas`);

        // Agregados diarios a SocialStatsDaily (IG)
        await updateDailyAggregatesForAsset(asset, startDate, endDate);
        if (posts.length > 0) {
            try {
                const dates = posts.map(p => new Date(p.timestamp));
                const minDate = new Date(Math.min.apply(null, dates));
                const maxDate = new Date(Math.max.apply(null, dates));
                if (minDate < startDate || maxDate > endDate) {
                    await updateDailyAggregatesForAsset(asset, minDate, maxDate);
                    console.log('📈 Agregados diarios IG recalculados con posts recientes (extendidos)');
                }
            } catch (e) {
                console.warn('⚠️ Error recalculando agregados IG (extendidos):', e.message);
            }
        }

        return {
            status: 'completed',
            recordsProcessed: posts.length
        };
    } catch (error) {
        console.error('❌ Error en syncInstagramPosts:', error);
        throw error;
    }
}

// Agrega agregados diarios a SocialStatsDaily basados en SocialPosts (por fecha de publicación)
async function updateDailyAggregatesForAsset(asset, startDate, endDate) {
    try {
        const start = new Date(startDate); start.setHours(0,0,0,0);
        const end = new Date(endDate); end.setHours(23,59,59,999);
        const posts = await SocialPosts.findAll({
            where: {
                asset_id: asset.id,
                published_at: { [Op.between]: [start, end] }
            },
            attributes: ['id','published_at','reactions_and_likes','comments_count','shares_count','saved_count','views_count']
        });
        const byDay = new Map();
        for (const p of posts) {
            const d = new Date(p.published_at); d.setHours(0,0,0,0);
            const key = d.toISOString();
            if (!byDay.has(key)) byDay.set(key, { likes:0, reactions:0, comments:0, shares:0, saved:0, views:0, posts:0 });
            const agg = byDay.get(key);
            if (asset.assetType === 'instagram_business') {
                agg.likes += p.reactions_and_likes || 0;
            } else if (asset.assetType === 'facebook_page') {
                agg.reactions += p.reactions_and_likes || 0;
            }
            agg.comments += p.comments_count || 0;
            agg.shares += p.shares_count || 0;
            agg.saved += p.saved_count || 0;
            agg.views += p.views_count || 0;
            agg.posts += 1;
        }
        for (const [key, agg] of byDay) {
            const d = new Date(key);
            const payload = {
                clinica_id: asset.clinicaId,
                asset_id: asset.id,
                asset_type: asset.assetType,
                date: d,
                views: agg.views,
                posts_count: agg.posts,
                engagement: (agg.likes + agg.reactions + agg.comments + agg.shares + agg.saved)
            };
            if (asset.assetType === 'instagram_business') {
                payload.likes = agg.likes;
            } else if (asset.assetType === 'facebook_page') {
                payload.reactions = agg.reactions;
            }
            const existing = await SocialStatsDaily.findOne({ where: { clinica_id: asset.clinicaId, asset_id: asset.id, date: d } });
            if (existing) await existing.update(payload); else await SocialStatsDaily.create(payload);
        }
        console.log(`📈 Agregados diarios actualizados para asset ${asset.id} (${asset.assetType})`);
    } catch (e) {
        console.warn('⚠️ Error calculando agregados diarios:', e.message);
    }
}

// Sincroniza métricas de una cuenta publicitaria (Ads)
async function syncAdAccountMetrics(asset, accessToken, startDate, endDate) {
    try {
        console.log(`💰 Sincronizando métricas de Ads para ${asset.metaAssetId}`);

        const accountId = asset.metaAssetId.startsWith('act_') ? asset.metaAssetId : `act_${asset.metaAssetId}`;
        const sinceStr = new Date(startDate).toISOString().slice(0,10);
        const untilStr = new Date(endDate).toISOString().slice(0,10);
        const stats = { entities: 0, insightsRows: 0, actionsRows: 0, linkedPromotions: 0 };

        // 1) Entidades (Ads) con creatives para posible vínculo a posts (guardamos entidades ahora)
        try {
            const { metaGet } = require('../lib/metaClient');
            let nextUrl = `${accountId}/ads`;
            let params = { fields: 'id,name,adset_id,campaign_id,status,effective_status,created_time,updated_time,creative{id,effective_instagram_media_id,effective_object_story_id,instagram_permalink_url}', limit: 200 };
            while (nextUrl) {
                const resp = await metaGet(nextUrl, { params, accessToken });
                const data = resp.data?.data || [];
                for (const ad of data) {
                    await SocialAdsEntity.upsert({
                        ad_account_id: accountId,
                        level: 'ad',
                        entity_id: String(ad.id),
                        parent_id: ad.adset_id ? String(ad.adset_id) : null,
                        name: ad.name || null,
                        status: ad.status || null,
                        effective_status: ad.effective_status || null,
                        objective: null,
                        buying_type: null,
                        created_time: ad.created_time ? new Date(ad.created_time) : null,
                        updated_time: ad.updated_time ? new Date(ad.updated_time) : null
                    });
                    stats.entities++;

                    // Vincular anuncio ↔ post orgánico (PostPromotions)
                    try {
                        const creative = ad.creative || {};
                        const igMediaId = creative.effective_instagram_media_id || null;
                        const fbStoryId = creative.effective_object_story_id || null; // formato pageId_postId
                        const igPermalink = creative.instagram_permalink_url || null;

                        let matchedPost = null;
                        let assetType = null;

                        if (igMediaId) {
                            matchedPost = await SocialPosts.findOne({
                                where: { clinica_id: asset.clinicaId, asset_type: 'instagram_business', post_id: String(igMediaId) }
                            });
                            assetType = matchedPost ? 'instagram_business' : assetType;
                        }

                        if (!matchedPost && fbStoryId) {
                            const parts = String(fbStoryId).split('_');
                            const idFull = String(fbStoryId);
                            const idShort = parts.length > 1 ? parts[1] : null;
                            matchedPost = await SocialPosts.findOne({
                                where: {
                                    clinica_id: asset.clinicaId,
                                    asset_type: 'facebook_page',
                                    post_id: idShort ? { [Op.in]: [idFull, idShort] } : idFull
                                }
                            });
                            assetType = matchedPost ? 'facebook_page' : assetType;
                        }

                        if (matchedPost) {
                            const wherePromo = { post_id: matchedPost.id, ad_id: String(ad.id) };
                            const existingPromo = await PostPromotions.findOne({ where: wherePromo });
                            const payload = {
                                asset_type: assetType || matchedPost.asset_type,
                                post_id: matchedPost.id,
                                ad_account_id: accountId,
                                campaign_id: ad.campaign_id ? String(ad.campaign_id) : null,
                                adset_id: ad.adset_id ? String(ad.adset_id) : null,
                                ad_id: String(ad.id),
                                ad_creative_id: creative.id ? String(creative.id) : null,
                                effective_instagram_media_id: igMediaId || null,
                                effective_object_story_id: fbStoryId || null,
                                instagram_permalink_url: igPermalink || null,
                                promo_start: ad.created_time ? new Date(ad.created_time) : null,
                                promo_end: ad.effective_status && ad.effective_status !== 'ACTIVE' ? (ad.updated_time ? new Date(ad.updated_time) : null) : null,
                                status: ad.effective_status || ad.status || null
                            };
                            if (existingPromo) {
                                await existingPromo.update(payload);
                                stats.linkedPromotions++;
                            } else {
                                await PostPromotions.create(payload);
                                stats.linkedPromotions++;
                            }
                        }
                    } catch (linkErr) {
                        console.warn('⚠️ Error vinculando anuncio con post orgánico:', linkErr.message);
                    }
                }
                const next = resp.data?.paging?.next;
                if (next) {
                    // paging.next es URL absoluta; la convertimos a ruta + params para metaGet
                    nextUrl = next.replace(/^https?:\/\/[^/]+\/[v\d\.]+\//, '');
                    params = {}; // ya incluye querystring en nextUrl
                } else {
                    nextUrl = null;
                }
            }
            console.log(`🧾 Ads detectados/actualizados: ${stats.entities}`);
        } catch (e) {
            console.warn('⚠️ Error sincronizando entidades de Ads:', e.response?.data || e.message);
        }

        // 2) Insights diarios (por ad, con breakdown de plataforma y posición)
        try {
            const params = {
                level: 'ad',
                time_increment: 1,
                time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
                fields: 'impressions,reach,clicks,inline_link_clicks,spend,cpc,cpm,ctr,frequency',
                breakdowns: 'publisher_platform,platform_position',
                limit: 500,
                access_token: accessToken
            };
            let nextUrl = `${accountId}/insights`;
            let totalRows = 0;
            while (true) {
                const resp = await metaGet(nextUrl, { params, accessToken });
                const rows = resp.data?.data || [];
                for (const r of rows) {
                    const date = r.date_start ? new Date(r.date_start) : new Date(endDate);
                    await SocialAdsInsightsDaily.upsert({
                        ad_account_id: accountId,
                        level: 'ad',
                        entity_id: String(r.ad_id || 'unknown'),
                        date: date.toISOString().slice(0,10),
                        publisher_platform: r.publisher_platform || null,
                        platform_position: r.platform_position || null,
                        impressions: parseInt(r.impressions || 0, 10),
                        reach: parseInt(r.reach || 0, 10),
                        clicks: parseInt(r.clicks || 0, 10),
                        inline_link_clicks: parseInt(r.inline_link_clicks || 0, 10),
                        spend: parseFloat(r.spend || 0),
                        cpm: parseFloat(r.cpm || 0),
                        cpc: parseFloat(r.cpc || 0),
                        ctr: parseFloat(r.ctr || 0),
                        frequency: parseFloat(r.frequency || 0),
                        video_plays: parseInt(r.video_plays || 0, 10),
                        video_plays_75: parseInt(r.video_plays_75 || 0, 10)
                    });
                    totalRows++;
                }
                const next = resp.data?.paging?.next;
                if (!next) break;
                nextUrl = next.replace(/^https?:\/\/[^/]+\/[v\d\.]+\//, '');
                params = {}; // next URL carries params
            }
            console.log(`📊 Insights de Ads guardados: ${totalRows} filas`);
            stats.insightsRows += totalRows;
        } catch (e) {
            console.warn('⚠️ Error guardando insights de Ads:', e.response?.data || e.message);
        }

        // 3) Actions diarios (por ad) con breakdown por action_type
        try {
            const params = {
                level: 'ad',
                time_increment: 1,
                time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
                fields: 'actions',
                action_breakdowns: 'action_type,action_destination',
                limit: 500,
                access_token: accessToken
            };
            let nextUrl = `${accountId}/insights`;
            let totalActions = 0;
            while (true) {
                const resp = await metaGet(nextUrl, { params, accessToken });
                const rows = resp.data?.data || [];
                for (const r of rows) {
                    const date = r.date_start ? new Date(r.date_start) : new Date(endDate);
                    const actions = r.actions || [];
                    for (const a of actions) {
                        await SocialAdsActionsDaily.create({
                            ad_account_id: accountId,
                            level: 'ad',
                            entity_id: String(r.ad_id || 'unknown'),
                            date: date.toISOString().slice(0,10),
                            action_type: a.action_type || 'unknown',
                            action_destination: a.action_destination || null,
                            value: parseInt(a.value || 0, 10)
                        });
                        totalActions++;
                    }
                }
                const next = resp.data?.paging?.next;
                if (!next) break;
                nextUrl = next.replace(/^https?:\/\/[^/]+\/[v\d\.]+\//, '');
                params = {};
            }
            console.log(`✅ Actions de Ads guardadas: ${totalActions} filas`);
            stats.actionsRows += totalActions;
        } catch (e) {
            console.warn('⚠️ Error guardando actions de Ads:', e.response?.data || e.message);
        }

        // 4) Volcar agregados por plataforma a SocialStatsDaily
        try {
            // Obtener resumen por fecha/plataforma del rango
            const sinceDate = new Date(sinceStr);
            const untilDate = new Date(untilStr);
            sinceDate.setHours(0,0,0,0);
            untilDate.setHours(0,0,0,0);
            const days = [];
            for (let d = new Date(sinceDate); d <= untilDate; d.setDate(d.getDate() + 1)) {
                days.push(new Date(d));
            }

            for (const day of days) {
                const dateStr = day.toISOString().slice(0,10);
                const rows = await SocialAdsInsightsDaily.findAll({
                    where: {
                        ad_account_id: accountId,
                        date: dateStr
                    },
                    raw: true
                });
                let agg = {
                    instagram: { reach: 0, impressions: 0, spend: 0 },
                    facebook: { reach: 0, impressions: 0, spend: 0 }
                };
                for (const r of rows) {
                    const plat = (r.publisher_platform || '').toLowerCase();
                    if (plat === 'instagram') {
                        agg.instagram.reach += r.reach || 0;
                        agg.instagram.impressions += r.impressions || 0;
                        agg.instagram.spend += parseFloat(r.spend || 0);
                    } else if (plat === 'facebook') {
                        agg.facebook.reach += r.reach || 0;
                        agg.facebook.impressions += r.impressions || 0;
                        agg.facebook.spend += parseFloat(r.spend || 0);
                    }
                }

                // Upsert SocialStatsDaily para este día
                const where = { clinica_id: asset.clinicaId, asset_id: asset.id, date: dateStr };
                const existing = await SocialStatsDaily.findOne({ where });
                const payload = {
                    clinica_id: asset.clinicaId,
                    asset_id: asset.id,
                    asset_type: 'ad_account',
                    date: dateStr,
                    reach_instagram: agg.instagram.reach,
                    reach_facebook: agg.facebook.reach,
                    impressions_instagram: agg.instagram.impressions,
                    impressions_facebook: agg.facebook.impressions,
                    spend_instagram: agg.instagram.spend,
                    spend_facebook: agg.facebook.spend
                };
                if (existing) {
                    await existing.update(payload);
                } else {
                    await SocialStatsDaily.create(payload);
                }
            }
            console.log('📈 Agregados Ads volcados a SocialStatsDaily');
        } catch (e) {
            console.warn('⚠️ Error volcando agregados Ads a SocialStatsDaily:', e.message);
        }

        return { status: 'completed', ...stats };
    } catch (error) {
        console.error('❌ Error en syncAdAccountMetrics:', error);
        throw error;
    }
}

// Exportar función para uso desde los jobs
exports.syncAdAccountMetrics = syncAdAccountMetrics;
// Valida un token de acceso
async function validateToken(connectionId) {
    try {
        console.log(`🔑 Validando token para conexión ${connectionId}`);
        
        // Obtener conexión
        const connection = await MetaConnection.findByPk(connectionId);
        
        if (!connection) {
            throw new Error(`No se encontró la conexión ${connectionId}`);
        }
        
        // Verificar que el token de acceso existe
        if (!connection.accessToken) {
            throw new Error(`La conexión ${connectionId} no tiene un token de acceso`);
        }
        
        // Validar token con la API de Meta
        const validationResponse = await axios.get(`${META_API_BASE_URL}/debug_token`, {
            params: {
                input_token: connection.accessToken,
                access_token: connection.accessToken
            }
        });
        
        if (!validationResponse.data || !validationResponse.data.data) {
            throw new Error('Respuesta de API inválida al validar token');
        }
        
        const tokenData = validationResponse.data.data;
        const isValid = tokenData.is_valid === true;
        const errorMessage = tokenData.error ? `${tokenData.error.code}: ${tokenData.error.message}` : null;
        
        // Registrar validación
        const validation = await TokenValidations.create({
            connection_id: connectionId,
            status: isValid ? 'valid' : 'invalid',
            error_message: errorMessage,
            validated_at: new Date()
        });
        
        console.log(`✅ Validación de token completada: ${isValid ? 'válido' : 'inválido'}`);
        
        return {
            status: isValid ? 'valid' : 'invalid',
            errorMessage,
            validatedAt: validation.validated_at
        };
    } catch (error) {
        console.error('❌ Error en validateToken:', error);
        
        // Registrar validación fallida
        await TokenValidations.create({
            connection_id: connectionId,
            status: 'invalid',
            error_message: error.message,
            validated_at: new Date()
        });
        
        throw error;
    }
}

// ==========================================
// A) ENDPOINT BACKEND - MÉTRICAS POR CLÍNICA
// ==========================================
// Archivo: /src/controllers/metasync.controller.js
// Agregar esta función al controlador existente

/**
 * Obtener métricas de redes sociales por clínica
 * GET /api/metasync/metrics/:clinicaId
 */

exports.getMetricsByClinica = async (req, res) => {

  try {
    const { clinicaId } = req.params;
    const { startDate, endDate } = req.query;

    // Validar parámetros
    if (!clinicaId) {
      return res.status(400).json({
        success: false,
        message: 'ID de clínica requerido'
      });
    }

    // Fechas por defecto (últimos 30 días)
    const defaultEndDate = new Date();
    const defaultStartDate = new Date();
    defaultStartDate.setDate(defaultStartDate.getDate() - 30);

    const start = startDate ? new Date(startDate) : defaultStartDate;
    const end = endDate ? new Date(endDate) : defaultEndDate;

    // Obtener métricas de SocialStatsDaily
    const metricas = await SocialStatsDaily.findAll({
      where: {
        clinica_id: clinicaId,
        date: {
          [Op.between]: [start, end]
        }
      },
      include: [{
        model: ClinicMetaAsset,
        as: 'asset',
        attributes: ['id', 'metaAssetId', 'metaAssetName', 'assetType']
      }],
      order: [['date', 'DESC']],
      raw: false
    });

    // Procesar datos por plataforma
    const metricasPorPlataforma = this.procesarMetricasPorPlataforma(metricas);

    // Calcular totales y tendencias
    const resumen = this.calcularResumenMetricas(metricas);

    // Obtener assets activos de la clínica
    const assetsActivos = await ClinicMetaAsset.findAll({
      where: {
        clinicaId: clinicaId,
        isActive: true
      },
      attributes: ['id', 'metaAssetId', 'metaAssetName', 'assetType', 'pageAccessToken']
    });

    res.json({
      success: true,
      data: {
        clinicaId: parseInt(clinicaId),
        periodo: {
          inicio: start.toISOString().split('T')[0],
          fin: end.toISOString().split('T')[0]
        },
        resumen,
        metricasPorPlataforma,
        assetsActivos: assetsActivos.length,
        ultimaActualizacion: metricas.length > 0 ? metricas[0].created_at : null
      }
    });

  } catch (error) {
    console.error('❌ Error obteniendo métricas por clínica:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
}

/**
 * Procesar métricas agrupadas por plataforma
 */
function procesarMetricasPorPlataforma(metricas) {
  const plataformas = {
    facebook: {
      nombre: 'Facebook',
      icono: 'heroicons_solid:check',
      color: 'text-blue-600',
      metricas: {
        impressions: 0,
        reach: 0,
        profile_visits: 0,
        followers: 0
      },
      tendencia: {
        impressions: 0,
        reach: 0,
        profile_visits: 0,
        followers: 0
      }
    },
    instagram: {
      nombre: 'Instagram',
      icono: 'heroicons_solid:camera',
      color: 'text-pink-500',
      metricas: {
        impressions: 0,
        reach: 0,
        profile_visits: 0,
        followers: 0
      },
      tendencia: {
        impressions: 0,
        reach: 0,
        profile_visits: 0,
        followers: 0
      }
    }
  };

  // Agrupar métricas por plataforma y asset_type
  metricas.forEach(metrica => {
    let plataforma = null;
    
    if (metrica.asset_type === 'facebook_page') {
      plataforma = plataformas.facebook;
    } else if (metrica.asset_type === 'instagram_business') {
      plataforma = plataformas.instagram;
    }

    if (plataforma) {
      // Sumar métricas actuales
      plataforma.metricas.impressions += metrica.impressions || 0;
      plataforma.metricas.reach += metrica.reach || 0;
      plataforma.metricas.profile_visits += metrica.profile_visits || 0;
      plataforma.metricas.followers = Math.max(plataforma.metricas.followers, metrica.followers || 0);
    }
  });

  // Calcular tendencias (comparar últimos 7 días vs 7 días anteriores)
  const hoy = new Date();
  const hace7Dias = new Date();
  hace7Dias.setDate(hoy.getDate() - 7);
  const hace14Dias = new Date();
  hace14Dias.setDate(hoy.getDate() - 14);

  const metricasRecientes = metricas.filter(m => new Date(m.date) >= hace7Dias);
  const metricasAnteriores = metricas.filter(m => 
    new Date(m.date) >= hace14Dias && new Date(m.date) < hace7Dias
  );

  // Calcular tendencias para cada plataforma
  Object.keys(plataformas).forEach(key => {
    const plataforma = plataformas[key];
    const assetType = key === 'facebook' ? 'facebook_page' : 'instagram_business';

    const recientes = metricasRecientes.filter(m => m.asset_type === assetType);
    const anteriores = metricasAnteriores.filter(m => m.asset_type === assetType);

    const sumaRecientes = {
      impressions: recientes.reduce((sum, m) => sum + (m.impressions || 0), 0),
      reach: recientes.reduce((sum, m) => sum + (m.reach || 0), 0),
      profile_visits: recientes.reduce((sum, m) => sum + (m.profile_visits || 0), 0)
    };

    const sumaAnteriores = {
      impressions: anteriores.reduce((sum, m) => sum + (m.impressions || 0), 0),
      reach: anteriores.reduce((sum, m) => sum + (m.reach || 0), 0),
      profile_visits: anteriores.reduce((sum, m) => sum + (m.profile_visits || 0), 0)
    };

    // Calcular porcentaje de cambio
    Object.keys(sumaRecientes).forEach(metrica => {
      if (sumaAnteriores[metrica] > 0) {
        const cambio = ((sumaRecientes[metrica] - sumaAnteriores[metrica]) / sumaAnteriores[metrica]) * 100;
        plataforma.tendencia[metrica] = Math.round(cambio * 100) / 100;
      }
    });
  });

  return plataformas;
}

// Export utilidades
exports.procesarMetricasPorPlataforma = procesarMetricasPorPlataforma;
