'use strict';

const { resolveHostedResponse, WebHostedOriginError } = require('../services/webHostedOrigin.service');

function shouldBypassHostedOrigin(req) {
  const pathname = String(req.originalUrl || req.url || req.path || '/');
  return pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname === '/oauth'
    || pathname.startsWith('/oauth/')
    || pathname === '/socket.io'
    || pathname.startsWith('/socket.io/');
}

async function webHostedOrigin(req, res, next) {
  if (shouldBypassHostedOrigin(req)) return next();
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
