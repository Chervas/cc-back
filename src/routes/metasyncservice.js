// services/metasyncservice.js
const axios = require('axios');
const { Op } = require('sequelize');
const models = require('../models');
const { SocialStatDaily, SocialPost, SocialPostStatDaily, SyncLog, TokenValidation } = models;

/**
 * Servicio para sincronizar datos con la API de Meta (Facebook/Instagram)
 */
class MetaSyncService {
    /**
     * Constructor del servicio
     */
    constructor() {
        this.baseUrl = 'https://graph.facebook.com/v18.0';
        this.defaultFields = {
            page: 'name,fan_count,followers_count,talking_about_count',
            insights: 'page_impressions,page_impressions_unique,page_engaged_users,page_consumptions,page_follows',
            posts: 'id,message,created_time,permalink_url,full_picture,type',
            postInsights: 'post_impressions,post_impressions_unique,post_engaged_users,post_reactions_by_type_total'
        };
    }

    /**
     * Iniciar un proceso de sincronización
     * @param {Object} options - Opciones de sincronización
     * @returns {Promise<Object>} - Registro de sincronización
     */
    async startSyncProcess(options = {}) {
        const { jobType, clinicaId, assetId, assetType } = options;
        
        // Crear registro de sincronización
        const syncLog = await SyncLog.startSync({
            job_type: jobType || 'full_sync',
            clinica_id: clinicaId,
            asset_id: assetId,
            asset_type: assetType,
            status: 'running'
        });
        
        console.log(`🔄 [MetaSyncService] Iniciando proceso de sincronización (ID: ${syncLog.id})`);
        
        return syncLog;
    }

    /**
     * Completar un proceso de sincronización
     * @param {number} syncLogId - ID del registro de sincronización
     * @param {Object} stats - Estadísticas del proceso
     * @returns {Promise<Object>} - Registro de sincronización actualizado
     */
    async completeSyncProcess(syncLogId, stats = {}) {
        const syncLog = await SyncLog.completeSync(syncLogId, {
            records_processed: stats.recordsProcessed || 0
        });
        
        console.log(`✅ [MetaSyncService] Proceso de sincronización completado (ID: ${syncLogId})`);
        
        return syncLog;
    }

    /**
     * Marcar un proceso de sincronización como fallido
     * @param {number} syncLogId - ID del registro de sincronización
     * @param {Error} error - Error ocurrido
     * @returns {Promise<Object>} - Registro de sincronización actualizado
     */
    async failSyncProcess(syncLogId, error) {
        const errorMessage = error.message || 'Error desconocido';
        
        const syncLog = await SyncLog.failSync(syncLogId, errorMessage);
        
        console.error(`❌ [MetaSyncService] Error en proceso de sincronización (ID: ${syncLogId}): ${errorMessage}`);
        
        return syncLog;
    }

    /**
     * Validar un token de acceso
     * @param {Object} connection - Conexión de Meta
     * @returns {Promise<Object>} - Resultado de la validación
     */
    async validateToken(connection) {
        try {
            const response = await axios.get(`${this.baseUrl}/debug_token`, {
                params: {
                    input_token: connection.accessToken,
                    access_token: connection.accessToken
                }
            });
            
            const { data } = response;
            const isValid = data && data.data && !data.data.is_valid === false;
            const expiresAt = data.data.expires_at ? new Date(data.data.expires_at * 1000) : null;
            
            // Registrar validación
            await TokenValidation.recordValidation(
                connection.id,
                isValid ? 'valid' : 'invalid',
                isValid ? null : 'Token inválido'
            );
            
            return {
                isValid,
                expiresAt,
                data: data.data
            };
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al validar token: ${error.message}`);
            
            // Registrar validación fallida
            await TokenValidation.recordValidation(
                connection.id,
                'invalid',
                error.message
            );
            
            return {
                isValid: false,
                error: error.message
            };
        }
    }

    /**
     * Sincronizar métricas diarias de una página de Facebook
     * @param {Object} asset - Activo de Meta (página de Facebook)
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @param {number} syncLogId - ID del registro de sincronización
     * @returns {Promise<Object>} - Estadísticas del proceso
     */
    async syncFacebookPageMetrics(asset, startDate, endDate, syncLogId) {
        try {
            const { metaAssetId, pageAccessToken, clinicaId } = asset;
            
            if (!pageAccessToken) {
                throw new Error('Token de página no disponible');
            }
            
            // Obtener información básica de la página
            const pageInfo = await this.fetchFacebookPageInfo(metaAssetId, pageAccessToken);
            
            // Obtener métricas diarias
            const metrics = await this.fetchFacebookPageInsights(
                metaAssetId,
                pageAccessToken,
                startDate,
                endDate
            );
            
            // Guardar métricas en la base de datos
            let recordsProcessed = 0;
            
            for (const metric of metrics) {
                await SocialStatDaily.upsertStats({
                    clinica_id: clinicaId,
                    asset_id: asset.id,
                    asset_type: 'facebook_page',
                    date: metric.date,
                    impressions: metric.impressions || 0,
                    reach: metric.reach || 0,
                    engagement: metric.engagement || 0,
                    clicks: metric.clicks || 0,
                    followers: metric.followers || pageInfo.followers_count || 0,
                    profile_visits: metric.profile_visits || 0
                });
                
                recordsProcessed++;
            }
            
            return { recordsProcessed };
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al sincronizar métricas de Facebook: ${error.message}`);
            await this.failSyncProcess(syncLogId, error);
            throw error;
        }
    }

    /**
     * Sincronizar métricas diarias de una cuenta de Instagram Business
     * @param {Object} asset - Activo de Meta (cuenta de Instagram Business)
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @param {number} syncLogId - ID del registro de sincronización
     * @returns {Promise<Object>} - Estadísticas del proceso
     */
    async syncInstagramMetrics(asset, startDate, endDate, syncLogId) {
        try {
            const { metaAssetId, pageAccessToken, clinicaId } = asset;
            
            if (!pageAccessToken) {
                throw new Error('Token de página no disponible');
            }
            
            // Obtener información básica de la cuenta de Instagram
            const igInfo = await this.fetchInstagramBusinessInfo(metaAssetId, pageAccessToken);
            
            // Obtener métricas diarias
            const metrics = await this.fetchInstagramInsights(
                igInfo.instagram_business_account.id,
                pageAccessToken,
                startDate,
                endDate
            );
            
            // Guardar métricas en la base de datos
            let recordsProcessed = 0;
            
            for (const metric of metrics) {
                await SocialStatDaily.upsertStats({
                    clinica_id: clinicaId,
                    asset_id: asset.id,
                    asset_type: 'instagram_business',
                    date: metric.date,
                    impressions: metric.impressions || 0,
                    reach: metric.reach || 0,
                    engagement: metric.engagement || 0,
                    clicks: metric.clicks || 0,
                    followers: metric.followers || igInfo.followers_count || 0,
                    profile_visits: metric.profile_visits || 0
                });
                
                recordsProcessed++;
            }
            
            return { recordsProcessed };
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al sincronizar métricas de Instagram: ${error.message}`);
            await this.failSyncProcess(syncLogId, error);
            throw error;
        }
    }

    /**
     * Sincronizar publicaciones de Facebook
     * @param {Object} asset - Activo de Meta (página de Facebook)
     * @param {number} limit - Límite de publicaciones a sincronizar
     * @param {number} syncLogId - ID del registro de sincronización
     * @returns {Promise<Object>} - Estadísticas del proceso
     */
    async syncFacebookPosts(asset, limit = 100, syncLogId) {
        try {
            const { metaAssetId, pageAccessToken, clinicaId } = asset;
            
            if (!pageAccessToken) {
                throw new Error('Token de página no disponible');
            }
            
            // Obtener publicaciones
            const posts = await this.fetchFacebookPosts(metaAssetId, pageAccessToken, limit);
            
            // Guardar publicaciones en la base de datos
            let recordsProcessed = 0;
            
            for (const postData of posts) {
                // Crear o actualizar publicación
                const post = await SocialPost.findOrCreatePost({
                    clinica_id: clinicaId,
                    asset_id: asset.id,
                    asset_type: 'facebook_page',
                    post_id: postData.id,
                    post_type: postData.type || 'status',
                    title: postData.message ? postData.message.substring(0, 100) : null,
                    content: postData.message,
                    media_url: postData.full_picture,
                    permalink_url: postData.permalink_url,
                    published_at: new Date(postData.created_time)
                });
                
                // Obtener métricas de la publicación
                const insights = await this.fetchFacebookPostInsights(postData.id, pageAccessToken);
                
                if (insights) {
                    // Guardar métricas de la publicación
                    await SocialPostStatDaily.upsertStats({
                        post_id: post.id,
                        date: new Date(postData.created_time).toISOString().split('T')[0],
                        impressions: insights.impressions || 0,
                        reach: insights.reach || 0,
                        engagement: insights.engagement || 0,
                        likes: insights.likes || 0,
                        comments: insights.comments || 0,
                        shares: insights.shares || 0
                    });
                }
                
                recordsProcessed++;
            }
            
            return { recordsProcessed };
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al sincronizar publicaciones de Facebook: ${error.message}`);
            await this.failSyncProcess(syncLogId, error);
            throw error;
        }
    }

    /**
     * Sincronizar publicaciones de Instagram
     * @param {Object} asset - Activo de Meta (cuenta de Instagram Business)
     * @param {number} limit - Límite de publicaciones a sincronizar
     * @param {number} syncLogId - ID del registro de sincronización
     * @returns {Promise<Object>} - Estadísticas del proceso
     */
    async syncInstagramPosts(asset, limit = 100, syncLogId) {
        try {
            const { metaAssetId, pageAccessToken, clinicaId } = asset;
            
            if (!pageAccessToken) {
                throw new Error('Token de página no disponible');
            }
            
            // Obtener ID de la cuenta de Instagram Business
            const igInfo = await this.fetchInstagramBusinessInfo(metaAssetId, pageAccessToken);
            const igBusinessId = igInfo.instagram_business_account.id;
            
            // Obtener publicaciones
            const posts = await this.fetchInstagramPosts(igBusinessId, pageAccessToken, limit);
            
            // Guardar publicaciones en la base de datos
            let recordsProcessed = 0;
            
            for (const postData of posts) {
                // Crear o actualizar publicación
                const post = await SocialPost.findOrCreatePost({
                    clinica_id: clinicaId,
                    asset_id: asset.id,
                    asset_type: 'instagram_business',
                    post_id: postData.id,
                    post_type: postData.media_type.toLowerCase(),
                    title: postData.caption ? postData.caption.substring(0, 100) : null,
                    content: postData.caption,
                    media_url: postData.media_url,
                    permalink_url: postData.permalink,
                    published_at: new Date(postData.timestamp)
                });
                
                // Obtener métricas de la publicación
                const insights = await this.fetchInstagramPostInsights(postData.id, pageAccessToken);
                
                if (insights) {
                    // Guardar métricas de la publicación
                    await SocialPostStatDaily.upsertStats({
                        post_id: post.id,
                        date: new Date(postData.timestamp).toISOString().split('T')[0],
                        impressions: insights.impressions || 0,
                        reach: insights.reach || 0,
                        engagement: insights.engagement || 0,
                        likes: insights.likes || 0,
                        comments: insights.comments || 0,
                        saved: insights.saved || 0
                    });
                }
                
                recordsProcessed++;
            }
            
            return { recordsProcessed };
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al sincronizar publicaciones de Instagram: ${error.message}`);
            await this.failSyncProcess(syncLogId, error);
            throw error;
        }
    }

    /**
     * Obtener información básica de una página de Facebook
     * @param {string} pageId - ID de la página
     * @param {string} accessToken - Token de acceso
     * @returns {Promise<Object>} - Información de la página
     */
    async fetchFacebookPageInfo(pageId, accessToken) {
        try {
            const response = await axios.get(`${this.baseUrl}/${pageId}`, {
                params: {
                    fields: this.defaultFields.page,
                    access_token: accessToken
                }
            });
            
            return response.data;
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al obtener información de página: ${error.message}`);
            throw error;
        }
    }

    /**
     * Obtener métricas diarias de una página de Facebook
     * @param {string} pageId - ID de la página
     * @param {string} accessToken - Token de acceso
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise<Array>} - Métricas diarias
     */
    async fetchFacebookPageInsights(pageId, accessToken, startDate, endDate) {
        try {
            // Formatear fechas para la API de Facebook
            const since = Math.floor(startDate.getTime() / 1000);
            const until = Math.floor(endDate.getTime() / 1000);
            
            // Obtener métricas
            const response = await axios.get(`${this.baseUrl}/${pageId}/insights`, {
                params: {
                    metric: this.defaultFields.insights,
                    period: 'day',
                    since,
                    until,
                    access_token: accessToken
                }
            });
            
            // Procesar y normalizar datos
            const { data } = response.data;
            const metrics = [];
            
            // Crear un mapa de fechas para facilitar la agregación
            const dateMap = {};
            
            // Procesar cada métrica
            for (const metricData of data) {
                const { name, values } = metricData;
                
                for (const value of values) {
                    const date = value.end_time.split('T')[0];
                    
                    if (!dateMap[date]) {
                        dateMap[date] = {
                            date,
                            impressions: 0,
                            reach: 0,
                            engagement: 0,
                            clicks: 0,
                            followers: 0,
                            profile_visits: 0
                        };
                    }
                    
                    // Mapear métricas de Facebook a nuestro modelo
                    switch (name) {
                        case 'page_impressions':
                            dateMap[date].impressions = value.value || 0;
                            break;
                        case 'page_impressions_unique':
                            dateMap[date].reach = value.value || 0;
                            break;
                        case 'page_engaged_users':
                            dateMap[date].engagement = value.value || 0;
                            break;
                        case 'page_consumptions':
                            dateMap[date].clicks = value.value || 0;
                            break;
                        case 'page_follows':
                            dateMap[date].followers = value.value || 0;
                            break;
                    }
                }
            }
            
            // Convertir el mapa a un array
            for (const date in dateMap) {
                metrics.push(dateMap[date]);
            }
            
            return metrics;
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al obtener métricas de página: ${error.message}`);
            throw error;
        }
    }

    /**
     * Obtener publicaciones de una página de Facebook
     * @param {string} pageId - ID de la página
     * @param {string} accessToken - Token de acceso
     * @param {number} limit - Límite de publicaciones
     * @returns {Promise<Array>} - Publicaciones
     */
    async fetchFacebookPosts(pageId, accessToken, limit = 100) {
        try {
            const response = await axios.get(`${this.baseUrl}/${pageId}/posts`, {
                params: {
                    fields: this.defaultFields.posts,
                    limit,
                    access_token: accessToken
                }
            });
            
            return response.data.data || [];
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al obtener publicaciones de Facebook: ${error.message}`);
            throw error;
        }
    }

    /**
     * Obtener métricas de una publicación de Facebook
     * @param {string} postId - ID de la publicación
     * @param {string} accessToken - Token de acceso
     * @returns {Promise<Object>} - Métricas de la publicación
     */
    async fetchFacebookPostInsights(postId, accessToken) {
        try {
            const response = await axios.get(`${this.baseUrl}/${postId}/insights`, {
                params: {
                    metric: this.defaultFields.postInsights,
                    access_token: accessToken
                }
            });
            
            const { data } = response.data;
            
            // Procesar y normalizar datos
            const insights = {
                impressions: 0,
                reach: 0,
                engagement: 0,
                likes: 0,
                comments: 0,
                shares: 0
            };
            
            // Procesar cada métrica
            for (const metricData of data) {
                const { name, values } = metricData;
                const value = values[0]?.value || 0;
                
                // Mapear métricas de Facebook a nuestro modelo
                switch (name) {
                    case 'post_impressions':
                        insights.impressions = value;
                        break;
                    case 'post_impressions_unique':
                        insights.reach = value;
                        break;
                    case 'post_engaged_users':
                        insights.engagement = value;
                        break;
                    case 'post_reactions_by_type_total':
                        insights.likes = value.like || 0;
                        break;
                }
            }
            
            // Obtener comentarios y compartidos
            const postDetails = await axios.get(`${this.baseUrl}/${postId}`, {
                params: {
                    fields: 'comments.summary(true),shares',
                    access_token: accessToken
                }
            });
            
            if (postDetails.data.comments && postDetails.data.comments.summary) {
                insights.comments = postDetails.data.comments.summary.total_count || 0;
            }
            
            if (postDetails.data.shares) {
                insights.shares = postDetails.data.shares.count || 0;
            }
            
            return insights;
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al obtener métricas de publicación de Facebook: ${error.message}`);
            return null;
        }
    }

    /**
     * Obtener información de una cuenta de Instagram Business
     * @param {string} pageId - ID de la página de Facebook asociada
     * @param {string} accessToken - Token de acceso
     * @returns {Promise<Object>} - Información de la cuenta de Instagram
     */
    async fetchInstagramBusinessInfo(pageId, accessToken) {
        try {
            // Primero obtenemos el ID de la cuenta de Instagram Business asociada a la página
            const response = await axios.get(`${this.baseUrl}/${pageId}`, {
                params: {
                    fields: 'instagram_business_account',
                    access_token: accessToken
                }
            });
            
            if (!response.data.instagram_business_account) {
                throw new Error('No se encontró una cuenta de Instagram Business asociada a esta página');
            }
            
            const igBusinessId = response.data.instagram_business_account.id;
            
            // Luego obtenemos la información de la cuenta de Instagram
            const igResponse = await axios.get(`${this.baseUrl}/${igBusinessId}`, {
                params: {
                    fields: 'name,username,profile_picture_url,followers_count,follows_count,media_count',
                    access_token: accessToken
                }
            });
            
            return {
                ...igResponse.data,
                instagram_business_account: {
                    id: igBusinessId
                }
            };
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al obtener información de Instagram: ${error.message}`);
            throw error;
        }
    }

    /**
     * Obtener métricas diarias de una cuenta de Instagram Business
     * @param {string} igBusinessId - ID de la cuenta de Instagram Business
     * @param {string} accessToken - Token de acceso
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise<Array>} - Métricas diarias
     */
    async fetchInstagramInsights(igBusinessId, accessToken, startDate, endDate) {
        try {
            // Formatear fechas para la API de Instagram
            const since = Math.floor(startDate.getTime() / 1000);
            const until = Math.floor(endDate.getTime() / 1000);
            
            // Obtener métricas
            const response = await axios.get(`${this.baseUrl}/${igBusinessId}/insights`, {
                params: {
                    metric: 'impressions,reach,profile_views,follower_count',
                    period: 'day',
                    since,
                    until,
                    access_token: accessToken
                }
            });
            
            // Procesar y normalizar datos
            const { data } = response.data;
            const metrics = [];
            
            // Crear un mapa de fechas para facilitar la agregación
            const dateMap = {};
            
            // Procesar cada métrica
            for (const metricData of data) {
                const { name, values } = metricData;
                
                for (const value of values) {
                    const date = value.end_time.split('T')[0];
                    
                    if (!dateMap[date]) {
                        dateMap[date] = {
                            date,
                            impressions: 0,
                            reach: 0,
                            engagement: 0,
                            profile_visits: 0,
                            followers: 0
                        };
                    }
                    
                    // Mapear métricas de Instagram a nuestro modelo
                    switch (name) {
                        case 'impressions':
                            dateMap[date].impressions = value.value || 0;
                            break;
                        case 'reach':
                            dateMap[date].reach = value.value || 0;
                            break;
                        case 'profile_views':
                            dateMap[date].profile_visits = value.value || 0;
                            break;
                        case 'follower_count':
                            dateMap[date].followers = value.value || 0;
                            break;
                    }
                }
            }
            
            // Obtener datos de engagement (no disponible directamente)
            const engagementResponse = await axios.get(`${this.baseUrl}/${igBusinessId}/insights`, {
                params: {
                    metric: 'engagement',
                    period: 'day',
                    since,
                    until,
                    access_token: accessToken
                }
            });
            
            if (engagementResponse.data && engagementResponse.data.data) {
                const engagementData = engagementResponse.data.data[0];
                
                if (engagementData && engagementData.values) {
                    for (const value of engagementData.values) {
                        const date = value.end_time.split('T')[0];
                        
                        if (dateMap[date]) {
                            dateMap[date].engagement = value.value || 0;
                        }
                    }
                }
            }
            
            // Convertir el mapa a un array
            for (const date in dateMap) {
                metrics.push(dateMap[date]);
            }
            
            return metrics;
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al obtener métricas de Instagram: ${error.message}`);
            throw error;
        }
    }

    /**
     * Obtener publicaciones de una cuenta de Instagram Business
     * @param {string} igBusinessId - ID de la cuenta de Instagram Business
     * @param {string} accessToken - Token de acceso
     * @param {number} limit - Límite de publicaciones
     * @returns {Promise<Array>} - Publicaciones
     */
    async fetchInstagramPosts(igBusinessId, accessToken, limit = 100) {
        try {
            const response = await axios.get(`${this.baseUrl}/${igBusinessId}/media`, {
                params: {
                    fields: 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,username',
                    limit,
                    access_token: accessToken
                }
            });
            
            return response.data.data || [];
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al obtener publicaciones de Instagram: ${error.message}`);
            throw error;
        }
    }

    /**
     * Obtener métricas de una publicación de Instagram
     * @param {string} mediaId - ID del media
     * @param {string} accessToken - Token de acceso
     * @returns {Promise<Object>} - Métricas de la publicación
     */
    async fetchInstagramPostInsights(mediaId, accessToken) {
        try {
            const response = await axios.get(`${this.baseUrl}/${mediaId}/insights`, {
                params: {
                    metric: 'impressions,reach,engagement,saved',
                    access_token: accessToken
                }
            });
            
            const { data } = response.data;
            
            // Procesar y normalizar datos
            const insights = {
                impressions: 0,
                reach: 0,
                engagement: 0,
                likes: 0,
                comments: 0,
                saved: 0
            };
            
            // Procesar cada métrica
            for (const metricData of data) {
                const { name, values } = metricData;
                const value = values[0]?.value || 0;
                
                // Mapear métricas de Instagram a nuestro modelo
                switch (name) {
                    case 'impressions':
                        insights.impressions = value;
                        break;
                    case 'reach':
                        insights.reach = value;
                        break;
                    case 'engagement':
                        insights.engagement = value;
                        break;
                    case 'saved':
                        insights.saved = value;
                        break;
                }
            }
            
            // Obtener likes y comentarios
            const mediaDetails = await axios.get(`${this.baseUrl}/${mediaId}`, {
                params: {
                    fields: 'like_count,comments_count',
                    access_token: accessToken
                }
            });
            
            insights.likes = mediaDetails.data.like_count || 0;
            insights.comments = mediaDetails.data.comments_count || 0;
            
            return insights;
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al obtener métricas de publicación de Instagram: ${error.message}`);
            return null;
        }
    }

    /**
     * Sincronizar todos los activos de una clínica
     * @param {number} clinicaId - ID de la clínica
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise<Object>} - Estadísticas del proceso
     */
    async syncClinicaAssets(clinicaId, startDate, endDate) {
        // Iniciar proceso de sincronización
        const syncLog = await this.startSyncProcess({
            jobType: 'clinica_sync',
            clinicaId
        });
        
        try {
            // Obtener activos de la clínica
            const assets = await models.ClinicMetaAsset.findAll({
                where: {
                    clinicaId,
                    isActive: true
                },
                include: [
                    {
                        model: models.MetaConnection,
                        as: 'metaConnection'
                    }
                ]
            });
            
            if (!assets || assets.length === 0) {
                throw new Error(`No se encontraron activos activos para la clínica ${clinicaId}`);
            }
            
            console.log(`🔄 [MetaSyncService] Sincronizando ${assets.length} activos para la clínica ${clinicaId}`);
            
            let totalRecordsProcessed = 0;
            
            // Sincronizar cada activo
            for (const asset of assets) {
                // Validar token de conexión
                const connection = asset.metaConnection;
                
                if (!connection) {
                    console.error(`❌ [MetaSyncService] No se encontró conexión para el activo ${asset.id}`);
                    continue;
                }
                
                const tokenValidation = await this.validateToken(connection);
                
                if (!tokenValidation.isValid) {
                    console.error(`❌ [MetaSyncService] Token inválido para la conexión ${connection.id}`);
                    continue;
                }
                
                // Sincronizar según el tipo de activo
                let stats = { recordsProcessed: 0 };
                
                switch (asset.assetType) {
                    case 'facebook_page':
                        // Sincronizar métricas de página
                        const fbMetricsStats = await this.syncFacebookPageMetrics(
                            asset,
                            startDate,
                            endDate,
                            syncLog.id
                        );
                        
                        // Sincronizar publicaciones
                        const fbPostsStats = await this.syncFacebookPosts(
                            asset,
                            100,
                            syncLog.id
                        );
                        
                        stats.recordsProcessed += fbMetricsStats.recordsProcessed + fbPostsStats.recordsProcessed;
                        break;
                        
                    case 'instagram_business':
                        // Sincronizar métricas de Instagram
                        const igMetricsStats = await this.syncInstagramMetrics(
                            asset,
                            startDate,
                            endDate,
                            syncLog.id
                        );
                        
                        // Sincronizar publicaciones
                        const igPostsStats = await this.syncInstagramPosts(
                            asset,
                            100,
                            syncLog.id
                        );
                        
                        stats.recordsProcessed += igMetricsStats.recordsProcessed + igPostsStats.recordsProcessed;
                        break;
                        
                    default:
                        console.log(`⚠️ [MetaSyncService] Tipo de activo no soportado: ${asset.assetType}`);
                }
                
                totalRecordsProcessed += stats.recordsProcessed;
            }
            
            // Completar proceso de sincronización
            await this.completeSyncProcess(syncLog.id, { recordsProcessed: totalRecordsProcessed });
            
            return {
                success: true,
                syncLogId: syncLog.id,
                recordsProcessed: totalRecordsProcessed
            };
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al sincronizar activos de clínica: ${error.message}`);
            await this.failSyncProcess(syncLog.id, error);
            
            return {
                success: false,
                syncLogId: syncLog.id,
                error: error.message
            };
        }
    }

    /**
     * Sincronizar un activo específico
     * @param {number} assetId - ID del activo
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise<Object>} - Estadísticas del proceso
     */
    async syncAsset(assetId, startDate, endDate) {
        // Obtener activo
        const asset = await models.ClinicMetaAsset.findByPk(assetId, {
            include: [
                {
                    model: models.MetaConnection,
                    as: 'metaConnection'
                }
            ]
        });
        
        if (!asset) {
            throw new Error(`No se encontró el activo con ID ${assetId}`);
        }
        
        if (!asset.isActive) {
            throw new Error(`El activo ${assetId} no está activo`);
        }
        
        // Iniciar proceso de sincronización
        const syncLog = await this.startSyncProcess({
            jobType: 'asset_sync',
            clinicaId: asset.clinicaId,
            assetId: asset.id,
            assetType: asset.assetType
        });
        
        try {
            // Validar token de conexión
            const connection = asset.metaConnection;
            
            if (!connection) {
                throw new Error(`No se encontró conexión para el activo ${asset.id}`);
            }
            
            const tokenValidation = await this.validateToken(connection);
            
            if (!tokenValidation.isValid) {
                throw new Error(`Token inválido para la conexión ${connection.id}`);
            }
            
            // Sincronizar según el tipo de activo
            let stats = { recordsProcessed: 0 };
            
            switch (asset.assetType) {
                case 'facebook_page':
                    // Sincronizar métricas de página
                    const fbMetricsStats = await this.syncFacebookPageMetrics(
                        asset,
                        startDate,
                        endDate,
                        syncLog.id
                    );
                    
                    // Sincronizar publicaciones
                    const fbPostsStats = await this.syncFacebookPosts(
                        asset,
                        100,
                        syncLog.id
                    );
                    
                    stats.recordsProcessed = fbMetricsStats.recordsProcessed + fbPostsStats.recordsProcessed;
                    break;
                    
                case 'instagram_business':
                    // Sincronizar métricas de Instagram
                    const igMetricsStats = await this.syncInstagramMetrics(
                        asset,
                        startDate,
                        endDate,
                        syncLog.id
                    );
                    
                    // Sincronizar publicaciones
                    const igPostsStats = await this.syncInstagramPosts(
                        asset,
                        100,
                        syncLog.id
                    );
                    
                    stats.recordsProcessed = igMetricsStats.recordsProcessed + igPostsStats.recordsProcessed;
                    break;
                    
                default:
                    throw new Error(`Tipo de activo no soportado: ${asset.assetType}`);
            }
            
            // Completar proceso de sincronización
            await this.completeSyncProcess(syncLog.id, stats);
            
            return {
                success: true,
                syncLogId: syncLog.id,
                recordsProcessed: stats.recordsProcessed
            };
        } catch (error) {
            console.error(`❌ [MetaSyncService] Error al sincronizar activo: ${error.message}`);
            await this.failSyncProcess(syncLog.id, error);
            
            return {
                success: false,
                syncLogId: syncLog.id,
                error: error.message
            };
        }
    }
}

module.exports = new MetaSyncService();

