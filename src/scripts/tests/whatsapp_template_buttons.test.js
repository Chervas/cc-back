'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {normalizeQuickReplyButtons} = require('../../lib/whatsapp-template-buttons');
const {customSubmissionName, runCustomSubmission} = require('../../lib/whatsapp-custom-submission');
const base = {clinicId: 1, wabaId: 'TESTONLY', createdByUserId: 1, bodyText: 'TESTONLY hello', displayName: 'TESTONLY'};
test('quick replies validate the actual provider definition and reject invalid or duplicated choices', () => {
  assert.deepEqual(normalizeQuickReplyButtons([{type:'QUICK_REPLY',text:' Sí '},{type:'QUICK_REPLY',text:'No'}]), [{type:'QUICK_REPLY',text:'Sí'},{type:'QUICK_REPLY',text:'No'}]);
  for (const input of [{}, ['Sí'], [{type:'URL',text:'Web'}], [{type:'QUICK_REPLY',text:''}], [{type:'QUICK_REPLY',text:'x'.repeat(26)}],
    [{type:'QUICK_REPLY',text:'Sí'},{type:'QUICK_REPLY',text:' sí '}], [{type:'QUICK_REPLY',text:'{{1}}'}], Array.from({length:11},(_,i)=>({type:'QUICK_REPLY',text:String(i)}))]) {
    assert.throws(()=>normalizeQuickReplyButtons(input), {code:'template_buttons_invalid',statusCode:400});
  }
});
test('button edits and explicit removal have distinct retry identities; old callers retain their identity', () => {
  const yes = {...base, buttons:[{type:'QUICK_REPLY',text:'Sí'}]};
  assert.notEqual(customSubmissionName(base), customSubmissionName(yes));
  assert.notEqual(customSubmissionName(yes), customSubmissionName({...base,buttons:[]}));
  assert.notEqual(customSubmissionName(base), customSubmissionName({...base,buttons:[]}));
  assert.equal(customSubmissionName(yes),customSubmissionName({...yes,buttons:[{type:'QUICK_REPLY',text:' Sí '}]}));
});
test('invalid buttons fail before taking a lease or creating provider/local records', async () => {
  await assert.rejects(runCustomSubmission({...base,buttons:[{type:'QUICK_REPLY',text:''}]},{acquire:()=>assert.fail('lease must not start')}), {code:'template_buttons_invalid'});
});
