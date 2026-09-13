'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { randomBytes } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../web/whatsapp-onboarding-window.js'), 'utf8');
function render(res) {
  const nonce = randomBytes(24).toString('base64');
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}' https://connect.facebook.net; style-src 'nonce-${nonce}'; connect-src https://connect.facebook.net https://www.facebook.com https://web.facebook.com https://graph.facebook.com; frame-src https://www.facebook.com https://web.facebook.com; img-src data: https://*.facebook.com https://*.fbcdn.net; base-uri 'none'; form-action https://www.facebook.com https://web.facebook.com; frame-ancestors https://app.clinicaclick.com https://crm.clinicaclick.com`);
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:20px;color:#172d33;background:#f5faf8}p{margin:0 0 18px}button{font:inherit;border:1px solid #147d60;border-radius:8px;padding:10px 18px;background:#147d60;color:white;cursor:pointer;margin:0 8px 8px 0}button:disabled{opacity:.5;cursor:default}#cancel{background:white;color:#174b3d}button:focus-visible{outline:3px solid #397cb7;outline-offset:3px}</style></head><body>
<p id="status" role="status" aria-live="polite">Preparando autorización de WhatsApp…</p><button id="authorize" type="button" disabled>Continuar en Meta</button><button id="cancel" type="button" disabled>Cancelar</button>
<script nonce="${nonce}">${source}</script></body></html>`);
}
module.exports = { render };
