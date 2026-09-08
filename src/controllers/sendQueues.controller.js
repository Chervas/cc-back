'use strict';

const sendQueuesService = require('../services/sendQueues.service');

exports.list = async (req, res) => {
  try {
    const data = await sendQueuesService.listSendQueues({
      userId: req.userData?.userId,
      scopeRaw: req.query.scope || req.query.clinica_id || req.query.clinic_id || 'all',
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error listando colas de envío', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'send_queues_list_failed',
    });
  }
};

async function mutate(req, res, action) {
  try {
    const data = await sendQueuesService.mutateSendQueue({
      userId: req.userData?.userId,
      queueId: req.params.queueId,
      action,
    });
    return res.json({ success: true, data });
  } catch (error) {
    if (!error.status || error.status >= 500) {
      console.error(`Error al ${action} cola de envío`, error);
    }
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'send_queue_action_failed',
    });
  }
}

exports.pause = (req, res) => mutate(req, res, 'pause');
exports.resume = (req, res) => mutate(req, res, 'resume');
