'use strict';

const sendQueuesService = require('../services/sendQueues.service');

exports.list = async (req, res) => {
  try {
    const data = await sendQueuesService.listSendQueues({ userId: req.userData?.userId });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error listando colas de envío', error);
    return res.status(500).json({ success: false, error: 'send_queues_list_failed' });
  }
};
