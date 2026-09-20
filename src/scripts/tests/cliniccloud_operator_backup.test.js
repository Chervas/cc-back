'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { optionValue, clientOptions, validateDirectory } = require('../cliniccloud-operator-backup');
test('MySQL client secrets are quoted and cannot inject another option', () => {
  assert.equal(optionValue('a"b\\c\nuser=root'), '"a\\"b\\\\c\\nuser=root"');
  const text = clientOptions({ host: 'localhost', port: 3306, user: 'qa', password: 's\necret' });
  assert.equal(text.split('\n').length, 6);
  assert.match(text, /password="s\\necret"/);
});
test('backup refuses a workspace, root and a missing output directory', () => {
  for (const directory of ['/home/ubuntu/wt/back-dev', '/home/ubuntu/secure-imports', '/home/ubuntu/secure-imports/not-created-output']) {
    assert.throws(() => validateDirectory(directory));
  }
});
