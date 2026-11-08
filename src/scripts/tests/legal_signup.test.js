'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalog, sha256 } = require('../../legal/catalog');
const { createLegalAcceptanceService } = require('../../services/legalAcceptance.service');
const cache = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const state = { active: false, failLedger: false, users: [], receipts: [], issueCalls: 0, transactions: 0 };
const document = { slug: 'terms', title: 'Términos ficticios', version: '2026-11-08', contentMarkdown: '# Ficticio\n', sha256: sha256('# Ficticio\n'),
    acceptanceKind: 'terms', status: 'approved', publishedAt: '2026-11-08T00:00:00.000Z', effectiveAt: '2026-11-08T00:00:00.000Z' };
const db = {
    Usuario: { create: async (input, { transaction }) => {
        if (state.active) assert.ok(transaction);
        const user = { id_usuario: 25, ...input }; state.users.push(user); return user;
    } },
    LegalDocumentAcceptance: { create: async (row, { transaction }) => {
        assert.ok(transaction);
        if (state.failLedger) throw Error('fictitious storage failure');
        state.receipts.push(row); return row;
    } },
    sequelize: { transaction: async work => {
        state.transactions += 1;
        try { return await work({ LOCK: { UPDATE: 'UPDATE' } }); }
        catch (error) { state.users.length = 0; state.receipts.length = 0; throw error; }
    } },
};
cache('../../../models', db);
cache('../../services/accessSession.service', { settings: () => ({ mode: 'legacy', emailMfaMode: 'off' }), issue: async () => {
    state.issueCalls += 1; return { token: 'fictitious-issued-token', expiresIn: 10 };
} });
cache('../../services/platformAudit.service', {});
cache('../../services/passwordReset.service', {});
cache('../../services/systemNotifications.service', { notifyUserRegistration: async () => {} });
cache('../../services/authEmailChallenge.service', {});
cache('../../services/authTrustedDevice.service', {});
cache('../../services/legalAcceptance.service', { getService: () => createLegalAcceptanceService({ db,
    catalog: createCatalog({ schemaVersion: 1, documents: state.active ? [document] : [{ ...document, status: 'draft', publishedAt: null, effectiveAt: null }] }, () => new Date('2026-11-08T12:00:00Z')) }) });
const controller = require('../../controllers/auth.controllers');
async function signup(body = {}) {
    const req = { body: { nombre: 'Ficticio', apellidos: 'Prueba', email_usuario: 'fictitious@example.invalid', password: 'FICTITIOUS_ONLY', ...body }, headers: {} };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await controller.signUp(req, res); return res;
}
function reset(active) { Object.assign(state, { active, failLedger: false, users: [], receipts: [], issueCalls: 0, transactions: 0 }); }
const input = { legalEvidence: { terms: { slug: document.slug, version: document.version, sha256: document.sha256, accepted: true } } };
test('registration remains unchanged before approval and never treats the legacy checkbox as clinic authority', async () => {
    reset(false);
    const res = await signup({ agreements: true });
    assert.equal(res.statusCode, 201);
    assert.equal(state.users.length, 1);
    assert.equal(state.receipts.length, 0);
    assert.equal(state.transactions, 0);
});
test('active registration creates account and exact account-only receipt in one transaction', async () => {
    reset(true);
    assert.equal((await signup(input)).statusCode, 201);
    assert.equal(state.transactions, 1);
    assert.equal(state.receipts.length, 1);
    assert.equal(state.receipts[0].scope_type, 'user');
    assert.equal(state.receipts[0].scope_id, 25);
    assert.equal(state.receipts[0].authority_declared, false);
    assert.equal(state.receipts[0].authority_declaration_text, null);
    assert.equal(state.receipts[0].authority_declaration_sha256, null);
    assert.equal(state.receipts[0].document_sha256, document.sha256);
});
test('missing/stale active evidence fails before account creation or session issue', async () => {
    reset(true);
    assert.equal((await signup({ agreements: true })).statusCode, 400);
    assert.equal((await signup({ legalEvidence: { terms: { ...input.legalEvidence.terms, version: 'old' } } })).statusCode, 409);
    assert.equal(state.users.length, 0);
    assert.equal(state.issueCalls, 0);
});
test('ledger failure rolls back registration and cannot issue an unaudited account token', async () => {
    reset(true); state.failLedger = true;
    assert.equal((await signup(input)).statusCode, 500);
    assert.equal(state.users.length, 0);
    assert.equal(state.receipts.length, 0);
    assert.equal(state.issueCalls, 0);
});
