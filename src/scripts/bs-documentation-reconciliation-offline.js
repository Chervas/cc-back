#!/usr/bin/env node
'use strict';

// Pinned local files only. No models, environment secrets, HTTP, tablet or jobs.
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { spawnSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseCsv } = require('../lib/cliniccloud-import/csv');
const { buildCatalogPlan } = require('../lib/cliniccloud-import/catalog');
const { WORKBOOK_SHA, ARCHIVE_SHA, COLUMNS } = require('../lib/cliniccloud-import/catalog-matrix');
const { MATRIX_FILE_SHA } = require('../lib/cliniccloud-import/catalog-preflight');
const { readBytes, parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { pdfSources, writePrivateCsv } = require('./bs-catalog-matrix-offline');
const { prepareDocumentationReconciliation, documentationReconciliationCsv } = require('../lib/cliniccloud-import/bs-documentation-reconciliation');

const REVIEW_FILES = Object.freeze([
    ['bs-consent-associations-package-20260922-v2.json', '08d072c2fa6ea5eae1e44d3a4f87c9969261b289697b9133d4df036c64582a44'],
    ['bs-consent-completion-package-20260922-v1.json', 'b46101c450624592761fc37381e40d93bd8d744ef237ca758099f383765569cc'],
    ['bs-capillary-consent-links-20260926-review.json', '084c3079b710010b33948ba93d32155341c788e832aa3679afe9ce7360d14a27'],
    ['bs-firmeza-consents-20260927-review.json', 'c910ec3a5fadfd144af60dbbfa85ef885cc58e8480d8981aba1d268c5380c45e'],
]);
const CONSENT_ARCHIVE_SHA = '89d52b41f83f4075aecaf7553bbd1d55e715d33095879f0ed5c4a1d9fcd27f40';
const pinned = (filename, expected) => {
    const bytes = readBytes(filename);
    if (hash(bytes) !== expected) throw Error('BS_DOC_PINNED_FILE_CHANGED');
    return bytes;
};

async function consentSources(bytes, selectedFiles) {
    const yauzl = require('yauzl');
    const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
    const result = [], seen = new Set();
    await new Promise((resolve, reject) => {
        zip.on('error', reject); zip.on('end', resolve);
        zip.on('entry', entry => {
            if (!selectedFiles.has(entry.fileName)) { zip.readEntry(); return; }
            if (seen.has(entry.fileName) || entry.uncompressedSize > 10 * 1024 * 1024) { zip.close(); reject(Error('BS_DOC_CONSENT_MEMBER_INVALID')); return; }
            seen.add(entry.fileName);
            zip.openReadStream(entry, (error, stream) => {
                if (error) { reject(error); return; }
                const parts = []; let total = 0;
                stream.on('error', reject);
                stream.on('data', part => { total += part.length; if (total > 10 * 1024 * 1024) stream.destroy(Error('BS_DOC_CONSENT_MEMBER_TOO_LARGE')); else parts.push(part); });
                stream.on('end', () => {
                    const content = Buffer.concat(parts);
                    const extracted = spawnSync('python3', ['-B', path.resolve(__dirname, 'cliniccloud_extract_protocol_pdf.py'), entry.fileName],
                        { input: content, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
                    if (extracted.status !== 0) { reject(Error('BS_DOC_CONSENT_LITERAL_EXTRACTION_FAILED')); zip.close(); return; }
                    const parsed = JSON.parse(extracted.stdout);
                    if (parsed.source_sha256 !== hash(content)) { reject(Error('BS_DOC_CONSENT_LITERAL_HASH_CHANGED')); zip.close(); return; }
                    result.push({ file: entry.fileName, pdf_sha256: hash(content),
                        text: parsed.parts.flatMap(part => [...part.content.matchAll(/\u0060\u0060\u0060pdf-text\n([\s\S]*?)\n\u0060\u0060\u0060\n\n/g)].map(match => match[1])).join(' ') });
                    zip.readEntry();
                });
            });
        });
        zip.readEntry();
    });
    if (seen.size !== selectedFiles.size) throw Error('BS_DOC_CONSENT_ORIGINAL_FILE_MISSING');
    return result;
}

async function run(args) {
    const required = ['--matrix', '--snapshot', '--workbook', '--archive', '--consent-archive', '--review-directory', '--private-output'];
    const options = parseArgs(args, [...required, '--private-csv']);
    if (required.some(key => !options[key])) throw Error('BS_DOC_ALL_SEVEN_FILE_OPTIONS_REQUIRED');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const matrixBytes = pinned(options['--matrix'], MATRIX_FILE_SHA);
    pinned(options['--workbook'], WORKBOOK_SHA);
    const extraction = spawnSync('python3', ['-B', path.resolve(__dirname, '../lib/cliniccloud-import/xlsx_catalog.py'), options['--workbook']],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    if (extraction.status !== 0) throw Error('BS_DOC_LITERAL_WORKBOOK_EXTRACTION_FAILED');
    const sourcePlan = buildCatalogPlan({ sheets: JSON.parse(extraction.stdout), workbookHash: WORKBOOK_SHA });
    const evidenceArtifacts = REVIEW_FILES.map(([key, expected]) => {
        const document = JSON.parse(decoder.decode(pinned(path.join(options['--review-directory'], key), expected)));
        return { key, document, document_sha256: hash(document) };
    });
    const manualSources = (await pdfSources(pinned(options['--archive'], ARCHIVE_SHA))).filter(source => source.role === 'manual');
    const preflight = JSON.parse(decoder.decode(readBytes(options['--snapshot'])));
    const originalFiles = new Set(preflight.snapshot.consent_versions.map(version => {
        const source = (typeof version.variable_schema === 'string' ? JSON.parse(version.variable_schema) : version.variable_schema)?.source;
        return source?.type === 'bsmedical_pdf_library' ? source.source_file : null;
    }).filter(Boolean));
    const originals = await consentSources(pinned(options['--consent-archive'], CONSENT_ARCHIVE_SHA), originalFiles);
    const plan = prepareDocumentationReconciliation({
        matrixRows: parseCsv(decoder.decode(matrixBytes), { required: COLUMNS }).map(row => row.values),
        matrixFileSha256: hash(matrixBytes), preflight,
        sourcePlan, evidenceArtifacts, manualSources, consentSources: originals,
    });
    writePrivateJson(options['--private-output'], plan);
    if (options['--private-csv']) writePrivateCsv(options['--private-csv'], documentationReconciliationCsv(plan));
    return { ...plan.summary, plan_sha256: plan.plan_sha256, original_files_modified: false,
        association_applicator_present: false, signatures_or_tablet_changed: false };
}
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
    process.stderr.write(/^BS_DOC_[A-Z0-9_]+$/.test(error.message) ? error.message + '\n' : 'BS_DOC_OFFLINE_FAILED_NO_DATABASE_WRITES\n');
    process.exitCode = 1;
});
module.exports = { run, REVIEW_FILES, CONSENT_ARCHIVE_SHA, consentSources };
