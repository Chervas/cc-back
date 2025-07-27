/**
 * Sistema de Jobs Cron para Sincronización de Métricas de Redes Sociales
 * 
 * Este archivo contiene la implementación de jobs automatizados para:
 * - Sincronización diaria de métricas de Meta (Facebook/Instagram)
 * - Validación periódica de tokens de acceso
 * - Limpieza de datos antiguos
 * - Verificación de salud del sistema
 * 
 * @author Manus AI
 * @version 1.0.0
 * @date 2025-07-27
 */

const cron = require('node-cron');
const axios = require('axios');
const { Op } = require('sequelize');

// Importar modelos
const { 
  ClinicMetaAsset, 
  MetaConnection, 
  SocialStatDaily, 
  SocialPost, 
  SocialPostStatDaily, 
  SyncLog, 
  TokenValidation 
} = require('../../models');

// Configuración de la API de Meta
const META_API_BASE_URL = 'https://graph.facebook.com/v23.0';

/**
 * Clase principal para gestión de Jobs Cron
 */
class MetaSyncJobs {
  constructor() {
    this.jobs = new Map();
    this.isRunning = false;
    this.config = {
      // Configuración de horarios
      schedules: {
        metricsSync: '0 2 * * *',        // Diario a las 2:00 AM
        tokenValidation: '0 */6 * * *',   // Cada 6 horas
        dataCleanup: '0 3 * * 0',        // Domingos a las 3:00 AM
        healthCheck: '0 * * * *'          // Cada hora
      },
      // Configuración de retención de datos
      dataRetention: {
        syncLogs: 90,      // 90 días
        tokenValidations: 30, // 30 días
        socialStats: 730   // 2 años
      },
      // Configuración de reintentos
      retries: {
        maxAttempts: 3,
        delayMs: 5000
      }
    };
  }

  /**
   * Inicializar todos los jobs
   */
  async initialize() {
    try {
      console.log('🚀 Inicializando sistema de Jobs Cron...');
      
      // Registrar jobs
      this.registerMetricsSyncJob();
      this.registerTokenValidationJob();
      this.registerDataCleanupJob();
      this.registerHealthCheckJob();
      
      this.isRunning = true;
      console.log('✅ Sistema de Jobs Cron inicializado correctamente');
      console.log(`📊 Jobs registrados: ${this.jobs.size}`);
      
      // Mostrar próximas ejecuciones
      this.showNextExecutions();
      
    } catch (error) {
      console.error('❌ Error al inicializar Jobs Cron:', error);
      throw error;
    }
  }

  /**
   * Job para sincronización diaria de métricas
   */
  registerMetricsSyncJob() {
    const job = cron.schedule(this.config.schedules.metricsSync, async () => {
      await this.executeMetricsSync();
    }, {
      scheduled: false,
      timezone: 'Europe/Madrid'
    });

    this.jobs.set('metricsSync', job);
    console.log('📈 Job de sincronización de métricas registrado');
  }

  /**
   * Job para validación de tokens
   */
  registerTokenValidationJob() {
    const job = cron.schedule(this.config.schedules.tokenValidation, async () => {
      await this.executeTokenValidation();
    }, {
      scheduled: false,
      timezone: 'Europe/Madrid'
    });

    this.jobs.set('tokenValidation', job);
    console.log('🔑 Job de validación de tokens registrado');
  }

  /**
   * Job para limpieza de datos antiguos
   */
  registerDataCleanupJob() {
    const job = cron.schedule(this.config.schedules.dataCleanup, async () => {
      await this.executeDataCleanup();
    }, {
      scheduled: false,
      timezone: 'Europe/Madrid'
    });

    this.jobs.set('dataCleanup', job);
    console.log('🧹 Job de limpieza de datos registrado');
  }

  /**
   * Job para verificación de salud del sistema
   */
  registerHealthCheckJob() {
    const job = cron.schedule(this.config.schedules.healthCheck, async () => {
      await this.executeHealthCheck();
    }, {
      scheduled: false,
      timezone: 'Europe/Madrid'
    });

    this.jobs.set('healthCheck', job);
    console.log('❤️ Job de verificación de salud registrado');
  }

  /**
   * Ejecutar sincronización de métricas
   */
  async executeMetricsSync() {
    const startTime = new Date();
    let syncLog = null;
    
    try {
      console.log('🔄 Iniciando sincronización automática de métricas...');
      
      // Crear log de sincronización
      syncLog = await SyncLog.create({
        job_type: 'automated_metrics_sync',
        status: 'running',
        start_time: startTime
      });

      // Obtener todas las conexiones activas
      const connections = await MetaConnection.findAll({
        where: { isActive: true },
        include: [{
          model: ClinicMetaAsset,
          where: { isActive: true },
          required: true
        }]
      });

      console.log(`📊 Encontradas ${connections.length} conexiones activas para sincronizar`);

      let successCount = 0;
      let errorCount = 0;
      const errors = [];

      // Procesar cada conexión
      for (const connection of connections) {
        try {
          await this.syncConnectionMetrics(connection);
          successCount++;
          
          // Delay entre conexiones para respetar rate limits
          await this.delay(2000);
          
        } catch (error) {
          console.error(`❌ Error al sincronizar conexión ${connection.id}:`, error);
          errorCount++;
          errors.push({
            connectionId: connection.id,
            error: error.message
          });
        }
      }

      // Actualizar log de sincronización
      await syncLog.update({
        status: errorCount === 0 ? 'completed' : 'completed_with_errors',
        end_time: new Date(),
        records_processed: successCount,
        error_message: errorCount > 0 ? `${errorCount} errors` : null
      });

      const duration = new Date() - startTime;
      console.log(`✅ Sincronización automática completada en ${duration}ms`);
      console.log(`📈 Éxitos: ${successCount}, Errores: ${errorCount}`);

    } catch (error) {
      console.error('❌ Error en sincronización automática:', error);
      
      if (syncLog) {
        await syncLog.update({
          status: 'failed',
          end_time: new Date(),
          error_message: error.message
        });
      }
    }
  }

  /**
   * Sincronizar métricas de una conexión específica
   */
  async syncConnectionMetrics(connection) {
    const assets = connection.ClinicMetaAssets || [];
    
    for (const asset of assets) {
      if (!asset.pageAccessToken) {
        console.log(`⚠️ Asset ${asset.id} no tiene token de página, omitiendo...`);
        continue;
      }

      try {
        // Obtener métricas según el tipo de asset
        if (asset.assetType === 'facebook_page') {
          await this.syncFacebookPageMetrics(asset);
        } else if (asset.assetType === 'instagram_business') {
          await this.syncInstagramBusinessMetrics(asset);
        }
        
        console.log(`✅ Métricas sincronizadas para asset ${asset.id} (${asset.assetType})`);
        
      } catch (error) {
        console.error(`❌ Error al sincronizar asset ${asset.id}:`, error);
        throw error;
      }
    }
  }

  /**
   * Sincronizar métricas de página de Facebook
   */
  async syncFacebookPageMetrics(asset) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    // Métricas de página
    const pageMetrics = [
      'page_fans',
      'page_fan_adds',
      'page_fan_removes',
      'page_views_total',
      'page_post_engagements',
      'page_posts_impressions',
      'page_posts_impressions_unique'
    ];

    try {
      const response = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
        params: {
          metric: pageMetrics.join(','),
          period: 'day',
          since: dateStr,
          until: dateStr,
          access_token: asset.pageAccessToken
        }
      });

      // Procesar y guardar métricas
      const metricsData = this.processMetricsResponse(response.data, asset, dateStr);
      await this.saveMetrics(metricsData);

      // Sincronizar publicaciones recientes
      await this.syncRecentPosts(asset, dateStr);

    } catch (error) {
      if (error.response?.status === 400 && error.response?.data?.error?.code === 190) {
        console.error(`🔑 Token inválido para asset ${asset.id}, marcando para revalidación`);
        await this.markTokenForRevalidation(asset);
      }
      throw error;
    }
  }

  /**
   * Sincronizar métricas de Instagram Business
   */
  async syncInstagramBusinessMetrics(asset) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    // Métricas de Instagram Business
    const igMetrics = [
      'follower_count',
      'impressions',
      'reach',
      'profile_views',
      'website_clicks'
    ];

    try {
      const response = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/insights`, {
        params: {
          metric: igMetrics.join(','),
          period: 'day',
          since: dateStr,
          until: dateStr,
          access_token: asset.pageAccessToken
        }
      });

      // Procesar y guardar métricas
      const metricsData = this.processMetricsResponse(response.data, asset, dateStr);
      await this.saveMetrics(metricsData);

      // Sincronizar publicaciones recientes
      await this.syncRecentPosts(asset, dateStr);

    } catch (error) {
      if (error.response?.status === 400 && error.response?.data?.error?.code === 190) {
        console.error(`🔑 Token inválido para asset ${asset.id}, marcando para revalidación`);
        await this.markTokenForRevalidation(asset);
      }
      throw error;
    }
  }

  /**
   * Procesar respuesta de métricas de Meta API
   */
  processMetricsResponse(data, asset, date) {
    const metrics = {};
    
    if (data.data && Array.isArray(data.data)) {
      data.data.forEach(metric => {
        if (metric.values && metric.values.length > 0) {
          const value = metric.values[0].value;
          metrics[metric.name] = typeof value === 'object' ? JSON.stringify(value) : value;
        }
      });
    }

    return {
      assetId: asset.id,
      date: date,
      platform: asset.assetType === 'facebook_page' ? 'facebook' : 'instagram',
      metrics: metrics,
      rawData: data
    };
  }

  /**
   * Guardar métricas en la base de datos
   */
  async saveMetrics(metricsData) {
    try {
      // Verificar si ya existen métricas para esta fecha y asset
      const existing = await SocialStatDaily.findOne({
        where: {
          assetId: metricsData.assetId,
          date: metricsData.date,
          platform: metricsData.platform
        }
      });

      if (existing) {
        // Actualizar métricas existentes
        await existing.update({
          metrics: metricsData.metrics,
          rawData: metricsData.rawData,
          updatedAt: new Date()
        });
      } else {
        // Crear nuevas métricas
        await SocialStatDaily.create({
          assetId: metricsData.assetId,
          date: metricsData.date,
          platform: metricsData.platform,
          metrics: metricsData.metrics,
          rawData: metricsData.rawData
        });
      }
    } catch (error) {
      console.error('❌ Error al guardar métricas:', error);
      throw error;
    }
  }

  /**
   * Sincronizar publicaciones recientes
   */
  async syncRecentPosts(asset, date) {
    try {
      const response = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}/posts`, {
        params: {
          fields: 'id,message,created_time,type,permalink_url',
          since: date,
          limit: 25,
          access_token: asset.pageAccessToken
        }
      });

      if (response.data.data && response.data.data.length > 0) {
        for (const post of response.data.data) {
          await this.savePost(post, asset);
          
          // Obtener métricas del post
          await this.syncPostMetrics(post.id, asset, date);
        }
      }
    } catch (error) {
      console.error(`❌ Error al sincronizar posts para asset ${asset.id}:`, error);
      // No lanzar error para no interrumpir el proceso principal
    }
  }

  /**
   * Guardar información de publicación
   */
  async savePost(postData, asset) {
    try {
      const existing = await SocialPost.findOne({
        where: {
          postId: postData.id,
          assetId: asset.id
        }
      });

      const postInfo = {
        postId: postData.id,
        assetId: asset.id,
        platform: asset.assetType === 'facebook_page' ? 'facebook' : 'instagram',
        content: postData.message || '',
        postType: postData.type || 'unknown',
        publishedAt: new Date(postData.created_time),
        permalink: postData.permalink_url || '',
        rawData: postData
      };

      if (existing) {
        await existing.update(postInfo);
      } else {
        await SocialPost.create(postInfo);
      }
    } catch (error) {
      console.error('❌ Error al guardar post:', error);
    }
  }

  /**
   * Sincronizar métricas de publicación
   */
  async syncPostMetrics(postId, asset, date) {
    try {
      const metrics = asset.assetType === 'facebook_page' 
        ? ['post_impressions', 'post_engaged_users', 'post_clicks', 'post_reactions_like_total']
        : ['impressions', 'reach', 'engagement'];

      const response = await axios.get(`${META_API_BASE_URL}/${postId}/insights`, {
        params: {
          metric: metrics.join(','),
          access_token: asset.pageAccessToken
        }
      });

      if (response.data.data) {
        const processedMetrics = {};
        response.data.data.forEach(metric => {
          if (metric.values && metric.values.length > 0) {
            processedMetrics[metric.name] = metric.values[0].value;
          }
        });

        // Guardar métricas del post
        const existing = await SocialPostStatDaily.findOne({
          where: {
            postId: postId,
            assetId: asset.id,
            date: date
          }
        });

        if (existing) {
          await existing.update({
            metrics: processedMetrics,
            rawData: response.data
          });
        } else {
          await SocialPostStatDaily.create({
            postId: postId,
            assetId: asset.id,
            date: date,
            platform: asset.assetType === 'facebook_page' ? 'facebook' : 'instagram',
            metrics: processedMetrics,
            rawData: response.data
          });
        }
      }
    } catch (error) {
      console.error(`❌ Error al sincronizar métricas del post ${postId}:`, error);
    }
  }

  /**
   * Marcar token para revalidación
   */
  async markTokenForRevalidation(asset) {
    try {
      await TokenValidation.create({
        assetId: asset.id,
        tokenType: 'page_access_token',
        isValid: false,
        validatedAt: new Date(),
        errorMessage: 'Token inválido detectado durante sincronización automática',
        needsRevalidation: true
      });
    } catch (error) {
      console.error('❌ Error al marcar token para revalidación:', error);
    }
  }

  /**
   * Ejecutar validación de tokens
   */
  async executeTokenValidation() {
    try {
      console.log('🔑 Iniciando validación automática de tokens...');
      
      const assets = await ClinicMetaAsset.findAll({
        where: { 
          isActive: true,
          pageAccessToken: { [Op.ne]: null }
        }
      });

      let validTokens = 0;
      let invalidTokens = 0;

      for (const asset of assets) {
        try {
          const isValid = await this.validateToken(asset);
          
          await TokenValidation.create({
            assetId: asset.id,
            tokenType: 'page_access_token',
            isValid: isValid,
            validatedAt: new Date(),
            errorMessage: isValid ? null : 'Token validation failed'
          });

          if (isValid) {
            validTokens++;
          } else {
            invalidTokens++;
          }

        } catch (error) {
          console.error(`❌ Error al validar token para asset ${asset.id}:`, error);
          invalidTokens++;
        }
      }

      console.log(`✅ Validación de tokens completada: ${validTokens} válidos, ${invalidTokens} inválidos`);

    } catch (error) {
      console.error('❌ Error en validación automática de tokens:', error);
    }
  }

  /**
   * Validar un token específico
   */
  async validateToken(asset) {
    try {
      const response = await axios.get(`${META_API_BASE_URL}/${asset.metaAssetId}`, {
        params: {
          fields: 'id,name',
          access_token: asset.pageAccessToken
        }
      });

      return response.status === 200 && response.data.id;
    } catch (error) {
      return false;
    }
  }

  /**
   * Ejecutar limpieza de datos antiguos
   */
  async executeDataCleanup() {
    try {
      console.log('🧹 Iniciando limpieza automática de datos antiguos...');
      
      const now = new Date();
      let deletedRecords = 0;

      // Limpiar logs de sincronización antiguos
      const syncLogsCutoff = new Date(now.getTime() - (this.config.dataRetention.syncLogs * 24 * 60 * 60 * 1000));
      const deletedSyncLogs = await SyncLog.destroy({
        where: {
          createdAt: { [Op.lt]: syncLogsCutoff }
        }
      });
      deletedRecords += deletedSyncLogs;

      // Limpiar validaciones de tokens antiguas
      const tokenValidationsCutoff = new Date(now.getTime() - (this.config.dataRetention.tokenValidations * 24 * 60 * 60 * 1000));
      const deletedTokenValidations = await TokenValidation.destroy({
        where: {
          createdAt: { [Op.lt]: tokenValidationsCutoff }
        }
      });
      deletedRecords += deletedTokenValidations;

      // Limpiar métricas sociales muy antiguas (mantener 2 años)
      const socialStatsCutoff = new Date(now.getTime() - (this.config.dataRetention.socialStats * 24 * 60 * 60 * 1000));
      const deletedSocialStats = await SocialStatDaily.destroy({
        where: {
          date: { [Op.lt]: socialStatsCutoff }
        }
      });
      deletedRecords += deletedSocialStats;

      console.log(`✅ Limpieza completada: ${deletedRecords} registros eliminados`);
      console.log(`📊 Detalles: ${deletedSyncLogs} sync logs, ${deletedTokenValidations} token validations, ${deletedSocialStats} social stats`);

    } catch (error) {
      console.error('❌ Error en limpieza automática:', error);
    }
  }

  /**
   * Ejecutar verificación de salud del sistema
   */
  async executeHealthCheck() {
    try {
      const health = {
        timestamp: new Date(),
        database: false,
        metaApi: false,
        activeConnections: 0,
        validTokens: 0,
        recentSyncs: 0
      };

      // Verificar conexión a base de datos
      try {
        await SyncLog.findOne({ limit: 1 });
        health.database = true;
      } catch (error) {
        console.error('❌ Error de conexión a base de datos:', error);
      }

      // Verificar API de Meta (usando un token válido si existe)
      try {
        const asset = await ClinicMetaAsset.findOne({
          where: { 
            isActive: true,
            pageAccessToken: { [Op.ne]: null }
          }
        });

        if (asset) {
          const response = await axios.get(`${META_API_BASE_URL}/me`, {
            params: { access_token: asset.pageAccessToken }
          });
          health.metaApi = response.status === 200;
        }
      } catch (error) {
        console.error('❌ Error de conexión a Meta API:', error);
      }

      // Contar conexiones activas
      health.activeConnections = await MetaConnection.count({
        where: { isActive: true }
      });

      // Contar tokens válidos recientes
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      
      health.validTokens = await TokenValidation.count({
        where: {
          isValid: true,
          validatedAt: { [Op.gte]: yesterday }
        }
      });

      // Contar sincronizaciones recientes
      health.recentSyncs = await SyncLog.count({
        where: {
          status: 'completed',
          createdAt: { [Op.gte]: yesterday }
        }
      });

      // Log del estado de salud (solo cada 6 horas para evitar spam)
      const hour = new Date().getHours();
      if (hour % 6 === 0) {
        console.log('❤️ Estado de salud del sistema:', health);
      }

    } catch (error) {
      console.error('❌ Error en verificación de salud:', error);
    }
  }

  /**
   * Iniciar todos los jobs
   */
  start() {
    if (!this.isRunning) {
      console.log('❌ Sistema de jobs no inicializado. Ejecute initialize() primero.');
      return;
    }

    this.jobs.forEach((job, name) => {
      job.start();
      console.log(`▶️ Job '${name}' iniciado`);
    });

    console.log('🚀 Todos los jobs han sido iniciados');
  }

  /**
   * Detener todos los jobs
   */
  stop() {
    this.jobs.forEach((job, name) => {
      job.stop();
      console.log(`⏹️ Job '${name}' detenido`);
    });

    console.log('🛑 Todos los jobs han sido detenidos');
  }

  /**
   * Obtener estado de todos los jobs
   */
  getStatus() {
    const status = {};
    this.jobs.forEach((job, name) => {
      status[name] = {
        running: job.running,
        scheduled: job.scheduled
      };
    });
    return status;
  }

  /**
   * Mostrar próximas ejecuciones
   */
  showNextExecutions() {
    console.log('\n📅 Próximas ejecuciones programadas:');
    Object.entries(this.config.schedules).forEach(([jobName, schedule]) => {
      console.log(`  ${jobName}: ${schedule}`);
    });
    console.log('');
  }

  /**
   * Ejecutar un job específico manualmente
   */
  async runJob(jobName) {
    try {
      console.log(`🔄 Ejecutando job '${jobName}' manualmente...`);
      
      switch (jobName) {
        case 'metricsSync':
          await this.executeMetricsSync();
          break;
        case 'tokenValidation':
          await this.executeTokenValidation();
          break;
        case 'dataCleanup':
          await this.executeDataCleanup();
          break;
        case 'healthCheck':
          await this.executeHealthCheck();
          break;
        default:
          throw new Error(`Job '${jobName}' no encontrado`);
      }
      
      console.log(`✅ Job '${jobName}' ejecutado correctamente`);
    } catch (error) {
      console.error(`❌ Error al ejecutar job '${jobName}':`, error);
      throw error;
    }
  }

  /**
   * Utilidad para delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Exportar la clase y crear instancia singleton
const metaSyncJobs = new MetaSyncJobs();

module.exports = {
  MetaSyncJobs,
  metaSyncJobs
};

