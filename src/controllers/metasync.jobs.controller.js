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

const { metaSyncJobs } = require('../jobs/metasync.jobs');
const { SyncLog, TokenValidation, SocialStatDaily } = require('../../models');
const { Op } = require('sequelize');

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
      error: error.message
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
      attributes: ['job_type', 'status', 'start_time', 'end_time', 'records_processed', 'error_message'],
      where: {
        job_type: {
          [Op.in]: ['automated_metrics_sync', 'manual_job_execution', 'health_check', 'token_validation', 'data_cleanup', 'ads_sync', 'ads_backfill']
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

    res.json({
      systemRunning: systemStatus.running,
      systemInitialized: systemStatus.initialized,
      jobsCount: systemStatus.jobsCount,
      jobs: getJobsSafeInfo(), // incluye description
      jobDescriptions: metaSyncJobs.jobDescriptions,
      todayStats,
      recentLogs: recentLogs.map(log => ({
        jobType: log.job_type,
        status: log.status,
        startedAt: log.start_time,
        completedAt: log.end_time,
        recordsProcessed: log.records_processed,
        errorMessage: log.error_message
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
    const userId = req.userData.userId; // CORREGIDO: usar userData.userId
    
    console.log(`🔄 Ejecutando job '${jobName}' manualmente por usuario ${userId}`);
    
    // Crear log de ejecución manual
    const syncLog = await SyncLog.create({
      job_type: 'manual_job_execution',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      // Ejecutar el job
      const result = await metaSyncJobs.runJob(jobName);
      
      // Actualizar log
      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: result.processed || 1
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
      // Actualizar log con error
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
