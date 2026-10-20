'use strict';

const { spawn } = require('node:child_process');
const sharp = require('sharp');
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status, statusCode: status });
const MAX_INPUT = 25 * 1024 * 1024;
const MAX_OUTPUT = 12 * 1024 * 1024;
const MAX_PAGES = 200;

// Fixed local binaries receive private bytes only on stdin. Never shell-expand
// filenames, write temporary patient files, expose stderr or follow a URL.
function run(binary, args, buffer, limit = MAX_OUTPUT) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    const chunks = []; let bytes = 0, finished = false;
    const finish = (error, result) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(fail('clinical_attachment_preview_timeout', 'La vista previa tardó demasiado. Prueba otra página.', 503)), 12000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limit) return finish(fail('clinical_attachment_preview_too_large', 'La vista previa es demasiado grande.', 413));
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => finish(fail('clinical_attachment_preview_unavailable', 'No se pudo preparar la vista previa.', 503)));
    child.on('close', code => code === 0 ? finish(null, Buffer.concat(chunks))
      : finish(fail('clinical_attachment_preview_invalid', 'El documento no permite generar una vista previa.')));
    child.stdin.end(buffer);
  });
}
function validBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_INPUT) throw fail('clinical_attachment_preview_invalid', 'El archivo no permite generar una vista previa.');
}
async function getPdfPageCount(buffer) {
  validBuffer(buffer);
  const info = await run('/usr/bin/pdfinfo', ['-'], buffer, 128 * 1024);
  const match = /^Pages:\s+(\d+)\s*$/m.exec(info.toString('utf8')), count = Number(match?.[1]);
  if (!Number.isSafeInteger(count) || count < 1) throw fail('clinical_attachment_preview_invalid', 'El documento PDF no es válido.');
  if (count > MAX_PAGES) throw fail('clinical_attachment_preview_too_many_pages', 'La vista previa admite documentos de hasta 200 páginas.', 413);
  return count;
}
function pageNumber(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (!(typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^[1-9]\d{0,2}$/.test(value))
    || Number(value) < 1 || Number(value) > MAX_PAGES) throw fail('clinical_attachment_preview_page_invalid', 'Selecciona una página válida.');
  return Number(value);
}
async function createClinicalAttachmentPreview({ buffer, contentType, page }) {
  validBuffer(buffer); page = pageNumber(page);
  if (contentType === 'application/pdf') {
    const pageCount = await getPdfPageCount(buffer);
    if (page > pageCount) throw fail('clinical_attachment_preview_page_not_found', 'La página no existe.', 404);
    const preview = await run('/usr/bin/pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1600', '-png', '-'], buffer);
    return { buffer: preview, contentType: 'image/png', page, pageCount };
  }
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(contentType)) throw fail('clinical_attachment_preview_type_not_allowed', 'Este archivo no tiene vista previa.');
  if (page !== 1) throw fail('clinical_attachment_preview_page_not_found', 'La página no existe.', 404);
  try {
    const image = sharp(buffer, { limitInputPixels: 40 * 1000 * 1000, failOn: 'error' });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw Error('unsupported_image');
    const preview = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    if (preview.length > MAX_OUTPUT) throw fail('clinical_attachment_preview_too_large', 'La vista previa es demasiado grande.', 413);
    return { buffer: preview, contentType: 'image/png', page: 1, pageCount: 1 };
  } catch (error) {
    if (error?.statusCode) throw error;
    throw fail('clinical_attachment_preview_invalid', 'La imagen no permite generar una vista previa.');
  }
}
module.exports = { createClinicalAttachmentPreview, getPdfPageCount, pageNumber, MAX_PAGES };
