'use strict';

const { UUID } = require('../services/metaMarketingEnrollment.contract');
const { routesForEnrollment } = require('../services/socialInboxRoute.service');

// Inspect one active enrollment in its own runtime. The result describes CRM
// assignments only; the broker and the messaging provider authorize independently.
async function main(argv) {
  const [runtime, enrollmentId] = argv;
  if (argv.length !== 2 || !['dev', 'staging', 'prod'].includes(runtime) || !UUID.test(enrollmentId))
    throw Error('social_routes_arguments');
  require('dotenv').config();
  require('./meta-lead-historical-recovery').assertRuntime(runtime);
  const db = require('../../models');
  try {
    return await db.sequelize.transaction(t => routesForEnrollment(db, enrollmentId, t));
  } finally {
    await db.sequelize.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(report => {
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.status !== 'resolved') process.exitCode = 2;
  }).catch(err => {
    const code = err.code || err.message;
    process.stderr.write((/^social_routes_arguments$|^meta_lead_recovery_runtime_/.test(code) ? code : 'social_routes_check_failed') + '\n');
    process.exitCode = 1;
  });
}
