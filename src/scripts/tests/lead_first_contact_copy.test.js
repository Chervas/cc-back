'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const migration = require('../../../migrations/20260922044000-distinguish-lead-first-contact-call');
test('called and uncalled templates retain the same variable contract but different truthful copy', () => {
  const { BEFORE, AFTER } = migration.__testing;
  assert.notEqual(BEFORE, AFTER);
  assert(!BEFORE.includes('intentado llamarte'));
  assert(AFTER.includes('Hemos intentado llamarte'));
  assert.deepEqual(AFTER.match(/\{\{\d+\}\}/g), BEFORE.match(/\{\{\d+\}\}/g));
  assert(AFTER.includes('no te molestaremos más'));
});
test('migration scopes to canonical catalogue and reverses only its own previous copy', async () => {
  const calls=[]; const qi={sequelize:{query:async(sql,options)=>calls.push({sql,...options})}};
  await migration.up(qi); await migration.down(qi);
  assert(calls[0].sql.includes('WHERE family_key=:family'));
  assert(calls[0].sql.includes('body_text=:expected'));
  assert(!calls[0].sql.includes('UPDATE WhatsappTemplates'));
  assert.equal(calls[0].replacements.next,calls[1].replacements.expected);
  assert.equal(calls[0].replacements.expected,calls[1].replacements.next);
});
