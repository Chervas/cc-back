#!/usr/bin/env node
'use strict';

// Deliberately separate from the reception queue: --apply writes only private
// form events for explicitly listed, existing leads. The default is DB-only.
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const result = { leadIds: [], clinicIds: [], apply: false, runtime: null, output: null };
  const integer = value => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value)
    && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--apply') { if (result.apply) throw Error('meta_lead_form_cli_invalid'); result.apply = true; continue; }
    if (!['--lead-id', '--clinic-id', '--runtime', '--output'].includes(key)
      || i + 1 >= argv.length) throw Error('meta_lead_form_cli_invalid');
    const value = argv[++i];
    if (key === '--lead-id' || key === '--clinic-id') {
      const number = integer(value); if (number === null) throw Error('meta_lead_form_cli_invalid');
      result[key === '--lead-id' ? 'leadIds' : 'clinicIds'].push(number);
    } else if (key === '--runtime') {
      if (result.runtime !== null || !['dev', 'staging', 'prod'].includes(value)) throw Error('meta_lead_form_cli_invalid');
      result.runtime = value;
    } else {
      if (result.output !== null || !path.isAbsolute(value)) throw Error('meta_lead_form_cli_invalid');
      result.output = value;
    }
  }
  if (!result.runtime || !result.leadIds.length || result.leadIds.length > 20 || !result.clinicIds.length
    || result.clinicIds.length > 20 || new Set(result.leadIds).size !== result.leadIds.length
    || new Set(result.clinicIds).size !== result.clinicIds.length) throw Error('meta_lead_form_cli_invalid');
  return result;
}

async function main(argv) {
  const options = parseArgs(argv);
  let models, outputFd = null;
  try {
    if (options.output) {
      // Reserve the destination BEFORE loading models or doing any provider I/O
      // or DML. A pre-existing report/symlink must not turn a committed recovery
      // into an apparent failure when writing its report afterwards.
      fs.mkdirSync(path.dirname(options.output), { recursive: true, mode: 0o700 });
      outputFd = fs.openSync(options.output,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    }
    // Credentials follow the runtime's existing .env/config selector. They never
    // appear in arguments, output, recovery reports or a copied environment file.
    require('dotenv').config({ path: path.join(process.cwd(), '.env') });
    const { receptionRuntimeNamespace } = require('../services/metaLeadReception.service');
    if (process.env.RUNTIME_ROLE === 'gateway' || receptionRuntimeNamespace() !== options.runtime)
      throw Error('meta_lead_form_cli_runtime_mismatch');
    const originalLog = console.log;
    try {
      // Legacy model bootstrap prints model names; retain a single JSON report.
      console.log = () => {};
      models = require('../../models');
    } finally { console.log = originalLog; }
    const reader = options.apply ? require('../services/metaMarketingLeadReader.service').forModels(models) : null;
    const service = require('../services/metaLeadFormEnrichment.service').createMetaLeadFormEnrichment({
      models, reader, runtime: options.runtime,
    });
    const report = { at: new Date().toISOString(), ...await service.run(options) };
    if (outputFd !== null) {
      fs.writeFileSync(outputFd, JSON.stringify(report, null, 2) + '\n');
      fs.fsyncSync(outputFd);
    }
    console.log(JSON.stringify(report));
    if (report.results.some(row => ['unavailable', 'not_attempted'].includes(row.status))) process.exitCode = 2;
  } finally {
    try { if (models) await models.sequelize.close(); }
    finally { if (outputFd !== null) fs.closeSync(outputFd); }
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(() => {
  // Provider errors may carry request/response objects: never print them.
  console.error(JSON.stringify({ success: false, code: 'meta_lead_form_enrichment_failed' }));
  process.exitCode = 1;
});

module.exports = { parseArgs, main };
