'use strict';

const { getStatusesByEntity } = require('../lib/status-catalog');

exports.getStatuses = async (req, res) => {
  try {
    const entity = String(req.query?.entity || '').trim().toLowerCase();
    const payload = getStatusesByEntity(entity);

    if (!payload) {
      return res.status(400).json({
        success: false,
        message: 'entity inválida',
        allowed: ['cita', 'lead'],
      });
    }

    return res.json({
      success: true,
      entity,
      data: payload,
      meta: {
        version: 'v1',
        source: 'system',
      },
    });
  } catch (err) {
    console.error('Error getStatuses /api/meta/statuses', err);
    return res.status(500).json({
      success: false,
      message: 'Error interno al recuperar estados',
    });
  }
};
