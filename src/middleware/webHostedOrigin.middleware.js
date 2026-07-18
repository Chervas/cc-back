'use strict';

const { resolveHostedResponse, WebHostedOriginError } = require('../services/webHostedOrigin.service');

async function webHostedOrigin(req, res, next) {
  const method = String(req.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) return next();
  try {
    const result = await resolveHostedResponse({
      host: req.headers?.host,
      pathname: req.originalUrl || req.url || '/',
    });
    if (!result) return next();
    for (const [name, value] of Object.entries(result.headers || {})) res.set(name, value);
    res.status(result.status);
    if (method === 'HEAD') return res.end();
    return res.send(result.body);
  } catch (error) {
    if (!(error instanceof WebHostedOriginError)) return next(error);
    res.set('Cache-Control', 'no-store');
    return res.status(error.status || 503).type('text/plain').send(
      error.status === 404 ? 'Página no encontrada.' : 'Página temporalmente no disponible.'
    );
  }
}

module.exports = webHostedOrigin;
