'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalog, sha256 } = require('../../legal/catalog');
const { createLegalAcceptanceService, entityHash, contractingEntity, DECLARATION } = require('../../services/legalAcceptance.service');
const NOW = new Date('2026-11-08T12:00:00.000Z');
const doc = (overrides = {}) => {
    const contentMarkdown = '# Condiciones\n\nTexto de prueba ficticio.\n';
    return { slug: 'terms', title: 'Condiciones', version: '2026-11-01', contentMarkdown, sha256: sha256(contentMarkdown),
        status: 'approved', acceptanceKind: 'terms', publishedAt: '2026-11-01T00:00:00.000Z', effectiveAt: '2026-11-01T00:00:00.000Z', ...overrides };
};
const catalogFor = documents => createCatalog({ schemaVersion: 1, documents }, () => NOW);
const evidence = document => ({ slug: document.slug, version: document.version, sha256: document.sha256 });
function fixture(documents = [doc(), doc({ slug: 'dpa', acceptanceKind: 'dpa' })]) {
    const catalog = catalogFor(documents), rows = [];
    const state = {
        role: 'propietario', invitation: 'aceptada', revalidations: 0, writes: 0, transactions: 0,
        clinic: { id_clinica: 9, grupoClinicaId: 7, nombre_clinica: 'Nombre comercial ficticio',
            datos_fiscales_clinica: { denominacion_social: 'Clínica Ficticia SL', cif_nif: 'TEST-FICTITIOUS', direccion_facturacion: 'Calle ficticia 1' } },
    };
    let tail = Promise.resolve();
    const db = {
        Clinica: { findByPk: async id => Number(id) === 9 ? state.clinic : null },
        UsuarioClinica: { findOne: async ({ where }) => {
            assert.equal(where.id_clinica, 9);
            assert.ok(where[require('sequelize').Op.or], 'invitation state is checked by the query');
            return state.role && ['propietario', 'personaldeclinica', 'agencia'].includes(state.role)
                && [null, 'aceptada'].includes(state.invitation) ? { rol_clinica: state.role } : null;
        } },
        Usuario: { findByPk: async id => ({ id_usuario: id, nombre: `Actor ${id}`, apellidos: 'Prueba', email_usuario: `actor${id}@example.invalid`, estado_cuenta: state.accountState || 'activo' }) },
        LegalDocumentAcceptance: {
            findAll: async ({ where }) => rows.filter(row => row.scope_type === where.scope_type && row.scope_id === where.scope_id),
            findOne: async ({ where }) => rows.find(row => Object.entries(where).every(([key, value]) => row[key] === value)) || null,
            create: async (row, { transaction }) => {
                assert.ok(transaction, 'ledger writes are transactional');
                assert.equal(row.authentication_context.ip, undefined);
                assert.equal(row.authentication_context.token, undefined);
                state.writes += 1; rows.push(structuredClone(row)); return row;
            },
        },
        sequelize: { transaction: async work => {
            state.transactions += 1;
            const previous = tail;
            let release; tail = new Promise(resolve => { release = resolve; });
            await previous;
            const snapshot = rows.length;
            try { return await work({ LOCK: { UPDATE: 'UPDATE' } }); }
            catch (error) { rows.splice(snapshot); throw error; }
            finally { release(); }
        } },
    };
    const service = createLegalAcceptanceService({ db, catalog, now: () => NOW, revalidateAuth: async () => {
        state.revalidations += 1;
        if (state.revoked) throw Object.assign(Error('revoked'), { code: 'auth_invalid', status: 401 });
    } });
    const req = (patch = {}) => ({ userData: { userId: 12 }, authSession: { id: 'fictitious-session-id' },
        headers: { authorization: 'Bearer NEVER_STORED' }, query: { scopeType: 'clinic', scopeId: 9 },
        body: { scopeType: 'clinic', scopeId: 9, ...evidence(documents.find(row => row.slug === 'dpa') || documents[0]),
            authorityDeclared: true, authorityDeclarationVersion: DECLARATION.version, authorityDeclarationSha256: DECLARATION.sha256,
            contractingEntitySha256: entityHash(contractingEntity(state.clinic)) }, ...patch });
    return { service, db, state, rows, req, catalog };
}

test('catalog hides draft texts and exposes bounded approved history with exact hashes', () => {
    const old = doc({ version: '2026-10-01', effectiveAt: '2026-10-01T00:00:00.000Z', publishedAt: '2026-10-01T00:00:00.000Z' });
    const draft = doc({ version: '2026-12-01', status: 'draft', publishedAt: null, effectiveAt: null });
    const c = catalogFor([old, doc(), draft]);
    assert.equal(c.list().documents.length, 1);
    assert.equal(c.list().documents[0].availableVersions.length, 2);
    assert.equal(c.get('terms', old.version).status, 'superseded');
    assert.equal(c.get('terms').version, doc().version);
    assert.throws(() => c.get('terms', draft.version), { code: 'legal_document_not_found', status: 404 });
    assert.equal(c.get('terms', draft.version, { review: true }).status, 'draft');
    assert.throws(() => c.get('../secret'), { status: 404 });
});
test('catalog rejects tampered or duplicate immutable document bytes', () => {
    assert.throws(() => catalogFor([doc({ contentMarkdown: '# Alterado' })]), { code: 'legal_catalog_invalid' });
    assert.throws(() => catalogFor([doc(), doc()]), { code: 'legal_catalog_invalid' });
    assert.throws(() => catalogFor([doc({ publishedAt: null })]), { code: 'legal_catalog_invalid' });
});
test('future approvals are readable after publication but cannot be accepted or required at signup', () => {
    const future = doc({ effectiveAt: '2027-01-01T00:00:00.000Z' }), c = catalogFor([future]);
    assert.equal(c.list().documents[0].status, 'approved');
    assert.equal(c.list().documents[0].current, false);
    assert.equal(c.activeTerms(), null);
    assert.throws(() => c.requireAcceptance(evidence(future)), { code: 'legal_document_not_active' });
});
test('draft-only activation leaves legacy signup available and records no invented acceptance', async () => {
    const f = fixture([doc({ status: 'draft', publishedAt: null, effectiveAt: null })]);
    assert.equal(f.service.prepareRegistration({ agreements: true }), null);
    await f.service.recordRegistration({ document: null });
    assert.equal(f.rows.length, 0);
    assert.throws(() => f.service.prepareRegistration({ legalEvidence: { terms: { ...evidence(doc()), accepted: true } } }), { code: 'legal_document_not_active' });
});
test('active signup requires explicit exact server-allowlisted terms evidence', async () => {
    const f = fixture();
    for (const body of [{}, { agreements: true }, { legalEvidence: { terms: { ...evidence(doc()), accepted: 'true' } } }]) {
        assert.throws(() => f.service.prepareRegistration(body), { code: 'legal_terms_acceptance_required' });
    }
    assert.throws(() => f.service.prepareRegistration({ legalEvidence: { terms: { ...evidence(doc()), version: 'old', accepted: true } } }), { code: 'legal_document_changed', status: 409 });
    const document = f.service.prepareRegistration({ legalEvidence: { terms: { ...evidence(doc()), accepted: true } } });
    await f.db.sequelize.transaction(transaction => f.service.recordRegistration({ transaction, document, req: f.req(),
        user: { id_usuario: 12, nombre: 'Nombre', apellidos: 'Apellido', email_usuario: 'fictitious@example.invalid' } }));
    assert.equal(f.rows[0].scope_type, 'user');
    assert.equal(f.rows[0].authority_declared, false);
    assert.equal(f.rows[0].authority_declaration_version, null);
    assert.equal(f.rows[0].authentication_context.method, 'account_registration');
});
test('clinic ledger is separate, captures real fiscal identity, and excludes credentials/IP', async () => {
    const f = fixture(), result = await f.service.accept(f.req());
    assert.equal(result.replayed, false);
    assert.equal(result.acceptance.contractingEntity.legalName, 'Clínica Ficticia SL');
    assert.equal(result.acceptance.contractingEntity.taxId, 'TEST-FICTITIOUS');
    assert.equal(result.acceptance.authorityDeclared, true);
    assert.equal(result.acceptance.authorityDeclarationText, DECLARATION.text);
    assert.equal(result.acceptance.authorityDeclarationSha256, sha256(result.acceptance.authorityDeclarationText));
    assert.equal(f.rows[0].authentication_context.sessionRef, 'fictitious-session-id');
    assert.equal(f.rows[0].accepted_at.toISOString(), NOW.toISOString());
    assert.ok(!JSON.stringify(f.rows).includes('NEVER_STORED'));
    assert.equal(f.state.revalidations, 1);
});
test('membership and explicit authority checks deny ordinary staff, patients, agencies, invitees and admin bypass', async () => {
    for (const role of ['personaldeclinica', 'agencia', 'paciente', null]) {
        const f = fixture(); f.state.role = role;
        await assert.rejects(f.service.accept(f.req()), { status: 403 });
        await assert.rejects(f.service.status(f.req()), { status: 403 });
        assert.equal(f.rows.length, 0);
    }
    for (const invitation of ['pendiente', 'cancelada', 'rechazada']) {
        const f = fixture(); f.state.invitation = invitation;
        await assert.rejects(f.service.accept(f.req()), { status: 403 });
    }
    const f = fixture(); f.state.role = null;
    await assert.rejects(f.service.accept(f.req({ userData: { userId: 1 } })), { status: 403 });
});
test('MVP rejects group authority, delegated sessions and non-boolean declarations', async () => {
    const f = fixture();
    await assert.rejects(f.service.accept(f.req({ authDelegation: { effectiveUserId: 12 } })), { code: 'delegated_operation_requires_own_session' });
    await assert.rejects(f.service.accept(f.req({ authSession: { kind: 'delegated' } })), { status: 403 });
    await assert.rejects(f.service.accept(f.req({ userData: null })), { status: 401 });
    const group = f.req(); group.body.scopeType = 'group';
    await assert.rejects(f.service.accept(group), { code: 'legal_clinic_scope_required' });
    for (const declaration of [false, undefined, 1, 'true']) {
        const req = f.req(); req.body.authorityDeclared = declaration;
        await assert.rejects(f.service.accept(req), { code: 'legal_authority_declaration_required' });
    }
    assert.equal(f.rows.length, 0);
});
test('authority evidence binds both displayed version and exact text hash without replacing first acceptance', async () => {
    const f = fixture();
    const status = await f.service.status(f.req());
    assert.equal(status.authorityDeclaration.sha256, sha256(status.authorityDeclaration.text));
    for (const patch of [{ authorityDeclarationVersion: 'older' }, { authorityDeclarationSha256: '0'.repeat(64) },
        { authorityDeclarationVersion: undefined }, { authorityDeclarationSha256: undefined }]) {
        const req = f.req(); Object.assign(req.body, patch);
        await assert.rejects(f.service.accept(req), { code: 'legal_authority_declaration_changed', status: 409 });
    }
    assert.equal(f.rows.length, 0);
    const req = f.req(); req.body.authorityDeclarationText = 'Untrusted client text';
    const first = await f.service.accept(req);
    assert.equal(first.acceptance.authorityDeclarationText, status.authorityDeclaration.text);
    const stale = f.req(); stale.body.authorityDeclarationSha256 = '0'.repeat(64);
    await assert.rejects(f.service.accept(stale), { code: 'legal_authority_declaration_changed' });
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].id, first.acceptance.id);
    assert.equal(f.rows[0].authority_declaration_sha256, DECLARATION.sha256);
});
test('incomplete or changed clinic legal identity cannot inherit a commercial name or stale acceptance', async () => {
    const f = fixture(), req = f.req();
    f.state.clinic.datos_fiscales_clinica.denominacion_social = '';
    const status = await f.service.status(req);
    assert.equal(status.canAccept, false);
    assert.equal(status.reason, 'legal_clinic_identity_incomplete');
    assert.equal(status.contractingEntity.legalName, '');
    await assert.rejects(f.service.accept(req), { code: 'legal_clinic_identity_incomplete', status: 409 });
    f.state.clinic.datos_fiscales_clinica.denominacion_social = 'Otra entidad ficticia SL';
    await assert.rejects(f.service.accept(req), { code: 'legal_clinic_identity_changed' });
    assert.equal(f.rows.length, 0);
});
test('draft, superseded, privacy and mismatched-hash documents cannot produce a clinic receipt', async () => {
    const draft = doc({ slug: 'draft', status: 'draft', publishedAt: null, effectiveAt: null });
    const historical = doc({ slug: 'old', status: 'superseded' });
    const privacy = doc({ slug: 'privacy', acceptanceKind: null });
    const f = fixture([doc(), draft, historical, privacy]);
    for (const document of [draft, historical, privacy, doc({ version: 'old' }), doc({ sha256: '0'.repeat(64) })]) {
        const req = f.req(); Object.assign(req.body, evidence(document));
        await assert.rejects(f.service.accept(req), { status: 409 });
    }
    assert.equal(f.rows.length, 0);
});
test('normal session and active account are revalidated after authorization locks', async () => {
    const f = fixture(); f.state.revoked = true;
    await assert.rejects(f.service.accept(f.req()), { status: 401 });
    assert.equal(f.rows.length, 0);
    f.state.revoked = false; f.state.accountState = 'suspendido';
    await assert.rejects(f.service.accept(f.req()), { code: 'legal_actor_inactive' });
    assert.equal(f.rows.length, 0);
});
test('terms becoming superseded during authentication wait cannot be accepted from stale evidence', async () => {
    const f = fixture(); let at = NOW;
    const newer = doc({ slug: 'dpa', acceptanceKind: 'dpa', version: '2026-11-09', publishedAt: '2026-11-08T00:00:00.000Z', effectiveAt: '2026-11-09T00:00:00.000Z' });
    const catalog = createCatalog({ schemaVersion: 1, documents: [doc({ slug: 'dpa', acceptanceKind: 'dpa' }), newer] }, () => at);
    const service = createLegalAcceptanceService({ db: f.db, catalog, revalidateAuth: async () => { at = new Date('2026-11-09T12:00:00.000Z'); } });
    await assert.rejects(service.accept(f.req()), { code: 'legal_document_changed', status: 409 });
    assert.equal(f.rows.length, 0);
});
test('simultaneous repeat acceptance preserves first actor and time with a single insert', async () => {
    const f = fixture();
    const results = await Promise.all([f.service.accept(f.req()), f.service.accept(f.req({ userData: { userId: 13 } }))]);
    assert.deepEqual(results.map(row => row.replayed), [false, true]);
    assert.equal(f.state.writes, 1);
    assert.equal(results[0].acceptance.id, results[1].acceptance.id);
    assert.equal(results[1].acceptance.actorUserId, 12);
    assert.equal(f.rows[0].actor_email, 'actor12@example.invalid');
});
test('changing the fiscal entity preserves old receipt and requires a separate new entity receipt', async () => {
    const f = fixture(); await f.service.accept(f.req());
    f.state.clinic.datos_fiscales_clinica.cif_nif = 'TEST-SECOND-ENTITY';
    let status = await f.service.status(f.req());
    assert.equal(status.acceptances[0].appliesToCurrentEntity, false);
    const result = await f.service.accept(f.req());
    assert.equal(result.replayed, false);
    assert.equal(f.rows.length, 2);
    assert.notEqual(f.rows[0].contracting_entity_sha256, f.rows[1].contracting_entity_sha256);
    status = await f.service.status(f.req());
    assert.equal(status.acceptances.filter(row => row.appliesToCurrentEntity).length, 1);
});
test('schema fixes idempotency across actors and ORM rejects mutation/deletion of evidence', async () => {
    const schema = require('../../lib/legalAcceptanceSchema');
    const T = require('sequelize').DataTypes;
    const model = require('../../../models/legalDocumentAcceptance')({ define: (_name, fields, options) => ({ fields, ...options }) }, T);
    assert.equal(model.timestamps, false);
    const unique = model.indexes.find(index => index.unique);
    assert.ok(unique.fields.includes('contracting_entity_sha256'));
    assert.ok(!unique.fields.includes('actor_user_id'), 'first acceptance cannot be replaced by another actor');
    for (const hook of Object.values(model.hooks)) assert.throws(hook, /immutable/);
    const migration = require('../../../migrations/20261108120000-create-legal-document-acceptances');
    const calls = [];
    await migration.up({ createTable: async (table, fields) => calls.push({ table, fields }), addIndex: async () => {} }, require('sequelize'));
    assert.equal(calls[0].table, schema.TABLE);
    assert.equal(calls[0].fields.document_sha256.allowNull, false);
    await assert.rejects(migration.down(), /history_must_be_preserved/);
    const files = require('../../lib/rdsSchemaMigrationPolicy').migrationFiles(require('node:path').resolve(__dirname, '../../..'), ['20261108120000-create-legal-document-acceptances.js']);
    assert.deepEqual(files.map(file => file.path), ['migrations/20261108120000-create-legal-document-acceptances.js', 'src/lib/legalAcceptanceSchema.js']);
});

test('actual HTTP router isolates public drafts, tech-admin review and own-session acceptance', async t => {
    const http = require('node:http'), express = require('express');
    const sessions = require('../../services/accessSession.service'), originalVerify = sessions.verify;
    sessions.verify = async token => {
        if (!['owner', 'admin'].includes(token)) throw Object.assign(Error('invalid'), { name: 'JsonWebTokenError' });
        return { userId: token === 'admin' ? 1 : 12, email: 'fictitious@example.invalid', sessionVersion: 1, jti: 'fictitious-session-id', exp: 2000000000 };
    };
    t.after(() => { sessions.verify = originalVerify; });
    const draft = doc({ slug: 'review-draft', status: 'draft', publishedAt: null, effectiveAt: null });
    const f = fixture([doc(), doc({ slug: 'dpa', acceptanceKind: 'dpa' }), draft]);
    const app = express(); app.use(express.json());
    app.use('/api/legal', require('../../routes/legal.routes').createRouter({ catalog: () => f.catalog, service: () => f.service }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const agent = new http.Agent();
    agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
    t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
    const request = (path, token, body) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, path: '/api/legal' + path,
            method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, response => {
            const chunks = []; response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        req.on('error', reject); req.end(data);
    });
    const publicCatalog = await request('/documents', 'expired');
    assert.equal(publicCatalog.status, 200, 'public legal pages work even if a client has a stale token');
    assert.equal(publicCatalog.body.documents.length, 2);
    assert.equal(publicCatalog.headers['cache-control'], 'no-store');
    assert.equal((await request('/documents/review-draft?review=true', 'admin')).status, 404);
    assert.equal((await request('/review/documents')).status, 401);
    assert.equal((await request('/review/documents', 'owner')).status, 403);
    const review = await request('/review/documents/review-draft', 'admin');
    assert.equal(review.status, 200); assert.equal(review.body.status, 'draft');
    assert.equal(review.body.contentMarkdown, draft.contentMarkdown);
    assert.equal((await request('/acceptances?scopeType=clinic&scopeId=9')).status, 401);
    assert.equal((await request('/acceptances', undefined, f.req().body)).status, 401);
    assert.equal((await request('/acceptances', 'owner', f.req().body)).status, 201);
    assert.equal((await request('/acceptances', 'owner', f.req().body)).status, 200);
    f.state.role = null;
    assert.equal((await request('/acceptances', 'admin', f.req().body)).status, 403);
});
