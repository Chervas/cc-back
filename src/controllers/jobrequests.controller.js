const { JobRequest, sequelize } = require('../../models');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');

const parseIntSafe = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseArrayParam = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const serializeJobRequest = (job) => ({
  id: job.id,
  type: job.type,
  priority: job.priority,
  status: job.status,
  origin: job.origin,
  payload: job.payload,
  requestedBy: job.requested_by,
  requestedByName: job.requested_by_name,
  requestedByRole: job.requested_by_role,
  attempts: job.attempts,
  maxAttempts: job.max_attempts,
  lastAttemptAt: job.last_attempt_at,
  nextRunAt: job.next_run_at,
  completedAt: job.completed_at,
  syncLogId: job.sync_log_id,
  errorMessage: job.error_message,
  resultSummary: job.result_summary,
  createdAt: job.created_at,
  updatedAt: job.updated_at
});

const VIEW_STATUS_MAP = {
  queue: ['pending', 'running', 'waiting'],
  history: ['completed', 'failed', 'cancelled'],
  all: undefined
};

exports.list = async (req, res) => {
  try {
    const { view = 'queue' } = req.query;
    const limit = parseIntSafe(req.query.limit, 50);
    const offset = parseIntSafe(req.query.offset, 0);
    const priorities = parseArrayParam(req.query.priority);
    const statuses = parseArrayParam(req.query.status) || VIEW_STATUS_MAP[view] || undefined;

    const { rows, count } = await jobRequestsService.listJobRequests({
      statuses,
      priorities,
      limit,
      offset,
      order: [['created_at', req.query.sort === 'asc' ? 'ASC' : 'DESC']]
    });

    res.json({
      data: rows.map(serializeJobRequest),
      meta: {
        count,
        limit,
        offset
      }
    });
  } catch (error) {
    console.error('❌ Error listando JobRequests:', error);
    res.status(500).json({ message: 'Error obteniendo solicitudes', error: error.message });
  }
};

exports.summary = async (_req, res) => {
  try {
    const statusSummary = await JobRequest.findAll({
      attributes: [
        'status',
        [sequelize.fn('COUNT', sequelize.col('status')), 'total']
      ],
      group: ['status']
    });

    const prioritySummary = await JobRequest.findAll({
      attributes: [
        'priority',
        [sequelize.fn('COUNT', sequelize.col('priority')), 'total']
      ],
      group: ['priority']
    });

    res.json({
      status: statusSummary.map((row) => ({
        status: row.get('status'),
        total: Number(row.get('total') || 0)
      })),
      priority: prioritySummary.map((row) => ({
        priority: row.get('priority'),
        total: Number(row.get('total') || 0)
      }))
    });
  } catch (error) {
    console.error('❌ Error obteniendo resumen de JobRequests:', error);
    res.status(500).json({ message: 'Error obteniendo resumen', error: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { type, payload, priority, origin, maxAttempts, nextRunAt, runImmediately } = req.body;
    const userId = req.userData?.userId || null;
    const userRole = req.userData?.role || null;
    const userName = req.userData?.name || null;

    const job = await jobRequestsService.enqueueJobRequest({
      type,
      payload,
      priority,
      origin: origin || 'manual',
      requestedBy: userId,
      requestedByName: userName,
      requestedByRole: userRole,
      maxAttempts,
      nextRunAt: nextRunAt ? new Date(nextRunAt) : null
    });

    if (runImmediately || job.priority === 'critical') {
      jobScheduler.triggerImmediate(job.id).catch((error) => {
        console.error('❌ Error disparando job inmediato:', error);
      });
    }

    res.status(201).json({
      message: 'JobRequest creado',
      job: serializeJobRequest(job)
    });
  } catch (error) {
    console.error('❌ Error creando JobRequest:', error);
    res.status(500).json({ message: 'Error creando job request', error: error.message });
  }
};

exports.cancel = async (req, res) => {
  try {
    const { id } = req.params;
    const job = await jobRequestsService.findJobById(id);
    if (!job) {
      return res.status(404).json({ message: 'JobRequest no encontrado' });
    }

    if (!['pending', 'waiting'].includes(job.status)) {
      return res.status(400).json({ message: 'Sólo se pueden cancelar jobs pendientes o en espera' });
    }

    await jobRequestsService.markCancelled(id, { errorMessage: 'Cancelado manualmente' });
    res.json({ message: 'JobRequest cancelado' });
  } catch (error) {
    console.error('❌ Error cancelando JobRequest:', error);
    res.status(500).json({ message: 'Error cancelando job request', error: error.message });
  }
};

exports.retry = async (req, res) => {
  try {
    const { id } = req.params;
    const job = await jobRequestsService.findJobById(id);
    if (!job) {
      return res.status(404).json({ message: 'JobRequest no encontrado' });
    }

    await jobRequestsService.setPending(id, { nextRunAt: new Date() });

    if (job.priority === 'critical') {
      jobScheduler.triggerImmediate(id).catch((error) => {
        console.error('❌ Error al relanzar job crítico:', error);
      });
    }

    res.json({ message: 'JobRequest reprogramado' });
  } catch (error) {
    console.error('❌ Error reprogramando JobRequest:', error);
    res.status(500).json({ message: 'Error reprogramando job request', error: error.message });
  }
};

exports.trigger = async (req, res) => {
  try {
    const { id } = req.params;
    const triggered = await jobScheduler.triggerImmediate(id);
    res.json({ triggered });
  } catch (error) {
    console.error('❌ Error ejecutando JobRequest inmediatamente:', error);
    res.status(500).json({ message: 'Error ejecutando job request', error: error.message });
  }
};

exports.workerStatus = (_req, res) => {
  try {
    const status = jobScheduler.getStatus();
    res.json(status);
  } catch (error) {
    console.error('❌ Error obteniendo estado del worker:', error);
    res.status(500).json({ message: 'Error obteniendo estado del worker', error: error.message });
  }
};
