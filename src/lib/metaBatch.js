'use strict';
const axios = require('axios');

/**
 * Lanza peticiones batch al Graph API v23.0
 * Agrupa en bloques de 50 operaciones.
 * @param {string} accessToken - token válido (page o user)
 * @param {Array<{method:string,relative_url:string}>} requests - peticiones relativas
 * @param {string} [baseUrl] - base Graph URL (por defecto process.env.META_API_BASE_URL o v23.0)
 * @returns {Promise<Array>} - respuestas parseadas en el mismo orden
 */
async function graphBatch(accessToken, requests, baseUrl) {
  const META_API_BASE_URL = baseUrl || process.env.META_API_BASE_URL || 'https://graph.facebook.com/v23.0';
  // Asegurar que siempre llamamos a una versión concreta (v23.0)
  let root = META_API_BASE_URL;
  if (/\/v\d+\.\d+$/.test(root)) {
    root = root.replace(/\/v\d+\.\d+$/, '/v23.0');
  } else {
    root = root.replace(/\/?$/, '') + '/v23.0';
  }

  const chunkSize = 50;
  const chunks = [];
  for (let i = 0; i < requests.length; i += chunkSize) {
    chunks.push(requests.slice(i, i + chunkSize));
  }

  const results = [];
  for (const chunk of chunks) {
    const body = new URLSearchParams();
    body.append('access_token', accessToken);
    body.append('batch', JSON.stringify(chunk));

    const resp = await axios.post(root + '/', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000
    });

    if (!Array.isArray(resp.data)) {
      throw new Error('Respuesta batch inválida');
    }

    for (const item of resp.data) {
      let parsedBody = null;
      try {
        parsedBody = item.body ? JSON.parse(item.body) : null;
      } catch (e) {
        parsedBody = { parse_error: true, raw: item.body };
      }
      results.push({ code: item.code, headers: item.headers, body: parsedBody });
    }
  }

  return results;
}

module.exports = { graphBatch };
