#!/usr/bin/env node
'use strict';

// Both provider scans and writes require an explicit mode. A scan produces a
// private plan; apply pins its exact bytes and never replays the reception job.
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const service = require('../services/metaLeadHistoricalRecovery.service');
const fail = code => { throw Object.assign(Error(code), { code }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = value => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value)
  && Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647 ? Number(value) : null;
function parseArgs(argv) {
  const result = { mode: null, runtime: null, output: null, plan: null, expectedSha256: null, clinicIds: [], acceptedJobIds: [] };
  const strings = { '--runtime': 'runtime', '--output': 'output', '--plan': 'plan', '--expected-sha256': 'expectedSha256',
    '--form-id': 'formId', '--start-date': 'startDate', '--end-date': 'endDate', '--start-instant': 'startInstant', '--end-instant': 'endInstant' };
  const integers = { '--actor-id': 'actorId', '--page-asset-id': 'pageAssetId', '--account-asset-id': 'accountAssetId',
    '--max-pages': 'maxPages', '--max-leads': 'maxLeads' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--scan' || key === '--apply') { if (result.mode !== null) fail('meta_lead_recovery_cli_invalid'); result.mode = key.slice(2); continue; }
    if ((!Object.hasOwn(strings,key) && !Object.hasOwn(integers,key) && !['--clinic-id','--accepted-job-id'].includes(key))
      || i + 1 >= argv.length) fail('meta_lead_recovery_cli_invalid');
    const value = argv[++i];
    if (key === '--clinic-id' || key === '--accepted-job-id') {
      const n = integer(value); if (n === null) fail('meta_lead_recovery_cli_invalid'); result[key === '--clinic-id' ? 'clinicIds' : 'acceptedJobIds'].push(n);
    } else {
      const name = strings[key] || integers[key]; if (Object.hasOwn(result,name) && result[name] !== null) fail('meta_lead_recovery_cli_invalid');
      result[name] = Object.hasOwn(integers,key) ? integer(value) : value;
      if (result[name] === null) fail('meta_lead_recovery_cli_invalid');
    }
  }
  if (!result.mode || !['dev','staging','prod'].includes(result.runtime) || !result.output || !path.isAbsolute(result.output)
    || path.resolve(result.output) !== result.output) fail('meta_lead_recovery_cli_invalid');
  if (result.mode === 'apply') {
    if (!result.plan || !path.isAbsolute(result.plan) || path.resolve(result.plan) !== result.plan
      || !/^[a-f0-9]{64}$/.test(result.expectedSha256 || '') || result.clinicIds.length || result.acceptedJobIds.length
      || Object.keys(integers).some(key => Object.hasOwn(result,integers[key]))
      || ['formId','startDate','endDate','startInstant','endInstant'].some(key => Object.hasOwn(result,key))) fail('meta_lead_recovery_cli_invalid');
  } else {
    if (result.plan || result.expectedSha256) fail('meta_lead_recovery_cli_invalid');
    service.normalizeInput({ ...result, apply: false });
  }
  return result;
}
function readPlan(filename, expectedSha256, uid = process.getuid()) {
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.uid !== uid || (before.mode & 0o077) !== 0 || before.nlink !== 1 || before.size > 1048576) fail('meta_lead_recovery_plan_private_required');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd); if (stat.ino !== before.ino || stat.dev !== before.dev) fail('meta_lead_recovery_plan_changed');
    const bytes = fs.readFileSync(fd); if (sha(bytes) !== expectedSha256) fail('meta_lead_recovery_plan_changed');
    let plan; try { plan = JSON.parse(bytes.toString('utf8')); } catch (_) { fail('meta_lead_recovery_plan_invalid'); }
    return { plan, input: service.optionsFromPlan(plan) };
  } finally { fs.closeSync(fd); }
}
function reserveOutput(directory, uid = process.getuid()) {
  const parent = path.dirname(directory), parentStat = fs.statSync(parent);
  if (fs.realpathSync(parent) !== parent || !parentStat.isDirectory() || parentStat.uid !== uid || (parentStat.mode & 0o022) !== 0)
    fail('meta_lead_recovery_output_private_required');
  fs.mkdirSync(directory,{mode:0o700});
  const opened = [];
  try {
    const open = name => { const fd = fs.openSync(path.join(directory,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);opened.push(fd);return fd; };
    const journalFd = open('journal.jsonl'), reportFd = open('report.json'), planFd = open('plan.json');
    const write = (fd,value) => {
      const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');let offset=0;fs.ftruncateSync(fd,0);
      while(offset<bytes.length){const written=fs.writeSync(fd,bytes,offset,bytes.length-offset,offset);if(!written)fail('meta_lead_recovery_journal_unavailable');offset+=written;}
      fs.fsyncSync(fd);
    };
    return { journal: async value => { fs.writeFileSync(journalFd,JSON.stringify(value)+'\n');fs.fsyncSync(journalFd); },
      report: value => write(reportFd,value), plan: value => write(planFd,value), close: () => { for(const fd of opened.splice(0)) fs.closeSync(fd); } };
  } catch (error) { for(const fd of opened) fs.closeSync(fd);throw error; }
}
function assertRuntime(runtime, { env = process.env, uid = process.getuid(), cwd = process.cwd() } = {}) {
  const filename = path.join(cwd,'.env'), stat = fs.lstatSync(filename);
  if (uid === 0 || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0) fail('meta_lead_recovery_runtime_uid');
  if (env.RUNTIME_ROLE === 'gateway' || require('../services/metaLeadReception.service').receptionRuntimeNamespace(env) !== runtime)
    fail('meta_lead_recovery_runtime_mismatch');
}
async function main(argv, dependencies = {}) {
  const options = parseArgs(argv);
  let input, loadedPlan = null;
  if (options.mode === 'apply') {
    loadedPlan = readPlan(options.plan,options.expectedSha256);input = loadedPlan.input;
    if (input.runtime !== options.runtime) fail('meta_lead_recovery_runtime_mismatch');
  } else input = { ...options, apply: false };
  const dotenv = dependencies.dotenv || (() => require('dotenv').config({path:path.join(process.cwd(),'.env')}));dotenv();
  (dependencies.assertRuntime || assertRuntime)(options.runtime);
  const output = reserveOutput(options.output);
  let models = null;
  try {
    const originalLog = console.log;
    try { console.log = () => {};models = (dependencies.loadModels || (() => require('../../models')))(); }
    finally { console.log = originalLog; }
    const reader = (dependencies.createReader || (m => require('../services/metaMarketingLeadReader.service').forModels(m)))(models);
    const factory = dependencies.createService || service.createHistoricalRecovery;
    const instance = factory({models,reader,journal:output.journal});
    const report = await instance.run(input);output.report(report);
    if (options.mode === 'scan') output.plan(report);
    else output.plan({version:1,mode:'apply-reference',sourcePlanSha256:options.expectedSha256,sourcePlanBatchId:loadedPlan.plan.batchId});
    const counts = report.results.reduce((all,row)=>(all[row.status]=(all[row.status]||0)+1,all),{});
    const summary = {success:report.complete,mode:options.mode,complete:report.complete,observed:report.observed,counts,messagesSent:0,
      output:options.output,...(options.mode==='scan'?{planSha256:sha(fs.readFileSync(path.join(options.output,'plan.json')))}:{})};
    console.log(JSON.stringify(summary));if (!report.complete) process.exitCode=2;
    return summary;
  } catch (error) {
    try { output.report({version:1,mode:options.mode,complete:false,code:/^meta_lead_[a-z_]{1,80}$/.test(error?.code||'')?error.code:'meta_lead_recovery_failed',messagesSent:0}); }
    catch (_) { /* Preserve the operation journal; never retry a possibly committed lead. */ }
    throw error;
  } finally {
    try { if(models?.sequelize?.close) await models.sequelize.close(); }
    finally { output.close(); }
  }
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{
  console.error(JSON.stringify({success:false,code:/^meta_lead_[a-z_]{1,80}$/.test(error?.code||'')?error.code:'meta_lead_recovery_failed'}));process.exitCode=1;
});
module.exports={parseArgs,readPlan,reserveOutput,assertRuntime,main};
