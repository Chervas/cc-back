'use strict';
const axios = require('axios');
const { 
    SocialStatsDaily, 
    SocialPosts, 
    SocialPostStatsDaily, 
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

        // Sincronizar publicaciones
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
        const since = Math.floor(startDate.getTime() / 1000);
        const until = Math.floor(endDate.getTime() / 1000);

        // Obtener variación diaria de seguidores (últimos días disponibles)
        const followersDayResponse = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
            params: {
                metric: 'follower_count',
                metric_type: 'time_series',
                period: 'day',
                since,
                until,
                access_token: accessToken
            }
        });

        const statsByDate = {};
        const followerValues = followersDayResponse.data?.data?.[0]?.values || [];
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
        const followersTotalResponse = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
            params: {
                metric: 'followers_count',
                metric_type: 'total_value',
                period: 'day',
                access_token: accessToken
            }
        });

        const currentFollowers = followersTotalResponse.data?.data?.[0]?.values?.[0]?.value || 0;

        // Reconstruir historial de seguidores usando la variación diaria
        const dates = Object.keys(statsByDate).sort();
        let runningTotal = currentFollowers;
        for (let i = dates.length - 1; i >= 0; i--) {
            const dateStr = dates[i];
            statsByDate[dateStr].followers = runningTotal;
            runningTotal -= statsByDate[dateStr].followers_day || 0;
        }

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

        // Sincronizar publicaciones
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
    try {
        console.log(`📝 Sincronizando publicaciones de Facebook ${asset.metaAssetId}`);
        
        // Formatear fechas para la API de Meta
        const since = Math.floor(startDate.getTime() / 1000);
        const until = Math.floor(endDate.getTime() / 1000);
        
        // Obtener publicaciones
        const postsResponse = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/posts`, {
            params: {
                fields: 'id,message,created_time,permalink_url,full_picture,type',
                since,
                until,
                limit: 100,
                access_token: accessToken
            }
        });
        
        if (!postsResponse.data || !postsResponse.data.data) {
            throw new Error('Respuesta de API inválida al obtener publicaciones de Facebook');
        }
        
        const posts = postsResponse.data.data;
        console.log(`📊 Encontradas ${posts.length} publicaciones de Facebook`);
        
        // Procesar cada publicación
        for (const post of posts) {
            // Guardar publicación en la base de datos
            const postData = {
                clinica_id: asset.clinicaId,
                asset_id: asset.id,
                asset_type: asset.assetType,
                post_id: post.id,
                post_type: post.type,
                title: post.message ? post.message.substring(0, 255) : null,
                content: post.message,
                media_url: post.full_picture,
                permalink_url: post.permalink_url,
                published_at: new Date(post.created_time)
            };
            
            // Buscar si ya existe la publicación
            let existingPost = await SocialPosts.findOne({
                where: {
                    asset_id: asset.id,
                    post_id: post.id
                }
            });
            
            if (existingPost) {
                // Actualizar publicación existente
                await existingPost.update(postData);
            } else {
                // Crear nueva publicación
                existingPost = await SocialPosts.create(postData);
            }
            
            // Obtener métricas de la publicación
            const metricsResponse = await axios.get(`${META_API_BASE_URL}/${post.id}/insights`, {
                params: {
                    metric: 'post_impressions,post_impressions_unique,post_engaged_users,post_reactions_by_type_total',
                    access_token: accessToken
                }
            });
            
            if (metricsResponse.data && metricsResponse.data.data) {
                const metricsData = metricsResponse.data.data;
                
                // Preparar datos para las métricas
                const statsData = {
                    post_id: existingPost.id,
                    date: new Date(),
                    impressions: 0,
                    reach: 0,
                    engagement: 0,
                    likes: 0,
                    comments: 0,
                    shares: 0
                };
                
                // Procesar métricas
                for (const metric of metricsData) {
                    const metricName = metric.name;
                    const value = metric.values[0]?.value || 0;
                    
                    switch (metricName) {
                        case 'post_impressions':
                            statsData.impressions = value;
                            break;
                        case 'post_impressions_unique':
                            statsData.reach = value;
                            break;
                        case 'post_engaged_users':
                            statsData.engagement = value;
                            break;
                        case 'post_reactions_by_type_total':
                            if (typeof value === 'object') {
                                statsData.likes = (value.like || 0) + (value.love || 0) + (value.wow || 0) + (value.haha || 0);
                            }
                            break;
                    }
                }
                
                // Obtener comentarios y compartidos (requiere llamadas adicionales)
                try {
                    const commentsResponse = await axios.get(`${META_API_BASE_URL}/${post.id}/comments`, {
                        params: {
                            summary: true,
                            access_token: accessToken
                        }
                    });
                    
                    if (commentsResponse.data && commentsResponse.data.summary) {
                        statsData.comments = commentsResponse.data.summary.total_count || 0;
                    }
                } catch (error) {
                    console.warn(`⚠️ Error al obtener comentarios para publicación ${post.id}:`, error.message);
                }
                
                try {
                    const sharesResponse = await axios.get(`${META_API_BASE_URL}/${post.id}/sharedposts`, {
                        params: {
                            summary: true,
                            access_token: accessToken
                        }
                    });
                    
                    if (sharesResponse.data && sharesResponse.data.summary) {
                        statsData.shares = sharesResponse.data.summary.total_count || 0;
                    }
                } catch (error) {
                    console.warn(`⚠️ Error al obtener compartidos para publicación ${post.id}:`, error.message);
                }
                
                // Guardar métricas en la base de datos
                await SocialPostStatsDaily.create(statsData);
            }
        }
        
        console.log(`✅ Sincronización de publicaciones de Facebook completada: ${posts.length} publicaciones procesadas`);
        
        return {
            status: 'completed',
            recordsProcessed: posts.length
        };
    } catch (error) {
        console.error('❌ Error en syncFacebookPosts:', error);
        throw error;
    }
}

// Sincroniza publicaciones de Instagram
async function syncInstagramPosts(asset, accessToken, startDate, endDate) {
    try {
        console.log(`📝 Sincronizando publicaciones de Instagram ${asset.metaAssetId}`);
        
        // Formatear fechas para la API de Meta
        const since = Math.floor(startDate.getTime() / 1000);
        const until = Math.floor(endDate.getTime() / 1000);
        
        // Obtener publicaciones
        const postsResponse = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/media`, {
            params: {
                fields: 'id,caption,media_type,permalink,media_url,thumbnail_url,timestamp',
                since,
                until,
                limit: 100,
                access_token: accessToken
            }
        });
        
        if (!postsResponse.data || !postsResponse.data.data) {
            throw new Error('Respuesta de API inválida al obtener publicaciones de Instagram');
        }
        
        const posts = postsResponse.data.data;
        console.log(`📊 Encontradas ${posts.length} publicaciones de Instagram`);
        
        // Procesar cada publicación
        for (const post of posts) {
            // Guardar publicación en la base de datos
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
            
            // Buscar si ya existe la publicación
            let existingPost = await SocialPosts.findOne({
                where: {
                    asset_id: asset.id,
                    post_id: post.id
                }
            });
            
            if (existingPost) {
                // Actualizar publicación existente
                await existingPost.update(postData);
            } else {
                // Crear nueva publicación
                existingPost = await SocialPosts.create(postData);
            }
            
            // Obtener métricas de la publicación
            const metricsResponse = await axios.get(`${META_API_BASE_URL}/${post.id}/insights`, {
                params: {
                    metric: 'impressions,reach,engagement,saved',
                    access_token: accessToken
                }
            });
            
            if (metricsResponse.data && metricsResponse.data.data) {
                const metricsData = metricsResponse.data.data;
                
                // Preparar datos para las métricas
                const statsData = {
                    post_id: existingPost.id,
                    date: new Date(),
                    impressions: 0,
                    reach: 0,
                    engagement: 0,
                    likes: 0,
                    comments: 0,
                    shares: 0 // En Instagram, "shares" se usa para "saved"
                };
                
                // Procesar métricas
                for (const metric of metricsData) {
                    const metricName = metric.name;
                    const value = metric.values[0]?.value || 0;
                    
                    switch (metricName) {
                        case 'impressions':
                            statsData.impressions = value;
                            break;
                        case 'reach':
                            statsData.reach = value;
                            break;
                        case 'engagement':
                            statsData.engagement = value;
                            break;
                        case 'saved':
                            statsData.shares = value; // En Instagram, "shares" se usa para "saved"
                            break;
                    }
                }
                
                // Obtener likes y comentarios
                try {
                    const likesCommentsResponse = await axios.get(`${META_API_BASE_URL}/${post.id}`, {
                        params: {
                            fields: 'like_count,comments_count',
                            access_token: accessToken
                        }
                    });
                    
                    if (likesCommentsResponse.data) {
                        statsData.likes = likesCommentsResponse.data.like_count || 0;
                        statsData.comments = likesCommentsResponse.data.comments_count || 0;
                    }
                } catch (error) {
                    console.warn(`⚠️ Error al obtener likes y comentarios para publicación ${post.id}:`, error.message);
                }
                
                // Guardar métricas en la base de datos
                await SocialPostStatsDaily.create(statsData);
            }
        }
        
        console.log(`✅ Sincronización de publicaciones de Instagram completada: ${posts.length} publicaciones procesadas`);
        
        return {
            status: 'completed',
            recordsProcessed: posts.length
        };
    } catch (error) {
        console.error('❌ Error en syncInstagramPosts:', error);
        throw error;
    }
}

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

