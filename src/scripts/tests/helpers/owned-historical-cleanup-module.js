'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Load the exact operator without .env, production models or its CLI entrypoint.
// SQL tests inject only their owned Unix-socket database and private output path.
module.exports = function loadCleanup({ db = {}, backupDir = '', logs = [] } = {}) {
  const file = path.resolve(__dirname, '../../cleanup-propdental-future-imported-historical-appointments.js');
  const module = { exports: {} };
  const localRequire = id => {
    if (id === 'dotenv') return { config() {} };
    if (id === '../../models') return db;
    return require(id);
  };
  localRequire.main = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, require: localRequire,
    process: { env: { CLINICACLICK_CLEANUP_BACKUP_DIR: backupDir }, argv: [] },
    console: { log: value => logs.push(JSON.parse(value)), error: value => logs.push(JSON.parse(value)) },
  }, { filename: file });
  return module.exports;
};
