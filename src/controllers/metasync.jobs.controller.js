/**
 * Controlador para Gestión de Jobs Cron de Sincronización de Métricas
 * 
 * Este controlador proporciona endpoints para:
 * - Inicializar y gestionar jobs cron
 * - Monitorear el estado de los jobs
 * - Ejecutar jobs manualmente
 * - Obtener estadísticas de ejecución
 * 
 * @author Manus AI
 * @version 1.0.0
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
        jobs: metaSyncJobs.getStatus()
      });
    }

    // Inicializar jobs
    await metaSyncJobs.initialize();
    
    // Iniciar jobs
    metaSyncJobs.start();
    
    return res.json({
      message: 'Sistema de jobs inicializado y iniciado correctamente',
      status: 'initialized',
      jobsCount: metaSyncJobs.jobs.size,
      jobs: metaSyncJobs.getStatus(),
      schedules: metaSyncJobs.config.schedules
    });

  } catch (error) {
    console.error('❌ Error al inicializar jobs:', error);
    return res.status(500).json({
      message: 'Error al inicializar sistema de jobs',
      error: error.message
    });
  }
};

/**
 * Obtener estado actual de todos los jobs
 */
exports.getJobsStatus = async (req, res) => {
  try {
    const status = {
      systemRunning: metaSyncJobs.isRunning,
      jobsCount: metaSyncJobs.jobs.size,
      jobs: metaSyncJobs.getStatus(),
      schedules: metaSyncJobs.config.schedules,
      lastExecutions: {}
    };

    // Obtener últimas ejecuciones de cada tipo de job
    const recentSyncs = await SyncLog.findAll({
      where: {
        syncType: {
          [Op.in]: ['automated_metrics_sync', 'manual_job_execution']
        }
      },
      order: [['createdAt', 'DESC']],
      limit: 10,
      attributes: ['syncType', 'status', 'createdAt', 'completedAt', 'recordsProcessed', 'recordsErrored']
    });

    status.recentExecutions = recentSyncs;

    // Estadísticas adicionales
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    status.todayStats = {
      syncExecutions: await SyncLog.count({
        where: {
          createdAt: { [Op.gte]: today }
        }
      }),
      tokenValidations: await TokenValidation.count({
        where: {
          validatedAt: { [Op.gte]: today }
        }
      }),
      metricsCollected: await SocialStatDaily.count({
        where: {
          createdAt: { [Op.gte]: today }
        }
      })
    };

    return res.json(status);

  } catch (error) {
    console.error('❌ Error al obtener estado de jobs:', error);
    return res.status(500).json({
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
    if (!metaSyncJobs.isRunning) {
      return res.status(400).json({
        message: 'Sistema de jobs no está inicializado',
        status: 'not_initialized'
      });
    }

    metaSyncJobs.start();

    return res.json({
      message: 'Todos los jobs han sido iniciados',
      status: 'started',
      jobs: metaSyncJobs.getStatus()
    });

  } catch (error) {
    console.error('❌ Error al iniciar jobs:', error);
    return res.status(500).json({
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
    metaSyncJobs.stop();

    return res.json({
      message: 'Todos los jobs han sido detenidos',
      status: 'stopped',
      jobs: metaSyncJobs.getStatus()
    });

  } catch (error) {
    console.error('❌ Error al detener jobs:', error);
    return res.status(500).json({
      message: 'Error al detener jobs',
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
    const userId = req.userData.userId;

    console.log(`🔄 Ejecutando job '${jobName}' manualmente por usuario ${userId}`);

    // Validar nombre del job
    const validJobs = ['metricsSync', 'tokenValidation', 'dataCleanup', 'healthCheck'];
    if (!validJobs.includes(jobName)) {
      return res.status(400).json({
        message: 'Nombre de job inválido',
        validJobs: validJobs
      });
    }

    // Crear log de ejecución manual
    const syncLog = await SyncLog.create({
      syncType: 'manual_job_execution',
      status: 'running',
      startedAt: new Date(),
      metadata: {
        jobName: jobName,
        executedBy: userId,
        trigger: 'manual'
      }
    });

    try {
      // Ejecutar el job
      await metaSyncJobs.runJob(jobName);

      // Actualizar log de éxito
      await syncLog.update({
        status: 'completed',
        completedAt: new Date()
      });

      return res.json({
        message: `Job '${jobName}' ejecutado correctamente`,
        jobName: jobName,
        status: 'completed',
        executedAt: new Date(),
        syncLogId: syncLog.id
      });

    } catch (jobError) {
      // Actualizar log de error
      await syncLog.update({
        status: 'failed',
        completedAt: new Date(),
        errorMessage: jobError.message
      });

      throw jobError;
    }

  } catch (error) {
    console.error(`❌ Error al ejecutar job '${req.params.jobName}':`, error);
    return res.status(500).json({
      message: `Error al ejecutar job '${req.params.jobName}'`,
      error: error.message
    });
  }
};

/**
 * Obtener logs de ejecución de jobs
 */
exports.getJobLogs = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      jobType = null, 
      status = null,
      startDate = null,
      endDate = null 
    } = req.query;

    const offset = (page - 1) * limit;
    const whereClause = {};

    // Filtros
    if (jobType) {
      whereClause.syncType = jobType;
    }

    if (status) {
      whereClause.status = status;
    }

    if (startDate || endDate) {
      whereClause.createdAt = {};
      if (startDate) {
        whereClause.createdAt[Op.gte] = new Date(startDate);
      }
      if (endDate) {
        whereClause.createdAt[Op.lte] = new Date(endDate);
      }
    }

    // Obtener logs con paginación
    const { count, rows } = await SyncLog.findAndCountAll({
      where: whereClause,
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: offset,
      attributes: [
        'id', 'syncType', 'status', 'startedAt', 'completedAt', 
        'recordsProcessed', 'recordsErrored', 'errorMessage', 'metadata'
      ]
    });

    // Calcular estadísticas
    const stats = await SyncLog.findAll({
      where: whereClause,
      attributes: [
        'status',
        [SyncLog.sequelize.fn('COUNT', SyncLog.sequelize.col('id')), 'count']
      ],
      group: ['status'],
      raw: true
    });

    const statusStats = {};
    stats.forEach(stat => {
      statusStats[stat.status] = parseInt(stat.count);
    });

    return res.json({
      logs: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      },
      stats: statusStats,
      filters: {
        jobType,
        status,
        startDate,
        endDate
      }
    });

  } catch (error) {
    console.error('❌ Error al obtener logs de jobs:', error);
    return res.status(500).json({
      message: 'Error al obtener logs de jobs',
      error: error.message
    });
  }
};

/**
 * Obtener estadísticas detalladas de jobs
 */
exports.getJobStatistics = async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    // Calcular fecha de inicio según el período
    const endDate = new Date();
    const startDate = new Date();
    
    switch (period) {
      case '24h':
        startDate.setHours(startDate.getHours() - 24);
        break;
      case '7d':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(startDate.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(startDate.getDate() - 90);
        break;
      default:
        startDate.setDate(startDate.getDate() - 7);
    }

    // Estadísticas de ejecuciones por tipo
    const executionsByType = await SyncLog.findAll({
      where: {
        createdAt: {
          [Op.between]: [startDate, endDate]
        }
      },
      attributes: [
        'syncType',
        'status',
        [SyncLog.sequelize.fn('COUNT', SyncLog.sequelize.col('id')), 'count'],
        [SyncLog.sequelize.fn('AVG', SyncLog.sequelize.col('recordsProcessed')), 'avgRecordsProcessed'],
        [SyncLog.sequelize.fn('SUM', SyncLog.sequelize.col('recordsProcessed')), 'totalRecordsProcessed']
      ],
      group: ['syncType', 'status'],
      raw: true
    });

    // Estadísticas de validaciones de tokens
    const tokenStats = await TokenValidation.findAll({
      where: {
        validatedAt: {
          [Op.between]: [startDate, endDate]
        }
      },
      attributes: [
        'isValid',
        [TokenValidation.sequelize.fn('COUNT', TokenValidation.sequelize.col('id')), 'count']
      ],
      group: ['isValid'],
      raw: true
    });

    // Estadísticas de métricas recolectadas
    const metricsStats = await SocialStatDaily.findAll({
      where: {
        createdAt: {
          [Op.between]: [startDate, endDate]
        }
      },
      attributes: [
        'platform',
        [SocialStatDaily.sequelize.fn('COUNT', SocialStatDaily.sequelize.col('id')), 'count']
      ],
      group: ['platform'],
      raw: true
    });

    // Tendencia diaria de ejecuciones
    const dailyTrend = await SyncLog.findAll({
      where: {
        createdAt: {
          [Op.between]: [startDate, endDate]
        }
      },
      attributes: [
        [SyncLog.sequelize.fn('DATE', SyncLog.sequelize.col('createdAt')), 'date'],
        'status',
        [SyncLog.sequelize.fn('COUNT', SyncLog.sequelize.col('id')), 'count']
      ],
      group: [
        SyncLog.sequelize.fn('DATE', SyncLog.sequelize.col('createdAt')),
        'status'
      ],
      order: [[SyncLog.sequelize.fn('DATE', SyncLog.sequelize.col('createdAt')), 'ASC']],
      raw: true
    });

    return res.json({
      period: period,
      dateRange: {
        start: startDate,
        end: endDate
      },
      executionsByType: executionsByType,
      tokenValidations: tokenStats,
      metricsCollected: metricsStats,
      dailyTrend: dailyTrend,
      summary: {
        totalExecutions: executionsByType.reduce((sum, item) => sum + parseInt(item.count), 0),
        successfulExecutions: executionsByType
          .filter(item => item.status === 'completed')
          .reduce((sum, item) => sum + parseInt(item.count), 0),
        failedExecutions: executionsByType
          .filter(item => item.status === 'failed')
          .reduce((sum, item) => sum + parseInt(item.count), 0),
        totalRecordsProcessed: executionsByType
          .reduce((sum, item) => sum + (parseInt(item.totalRecordsProcessed) || 0), 0)
      }
    });

  } catch (error) {
    console.error('❌ Error al obtener estadísticas de jobs:', error);
    return res.status(500).json({
      message: 'Error al obtener estadísticas de jobs',
      error: error.message
    });
  }
};

/**
 * Obtener configuración actual de jobs
 */
exports.getJobConfiguration = async (req, res) => {
  try {
    return res.json({
      schedules: metaSyncJobs.config.schedules,
      dataRetention: metaSyncJobs.config.dataRetention,
      retries: metaSyncJobs.config.retries,
      systemStatus: {
        isRunning: metaSyncJobs.isRunning,
        jobsCount: metaSyncJobs.jobs.size,
        jobs: metaSyncJobs.getStatus()
      }
    });

  } catch (error) {
    console.error('❌ Error al obtener configuración de jobs:', error);
    return res.status(500).json({
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
    const cron = require('node-cron');
    const nextExecutions = {};

    // Calcular próximas ejecuciones para cada job
    Object.entries(metaSyncJobs.config.schedules).forEach(([jobName, schedule]) => {
      try {
        // Nota: node-cron no tiene una función nativa para calcular próxima ejecución
        // Esta es una implementación simplificada
        nextExecutions[jobName] = {
          schedule: schedule,
          description: this.getScheduleDescription(schedule),
          isValid: cron.validate(schedule)
        };
      } catch (error) {
        nextExecutions[jobName] = {
          schedule: schedule,
          error: 'Formato de cron inválido',
          isValid: false
        };
      }
    });

    return res.json({
      nextExecutions: nextExecutions,
      timezone: 'Europe/Madrid',
      currentTime: new Date()
    });

  } catch (error) {
    console.error('❌ Error al obtener próximas ejecuciones:', error);
    return res.status(500).json({
      message: 'Error al obtener próximas ejecuciones',
      error: error.message
    });
  }
};

/**
 * Obtener descripción legible de un schedule cron
 */
getScheduleDescription = (cronExpression) => {
  const descriptions = {
    '0 2 * * *': 'Diario a las 2:00 AM',
    '0 */6 * * *': 'Cada 6 horas',
    '0 3 * * 0': 'Domingos a las 3:00 AM',
    '0 * * * *': 'Cada hora'
  };

  return descriptions[cronExpression] || 'Horario personalizado';
};

/**
 * Reiniciar el sistema de jobs
 */
exports.restartJobs = async (req, res) => {
  try {
    console.log('🔄 Reiniciando sistema de jobs...');

    // Detener jobs actuales
    metaSyncJobs.stop();

    // Esperar un momento
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Reinicializar
    await metaSyncJobs.initialize();
    metaSyncJobs.start();

    return res.json({
      message: 'Sistema de jobs reiniciado correctamente',
      status: 'restarted',
      jobsCount: metaSyncJobs.jobs.size,
      jobs: metaSyncJobs.getStatus()
    });

  } catch (error) {
    console.error('❌ Error al reiniciar jobs:', error);
    return res.status(500).json({
      message: 'Error al reiniciar sistema de jobs',
      error: error.message
    });
  }
};

