'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { randomBytes } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../web/whatsapp-onboarding-window.js'), 'utf8');
function render(res) {
  const nonce = randomBytes(24).toString('base64');
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}' https://connect.facebook.net; style-src 'nonce-${nonce}'; connect-src https://connect.facebook.net https://www.facebook.com https://web.facebook.com https://graph.facebook.com; frame-src https://www.facebook.com https://web.facebook.com; img-src data: https://*.facebook.com https://*.fbcdn.net; base-uri 'none'; form-action https://www.facebook.com https://web.facebook.com; frame-ancestors https://app.clinicaclick.com https://crm.clinicaclick.com`);
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:6px 0;color:#475569;background:transparent}p{margin:0 0 16px}button{font:600 14px/1.5 system-ui,sans-serif;border:1px solid #4f46e5;border-radius:8px;padding:12px 18px;background:#4f46e5;color:white;cursor:pointer;width:100%;margin:0 0 10px}button:disabled{opacity:.6;cursor:default}#cancel{background:white;color:#475569;border-color:#cbd5e1}button[hidden]{display:none}button:focus-visible{outline:3px solid #a5b4fc;outline-offset:3px}</style></head><body>
<p id="status" role="status" aria-live="polite">Preparando la conexión segura…</p><button id="authorize" type="button" disabled>Conectar con Meta ↗</button><button id="cancel" type="button" disabled hidden>Cancelar intento</button>
<script nonce="${nonce}">${source}</script></body></html>`);
}
module.exports = { render };
