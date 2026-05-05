'use strict';

require('dotenv').config();

const originalLog = console.log;
console.log = () => {};
const db = require('../models');
console.log = originalLog;
const { copyClinicIntakeConfigToGroup } = require('../src/services/groupAssets.service');

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function main() {
  const clinicId = Number.parseInt(String(readArg('clinic') || ''), 10);
  const groupId = Number.parseInt(String(readArg('group') || ''), 10);
  const overwrite = process.argv.includes('--overwrite');
  const reason = readArg('reason') || 'manual_backfill';

  if (!Number.isInteger(clinicId) || !Number.isInteger(groupId)) {
    throw new Error('Uso: node scripts/copy-intake-config-to-group.js --clinic=<id> --group=<id> [--overwrite] [--reason=texto]');
  }

  const result = await copyClinicIntakeConfigToGroup({
    clinicId,
    groupId,
    overwrite,
    reason
  });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
