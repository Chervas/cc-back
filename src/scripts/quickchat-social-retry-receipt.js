'use strict';

const { retryReviewedReceipt } = require('../services/socialInboxIntake.service');

async function main(args) {
  const [runtime, clinic, channel, accountId, receiptKey] = args;
  if (args.length !== 5 || !['dev', 'staging', 'prod'].includes(runtime) || !/^[1-9]\d*$/.test(clinic) ||
      !Number.isSafeInteger(Number(clinic)) || !['instagram', 'messenger'].includes(channel) ||
      !/^[1-9]\d{0,29}$/.test(accountId) || !/^[a-f0-9]{64}$/.test(receiptKey))
    throw Error('social_retry_arguments');

  require('dotenv').config();
  require('./meta-lead-historical-recovery').assertRuntime(runtime);
  const db = require('../../models');
  try {
    const queued = await retryReviewedReceipt(db, receiptKey, { clinicId: Number(clinic), channel, accountId, namespace: runtime });
    return { queued };
  } finally {
    await db.sequelize.close();
  }
}

if (require.main === module) main(process.argv.slice(2)).then(
  result => process.stdout.write(JSON.stringify(result) + '\n'),
  error => { process.stderr.write(error.message === 'social_retry_arguments' ? 'social_retry_arguments\n' : 'social_retry_failed\n'); process.exitCode = 1; },
);
module.exports = { main };
