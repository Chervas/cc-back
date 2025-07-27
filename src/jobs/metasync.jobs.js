/**
 * Sistema de Jobs Cron para Sincronización de Métricas de Redes Sociales
 * ClinicaClick - Versión con Configuraciones .ENV
 * 
 * Este archivo contiene la implementación de jobs automatizados para:
 * - Sincronización diaria de métricas de Meta (Facebook/Instagram)
 * - Validación periódica de tokens de acceso
 * - Limpieza de datos antiguos
 * - Verificación de salud del sistema
 * 
 * @author Manus AI
 * @version 1.0.0 - ENV CONFIG
 * @date 2025-07-27
 */

const cron = require('node-cron');
const axios = require('axios');
const { Op } = require('sequelize');

// Importar modelos
const {
  ClinicMetaAsset,
  MetaConecction, // Nota: usando el nombre correcto con doble 'c'
  SocialStatDaily,
  SocialPost,
  SocialPostStatDaily,
  SyncLog,
  TokenValidation
} = require('../../models');

class MetaSyncJobs {
  constructor() {
    this.jobs = new Map();
    this.isInitialized = false;
    this.isRunning = false;
    
    // Configuración desde variables de entorno
    this.config = {
      schedules: {
        metricsSync: process.env.JOBS_METRICS_SCHEDULE || '0 2 * * *',
        tokenValidation: process.env.JOBS_TOKEN_VALIDATION_SCHEDULE || '0 */6 * * *',
        dataCleanup: process.env.JOBS_CLEANUP_SCHEDULE || '0 3 * * 0',
        healthCheck: process.env.JOBS_HEALTH_CHECK_SCHEDULE || '0 * * * *'
      },
      timezone: process.env.JOBS_TIMEZONE || 'Europe/Madrid',
      autoStart: process.env.JOBS_AUTO_START === 'true',
      dataRetention: {
        syncLogs: parseInt(process.env.JOBS_SYNC_LOGS_RETENTION) || 90,
        tokenValidations: parseInt(process.env.JOBS_TOKEN_VALIDATIONS_RETENTION) || 30,
        socialStats: parseInt(process.env.JOBS_SOCIAL_STATS_RETENTION) || 730
      },
      retries: {
        maxAttempts: parseInt(process.env.JOBS_MAX_RETRIES) || 3,
        delayMs: parseInt(process.env.JOBS_RETRY_DELAY) || 5000
      }
    };

    console.log('🔧 Configuración de Jobs cargada desde .env:');
    console.log(`  - Timezone: ${this.config.timezone}`);
    console.log(`  - Auto Start: ${this.config.autoStart}`);
    console.log('  - Horarios:');
    for (const [name, schedule] of Object.entries(this.config.schedules)) {
      console.log(`    ${name}: ${schedule}`);
    }
  }

  /**
   * Inicializa el sistema de jobs
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('⚠️ Sistema de jobs ya está inicializado');
      return { status: 'already_initialized' };
    }

    try {
      console.log('🚀 Inicializando Sistema de Jobs Cron...');
      
      // Registrar jobs con configuraciones del .env
      this.registerJob('metricsSync', this.config.schedules.metricsSync, () => this.executeMetricsSync());
      this.registerJob('tokenValidation', this.config.schedules.tokenValidation, () => this.executeTokenValidation());
      this.registerJob('dataCleanup', this.config.schedules.dataCleanup, () => this.executeDataCleanup());
      this.registerJob('healthCheck', this.config.schedules.healthCheck, () => this.executeHealthCheck());

      this.isInitialized = true;
      
      console.log('✅ Sistema de Jobs Cron inicializado correctamente');
      console.log(`📊 Jobs registrados: ${this.jobs.size}`);
      console.log(`🌍 Timezone configurado: ${this.config.timezone}`);
      console.log('\n📅 Próximas ejecuciones programadas:');
      
      for (const [name, schedule] of Object.entries(this.config.schedules)) {
        console.log(`  ${name}: ${schedule}`);
      }

      return {
        status: 'initialized',
        jobsCount: this.jobs.size,
        jobs: Object.fromEntries(this.jobs),
        config: {
          timezone: this.config.timezone,
          autoStart: this.config.autoStart
        }
      };
    } catch (error) {
      console.error('❌ Error al inicializar sistema de jobs:', error);
      throw error;
    }
  }

  /**
   * Registra un job con su programación
   */
  registerJob(name, schedule, handler) {
    const job = cron.schedule(schedule, async () => {
      await this.executeWithRetry(name, handler);
    }, {
      scheduled: false,
      timezone: this.config.timezone // Usar timezone del .env
    });

    this.jobs.set(name, {
      job,
      schedule,
      handler,
      lastExecution: null,
      status: 'registered'
    });

    console.log(`📝 Job '${name}' registrado con programación: ${schedule} (${this.config.timezone})`);
  }

  /**
   * Inicia todos los jobs
   */
  start() {
    if (!this.isInitialized) {
      throw new Error('Sistema de jobs no está inicializado');
    }

    if (this.isRunning) {
      console.log('⚠️ Los jobs ya están en ejecución');
      return { status: 'already_running' };
    }

    console.log('\n🚀 Iniciando todos los jobs...');
    
    for (const [name, jobData] of this.jobs) {
      jobData.job.start();
      jobData.status = 'running';
      console.log(`▶️ Job '${name}' iniciado`);
    }

    this.isRunning = true;
    console.log('🚀 Todos los jobs han sido iniciados');
    
    return {
      status: 'started',
      jobsCount: this.jobs.size
    };
  }

  /**
   * Detiene todos los jobs
   */
  stop() {
    if (!this.isRunning) {
      console.log('⚠️ Los jobs no están en ejecución');
      return { status: 'already_stopped' };
    }

    console.log('🛑 Deteniendo todos los jobs...');
    
    for (const [name, jobData] of this.jobs) {
      jobData.job.stop();
      jobData.status = 'stopped';
      console.log(`⏹️ Job '${name}' detenido`);
    }

    this.isRunning = false;
    console.log('🛑 Todos los jobs han sido detenidos');
    
    return {
      status: 'stopped',
      jobsCount: this.jobs.size
    };
  }

  /**
   * Reinicia el sistema de jobs
   */
  restart() {
    console.log('🔄 Reiniciando sistema de jobs...');
    this.stop();
    return this.start();
  }

  /**
   * Ejecuta un job con sistema de reintentos
   */
  async executeWithRetry(jobName, handler) {
    const maxAttempts = this.config.retries.maxAttempts;
    const delay = this.config.retries.delayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`🔄 Ejecutando job '${jobName}' (intento ${attempt}/${maxAttempts})`);
        
        const result = await handler();
        
        // Actualizar información del job
        const jobData = this.jobs.get(jobName);
        if (jobData) {
          jobData.lastExecution = new Date();
          jobData.status = 'completed';
        }

        console.log(`✅ Job '${jobName}' completado exitosamente`);
        return result;
        
      } catch (error) {
        console.error(`❌ Error en job '${jobName}' (intento ${attempt}/${maxAttempts}):`, error.message);
        
        if (attempt === maxAttempts) {
          // Actualizar estado del job como fallido
          const jobData = this.jobs.get(jobName);
          if (jobData) {
            jobData.lastExecution = new Date();
            jobData.status = 'failed';
            jobData.lastError = error.message;
          }
          
          throw error;
        }
        
        // Esperar antes del siguiente intento
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      }
    }
  }

  /**
   * Ejecuta job manualmente
   */
  async runJob(jobName) {
    if (!this.jobs.has(jobName)) {
      throw new Error(`Job '${jobName}' no encontrado`);
    }

    const jobData = this.jobs.get(jobName);
    console.log(`🔄 Ejecutando job '${jobName}' manualmente...`);
    
    try {
      const result = await jobData.handler();
      
      jobData.lastExecution = new Date();
      jobData.status = 'completed';
      
      console.log(`✅ Job '${jobName}' ejecutado correctamente`);
      return result;
      
    } catch (error) {
      jobData.lastExecution = new Date();
      jobData.status = 'failed';
      jobData.lastError = error.message;
      
      console.error(`❌ Error al ejecutar job '${jobName}':`, error);
      throw error;
    }
  }

  /**
   * Job: Sincronización de métricas de Meta
   */
  async executeMetricsSync() {
    console.log('📊 Iniciando sincronización de métricas de Meta...');
    
    const syncLog = await SyncLog.create({
      job_type: 'automated_metrics_sync',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      // Obtener assets activos con tokens válidos
      const assets = await ClinicMetaAsset.findAll({
        where: {
          isActive: true,
          pageAccessToken: { [Op.not]: null }
        }
      });

      console.log(`📋 Encontrados ${assets.length} assets activos para sincronizar`);
      
      let processedCount = 0;
      let errorCount = 0;

      for (const asset of assets) {
        try {
          console.log(`🔄 Procesando asset ${asset.id} (${asset.assetType})`);
          
          await this.syncAssetMetrics(asset);
          processedCount++;
          
          // Delay entre assets para respetar rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));
          
        } catch (error) {
          console.error(`❌ Error procesando asset ${asset.id}:`, error.message);
          errorCount++;
        }
      }

      // Actualizar log de sincronización
      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: processedCount,
        error_message: errorCount > 0 ? `${errorCount} errores encontrados` : null
      });

      console.log(`✅ Sincronización completada: ${processedCount} assets procesados, ${errorCount} errores`);
      
      return {
        status: 'completed',
        processed: processedCount,
        errors: errorCount
      };

    } catch (error) {
      await syncLog.update({
        status: 'failed',
        end_time: new Date(),
        error_message: error.message
      });

      throw error;
    }
  }

  /**
   * Sincroniza métricas de un asset específico
   */
  async syncAssetMetrics(asset) {
    const { assetType, metaAssetId, pageAccessToken } = asset;
    
    if (assetType === 'facebook_page') {
      await this.syncFacebookPageMetrics(asset);
    } else if (assetType === 'instagram_business') {
      await this.syncInstagramMetrics(asset);
    }
  }

  /**
   * Sincroniza métricas de página de Facebook
   */
  async syncFacebookPageMetrics(asset) {
    const { metaAssetId, pageAccessToken, clinicaId } = asset;
    const today = new Date().toISOString().split('T')[0];
    
    try {
      // Obtener métricas de la página
      const metricsResponse = await axios.get(
        `https://graph.facebook.com/v18.0/${metaAssetId}/insights`,
        {
          params: {
            metric: 'page_fans,page_fan_adds,page_fan_removes,page_views_total,page_post_engagements,page_posts_impressions,page_posts_impressions_unique',
            period: 'day',
            since: today,
            until: today,
            access_token: pageAccessToken
          }
        }
      );

      const metrics = metricsResponse.data.data;
      
      // Procesar y almacenar métricas
      for (const metric of metrics) {
        if (metric.values && metric.values.length > 0) {
          const value = metric.values[0].value || 0;
          
          await SocialStatDaily.upsert({
            clinica_id: clinicaId,
            asset_id: asset.id,
            asset_type: 'facebook_page',
            date: today,
            metric_name: metric.name,
            metric_value: value,
            created_at: new Date(),
            updated_at: new Date()
          });
        }
      }

      console.log(`✅ Métricas de Facebook sincronizadas para asset ${asset.id}`);
      
    } catch (error) {
      console.error(`❌ Error sincronizando Facebook asset ${asset.id}:`, error.message);
      throw error;
    }
  }

  /**
   * Sincroniza métricas de Instagram Business
   */
  async syncInstagramMetrics(asset) {
    const { metaAssetId, pageAccessToken, clinicaId } = asset;
    const today = new Date().toISOString().split('T')[0];
    
    try {
      // Obtener métricas de Instagram Business
      const metricsResponse = await axios.get(
        `https://graph.facebook.com/v18.0/${metaAssetId}/insights`,
        {
          params: {
            metric: 'follower_count,impressions,reach,profile_views,website_clicks',
            period: 'day',
            since: today,
            until: today,
            access_token: pageAccessToken
          }
        }
      );

      const metrics = metricsResponse.data.data;
      
      // Procesar y almacenar métricas
      for (const metric of metrics) {
        if (metric.values && metric.values.length > 0) {
          const value = metric.values[0].value || 0;
          
          await SocialStatDaily.upsert({
            clinica_id: clinicaId,
            asset_id: asset.id,
            asset_type: 'instagram_business',
            date: today,
            metric_name: metric.name,
            metric_value: value,
            created_at: new Date(),
            updated_at: new Date()
          });
        }
      }

      console.log(`✅ Métricas de Instagram sincronizadas para asset ${asset.id}`);
      
    } catch (error) {
      console.error(`❌ Error sincronizando Instagram asset ${asset.id}:`, error.message);
      throw error;
    }
  }

  /**
   * Job: Validación de tokens de acceso
   */
  async executeTokenValidation() {
    console.log('🔐 Iniciando validación de tokens de acceso...');
    
    const syncLog = await SyncLog.create({
      job_type: 'token_validation',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      // Obtener todos los assets con tokens
      const assets = await ClinicMetaAsset.findAll({
        where: {
          pageAccessToken: { [Op.not]: null }
        }
      });

      console.log(`🔍 Validando ${assets.length} tokens...`);
      
      let validCount = 0;
      let invalidCount = 0;

      for (const asset of assets) {
        try {
          const isValid = await this.validateToken(asset.pageAccessToken, asset.metaAssetId);
          
          // Registrar resultado de validación
          await TokenValidation.create({
            asset_id: asset.id,
            token_valid: isValid,
            validated_at: new Date(),
            error_message: isValid ? null : 'Token inválido o expirado'
          });

          if (isValid) {
            validCount++;
          } else {
            invalidCount++;
            console.log(`⚠️ Token inválido para asset ${asset.id}`);
          }
          
          // Delay entre validaciones
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          console.error(`❌ Error validando token para asset ${asset.id}:`, error.message);
          invalidCount++;
        }
      }

      // Actualizar log
      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: assets.length,
        error_message: invalidCount > 0 ? `${invalidCount} tokens inválidos` : null
      });

      console.log(`✅ Validación completada: ${validCount} válidos, ${invalidCount} inválidos`);
      
      return {
        status: 'completed',
        valid: validCount,
        invalid: invalidCount
      };

    } catch (error) {
      await syncLog.update({
        status: 'failed',
        end_time: new Date(),
        error_message: error.message
      });

      throw error;
    }
  }

  /**
   * Valida un token de acceso específico
   */
  async validateToken(token, assetId) {
    try {
      const response = await axios.get(
        `https://graph.facebook.com/v18.0/${assetId}`,
        {
          params: {
            fields: 'id,name',
            access_token: token
          },
          timeout: 10000
        }
      );

      return response.status === 200 && response.data.id;
      
    } catch (error) {
      console.error(`❌ Token inválido para asset ${assetId}:`, error.message);
      return false;
    }
  }

  /**
   * Job: Limpieza de datos antiguos
   */
  async executeDataCleanup() {
    console.log('🧹 Iniciando limpieza de datos antiguos...');
    
    const syncLog = await SyncLog.create({
      job_type: 'data_cleanup',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      let totalDeleted = 0;
      
      // Limpiar logs de sincronización antiguos
      const syncLogsDeleted = await this.cleanupSyncLogs();
      totalDeleted += syncLogsDeleted;
      
      // Limpiar validaciones de tokens antiguas
      const tokenValidationsDeleted = await this.cleanupTokenValidations();
      totalDeleted += tokenValidationsDeleted;
      
      // Limpiar métricas sociales muy antiguas (opcional)
      const socialStatsDeleted = await this.cleanupOldSocialStats();
      totalDeleted += socialStatsDeleted;

      // Actualizar log
      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: totalDeleted
      });

      console.log(`✅ Limpieza completada: ${totalDeleted} registros eliminados`);
      
      return {
        status: 'completed',
        deleted: totalDeleted,
        breakdown: {
          syncLogs: syncLogsDeleted,
          tokenValidations: tokenValidationsDeleted,
          socialStats: socialStatsDeleted
        }
      };

    } catch (error) {
      await syncLog.update({
        status: 'failed',
        end_time: new Date(),
        error_message: error.message
      });

      throw error;
    }
  }

  /**
   * Limpia logs de sincronización antiguos
   */
  async cleanupSyncLogs() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.dataRetention.syncLogs);
    
    const deleted = await SyncLog.destroy({
      where: {
        created_at: { [Op.lt]: cutoffDate }
      }
    });

    console.log(`🗑️ Eliminados ${deleted} logs de sincronización antiguos (>${this.config.dataRetention.syncLogs} días)`);
    return deleted;
  }

  /**
   * Limpia validaciones de tokens antiguas
   */
  async cleanupTokenValidations() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.dataRetention.tokenValidations);
    
    const deleted = await TokenValidation.destroy({
      where: {
        created_at: { [Op.lt]: cutoffDate }
      }
    });

    console.log(`🗑️ Eliminadas ${deleted} validaciones de tokens antiguas (>${this.config.dataRetention.tokenValidations} días)`);
    return deleted;
  }

  /**
   * Limpia métricas sociales muy antiguas
   */
  async cleanupOldSocialStats() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.dataRetention.socialStats);
    
    const deleted = await SocialStatDaily.destroy({
      where: {
        created_at: { [Op.lt]: cutoffDate }
      }
    });

    console.log(`🗑️ Eliminadas ${deleted} métricas sociales antiguas (>${this.config.dataRetention.socialStats} días)`);
    return deleted;
  }

  /**
   * Job: Verificación de salud del sistema
   */
  async executeHealthCheck() {
    console.log('🏥 Ejecutando verificación de salud del sistema...');
    
    const syncLog = await SyncLog.create({
      job_type: 'health_check',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      const healthStatus = {
        database: false,
        metaApi: false,
        activeConnections: 0,
        validTokens: 0,
        recentActivity: false
      };

      // Verificar conectividad de base de datos
      try {
        await SyncLog.findOne({ limit: 1 });
        healthStatus.database = true;
        console.log('✅ Base de datos: Conectada');
      } catch (error) {
        console.error('❌ Base de datos: Error de conexión');
        throw new Error('Database connection failed');
      }

      // Verificar conexiones activas
      try {
        const activeAssets = await ClinicMetaAsset.findAll({
          where: {
            pageAccessToken: { [Op.not]: null }
          }
        });
        healthStatus.activeConnections = activeAssets.length;
        console.log(`✅ Conexiones activas: ${activeAssets.length}`);
      } catch (error) {
        console.error('❌ Error verificando conexiones activas:', error);
      }

      // Verificar disponibilidad de Meta API (prueba simple)
      try {
        const testResponse = await axios.get('https://graph.facebook.com/v18.0/', {
          timeout: 5000
        });
        healthStatus.metaApi = testResponse.status === 200;
        console.log('✅ Meta API: Disponible');
      } catch (error) {
        console.error('❌ Meta API: No disponible');
      }

      // Verificar actividad reciente
      try {
        const recentLogs = await SyncLog.findAll({
          where: {
            created_at: { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          },
          limit: 1
        });
        healthStatus.recentActivity = recentLogs.length > 0;
        console.log(`✅ Actividad reciente: ${healthStatus.recentActivity ? 'Sí' : 'No'}`);
      } catch (error) {
        console.error('❌ Error verificando actividad reciente:', error);
      }

      // Actualizar log
      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: 1,
        error_message: JSON.stringify(healthStatus)
      });

      console.log('✅ Verificación de salud completada');
      
      return {
        status: 'completed',
        health: healthStatus
      };

    } catch (error) {
      console.error('❌ Error en verificación de salud:', error);
      
      await syncLog.update({
        status: 'failed',
        end_time: new Date(),
        error_message: error.message
      });

      throw error;
    }
  }

  /**
   * Obtiene el estado actual del sistema
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      running: this.isRunning,
      jobsCount: this.jobs.size,
      config: {
        timezone: this.config.timezone,
        autoStart: this.config.autoStart,
        schedules: this.config.schedules
      },
      jobs: Object.fromEntries(
        Array.from(this.jobs.entries()).map(([name, data]) => [
          name,
          {
            schedule: data.schedule,
            status: data.status,
            lastExecution: data.lastExecution,
            lastError: data.lastError
          }
        ])
      )
    };
  }

  /**
   * Obtiene la configuración actual
   */
  getConfiguration() {
    return {
      schedules: this.config.schedules,
      timezone: this.config.timezone,
      autoStart: this.config.autoStart,
      dataRetention: this.config.dataRetention,
      retries: this.config.retries
    };
  }
}

// Crear instancia singleton
const metaSyncJobs = new MetaSyncJobs();

module.exports = {
  metaSyncJobs,
  MetaSyncJobs
};

