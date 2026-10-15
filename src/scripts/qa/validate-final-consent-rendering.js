#!/usr/bin/env node
'use strict';

// Offline rendering of private conversion artifacts through the REAL printable
// consent renderer. Models are replaced before loading: no DB/app/provider boot.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { parseArgs } = require('../../lib/cliniccloud-import/io');

const digest = raw => crypto.createHash('sha256').update(raw).digest('hex');
const servicePath = path.resolve(__dirname, '../../services/consentimientos.service.js');
const CHROME = '/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell';

function renderer(document) {
  const db = { Sequelize: { Op: {} }, PatientConsentDocument: { findByPk: async () => document } };
  const nativeRequire = createRequire(servicePath), module = { exports: {} };
  const localRequire = name => name === '../../models' ? db : nativeRequire(name);
  vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), {
    require: localRequire, module, exports: module.exports, __dirname: path.dirname(servicePath),
    process: { env: {} }, Buffer, console,
  });
  return module.exports;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--manifest', '--output', '--limit']);
  const manifestPath = fs.realpathSync(args['--manifest']);
  if (!manifestPath.startsWith('/home/ubuntu/secure-imports/')) throw Error('PRIVATE_MANIFEST_REQUIRED');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!['bs-final-consent-source-faithful-conversion', 'bs-final-consent-editable-html-conversion'].includes(manifest.name)
    || manifest.unique_documents !== 44) throw Error('FINAL_44_MANIFEST_REQUIRED');
  const editable = manifest.name === 'bs-final-consent-editable-html-conversion';
  const output = path.resolve(args['--output']);
  if (!output.startsWith(path.dirname(manifestPath) + '/')) throw Error('OUTPUT_MUST_BE_CONVERSION_CHILD');
  fs.mkdirSync(output, { mode: 0o700 });
  const limit = args['--limit'] ? Number(args['--limit']) : 44;
  if (!Number.isInteger(limit) || limit < 1 || limit > 44) throw Error('RENDER_LIMIT_INVALID');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
  const results = [];
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => /^(?:data:|about:)/.test(request.url()) ? request.continue() : request.abort());
    for (const item of manifest.documents.slice(0, limit)) {
      const source = fs.readFileSync(item.body_html.path);
      if (digest(source) !== item.body_html.sha256) throw Error('BODY_ARTIFACT_CHANGED');
      // Only synthetic QA identity, never a live patient/document/signature.
      const document = { id: 1, public_id: 'source_conversion_qa', status: 'pending', title: item.source_name,
        snapshot_html: source.toString('utf8').replace(/\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/g, ''),
        snapshot_hash: item.body_html.sha256,
        snapshot_json: { context: { paciente: {}, clinica: {}, tratamiento: {}, cita: {}, profesional: {} } } };
      const html = await renderer(document).renderConsentDocument('1');
      await page.setViewport({ width: 1050, height: 1100 });
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      const images = await page.evaluate(async () => {
        await Promise.all([...document.images].map(image => image.decode()));
        return [...document.querySelectorAll('.content img')].map(image => ({
          loaded: image.complete && image.naturalWidth > 0, width: image.naturalWidth, height: image.naturalHeight,
        }));
      });
      const expectedImages = editable ? (source.toString().match(/<img\b/g) || []).length : item.page_count;
      if (images.length !== expectedImages || images.some(image => !image.loaded)) throw Error('SOURCE_CONTENT_IMAGE_MISSING');
      const pdfPath = path.join(output, item.source_sha256 + '.pdf');
      await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
      fs.chmodSync(pdfPath, 0o600);
      const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
      const pdfPages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (!Number.isInteger(pdfPages) || pdfPages < 1 || !editable && pdfPages < item.page_count) throw Error('PRINTED_CONTENT_MISSING');
      const pdfBytes = fs.readFileSync(pdfPath);
      results.push({ source_sha256: item.source_sha256, source_pages: item.page_count, images_loaded: images.length,
        printed_pages: pdfPages, pdf_path: pdfPath, pdf_bytes: pdfBytes.length, pdf_sha256: digest(pdfBytes) });
      console.log(JSON.stringify({ checked: results.length, of: limit, source_sha256: item.source_sha256,
        pages: item.page_count, printed_pages: pdfPages, pdf_bytes: pdfBytes.length }));
    }
    const report = { name: 'bs-final-consent-offline-engine-render-validation', version: 1,
      source_manifest_sha256: digest(fs.readFileSync(manifestPath)), tested_documents: results.length,
      body_format: editable ? 'editable_html_text' : 'source_page_images',
      source_pages_preserved: !editable, source_body_hashes_preserved: true,
      database_calls: 0, network_requests: 0, deliveries: 0, results };
    const destination = path.join(output, 'render-validation.json');
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ report: destination, sha256: digest(fs.readFileSync(destination)), tested_documents: results.length }));
  } finally { await browser.close(); }
}

if (require.main === module) main().catch(error => {
  console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'PRIVATE_RENDER_VALIDATION_FAILED');
  process.exitCode = 1;
});
module.exports = { renderer, main };
