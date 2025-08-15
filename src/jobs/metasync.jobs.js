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
const META_API_BASE_URL = process.env.META_API_BASE_URL || 'https://graph.facebook.com/v23.0';
const url = `${META_API_BASE_URL}/...`;

// Importar modelos
const {
  ClinicMetaAsset,
  SocialStatsDaily,
  SocialPosts,
  SocialPostStatDaily,
  SyncLog,
  TokenValidations,
  MetaConnection
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
  console.log('📊 Ejecutando sincronización de métricas...');
  
  const syncLog = await SyncLog.create({
    job_type: 'metrics_sync',
    status: 'running',
    start_time: new Date(),
    records_processed: 0
  });

  try {
    let totalProcessed = 0;
    const errors = [];

    // Obtener todos los assets activos con tokens
    const activeAssets = await ClinicMetaAsset.findAll({
      where: {
        isActive: true,
        pageAccessToken: { [Op.ne]: null }
      },
      include: [{
        model: MetaConnection,
        as: 'metaConnection',
        where: {
          accessToken: { [Op.ne]: null },
          expiresAt: { [Op.gt]: new Date() }
        }
      }]
    });

    console.log(`📋 Assets activos encontrados: ${activeAssets.length}`);

    for (const asset of activeAssets) {
      try {
        const processed = await this.syncAssetMetrics(asset);
        totalProcessed += processed;
        console.log(`✅ Asset ${asset.metaAssetName}: ${processed} métricas sincronizadas`);
      } catch (error) {
        console.error(`❌ Error sincronizando asset ${asset.metaAssetName}:`, error.message);
        errors.push(`${asset.metaAssetName}: ${error.message}`);
      }
    }

    // Actualizar log de sincronización
    await syncLog.update({
      status: 'completed',
      end_time: new Date(),
      records_processed: totalProcessed,
      status_report: JSON.stringify({
        assetsProcessed: activeAssets.length,
        totalMetrics: totalProcessed,
        errors: errors.length > 0 ? errors : null
      })
    });

    console.log(`✅ Sincronización completada: ${totalProcessed} métricas procesadas`);
    return { success: true, processed: totalProcessed };

  } catch (error) {
    console.error('❌ Error en sincronización de métricas:', error);
    
    await syncLog.update({
      status: 'failed',
      end_time: new Date(),
      error_message: error.message
    });

    throw error;
  }
}


  //  Usar la variable extraída:
async syncAssetMetrics(asset) {
  let processed = 0;

  switch (asset.assetType) {
    case 'facebook_page':
      processed = await this.syncFacebookPageMetrics(asset);
      break;
    
    case 'instagram_business':
      processed = await this.syncInstagramMetrics(asset);
      break;
    
    case 'ad_account':
      console.log(`ℹ️ Ad Account ${asset.metaAssetName}: Métricas de anuncios no implementadas aún`);
      processed = 0;
      break;
    
    default:
      console.log(`⚠️ Tipo de asset no soportado: ${asset.assetType}`);
      processed = 0;
  }

  return processed;
}

/**
 * Sincronizar métricas de Facebook Page
 * FUNCIÓN COMPLETA Y CORREGIDA - REEMPLAZAR COMPLETAMENTE
 */
async syncFacebookPageMetrics(asset) {
  console.log(`📘 Sincronizando métricas de Facebook: ${asset.metaAssetName}`);

  try {
    // Obtener número total de seguidores actuales
    const response = await axios.get(
      `${process.env.META_API_BASE_URL}/${asset.metaAssetId}`,
      {
        params: {
          fields: 'fan_count',
          access_token: asset.pageAccessToken
        }
      }
    );

    const fanCount = response.data?.fan_count;
    if (fanCount === undefined) {
      throw new Error('Respuesta de API inválida al obtener fan_count');
    }

    const date = new Date();
    date.setHours(0, 0, 0, 0);

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

    await SocialStatsDaily.upsert({
      clinica_id: asset.clinicaId,
      asset_id: asset.id,
      asset_type: 'facebook_page',
      date: date.toISOString().split('T')[0],
      followers: fanCount,
      followers_day: followersDay
    });

    console.log(`✅ Facebook ${asset.metaAssetName}: métricas guardadas`);
    return 1;

  } catch (error) {
    console.error(`❌ Error sincronizando Facebook ${asset.metaAssetName}:`, error.message);
    console.error(`🔍 DEBUG: Error completo:`, error.response?.data || error);
    throw error;
  }
}




  /**
   * Sincroniza métricas de Instagram Business
   */
  async syncInstagramMetrics(asset) {
  console.log(`📷 Sincronizando métricas de Instagram: ${asset.metaAssetName}`);

  try {
    const until = Math.floor(Date.now() / 1000);
    const since = until - 30 * 24 * 60 * 60; // últimos 30 días

    // Variación diaria de seguidores
    const followersDayResp = await axios.get(
      `${process.env.META_API_BASE_URL}/${asset.metaAssetId}/insights`,
      {
        params: {
          metric: 'follower_count',
          metric_type: 'time_series',
          period: 'day',
          since,
          until,
          access_token: asset.pageAccessToken
        }
      }
    );

    const statsByDate = {};
    const followerValues = followersDayResp.data?.data?.[0]?.values || [];
    for (const value of followerValues) {
      const date = new Date(value.end_time);
      date.setHours(0, 0, 0, 0);
      const dateStr = date.toISOString().split('T')[0];

      statsByDate[dateStr] = {
        asset_id: asset.id,
        clinica_id: asset.clinicaId,
        asset_type: 'instagram_business',
        date: dateStr,
        followers_day: value.value || 0
      };
    }

    // Total actual de seguidores
    const followersTotalResp = await axios.get(
      `${process.env.META_API_BASE_URL}/${asset.metaAssetId}/insights`,
      {
        params: {
          metric: 'followers_count',
          metric_type: 'total_value',
          period: 'day',
          access_token: asset.pageAccessToken
        }
      }
    );

    const currentFollowers = followersTotalResp.data?.data?.[0]?.values?.[0]?.value || 0;

    const dates = Object.keys(statsByDate).sort();
    let runningTotal = currentFollowers;
    for (let i = dates.length - 1; i >= 0; i--) {
      const dateStr = dates[i];
      statsByDate[dateStr].followers = runningTotal;
      runningTotal -= statsByDate[dateStr].followers_day || 0;
    }

    let processed = 0;
    for (const dateStr of dates) {
      await SocialStatsDaily.upsert(statsByDate[dateStr]);
      processed++;
    }

    console.log(`✅ Instagram ${asset.metaAssetName}: ${processed} métricas guardadas`);
    return processed;

  } catch (error) {
    console.error(`❌ Error sincronizando Instagram ${asset.metaAssetName}:`, error.message);
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
        `${META_API_BASE_URL}/${assetId}`,
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
    
    const deleted = await SocialStatsDaily.destroy({
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
      const activeConnections = await MetaConnection.count({
        where: {
          accessToken: { [Op.ne]: null },
          expiresAt: { [Op.gt]: new Date() }  // No expirado
        }
      });
      healthStatus.activeConnections = activeConnections;
      console.log(`✅ Conexiones activas: ${activeConnections}`); 
    } catch (error) {
      console.error('❌ Error verificando conexiones activas:', error);
    }

    // Verificar disponibilidad de Meta API (prueba simple)
    // ✅ CORRECTO (usar token real):
    try {
      const connection = await MetaConnection.findOne({
        where: {
          accessToken: { [Op.ne]: null },
          expiresAt: { [Op.gt]: new Date() }
        }
      });

      if (connection && connection.accessToken) {
        const testResponse = await axios.get(`${META_API_BASE_URL}/me`, {
          params: { access_token: connection.accessToken },
          timeout: 5000
        });
        healthStatus.metaApi = testResponse.status === 200;
        console.log('✅ Meta API: Disponible');
      } else {
        healthStatus.metaApi = false;
        console.log('❌ Meta API: Sin tokens válidos');
      }
    } catch (error) {
      console.error('❌ Meta API: Error -', error.message);
      healthStatus.metaApi = false;
    }

    // Verificar tokens válidos
    // Verificar tokens válidos (incluir tokens de página permanentes)
try {
  // Contar tokens de página permanentes (más importantes)
  const pageTokens = await ClinicMetaAsset.count({
    where: {
      pageAccessToken: { [Op.ne]: null },
      isActive: true
    }
  });

  // Contar validaciones recientes de tokens de usuario
  const recentValidations = await TokenValidations.count({
    where: {
      status: 'valid',
      validation_date: { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }
  });

  // Total de tokens válidos (página + validaciones recientes)
  const totalValidTokens = pageTokens + recentValidations;
  
  healthStatus.validTokens = totalValidTokens;
  console.log(`✅ Tokens válidos: ${totalValidTokens} (${pageTokens} de página + ${recentValidations} validaciones)`);
} catch (error) {
  console.error('❌ Error verificando tokens válidos:', error);
  healthStatus.validTokens = 0;
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

    // ✅ CORREGIDO: Usar status_report para health status
    await syncLog.update({
      status: 'completed',
      end_time: new Date(),
      records_processed: 1,
      status_report: healthStatus  // ✅ Usar el nuevo campo
    });

    console.log('✅ Verificación de salud completada');
    
    return {
      status: 'completed',
      health: healthStatus
    };

  } catch (error) {
    console.error('❌ Error en verificación de salud:', error);
    
    // ✅ CORREGIDO: error_message solo para errores reales
    await syncLog.update({
      status: 'failed',
      end_time: new Date(),
      error_message: error.message  // ✅ Solo errores reales aquí
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

