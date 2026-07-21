'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('las plantillas de sistema no generan notificaciones de aprobación', () => {
  const service = fs.readFileSync(
    path.resolve(__dirname, '../../services/whatsappTemplates.service.js'),
    'utf8',
  );
  const start = service.indexOf('async function notifyReviewPhotoTemplateApproved');
  const end = service.indexOf('\nfunction buildCustomTemplateExtraComponents', start);
  assert.ok(start >= 0 && end > start, 'notifyReviewPhotoTemplateApproved debe existir');
  const block = service.slice(start, end);

  assert.match(block, /catalog_template_id \|\| catalog\?\.id/);
  assert.match(block, /if \(Number\([\s\S]*?\) > 0\) return;/);
  assert.ok(
    block.indexOf('catalog_template_id') < block.indexOf('dispatchEvent'),
    'la exclusión de sistema debe ejecutarse antes de crear la notificación',
  );
});
