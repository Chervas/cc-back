'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const I = require('../../lib/whatsapp-contact-identity'), P = require('../../lib/phone');
test('opaque identifiers cannot become phone candidates and portfolio scope remains exact', () => {
    for (const input of ['ES.123456789', 'es.123456789', 'bsuid:301:ES.123456789']) {
        assert.equal(P.normalizePhoneE164(input), null);
        assert.deepEqual(P.getPhoneIdentityCandidates(input), []);
        assert.deepEqual(P.getPhoneLookupCandidates(input), []);
    }
    assert.equal(I.contactFor('301', 'ES.123ABC'), 'bsuid:301:ES.123ABC');
    assert.notEqual(I.key(71, '301', 'bsuid', 'ES.123ABC'), I.key(71, '302', 'bsuid', 'ES.123ABC'));
    assert.notEqual(I.key(71, '301', 'bsuid', 'ES.123ABC'), I.key(72, '301', 'bsuid', 'ES.123ABC'));
    assert.throws(() => I.contactFor('', 'ES.123ABC'), /scope_required/);
});
test('provider aliases need a unique matching contact; display names and other vCards never prove identity', () => {
    const m = { from_user_id: 'ES.123ABC', from: '19995550101' }, contacts = [{ user_id: 'ES.123ABC', wa_id: '19995550101', profile: { name: 'Test name', username: 'test_alias' } }];
    assert.equal(I.providerIdentity(m, contacts).phone, '19995550101');
    assert.throws(() => I.providerIdentity(m, [...contacts, ...contacts]), /identity_conflict/);
    assert.throws(() => I.providerIdentity({ ...m, from: '19995550102' }, contacts), /identity_conflict/);
    assert.equal(I.providerIdentity({ from_user_id: 'ES.123ABC' }, []).bsuid, 'ES.123ABC');
    assert.equal(I.providerIdentity({ from_user_id: 'ES.123ABC' }, []).phone, null);
    const card = { from_user_id: 'ES.123ABC', type: 'contacts', contacts: [{ origin: 'other', phones: [{ wa_id: '19995550102' }] }] };
    const minimal = [{ user_id: 'ES.123ABC', profile: { name: 'Test name' } }];
    assert.equal(I.providerIdentity(card, minimal).phone, null);
    assert.equal(I.providerIdentity({ ...card, contacts: [{ ...card.contacts[0], origin: 'contact_request' }] }, minimal).phone, '19995550102');
});

test('the native importer preserves provider ad evidence without inventing an organic source',()=>{
 const D=require('../../lib/whatsappInboundDetails');
 const referral={source_type:'ad',source_id:'9001',source_url:'https://example.invalid/ad',ctwa_clid:'fictitious-click',headline:'Fictitious ad',body:'Fictitious description',untrusted_extra:'discard'};
 const result=D.details({type:'text',text:{body:'Fictitious reply'},referral}).referral;
 assert.equal(result.source_id,'9001');assert.equal(result.ctwa_clid,'fictitious-click');assert.equal(result.untrusted_extra,undefined);
 assert.equal(D.details({type:'text',text:{body:'Fictitious direct reply'}}).referral,undefined);
});
