#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { captureRecipientRegistration, applyRecipientRegistration } = require('../lib/recipient-list-registration');

async function run(argv) {
  if (argv.length % 2) throw Error('RECIPIENT_ARGUMENTS_INVALID');
  const options = {};
  const allowed = new Set(['--target','--clinic','--list','--mode','--out','--apply-sha256','--actor']);
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || Object.hasOwn(options, argv[i])) throw Error('RECIPIENT_ARGUMENTS_INVALID');
    options[argv[i]] = argv[i + 1];
  }
  const target = options['--target'], mode = options['--mode'];
  const clinicId = Number(options['--clinic']), listId = Number(options['--list']), actorId = Number(options['--actor']);
  if (!['dev','crm'].includes(target) || !['prepare','apply'].includes(mode)
    || !Number.isSafeInteger(clinicId) || clinicId <= 0 || !Number.isSafeInteger(listId) || listId <= 0) throw Error('RECIPIENT_EXPLICIT_TARGET_REQUIRED');
  const out = options['--out'];
  if (!out || !path.isAbsolute(out) || !fs.realpathSync(out).startsWith('/home/ubuntu/secure-imports/')
    || (fs.statSync(out).mode & 0o077)) throw Error('RECIPIENT_PRIVATE_OUTPUT_REQUIRED');
  const write = (name, value) => {
    const fd = fs.openSync(path.join(out,name), 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value,null,2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const connection = await connectOperatorDatabase(target);
  try {
    if (mode === 'prepare') {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const snapshot = await captureRecipientRegistration(connection, { clinicId,listId });
      await connection.rollback();
      write('registration-prepare.json', { target,capturedAt:new Date().toISOString(),snapshot });
      return { target,mode,clinicId,listId,sha256:snapshot.plan.sha256,counts:snapshot.plan.counts,messagesSent:0 };
    }
    if (!Number.isSafeInteger(actorId) || actorId <= 0) throw Error('RECIPIENT_ACTOR_REQUIRED');
    const result = await applyRecipientRegistration(connection, { clinicId,listId,expectedSha256:options['--apply-sha256'],actorId,
      beforeCommit: async journal => write('registration-before-commit.json', { target,at:new Date().toISOString(),...journal }) });
    write('registration-committed.json', { target,at:new Date().toISOString(),...result });
    return { target,mode,clinicId,listId,created:result.created,linkedExisting:result.linkedExisting,counts:result.counts,messagesSent:0 };
  } finally { await connection.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result,null,2))).catch(error => {
  console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'RECIPIENT_REGISTRATION_REQUIRES_PRIVATE_JOURNAL_REVIEW'); process.exitCode = 1;
});
module.exports = { run };
