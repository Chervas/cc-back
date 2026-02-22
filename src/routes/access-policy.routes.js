'use strict';
const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');

router.use(authMiddleware);

// MVP fallback: override remoto opcional. Si no hay persistencia, devolvemos vacío.
router.get('/overrides', (req, res) => {
  const featureKey = String(req.query?.feature_key || 'marketing');
  return res.json({
    feature_key: featureKey,
    items: [],
  });
});

// MVP fallback: aceptar cambios sin persistencia para no bloquear UI.
router.put('/overrides', (_req, res) => {
  return res.json({ success: true });
});

module.exports = router;
