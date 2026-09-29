'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const servicePath = path.resolve(__dirname, '../../services/consentimientos.service.js');
function harness({ document = {}, packageRow = {} } = {}) {
    let writes = 0;
    const updates = [];
    const doc = { id: 1, public_id: 'qa_document', status: 'pending', ...document, update: async patch => { writes++; updates.push(patch); } };
    const pack = { id: 1, public_id: 'qa_package', status: 'pending', documents: [doc], ...packageRow };
    const db = { Sequelize: { Op: {} }, PatientConsentDocument: { findByPk: async () => doc }, PatientIntakeRequest: { findOne: async () => null },
        ConsentSignaturePackage: { findOne: async () => pack, findByPk: async () => pack },
        ConsentDeliveryEvent: { create: async () => { writes++; } } };
    const nativeRequire = createRequire(servicePath), module = { exports: {} };
    const localRequire = name => name === '../../models' ? db : name === 'jsonwebtoken'
        ? { verify: () => ({ type: 'consent_signature_package', package_public_id: 'qa_package' }) } : nativeRequire(name);
    vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), { require: localRequire, module, exports: module.exports, __dirname: path.dirname(servicePath), process: { env: {} }, Buffer, console });
    return { service: module.exports, writes: () => writes, updates };
}
const valid = { signer_name: 'Paciente ficticio QA', accepted_statement: true, signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };
for (const [label, change, code] of [
    ['missing declaration', { accepted_statement: undefined }, 'consent_signature_statement_required'],
    ['declined declaration', { accepted_statement: false }, 'consent_signature_statement_required'],
    ['string declaration', { accepted_statement: 'false' }, 'consent_signature_statement_required'],
    ['missing name', { signer_name: '' }, 'consent_signature_name_required'],
    ['missing drawing', { signature_data_url: null }, 'consent_drawn_signature_required'],
    ['non image drawing', { signature_data_url: 'data:image/png;base64,aGVsbG8=' }, 'consent_drawn_signature_required'],
    ['invalid role', { signer_role: 'doctor' }, 'consent_signature_role_invalid'],
]) test(label + ' is rejected before writes, even through the direct document API', async () => {
    const h = harness();
    await assert.rejects(h.service.signConsentDocument('1', { ...valid, ...change }), e => e.message === code && e.statusCode === 400);
    assert.equal(h.writes(), 0);
});
for (const packageRow of [{ status: 'cancelled' }, { status: 'expired' }, { expires_at: new Date(0) }]) {
    for (const method of ['getPublicPackage', 'signPublicPackage', 'createTabletSession']) test(method + ' rejects unavailable package ' + JSON.stringify(packageRow), async () => {
        const h = harness({ packageRow });
        await assert.rejects(h.service[method]('1', valid), e => e.statusCode === 410);
        assert.equal(h.writes(), 0);
    });
}
test('expired document cannot be signed', async () => {
    const h = harness({ document: { expires_at: new Date(0) } });
    await assert.rejects(h.service.signConsentDocument('1', valid), e => e.statusCode === 409);
    assert.equal(h.writes(), 0);
});
test('minor requires a representative and relationship', async () => {
    const h = harness({ document: { snapshot_json: { patient_flags: { is_minor: true }, template: { requires_representative_when_minor: true } } } });
    await assert.rejects(h.service.signPublicPackage('1', valid), e => e.message === 'representative_signature_required');
    await assert.rejects(h.service.signPublicPackage('1', { ...valid, signer_role: 'representative' }), e => e.message === 'representative_signature_required');
    assert.equal(h.writes(), 0);
});
test('already signed package rejects duplicate submission', async () => {
    const h = harness({ document: { status: 'signed' } });
    await assert.rejects(h.service.signPublicPackage('1', valid), e => e.statusCode === 409);
    assert.equal(h.writes(), 0);
});

const professionalDocument = { status: 'signed', snapshot_json: { template: { requires_professional_signature: true } } };
for (const accepted_statement of [undefined, false, 'true']) test('professional signature requires an explicit boolean acceptance: ' + accepted_statement, async () => {
    const h = harness({ document: professionalDocument });
    await assert.rejects(h.service.signProfessionalConsentDocument('1', { accepted_statement }, 17), e => e.message === 'professional_signature_statement_required');
    assert.equal(h.writes(), 0);
});
test('professional signature cannot impersonate a supplied identity or omit its actor', async () => {
    const h = harness({ document: professionalDocument });
    await assert.rejects(h.service.signProfessionalConsentDocument('1', { accepted_statement: true, professional_id: 99 }, 17), e => e.message === 'professional_signature_actor_mismatch');
    await assert.rejects(h.service.signProfessionalConsentDocument('1', { accepted_statement: true }, null), e => e.statusCode === 401);
    assert.equal(h.writes(), 0);
});
test('professional signature uses the authenticated actor and server evidence, not client names or methods', async () => {
    const h = harness({ document: professionalDocument });
    await h.service.signProfessionalConsentDocument('1', { accepted_statement: true, professional_name: 'Someone else', method: 'forged' }, 17);
    assert.equal(h.updates[0].professional_signed_by, 17);
    const evidence = h.updates[0].snapshot_json.professional_signature_evidence;
    assert.equal(evidence.professional_id, 17);
    assert.equal(evidence.professional_name, null);
    assert.equal(evidence.method, 'professional_confirmation');
});
test('professional countersignature cannot revive an expired document', async () => {
    const h = harness({ document: { ...professionalDocument, expires_at: new Date(0) } });
    await assert.rejects(h.service.signProfessionalConsentDocument('1', { accepted_statement: true }, 17), e => e.statusCode === 409);
    assert.equal(h.writes(), 0);
});
