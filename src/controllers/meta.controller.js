'use strict';

const { getStatusesByEntity } = require('../lib/status-catalog');

exports.getStatuses = async (req, res) => {
  try {
    const entity = String(req.query.entity || '').trim().toLowerCase();
    if (!entity) {
      return res.status(400).json({
        success: false,
        error: 'entity_required',
        message: 'Query param "entity" es obligatorio',
      });
    }

    const payload = getStatusesByEntity(entity);
    if (!payload) {
      return res.status(400).json({
        success: false,
        error: 'invalid_entity',
        message: 'Entity inválida. Usa appointment o lead.',
      });
    }

    return res.json({
      success: true,
      entity,
      data: payload,
      meta: {
        version: 'v2',
        source: 'system',
      },
    });
  } catch (error) {
    console.error('[meta.controller] getStatuses error:', error);
    return res.status(500).json({
      success: false,
      error: 'meta_statuses_failed',
      message: 'No se pudieron cargar los estados canónicos',
    });
  }
};
