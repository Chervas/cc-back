// services/metasyncservice.js
const axios = require('axios');
const db = require('../../models');
const { Op } = require('sequelize');

// Modelos
const SyncLog = db.SyncLogs;
const TokenValidation = db.TokenValidations;
const MetaConnection = db.MetaConnection;
const ClinicMetaAsset = db.ClinicMetaAsset;
const SocialStatDaily = db.SocialStatsDaily;
const SocialPost = db.SocialPosts;
const SocialPostStatDaily = db.SocialPostStatsDaily;

// Constantes
const META_API_VERSION = 'v23.0';
const META_API_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

/**
 * Servicio para sincronización con la API de Meta
 */
const MetaSyncService = {
    /**
     * Sincroniza todos los activos de una clínica
     * @param {number} clinicaId - ID de la clínica
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @param {number} syncLogId - ID del registro de sincronización
     * @returns {Promise} - Promesa que se resuelve cuando se completa la sincronización
     */
    syncClinicaAssets: async (clinicaId, startDate, endDate, syncLogId) => {
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
            
            for (const asset of assets) {
                try {
                    await MetaSyncService.syncAsset(asset, startDate, endDate);
                    processedCount++;
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
                errorCount
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
    },
    
    /**
     * Sincroniza un activo específico
     * @param {Object} asset - Activo de Meta
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @param {number} syncLogId - ID del registro de sincronización
     * @returns {Promise} - Promesa que se resuelve cuando se completa la sincronización
     */
    syncAsset: async (asset, startDate, endDate, syncLogId) => {
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
                    result = await MetaSyncService.syncFacebookPageMetrics(asset, accessToken, startDate, endDate);
                    break;
                case 'instagram_business':
                    result = await MetaSyncService.syncInstagramMetrics(asset, accessToken, startDate, endDate);
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
    },
    
    /**
     * Sincroniza métricas de una página de Facebook
     * @param {Object} asset - Activo de Meta (página de Facebook)
     * @param {string} accessToken - Token de acceso
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise} - Promesa que se resuelve cuando se completa la sincronización
     */
    syncFacebookPageMetrics: async (asset, accessToken, startDate, endDate) => {
        try {
            console.log(`📊 Sincronizando métricas de página de Facebook ${asset.metaAssetId}`);
            
            // Formatear fechas para la API de Meta
            const since = Math.floor(startDate.getTime() / 1000);
            const until = Math.floor(endDate.getTime() / 1000);
            
            // Obtener métricas diarias
            const metricsResponse = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
                params: {
                    metric: 'page_impressions,page_impressions_unique,page_engaged_users,page_clicks,page_fans,page_views_total',
                    period: 'day',
                    since,
                    until,
                    access_token: accessToken
                }
            });
            
            if (!metricsResponse.data || !metricsResponse.data.data) {
                throw new Error('Respuesta de API inválida al obtener métricas de página');
            }
            
            // Procesar métricas
            const metricsData = metricsResponse.data.data;
            const processedDays = new Set();
            
            for (const metric of metricsData) {
                const metricName = metric.name;
                const values = metric.values;
                
                for (const value of values) {
                    const date = new Date(value.end_time);
                    date.setHours(0, 0, 0, 0);
                    const dateStr = date.toISOString().split('T')[0];
                    
                    // Preparar datos para upsert
                    let statsData = {
                        clinica_id: asset.clinicaId,
                        asset_id: asset.id,
                        asset_type: asset.assetType,
                        date: date
                    };
                    
                    // Mapear métricas de la API a campos de la base de datos
                    switch (metricName) {
                        case 'page_impressions':
                            statsData.impressions = value.value || 0;
                            break;
                        case 'page_impressions_unique':
                            statsData.reach = value.value || 0;
                            break;
                        case 'page_engaged_users':
                            statsData.engagement = value.value || 0;
                            break;
                        case 'page_clicks':
                            statsData.clicks = value.value || 0;
                            break;
                        case 'page_fans':
                            statsData.followers = value.value || 0;
                            break;
                        case 'page_views_total':
                            statsData.profile_visits = value.value || 0;
                            break;
                    }
                    
                    // Buscar si ya existe un registro para esta fecha
                    let existingStats = await SocialStatDaily.findOne({
                        where: {
                            clinica_id: asset.clinicaId,
                            asset_id: asset.id,
                            date: date
                        }
                    });
                    
                    if (existingStats) {
                        // Actualizar registro existente
                        await existingStats.update(statsData);
                    } else {
                        // Crear nuevo registro
                        await SocialStatDaily.create(statsData);
                    }
                    
                    processedDays.add(dateStr);
                }
            }
            
            // Sincronizar publicaciones
            await MetaSyncService.syncFacebookPosts(asset, accessToken, startDate, endDate);
            
            console.log(`✅ Sincronización de métricas de Facebook completada: ${processedDays.size} días procesados`);
            
            return {
                status: 'completed',
                recordsProcessed: processedDays.size
            };
        } catch (error) {
            console.error('❌ Error en syncFacebookPageMetrics:', error);
            throw error;
        }
    },
    
    /**
     * Sincroniza métricas de una cuenta de Instagram
     * @param {Object} asset - Activo de Meta (cuenta de Instagram)
     * @param {string} accessToken - Token de acceso
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise} - Promesa que se resuelve cuando se completa la sincronización
     */
    syncInstagramMetrics: async (asset, accessToken, startDate, endDate) => {
        try {
            console.log(`📊 Sincronizando métricas de Instagram ${asset.metaAssetId}`);
            
            // Formatear fechas para la API de Meta
            const since = Math.floor(startDate.getTime() / 1000);
            const until = Math.floor(endDate.getTime() / 1000);
            
            // Obtener métricas diarias
            const metricsResponse = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
                params: {
                    metric: 'impressions,reach,profile_views,follower_count',
                    period: 'day',
                    since,
                    until,
                    access_token: accessToken
                }
            });
            
            if (!metricsResponse.data || !metricsResponse.data.data) {
                throw new Error('Respuesta de API inválida al obtener métricas de Instagram');
            }
            
            // Procesar métricas
            const metricsData = metricsResponse.data.data;
            const processedDays = new Set();
            
            for (const metric of metricsData) {
                const metricName = metric.name;
                const values = metric.values;
                
                for (const value of values) {
                    const date = new Date(value.end_time);
                    date.setHours(0, 0, 0, 0);
                    const dateStr = date.toISOString().split('T')[0];
                    
                    // Preparar datos para upsert
                    let statsData = {
                        clinica_id: asset.clinicaId,
                        asset_id: asset.id,
                        asset_type: asset.assetType,
                        date: date
                    };
                    
                    // Mapear métricas de la API a campos de la base de datos
                    switch (metricName) {
                        case 'impressions':
                            statsData.impressions = value.value || 0;
                            break;
                        case 'reach':
                            statsData.reach = value.value || 0;
                            break;
                        case 'profile_views':
                            statsData.profile_visits = value.value || 0;
                            break;
                        case 'follower_count':
                            statsData.followers = value.value || 0;
                            break;
                    }
                    
                    // Buscar si ya existe un registro para esta fecha
                    let existingStats = await SocialStatDaily.findOne({
                        where: {
                            clinica_id: asset.clinicaId,
                            asset_id: asset.id,
                            date: date
                        }
                    });
                    
                    if (existingStats) {
                        // Actualizar registro existente
                        await existingStats.update(statsData);
                    } else {
                        // Crear nuevo registro
                        await SocialStatDaily.create(statsData);
                    }
                    
                    processedDays.add(dateStr);
                }
            }
            
            // Obtener métricas de engagement (requiere una llamada separada)
            const engagementResponse = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
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
                        const date = new Date(value.end_time);
                        date.setHours(0, 0, 0, 0);
                        
                        // Buscar si ya existe un registro para esta fecha
                        let existingStats = await SocialStatDaily.findOne({
                            where: {
                                clinica_id: asset.clinicaId,
                                asset_id: asset.id,
                                date: date
                            }
                        });
                        
                        if (existingStats) {
                            // Actualizar registro existente
                            await existingStats.update({
                                engagement: value.value || 0
                            });
                        }
                    }
                }
            }
            
            // Sincronizar publicaciones
            await MetaSyncService.syncInstagramPosts(asset, accessToken, startDate, endDate);
            
            console.log(`✅ Sincronización de métricas de Instagram completada: ${processedDays.size} días procesados`);
            
            return {
                status: 'completed',
                recordsProcessed: processedDays.size
            };
        } catch (error) {
            console.error('❌ Error en syncInstagramMetrics:', error);
            throw error;
        }
    },
    
    /**
     * Sincroniza publicaciones de Facebook
     * @param {Object} asset - Activo de Meta (página de Facebook)
     * @param {string} accessToken - Token de acceso
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise} - Promesa que se resuelve cuando se completa la sincronización
     */
    syncFacebookPosts: async (asset, accessToken, startDate, endDate) => {
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
                let existingPost = await SocialPost.findOne({
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
                    existingPost = await SocialPost.create(postData);
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
                    await SocialPostStatDaily.create(statsData);
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
    },
    
    /**
     * Sincroniza publicaciones de Instagram
     * @param {Object} asset - Activo de Meta (cuenta de Instagram)
     * @param {string} accessToken - Token de acceso
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise} - Promesa que se resuelve cuando se completa la sincronización
     */
    syncInstagramPosts: async (asset, accessToken, startDate, endDate) => {
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
                let existingPost = await SocialPost.findOne({
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
                    existingPost = await SocialPost.create(postData);
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
                    await SocialPostStatDaily.create(statsData);
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
    },
    
    /**
     * Valida un token de acceso
     * @param {number} connectionId - ID de la conexión de Meta
     * @returns {Promise} - Promesa que se resuelve con el resultado de la validación
     */
    validateToken: async (connectionId) => {
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
            const validation = await TokenValidation.create({
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
            await TokenValidation.create({
                connection_id: connectionId,
                status: 'invalid',
                error_message: error.message,
                validated_at: new Date()
            });
            
            throw error;
        }
    }
};

module.exports = MetaSyncService;

