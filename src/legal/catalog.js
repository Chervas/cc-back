'use strict';

const { createHash } = require('node:crypto');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isoDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && /T.*Z$/.test(value);

// A shipped artifact is the allowlist. Requests cannot select arbitrary files,
// provide their own document text, or promote a draft to an active contract.
function createCatalog(artifact, now = () => new Date()) {
    if (artifact?.schemaVersion !== 1 || !Array.isArray(artifact.documents)) throw fail('legal_catalog_invalid', 503);
    const keys = new Set();
    const documents = artifact.documents.map(source => {
        const doc = { ...source };
        if (!identifier(doc.slug) || !identifier(doc.version) || typeof doc.title !== 'string' || !doc.title.trim()
            || typeof doc.contentMarkdown !== 'string' || !doc.contentMarkdown.trim()
            || !digest(doc.sha256) || sha256(doc.contentMarkdown) !== doc.sha256
            || !['draft', 'approved', 'superseded'].includes(doc.status)
            || ![null, undefined, 'terms', 'dpa'].includes(doc.acceptanceKind)
            || doc.status !== 'draft' && (!isoDate(doc.publishedAt) || !isoDate(doc.effectiveAt))
            || doc.status !== 'draft' && Date.parse(doc.publishedAt) > Date.parse(doc.effectiveAt)
            || keys.has(`${doc.slug}:${doc.version}`)) throw fail('legal_catalog_invalid', 503);
        keys.add(`${doc.slug}:${doc.version}`);
        return Object.freeze(doc);
    });
    const visible = doc => doc.status !== 'draft' && Date.parse(doc.publishedAt) <= now().getTime();
    const active = doc => doc.status === 'approved' && visible(doc) && Date.parse(doc.effectiveAt) <= now().getTime();
    const newest = rows => [...rows].sort((a, b) => Date.parse(b.effectiveAt || 0) - Date.parse(a.effectiveAt || 0)
        || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0) || b.version.localeCompare(a.version))[0] || null;
    const current = slug => newest(documents.filter(doc => doc.slug === slug && active(doc)));
    const metadata = doc => ({
        slug: doc.slug, title: doc.title, status: active(doc) && current(doc.slug) !== doc ? 'superseded' : doc.status,
        version: doc.version, sha256: doc.sha256, publishedAt: doc.publishedAt || null, effectiveAt: doc.effectiveAt || null,
        summary: doc.summary || '', acceptanceKind: doc.acceptanceKind || null, current: current(doc.slug) === doc,
    });
    const versions = (slug, review) => documents.filter(doc => doc.slug === slug && (review || visible(doc)))
        .map(doc => metadata(doc)).map(({ version, sha256, publishedAt, effectiveAt, status }) => ({ version, sha256, publishedAt, effectiveAt, status }));
    const describe = (doc, review, content = false) => ({ ...metadata(doc), availableVersions: versions(doc.slug, review), ...(content ? { contentMarkdown: doc.contentMarkdown } : {}) });
    return {
        list({ review = false } = {}) {
            const slugs = [...new Set(documents.filter(doc => review || visible(doc)).map(doc => doc.slug))];
            return { documents: slugs.map(slug => review ? newest(documents.filter(doc => doc.slug === slug)) : current(slug) || newest(documents.filter(doc => doc.slug === slug && visible(doc))))
                .filter(Boolean).map(doc => describe(doc, review)), reviewMode: review };
        },
        get(slug, version, { review = false } = {}) {
            if (!identifier(slug) || version !== undefined && !identifier(version)) throw fail('legal_document_not_found', 404);
            const rows = documents.filter(doc => doc.slug === slug && (review || visible(doc)));
            const doc = version ? rows.find(row => row.version === version) : review ? newest(rows) : current(slug) || newest(rows);
            if (!doc) throw fail('legal_document_not_found', 404);
            return describe(doc, review, true);
        },
        activeTerms() {
            const rows = [...new Set(documents.map(doc => doc.slug))].map(current).filter(doc => doc?.acceptanceKind === 'terms');
            if (rows.length > 1) throw fail('legal_catalog_terms_ambiguous', 503);
            return rows[0] || null;
        },
        requireAcceptance(input, kind) {
            if (!input || !identifier(input.slug) || !identifier(input.version) || !digest(input.sha256)) throw fail('legal_document_evidence_invalid');
            const doc = current(input.slug);
            if (!doc || !['terms', 'dpa'].includes(doc.acceptanceKind) || kind && doc.acceptanceKind !== kind) throw fail('legal_document_not_active', 409);
            if (doc.version !== input.version || doc.sha256 !== input.sha256) throw fail('legal_document_changed', 409);
            return doc;
        },
        matchesReceipt(row) { return documents.some(doc => visible(doc) && doc.slug === row.document_slug && doc.version === row.document_version && doc.sha256 === row.document_sha256); },
    };
}

// Lazy loading keeps module import usable before catalog generation and isolates
// unrelated authentication paths from legal activation.
let catalog;
function getCatalog() {
    if (!catalog) catalog = createCatalog(require('./catalog.generated.json'));
    return catalog;
}
module.exports = { createCatalog, getCatalog, fail, sha256, digest };
