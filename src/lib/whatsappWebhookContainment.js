'use strict';

// Keep the legacy ingress closed until an authenticated, durable inbox replaces
// it. There is deliberately no environment switch: activating an asset or a
// worker must not restore the old acknowledge-and-discard path.
module.exports = function whatsappWebhookContainment(_req, res) {
  res.set('Cache-Control', 'no-store');
  res.set('Retry-After', '60');
  return res.status(503).json({ error: 'whatsapp_ingress_unavailable' });
};
