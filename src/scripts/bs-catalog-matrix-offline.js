#!/usr/bin/env node
'use strict';

// Intentionally no database/runtime/service/browser/network imports or options.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { readBytes, parseArgs, PRIVATE_ROOT, syncDirectory } = require('../lib/cliniccloud-import/io');
const { WORKBOOK_SHA, REPLIES_SHA, ARCHIVE_SHA, PDF_SOURCES, buildCatalogMatrix, matrixCsv } = require('../lib/cliniccloud-import/catalog-matrix');

function pinnedBytes(filename, expected) {
    const bytes = readBytes(filename);
    if (hash(bytes) !== expected) throw new Error('MATRIX_ORIGINAL_SOURCE_HASH_MISMATCH');
    return bytes;
}
function workbook(filename, expected) {
    pinnedBytes(filename, expected);
    const result = spawnSync('python3', ['-B', path.resolve(__dirname, '../lib/cliniccloud-import/xlsx_catalog.py'), filename], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('MATRIX_WORKBOOK_EXTRACTION_FAILED');
    return JSON.parse(result.stdout);
}
async function pdfSources(bytes) {
    // yauzl is already installed in the operator workspace; never extract ZIP
    // members to disk, never process patient exports or __MACOSX resource forks.
    const yauzl = require('yauzl');
    const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: true }, (error, value) => error ? reject(error) : resolve(value)));
    const members = new Map();
    await new Promise((resolve, reject) => {
        zip.on('error', reject); zip.on('end', resolve);
        zip.on('entry', entry => {
            const spec = PDF_SOURCES.find(s => s.file === entry.fileName);
            if (!spec) { zip.readEntry(); return; }
            if (members.has(spec.file) || entry.uncompressedSize > 10 * 1024 * 1024) { zip.close(); reject(new Error('MATRIX_ZIP_MEMBER_INVALID')); return; }
            zip.openReadStream(entry, (error, stream) => {
                if (error) { reject(error); return; }
                const parts = []; let total = 0;
                stream.on('error', reject);
                stream.on('data', part => { total += part.length; if (total > 10 * 1024 * 1024) stream.destroy(new Error('MATRIX_ZIP_SIZE_LIMIT')); else parts.push(part); });
                stream.on('end', () => { members.set(spec.file, Buffer.concat(parts)); zip.readEntry(); });
            });
        });
        zip.readEntry();
    });
    if (members.size !== PDF_SOURCES.length) throw new Error('MATRIX_PDF_SOURCE_MISSING');
    return PDF_SOURCES.map(spec => {
        const content = members.get(spec.file);
        if (hash(content) !== spec.sha256) throw new Error('MATRIX_PDF_HASH_MISMATCH');
        // Existing literal extractor, including page/full text hashes and guards.
        const extracted = spawnSync('python3', ['-B', path.resolve(__dirname, 'cliniccloud_extract_protocol_pdf.py'), spec.file], { input: content, encoding: 'utf8', timeout: 35000, maxBuffer: 8 * 1024 * 1024 });
        if (extracted.status !== 0) throw new Error('MATRIX_PDF_EXTRACTION_FAILED');
        const parsed = JSON.parse(extracted.stdout);
        if (parsed.source_sha256 !== spec.sha256 || parsed.page_count !== spec.pages) throw new Error('MATRIX_PDF_PAGE_OR_HASH_MISMATCH');
        const pages = parsed.parts.flatMap(part => [...part.content.matchAll(/```pdf-text\n([\s\S]*?)\n```\n\n/g)].map(m => m[1]));
        if (pages.length !== spec.pages || pages.some((p, i) => hash(p) !== parsed.page_sha256[i])) throw new Error('MATRIX_LITERAL_PAGE_HASH_MISMATCH');
        return { ...spec, pages };
    });
}
function writePrivateCsv(filename, text) {
    if (!path.isAbsolute(filename)) throw new Error('MATRIX_PRIVATE_OUTPUT_ABSOLUTE_REQUIRED');
    const root = fs.realpathSync(PRIVATE_ROOT); const stat = fs.statSync(root);
    if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('MATRIX_PRIVATE_ROOT_PERMISSIONS_INVALID');
    const parent = fs.realpathSync(path.dirname(filename));
    if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('MATRIX_OUTPUT_OUTSIDE_PRIVATE_ROOT');
    const descriptor = fs.openSync(path.join(parent, path.basename(filename)), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    syncDirectory(parent);
}
async function run(args) {
    const options = parseArgs(args, ['--workbook', '--client-replies', '--archive', '--private-output']);
    if (Object.keys(options).length !== 4) throw new Error('MATRIX_ALL_FOUR_INPUT_OPTIONS_REQUIRED');
    const sheets = workbook(options['--workbook'], WORKBOOK_SHA);
    const replySheets = workbook(options['--client-replies'], REPLIES_SHA);
    const pdfs = await pdfSources(pinnedBytes(options['--archive'], ARCHIVE_SHA));
    const matrix = buildCatalogMatrix({ sheets, workbookHash: WORKBOOK_SHA, replySheets, repliesHash: REPLIES_SHA, pdfs });
    const csv = matrixCsv(matrix);
    writePrivateCsv(options['--private-output'], csv);
    return { ...matrix.summary, matrix_sha256: matrix.matrix_sha256, csv_sha256: hash(csv), source_priority: 'verified_october_tariff_field_over_september_prices_only',
        source_prices_not_final_unless_october_linked: true, originals_modified: false, catalogue_activated: false };
}
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
    process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'MATRIX_OFFLINE_EXTRACTION_FAILED') + '\n'); process.exitCode = 1;
});
module.exports = { run, pdfSources, writePrivateCsv };
