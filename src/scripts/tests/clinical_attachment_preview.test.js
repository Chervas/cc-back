'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), sharp = require('sharp');
const { createClinicalAttachmentPreview: preview, getPdfPageCount, pageNumber } = require('../../services/clinicalAttachmentPreview.service');
function ownedPdf(count = 2) {
  const objects = ['', '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count ' + count + ' /Kids ['
    + Array.from({ length: count }, (_, n) => (3 + n * 2) + ' 0 R').join(' ') + '] >>'];
  for (let index = 0; index < count; index++) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents ' + (4 + index * 2) + ' 0 R >>');
    const data = index ? '0 0 1 rg 20 20 50 40 re f\n' : '1 0 0 rg 20 20 50 40 re f\n';
    objects.push('<< /Length ' + Buffer.byteLength(data) + ' >>\nstream\n' + data + 'endstream');
  }
  let value = '%PDF-1.4\n'; const offsets = [0];
  objects.slice(1).forEach((object, index) => { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(value); value += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(position => { value += String(position).padStart(10, '0') + ' 00000 n \n'; });
  value += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(value);
}
test('real local PDF binaries render the selected page from stdin with bounded image size', async () => {
  const buffer = ownedPdf(); assert.equal(await getPdfPageCount(buffer), 2);
  const first = await preview({ buffer, contentType: 'application/pdf', page: '1' });
  const second = await preview({ buffer, contentType: 'application/pdf', page: 2 });
  assert.equal(first.pageCount, 2); assert.equal(second.page, 2); assert.equal(first.contentType, 'image/png');
  assert.notDeepEqual(first.buffer, second.buffer);
  const metadata = await sharp(first.buffer).metadata(); assert.equal(metadata.width, 1600); assert.equal(metadata.height, 800);
  await assert.rejects(preview({ buffer, contentType: 'application/pdf', page: 3 }), { statusCode: 404 });
});
test('image previews decode supported private bytes; no remote SVG or fake image is accepted', async () => {
  const buffer = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#4f46e5' } }).jpeg().toBuffer();
  const output = await preview({ buffer, contentType: 'image/jpeg' });
  const metadata = await sharp(output.buffer).metadata(); assert.equal(metadata.width, 1600); assert.equal(metadata.height, 800); assert.equal(output.pageCount, 1);
  await assert.rejects(preview({ buffer, contentType: 'image/jpeg', page: 2 }), { statusCode: 404 });
  await assert.rejects(preview({ buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://untrusted.example/x"/></svg>'), contentType: 'image/png' }), { statusCode: 400 });
  await assert.rejects(preview({ buffer: Buffer.from('not PDF'), contentType: 'application/pdf' }), { statusCode: 400 });
});
test('page values reject options, paths, shell fragments and coercion', () => {
  for (const page of ['-f', '../../secret', '1; cat', '1.0', '1x', true, [], {}, -1, 0, 201, 1.5]) {
    assert.throws(() => pageNumber(page), { code: 'clinical_attachment_preview_page_invalid' });
  }
});
module.exports = { ownedPdf };
