'use strict';
// Observe a manager and its application as distinct Linux processes. No process
// environment or credentials are read, returned, or used as an identity.
const fs = require('node:fs');
const path = require('node:path');
const fail = code => { throw Error(code); };
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) fail('clinical_cut_process_invalid');
  const root = '/proc/' + pid;
  const stat = fs.readFileSync(root + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  if (['Z', 'X'].includes(fields[0])) fail('clinical_cut_process_exited');
  return { pid, parentPid: Number(fields[1]), startTicks: fields[19], uid: fs.statSync(root).uid };
}
function applicationProcesses(root) {
  const found = [];
  for (const value of fs.readdirSync('/proc').filter(v => /^[1-9][0-9]*$/.test(v))) {
    const pid = Number(value);
    try {
      if (fs.realpathSync('/proc/' + pid + '/cwd') !== root) continue;
      const argv = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
      if (path.basename(argv[0]) === 'node' && argv[1] === 'src/app.js') found.push(processIdentity(pid));
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return found;
}
function observePm2Application({ rows, id, root }) {
  root = fs.realpathSync(root);
  const matches = rows.filter(row => row.name === id);
  if (matches.length !== 1) fail('clinical_cut_manager_ambiguous');
  const row = matches[0];
  if (fs.realpathSync(row.pm2_env.pm_cwd) !== root) fail('clinical_cut_manager_root_changed');
  const applications = applicationProcesses(root);
  if (row.pm2_env.status === 'stopped' && !row.pid) {
    return applications.length ? { state: 'stopping', pid: 0 } : { state: 'stopped', pid: 0 };
  }
  if (row.pm2_env.status !== 'online') return { state: row.pm2_env.status, pid: row.pid || 0 };
  if (!applications.length) return { state: 'starting', pid: row.pid };
  if (applications.length !== 1) fail('clinical_cut_application_ambiguous');
  const manager = processIdentity(row.pid), application = applications[0], lineage = [];
  if (fs.realpathSync('/proc/' + manager.pid + '/cwd') !== root) fail('clinical_cut_manager_root_changed');
  let current = application;
  for (let depth = 0; current.pid !== manager.pid; depth++) {
    if (depth >= 16 || current.parentPid < 2 || current.uid !== manager.uid) fail('clinical_cut_application_not_managed');
    lineage.push(current); current = processIdentity(current.parentPid);
  }
  if (JSON.stringify(current) !== JSON.stringify(manager)
    || JSON.stringify(processIdentity(application.pid)) !== JSON.stringify(application)
    || JSON.stringify(processIdentity(manager.pid)) !== JSON.stringify(manager)) fail('clinical_cut_process_changed_during_observation');
  return { state: 'running', pid: manager.pid, identity: { manager, application, lineage } };
}
module.exports = { processIdentity, applicationProcesses, observePm2Application };
