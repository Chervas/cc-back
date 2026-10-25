'use strict';

const { runLocalDecoder } = require('./accountingDocumentReader.service');

const MAX_BYTES = 18 * 1024 * 1024;
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

function previewError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function integerOption(value, fallback, min, max, field) {
  if (value == null || value === '') return fallback;
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw previewError(400, 'accounting_preview_option_invalid', `El valor de ${field} no es válido.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw previewError(400, 'accounting_preview_option_invalid', `El valor de ${field} no es válido.`);
  }
  return number;
}

/** Private bytes only: fixed local decoders, stdin/stdout, bounded time and pixels. */
async function renderDocumentPreview({ buffer, contentType, page, width }) {
  page = integerOption(page, 1, 1, 10000, 'página');
  width = integerOption(width, 1200, 200, 1600, 'tamaño');
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES) {
    throw previewError(413, 'accounting_preview_size_invalid', 'No se puede previsualizar este archivo. Abre su original.');
  }
  if (['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(contentType)) {
    if (page !== 1) throw previewError(404, 'accounting_preview_page_missing', 'Esta imagen sólo tiene una página.');
    return { buffer, contentType: contentType === 'image/jpg' ? 'image/jpeg' : contentType, page: 1, pages: 1 };
  }
  if (contentType !== 'application/pdf' || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw previewError(415, 'accounting_preview_type_unsupported', 'La vista previa admite PDF e imágenes. Puedes abrir el original.');
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    throw previewError(429, 'accounting_preview_busy', 'Hay otras vistas previas cargando. Vuelve a intentarlo en un momento.');
  }
  inFlight++;
  try {
    const metadata = (await runLocalDecoder('/usr/bin/pdfinfo', ['-'], buffer, 128 * 1024, 10000)).toString('utf8');
    const match = /^Pages:\s+(\d+)\s*$/m.exec(metadata);
    const pages = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(pages) || pages < 1) throw Error('invalid_pdf_page_count');
    if (page > pages) throw previewError(404, 'accounting_preview_page_missing', 'La página solicitada no existe.');
    const image = await runLocalDecoder('/usr/bin/pdftoppm', [
      '-f', String(page), '-l', String(page), '-singlefile', '-scale-to', String(width), '-png', '-',
    ], buffer, 12 * 1024 * 1024, 15000);
    if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error('invalid_pdf_preview');
    return { buffer: image, contentType: 'image/png', page, pages };
  } catch (error) {
    if (error?.statusCode) throw error;
    // Decoder output can contain private metadata; never forward it to a response/log.
    throw previewError(422, 'accounting_preview_unavailable', 'No se ha podido generar la vista previa. Puedes abrir el PDF original.');
  } finally {
    inFlight--;
  }
}

module.exports = { renderDocumentPreview };
