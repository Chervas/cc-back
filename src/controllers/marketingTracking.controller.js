'use strict';

const marketingLinkTrackingService = require('../services/marketingLinkTracking.service');

exports.redirectTrackedLink = async (req, res) => {
  try {
    const url = await marketingLinkTrackingService.recordTrackedLinkClick(req.params.token, req);
    if (!url) {
      return res.status(404).send('Enlace no encontrado');
    }
    return res.redirect(302, url);
  } catch (error) {
    console.error('[marketing-tracking] Error registrando click', error);
    return res.status(404).send('Enlace no encontrado');
  }
};
