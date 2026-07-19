'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const controller = require('../../controllers/webContentMedia.controller');

for (const name of [
  'listContent',
  'createContent',
  'updateContent',
  'listContentVersions',
  'listMedia',
  'registerMedia',
  'updateMedia',
]) {
  assert.equal(typeof controller[name], 'function', `${name} debe estar expuesto`);
}

const routes = fs.readFileSync(path.resolve(__dirname, '../../routes/marketing.routes.js'), 'utf8');
for (const contract of [
  "router.get('/web-content', webContentMediaController.listContent)",
  "router.post('/web-content', limitWebContentWrites, webContentMediaController.createContent)",
  "router.patch('/web-content/:contentId', limitWebContentWrites, webContentMediaController.updateContent)",
  "router.get('/web-content/:contentId/versions', webContentMediaController.listContentVersions)",
  "router.get('/web-media', webContentMediaController.listMedia)",
  "router.post('/web-media', limitWebMediaWrites, webContentMediaController.registerMedia)",
  "router.patch('/web-media/:mediaId', limitWebMediaWrites, webContentMediaController.updateMedia)",
]) {
  assert.equal(routes.includes(contract), true, `falta contrato de ruta: ${contract}`);
}
assert.match(
  routes,
  /const limitWebContentAcceptances = webRateLimit\(\{ operation: 'web_content_generation_accept', limit: 60,/,
  'accept debe tener un límite antiabuso independiente de la cuota de llamadas a OpenAI'
);
assert.match(
  routes,
  /router\.post\(\s*'\/web-content\/generations\/:generationId\/accept',\s*limitWebContentAcceptances,/,
  'aceptar un borrador no debe consumir la cuota de generación del proveedor'
);

console.log('web content/media controller contract: ok');
