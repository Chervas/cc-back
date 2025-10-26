/**
 * Controlador para Gestión de Jobs Cron de Sincronización de Métricas
 * ClinicaClick - Versión Final (Sin Referencias Circulares)
 * 
 * Este controlador proporciona endpoints para:
 * - Inicializar y gestionar jobs cron
 * - Monitorear el estado de los jobs
 * - Ejecutar jobs manualmente
 * - Obtener estadísticas de ejecución
 * 
 * @author Manus AI
 * @version 1.0.0 - FINAL
 * @date 2025-07-27
 */

const { metaSyncJobs } = require('../jobs/sync.jobs');
const { getUsageStatus } = require('../lib/metaClient');
const { getGoogleAdsUsageStatus, resumeGoogleAdsUsage } = require('../lib/googleAdsClient');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');
const fs = require('fs');
const path = require('path');
const { SyncLog, TokenValidation, SocialStatDaily, ApiUsageCounter } = require('../../models');
const { Op } = require('sequelize');

const JOB_NAME_TO_QUEUE_TYPE = {
  adsSync: 'meta_ads_recent',
  adsSyncMidday: 'meta_ads_midday',
  adsBackfill: 'meta_ads_backfill',
  googleAdsSync: 'google_ads_recent',
  googleAdsBackfill: 'google_ads_backfill',
  analyticsSync: 'analytics_recent',
  analyticsBackfill: 'analytics_backfill',
  webSync: 'web_recent',
  webBackfill: 'web_backfill'
};

/**
 * Inicializar el sistema de jobs cron
 */
exports.initializeJobs = async (req, res) => {
  try {
    console.log('🚀 Solicitud de inicialización de jobs recibida');
    
    // Verificar si ya están inicializados
    if (metaSyncJobs.isRunning) {
      return res.json({
        message: 'Sistema de jobs ya está inicializado',
        status: 'already_running',
        jobsCount: metaSyncJobs.jobs.size,
        jobs: getJobsSafeInfo() // CORREGIDO: usar función segura
      });
    }

    // Inicializar el sistema
    const result = await metaSyncJobs.initialize();
    
    // Iniciar automáticamente
    metaSyncJobs.start();
    
    res.json({
      message: 'Sistema de jobs inicializado y iniciado correctamente',
      status: result.status,
      jobsCount: result.jobsCount,
      jobs: getJobsSafeInfo() // CORREGIDO: usar función segura
    });

  } catch (error) {
    console.error('❌ Error al inicializar jobs:', error);
    res.status(500).json({
      message: 'Error al inicializar sistema de jobs',
    });
  }
};

/**
 * Función auxiliar para obtener información segura de jobs (sin referencias circulares)
 */
function getJobsSafeInfo() {
  const safeJobs = {};
  
  for (const [name, jobData] of metaSyncJobs.jobs) {
    safeJobs[name] = {
      schedule: jobData.schedule,
      status: jobData.status,
      lastExecution: jobData.lastExecution,
      lastError: jobData.lastError || null,
      description: metaSyncJobs.jobDescriptions?.[name] || ''
    };
  }
  
  return safeJobs;
}

/**
 * Obtener estado actual de los jobs
 */
exports.getJobsStatus = async (req, res) => {
  try {
    // Obtener estado básico del sistema
    const systemStatus = metaSyncJobs.getStatus();
    
    // Obtener estadísticas del día actual
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Obtener logs recientes - CORREGIDO: usar job_type en lugar de syncType
    const recentLogs = await SyncLog.findAll({
      attributes: ['id','job_type', 'status', 'start_time', 'end_time', 'records_processed', 'error_message', 'status_report'],
      where: {
        job_type: {
          [Op.in]: ['automated_metrics_sync', 'manual_job_execution', 'health_check', 'token_validation', 'data_cleanup', 'ads_sync', 'ads_sync_midday', 'ads_backfill', 'web_sync', 'web_backfill', 'analytics_sync', 'analytics_backfill']
        }
      },
      order: [['created_at', 'DESC']],
      limit: 10
    });

    // Obtener estadísticas del día - CORREGIDO: manejar posibles errores
    let todayStats = {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0
    };

    try {
      const todayExecutions = await SyncLog.count({
        where: {
          created_at: { [Op.gte]: today }
        }
      });
      
      const todaySuccessful = await SyncLog.count({
        where: {
          created_at: { [Op.gte]: today },
          status: 'completed'
        }
      });

      const todayFailed = await SyncLog.count({
        where: {
          created_at: { [Op.gte]: today },
          status: 'failed'
        }
      });

      todayStats = {
        totalExecutions: todayExecutions || 0,
        successfulExecutions: todaySuccessful || 0,
        failedExecutions: todayFailed || 0
      };
    } catch (statsError) {
      console.error('⚠️ Error obteniendo estadísticas del día:', statsError.message);
      // Mantener valores por defecto
    }

    // Exponer uso de Meta y estado de espera (waiting)
    const metaUsage = await getUsageStatus();
    const googleUsage = await getGoogleAdsUsageStatus();
    const googleWaiting = googleUsage && googleUsage.pauseUntil && googleUsage.pauseUntil > Date.now();
    const jobsBase = getJobsSafeInfo();
    const jobsView = {};
    Object.keys(jobsBase).forEach((name) => {
      const j = jobsBase[name];
      let effectiveStatus = j.status;
      if (metaUsage.waiting && j.status === 'running' && name.startsWith('ads')) {
        effectiveStatus = 'waiting';
      }
      if (googleWaiting && j.status === 'running' && name.startsWith('googleAds')) {
        effectiveStatus = 'waiting';
      }
      jobsView[name] = { ...j, status: effectiveStatus };
    });

    res.json({
      systemRunning: systemStatus.running,
      systemInitialized: systemStatus.initialized,
      jobsCount: systemStatus.jobsCount,
      jobs: jobsView, // incluye description y estado efectivo
      metaUsage: {
        usagePct: metaUsage.usagePct || 0,
        waiting: !!metaUsage.waiting,
        nextAllowedAt: metaUsage.nextAllowedAt || 0,
        now: metaUsage.now || Date.now()
      },
      googleAdsUsage: {
        usagePct: googleUsage?.usagePct || 0,
        requestCount: googleUsage?.requestCount || 0,
        quota: googleUsage?.quota || 0,
        resetAt: googleUsage?.resetAt || 0,
        pauseUntil: googleUsage?.pauseUntil || 0,
        now: googleUsage?.now || Date.now()
      },
      jobDescriptions: metaSyncJobs.jobDescriptions,
      todayStats,
      recentLogs: recentLogs.map(log => ({
        id: log.id,
        jobType: log.job_type,
        status: log.status,
        startedAt: log.start_time,
        completedAt: log.end_time,
        recordsProcessed: log.records_processed,
        errorMessage: log.error_message,
        statusReport: (() => { try { return JSON.parse(log.status_report || '{}'); } catch { return {}; } })()
      }))
    });

  } catch (error) {
    console.error('❌ Error al obtener estado de jobs:', error);
    res.status(500).json({
      message: 'Error al obtener estado de jobs',
      error: error.message
    });
  }
};

/**
 * Uso actual de la API de Meta (para gauge de carga)
 */
exports.getMetaUsageStatus = async (req, res) => {
  try {
    const s = await getUsageStatus();
    const metaCounter = await ApiUsageCounter.findOne({ where: { provider: 'meta_ads' } });
    res.json({
      usagePct: s.usagePct || 0,
      nextAllowedAt: s.nextAllowedAt || 0,
      now: s.now || Date.now(),
      waiting: (s.nextAllowedAt || 0) > Date.now(),
      lastUpdatedAt: metaCounter?.updated_at || null
    });
  } catch (e) {
    console.error('❌ Error getMetaUsageStatus:', e);
    res.status(500).json({ message: 'Error obteniendo uso Meta', error: e.message });
  }
};

exports.getGoogleUsageStatus = async (req, res) => {
  try {
    const s = await getGoogleAdsUsageStatus();
    const googleCounter = await ApiUsageCounter.findOne({ where: { provider: 'google_ads' } });
    res.json({
      usagePct: s?.usagePct || 0,
      requestCount: s?.requestCount || googleCounter?.requestCount || 0,
      quota: s?.quota || 0,
      resetAt: s?.resetAt || 0,
      pauseUntil: s?.pauseUntil || googleCounter?.pauseUntil?.getTime?.() || 0,
      now: s?.now || Date.now(),
      waiting: !!(s?.pauseUntil && s.pauseUntil > Date.now()),
      lastUpdatedAt: googleCounter?.updated_at || null
    });
  } catch (e) {
    console.error('❌ Error getGoogleUsageStatus:', e);
    res.status(500).json({ message: 'Error obteniendo uso Google Ads', error: e.message });
  }
};

exports.resumeGoogleUsage = async (req, res) => {
  try {
    await resumeGoogleAdsUsage();
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Error resumeGoogleUsage:', e);
    res.status(500).json({ message: 'Error reactivando Google Ads', error: e.message });
  }
};

/**
 * Tail simple del log del proceso (o log asociado a un SyncLog si se provee ruta)
 * GET /jobs/sync-logs/:id/tail?lines=500
 * Si no hay log específico, lee PM2_LOG_PATH/APP_LOG_PATH
 */
exports.tailJobLog = async (req, res) => {
  try {
    const lines = Math.min(parseInt(req.query.lines || '500', 10), 5000);
    const filter = String(req.query.filter || '').toLowerCase(); // 'important'
    const levelsParam = String(req.query.levels || '').toLowerCase(); // ej. 'warn,error'
    const wantLevels = levelsParam ? new Set(levelsParam.split(',').map(s => s.trim())) : null;
    const logPathFromEnv = process.env.PM2_LOG_PATH || process.env.APP_LOG_PATH || '';
    let filePath = logPathFromEnv;

    // Intentar obtener un log específico si más adelante guardamos log_path en SyncLogs.status_report
    const id = req.params.id ? parseInt(req.params.id, 10) : null;
    if (id) {
      try {
        const log = await SyncLog.findByPk(id);
        const sr = (() => { try { return JSON.parse(log?.status_report || '{}'); } catch { return {}; } })();
        if (sr.log_path && fs.existsSync(sr.log_path)) filePath = sr.log_path;
      } catch {}
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'No se encontró archivo de log. Configure PM2_LOG_PATH o APP_LOG_PATH.' });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const arr = content.split(/\r?\n/);
    const tail = arr.slice(-lines);
    // Clasificar niveles simples
    let items = tail.map((t) => ({
      level: /error|❌/i.test(t) ? 'error' : (/warn|⚠️/i.test(t) ? 'warn' : 'info'),
      line: t
    }));
    // Filtro de importancia: incluir sólo errores/avisos/acciones relevantes
    if (filter === 'important') {
      const actionRegex = /(📝|📢|▶️|📊|📆)/;
      items = items.filter(it => it.level !== 'info' ? true : actionRegex.test(it.line));
      // Excluir ruido de consultas automáticas
      items = items.filter(it => !/Executing \(default\): SELECT/.test(it.line));
    }
    if (wantLevels && wantLevels.size) {
      items = items.filter(it => wantLevels.has(it.level));
    }
    res.json({ filePath, lines: items.length, items });
  } catch (e) {
    console.error('❌ Error tailJobLog:', e);
    res.status(500).json({ message: 'Error leyendo log', error: e.message });
  }
};

/**
 * Iniciar todos los jobs
 */
exports.startJobs = async (req, res) => {
  try {
    const result = metaSyncJobs.start();
    
    res.json({
      message: 'Jobs iniciados correctamente',
      status: result.status,
      jobsCount: result.jobsCount
    });

  } catch (error) {
    console.error('❌ Error al iniciar jobs:', error);
    res.status(500).json({
      message: 'Error al iniciar jobs',
      error: error.message
    });
  }
};

/**
 * Detener todos los jobs
 */
exports.stopJobs = async (req, res) => {
  try {
    const result = metaSyncJobs.stop();
    
    res.json({
      message: 'Jobs detenidos correctamente',
      status: result.status,
      jobsCount: result.jobsCount
    });

  } catch (error) {
    console.error('❌ Error al detener jobs:', error);
    res.status(500).json({
      message: 'Error al detener jobs',
      error: error.message
    });
  }
};

/**
 * Reiniciar el sistema de jobs
 */
exports.restartJobs = async (req, res) => {
  try {
    const result = metaSyncJobs.restart();
    
    res.json({
      message: 'Jobs reiniciados correctamente',
      status: result.status,
      jobsCount: result.jobsCount
    });

  } catch (error) {
    console.error('❌ Error al reiniciar jobs:', error);
    res.status(500).json({
      message: 'Error al reiniciar jobs',
      error: error.message
    });
  }
};

/**
 * Ejecutar un job específico manualmente
 */
exports.runJob = async (req, res) => {
  try {
    const { jobName } = req.params;
    const userId = req.userData?.userId || null;
    const userRole = req.userData?.role || null;
    const userName = req.userData?.name || null;
    const queueType = JOB_NAME_TO_QUEUE_TYPE[jobName] || null;
    const payload = (req.body && typeof req.body.payload === 'object') ? req.body.payload : {};
    const priority = req.body?.priority || (queueType && queueType.includes('backfill') ? 'high' : 'normal');
    const runImmediately = Boolean(req.body?.runImmediately);

    if (queueType) {
      const jobRequest = await jobRequestsService.enqueueJobRequest({
        type: queueType,
        payload,
        priority,
        origin: `manual:${jobName}`,
        requestedBy: userId,
        requestedByName: userName,
        requestedByRole: userRole
      });

      if (runImmediately || jobRequest.priority === 'critical') {
        jobScheduler.triggerImmediate(jobRequest.id).catch((error) => {
          console.error(`❌ Error ejecutando job ${jobRequest.id} inmediatamente:`, error);
        });
      }

      return res.json({
        message: `Job '${jobName}' encolado`,
        jobName,
        jobRequest: {
          id: jobRequest.id,
          type: jobRequest.type,
          status: jobRequest.status,
          priority: jobRequest.priority,
          createdAt: jobRequest.created_at
        }
      });
    }

    console.log(`🔄 Ejecutando job '${jobName}' manualmente en modo directo por usuario ${userId}`);

    const syncLog = await SyncLog.create({
      job_type: 'manual_job_execution',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      const result = await metaSyncJobs.runJob(jobName);

      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: result?.processed || 1
      });

      res.json({
        message: `Job '${jobName}' ejecutado correctamente`,
        jobName,
        status: 'completed',
        executedAt: new Date(),
        syncLogId: syncLog.id,
        result
      });

    } catch (jobError) {
      await syncLog.update({
        status: 'failed',
        end_time: new Date(),
        error_message: jobError.message
      });

      throw jobError;
    }

  } catch (error) {
    console.error(`❌ Error ejecutando job '${req.params.jobName}':`, error);
    res.status(500).json({
      message: `Error al ejecutar job '${req.params.jobName}'`,
      error: error.message
    });
  }
};

/**
 * Ejecutar un backfill web acotado a los sitios recién mapeados
 */
exports.runTargetedWebBackfill = async (req, res) => {
  try {
    const mappings = Array.isArray(req.body?.mappings)
      ? req.body.mappings
          .map((item) => ({
            clinicId: item?.clinicId ?? item?.clinicaId,
            siteUrl: item?.siteUrl
          }))
          .filter((item) => item.clinicId && item.siteUrl)
      : [];

    if (!mappings.length) {
      return res.status(400).json({
        success: false,
        message: 'Se necesita al menos un par { clinicId, siteUrl } en mappings.'
      });
    }

    const job = await jobRequestsService.enqueueJobRequest({
      type: 'web_backfill',
      payload: { mappings },
      priority: 'high',
      origin: 'web:targeted-backfill',
      requestedBy: req.userData?.userId || null
    });

    jobScheduler.triggerImmediate(job.id).catch((error) => {
      console.error('❌ Error ejecutando backfill dirigido de Search Console desde cola:', error);
    });

    return res.status(202).json({
      success: true,
      enqueued: mappings.length,
      jobRequestId: job.id,
      message: 'Backfill dirigido encolado'
    });
  } catch (error) {
    console.error('❌ Error al encolar backfill dirigido:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al encolar backfill dirigido',
      error: error.message
    });
  }
};


/**
 * Ejecutar un backfill dirigido de Google Analytics (GA4) tras un nuevo mapeo
 */
exports.runTargetedAnalyticsBackfill = async (req, res) => {
  try {
    const mappings = Array.isArray(req.body?.mappings)
      ? req.body.mappings
          .map((item) => ({
            clinicId: item?.clinicId ?? item?.clinicaId,
            propertyId: item?.propertyId ?? item?.id,
            propertyName: item?.propertyName ?? item?.name
          }))
          .filter((item) => item.clinicId && (item.propertyId || item.propertyName))
      : [];

    if (!mappings.length) {
      return res.status(400).json({
        success: false,
        message: 'Se necesita al menos un par { clinicId, propertyId|propertyName } en mappings.'
      });
    }

    const job = await jobRequestsService.enqueueJobRequest({
      type: 'analytics_backfill',
      payload: { mappings },
      priority: 'high',
      origin: 'analytics:targeted-backfill',
      requestedBy: req.userData?.userId || null
    });

    jobScheduler.triggerImmediate(job.id).catch((error) => {
      console.error('❌ Error ejecutando backfill dirigido de Analytics desde cola:', error);
    });

    return res.status(202).json({
      success: true,
      enqueued: mappings.length,
      jobRequestId: job.id,
      message: 'Backfill de Analytics encolado'
    });
  } catch (error) {
    console.error('❌ Error al encolar backfill de Analytics:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al encolar backfill de Analytics',
      error: error.message
    });
  }
};

/**
 * Obtener logs de ejecución con filtros
 */
exports.getJobsLogs = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      jobType,
      startDate,
      endDate
    } = req.query;

    // Construir filtros
    const where = {};
    
    if (status) {
      where.status = status;
    }
    
    if (jobType) {
      where.job_type = jobType;
    }
    
    if (startDate || endDate) {
      where.created_at = {};
      if (startDate) {
        where.created_at[Op.gte] = new Date(startDate);
      }
      if (endDate) {
        where.created_at[Op.lte] = new Date(endDate);
      }
    }

    // Obtener logs con paginación
    const offset = (page - 1) * limit;
    const { count, rows: logs } = await SyncLog.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      logs: logs.map(log => ({
        id: log.id,
        jobType: log.job_type,
        status: log.status,
        startedAt: log.start_time,
        completedAt: log.end_time,
        recordsProcessed: log.records_processed,
        errorMessage: log.error_message,
        createdAt: log.created_at
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(count / limit),
        totalItems: count,
        itemsPerPage: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('❌ Error obteniendo logs de jobs:', error);
    res.status(500).json({
      message: 'Error al obtener logs de jobs',
      error: error.message
    });
  }
};

/**
 * Obtener estadísticas de rendimiento
 */
exports.getJobsStatistics = async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    
    // Calcular fecha de inicio según el período
    const now = new Date();
    let startDate = new Date();
    
    switch (period) {
      case '24h':
        startDate.setHours(now.getHours() - 24);
        break;
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(now.getDate() - 90);
        break;
      default:
        startDate.setHours(now.getHours() - 24);
    }

    // Obtener estadísticas generales
    const totalExecutions = await SyncLog.count({
      where: {
        created_at: { [Op.gte]: startDate }
      }
    });

    const successfulExecutions = await SyncLog.count({
      where: {
        created_at: { [Op.gte]: startDate },
        status: 'completed'
      }
    });

    const failedExecutions = await SyncLog.count({
      where: {
        created_at: { [Op.gte]: startDate },
        status: 'failed'
      }
    });

    // Estadísticas por tipo de job
    const jobTypeStats = await SyncLog.findAll({
      attributes: [
        'job_type',
        [SyncLog.sequelize.fn('COUNT', SyncLog.sequelize.col('id')), 'count'],
        [SyncLog.sequelize.fn('AVG', SyncLog.sequelize.literal('TIMESTAMPDIFF(SECOND, start_time, end_time)')), 'avgDuration']
      ],
      where: {
        created_at: { [Op.gte]: startDate },
        end_time: { [Op.not]: null }
      },
      group: ['job_type'],
      raw: true
    });

    // Tendencia diaria (últimos 7 días)
    const dailyTrend = await SyncLog.findAll({
      attributes: [
        [SyncLog.sequelize.fn('DATE', SyncLog.sequelize.col('created_at')), 'date'],
        [SyncLog.sequelize.fn('COUNT', SyncLog.sequelize.col('id')), 'executions'],
        [SyncLog.sequelize.fn('SUM', SyncLog.sequelize.literal('CASE WHEN status = "completed" THEN 1 ELSE 0 END')), 'successful']
      ],
      where: {
        created_at: { [Op.gte]: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }
      },
      group: [SyncLog.sequelize.fn('DATE', SyncLog.sequelize.col('created_at'))],
      order: [[SyncLog.sequelize.fn('DATE', SyncLog.sequelize.col('created_at')), 'ASC']],
      raw: true
    });

    res.json({
      period,
      summary: {
        totalExecutions,
        successfulExecutions,
        failedExecutions,
        successRate: totalExecutions > 0 ? ((successfulExecutions / totalExecutions) * 100).toFixed(2) : 0
      },
      jobTypeStats: jobTypeStats.map(stat => ({
        jobType: stat.job_type,
        executions: parseInt(stat.count),
        avgDurationSeconds: stat.avgDuration ? parseFloat(stat.avgDuration).toFixed(2) : null
      })),
      dailyTrend: dailyTrend.map(day => ({
        date: day.date,
        executions: parseInt(day.executions),
        successful: parseInt(day.successful)
      }))
    });

  } catch (error) {
    console.error('❌ Error obteniendo estadísticas de jobs:', error);
    res.status(500).json({
      message: 'Error al obtener estadísticas de jobs',
      error: error.message
    });
  }
};

/**
 * Obtener configuración actual del sistema
 */
exports.getJobsConfiguration = async (req, res) => {
  try {
    const config = metaSyncJobs.getConfiguration();
    
    res.json({
      configuration: config,
      systemStatus: {
        initialized: metaSyncJobs.isInitialized,
        running: metaSyncJobs.isRunning,
        jobsCount: metaSyncJobs.jobs.size
      },
      jobDescriptions: metaSyncJobs.jobDescriptions
    });

  } catch (error) {
    console.error('❌ Error obteniendo configuración de jobs:', error);
    res.status(500).json({
      message: 'Error al obtener configuración de jobs',
      error: error.message
    });
  }
};

/**
 * Obtener próximas ejecuciones programadas
 */
exports.getNextExecutions = async (req, res) => {
  try {
    const config = metaSyncJobs.getConfiguration();
    
    const nextExecutions = {};
    
    for (const [jobName, schedule] of Object.entries(config.schedules)) {
      try {
        // Información básica de programación
        nextExecutions[jobName] = {
          schedule,
          description: getScheduleDescription(schedule),
          timezone: 'Europe/Madrid'
        };
      } catch (error) {
        nextExecutions[jobName] = {
          schedule,
          description: 'Error calculando descripción',
          timezone: 'Europe/Madrid'
        };
      }
    }

    res.json({
      nextExecutions,
      currentTime: new Date(),
      timezone: 'Europe/Madrid'
    });

  } catch (error) {
    console.error('❌ Error obteniendo próximas ejecuciones:', error);
    res.status(500).json({
      message: 'Error al obtener próximas ejecuciones',
      error: error.message
    });
  }
};

/**
 * Función auxiliar para describir horarios cron
 */
function getScheduleDescription(cronExpression) {
  const descriptions = {
    '0 2 * * *': 'Diariamente a las 2:00 AM',
    '0 */6 * * *': 'Cada 6 horas',
    '0 3 * * 0': 'Domingos a las 3:00 AM',
    '0 * * * *': 'Cada hora'
  };
  
  return descriptions[cronExpression] || `Programación personalizada: ${cronExpression}`;
}
