#!/usr/bin/env node
'use strict';

// Explicitly scoped additive cut. Never runs the generic pending migration queue,
// imports patients, activates appointment profiles or changes automation settings.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createGzip } = require('node:zlib');

const ALLOWED = [
  '20260906230000-create-patient-follow-ups.js',
  '20260907001500-create-treatment-protocols.js',
  '20260907003000-create-treatment-programs.js',
  '20260907010000-create-appointment-booking-occupancy.js',
];
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--backup', '--apply-new-schema'].includes(args[0])) throw new Error('Uso: cliniccloud-dev-schema.js --backup | --apply-new-schema (siempre crea backup privado nuevo).');
  const repo = path.resolve(__dirname, '../..');
  if (repo !== '/home/ubuntu/wt/back-dev' || process.cwd() !== repo) throw new Error('Este corte solo se ejecuta desde el worktree back-dev.');
  require('dotenv').config({ quiet: true });
  const db = require('../../models');
  const dir = await fsp.mkdtemp('/home/ubuntu/secure-imports/cliniccloud-dev-schema-');
  await fsp.chmod(dir, 0o700);
  try {
    const config = db.sequelize.config;
    if (config.dialect && config.dialect !== 'mysql') throw new Error('Este backup requiere MySQL.');
    await db.sequelize.authenticate();
    const backup = path.join(dir, 'database-before.sql.gz');
    const dump = spawn('mysqldump', ['--single-transaction', '--skip-lock-tables', '--hex-blob', '--no-tablespaces', '--routines', '--triggers', '--host', String(config.host), '--port', String(config.port || 3306), '--user', String(config.username), String(config.database)], {
      env: { ...process.env, MYSQL_PWD: config.password || '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const diagnostic = fs.createWriteStream(path.join(dir, 'backup-diagnostic.txt'), { flags: 'wx', mode: 0o600 });
    dump.stderr.pipe(diagnostic);
    const finished = new Promise((resolve, reject) => { dump.once('error', reject); dump.once('close', code => code === 0 ? resolve() : reject(new Error('mysqldump falló; el diagnóstico queda solo en el directorio privado.'))); });
    await Promise.all([finished, pipeline(dump.stdout, createGzip(), fs.createWriteStream(backup, { flags: 'wx', mode: 0o600 }))]);
    const manifest = { generated_at: new Date().toISOString(), scope: 'shared_database_additive_dev_schema_only', backup: { file: 'database-before.sql.gz', bytes: (await fsp.stat(backup)).size, sha256: await digest(backup) }, migrations: [], business_data_changed: false, automation_activated: false, booking_flags_changed: false };
    if (!manifest.backup.bytes) throw new Error('Backup vacío: no se aplica ningún esquema.');
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const q = db.sequelize.getQueryInterface();
    const [existing] = await db.sequelize.query('SELECT name FROM SequelizeMeta');
    const applied = new Set(existing.map(row => row.name));
    if (args[0] === '--apply-new-schema') {
      for (const name of ALLOWED) await fsp.access(path.join(repo, 'migrations', name));
      for (const name of ALLOWED) {
        const file = path.join(repo, 'migrations', name);
        const hash = await digest(file);
        if (applied.has(name)) { manifest.migrations.push({ name, sha256: hash, action: 'already_applied' }); continue; }
        const entry = { name, sha256: hash, action: 'applying' };
        manifest.migrations.push(entry);
        await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
        await require(file).up(q, db.Sequelize);
        await q.bulkInsert('SequelizeMeta', [{ name }]);
        entry.action = 'applied';
        await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      }
    }
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ backup_directory: dir, backup_bytes: manifest.backup.bytes, backup_sha256: manifest.backup.sha256, migrations: manifest.migrations.map(({ name, action }) => ({ name, action })), business_data_changed: false, automation_activated: false }));
  } finally { await db.sequelize.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.message?.startsWith('Uso:') ? error.message : 'Corte detenido. No se han activado mensajes ni importaciones; revisar diagnóstico privado y estado de las tablas antes de reintentar.'); process.exitCode = 1; });
module.exports = { ALLOWED };
