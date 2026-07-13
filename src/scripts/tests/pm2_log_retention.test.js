'use strict';

const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Transform } = require('stream');
const { createGzip, gunzipSync } = require('zlib');
const { runPm2LogRetention } = require('../../services/pm2LogRetention.service');

async function setMtime(filePath, date) {
  await fs.utimes(filePath, date, date);
}

async function testRotationCompressionAndRetention() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pm2-retention-'));
  const activePath = path.join(directory, 'active-out.log');
  const expiredPath = path.join(directory, 'stopped-out.log');
  const recentPath = path.join(directory, 'recent-rotation.log');
  const now = new Date('2026-07-13T18:00:00.000Z');
  const activeMtime = new Date('2026-07-10T12:34:56.000Z');
  const activeOutput = Buffer.from('active output '.repeat(20_000));

  await fs.writeFile(activePath, activeOutput);
  await fs.writeFile(expiredPath, 'expired output');
  await fs.writeFile(recentPath, 'recent output');
  await setMtime(activePath, activeMtime);
  await setMtime(expiredPath, new Date('2026-05-01T00:00:00.000Z'));
  await setMtime(recentPath, new Date('2026-07-01T00:00:00.000Z'));

  const commands = [];
  const timeline = [];
  const commandRunner = async (_binary, args) => {
    commands.push(args.join(' '));
    timeline.push(args[0]);
    if (args[0] === 'jlist') {
      return {
        stdout: JSON.stringify([
          {
            pm2_env: {
              status: 'online',
              pm_out_log_path: activePath,
              pm_err_log_path: path.join(directory, 'active-error.log'),
            },
          },
          {
            pm2_env: {
              status: 'stopped',
              pm_out_log_path: expiredPath,
            },
          },
        ]),
      };
    }
    return { stdout: 'Reloading all logs' };
  };
  let gzipCalls = 0;
  const gzipFactory = () => {
    gzipCalls += 1;
    timeline.push('gzip');
    return createGzip();
  };

  try {
    const dryRun = await runPm2LogRetention({
      directory,
      retentionDays: 60,
      now,
      dryRun: true,
      commandRunner,
      gzipFactory,
    });
    assert.equal(dryRun.files_rotated, 1);
    assert.equal(dryRun.files_compressed, 0);
    assert.equal(dryRun.bytes_compressed_input, 0);
    assert.equal(dryRun.bytes_compressed_output, 0);
    assert.equal(dryRun.files_deleted, 1);
    assert.equal(commands.filter((command) => command === 'reloadLogs').length, 0);
    assert.equal(gzipCalls, 0, 'dry-run must not start a gzip stream');
    await fs.access(activePath);
    await fs.access(expiredPath);
    assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.gz')), false);

    const result = await runPm2LogRetention({
      directory,
      retentionDays: 60,
      now,
      commandRunner,
      gzipFactory,
    });
    assert.equal(result.files_rotated, 1);
    assert.equal(result.bytes_rotated, activeOutput.length);
    assert.equal(result.files_compressed, 1);
    assert.equal(result.bytes_compressed_input, activeOutput.length);
    assert(result.bytes_compressed_output > 0);
    assert(result.bytes_compressed_output < result.bytes_compressed_input);
    assert.equal(
      result.bytes_saved,
      result.bytes_compressed_input - result.bytes_compressed_output
    );
    assert.equal(result.files_deleted, 1);
    assert.equal(commands.filter((command) => command === 'reloadLogs').length, 1);
    assert(timeline.lastIndexOf('reloadLogs') < timeline.lastIndexOf('gzip'));
    await assert.rejects(() => fs.access(activePath), { code: 'ENOENT' });
    await assert.rejects(() => fs.access(expiredPath), { code: 'ENOENT' });
    await fs.access(recentPath);

    const remaining = await fs.readdir(directory);
    const compressedName = result.compressed_files[0];
    assert(compressedName.startsWith('active-out.2026-07-13T18-00-00-000Z'));
    assert(compressedName.endsWith('.log.gz'));
    assert(remaining.includes(compressedName));
    assert.equal(remaining.some((name) => name.includes('.tmp-')), false);

    const compressedPath = path.join(directory, compressedName);
    assert.deepEqual(gunzipSync(await fs.readFile(compressedPath)), activeOutput);
    const compressedStat = await fs.stat(compressedPath);
    assert(Math.abs(compressedStat.mtimeMs - activeMtime.getTime()) < 2);
    await assert.rejects(
      () => fs.access(compressedPath.slice(0, -'.gz'.length)),
      { code: 'ENOENT' }
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testAtomicFailureCanBeRecovered() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pm2-retention-retry-'));
  const activePath = path.join(directory, 'retry-out.log');
  const activeOutput = Buffer.from('retry output '.repeat(10_000));
  const now = new Date('2026-07-13T19:00:00.000Z');
  const activeMtime = new Date('2026-07-12T09:00:00.000Z');
  await fs.writeFile(activePath, activeOutput);
  await setMtime(activePath, activeMtime);

  const commandRunner = async (_binary, args) => {
    if (args[0] === 'jlist') {
      return {
        stdout: JSON.stringify([{
          pm2_env: {
            status: 'online',
            pm_out_log_path: activePath,
          },
        }]),
      };
    }
    return { stdout: 'Reloading all logs' };
  };

  const failingGzipFactory = () => new Transform({
    transform(_chunk, _encoding, callback) {
      callback(new Error('forced gzip failure'));
    },
  });

  try {
    await assert.rejects(
      () => runPm2LogRetention({
        directory,
        retentionDays: 60,
        now,
        commandRunner,
        gzipFactory: failingGzipFactory,
      }),
      /forced gzip failure/
    );

    const afterFailure = await fs.readdir(directory);
    const rawRotation = afterFailure.find((name) => (
      name.startsWith('retry-out.2026-07-13T19-00-00-000Z') && name.endsWith('.log')
    ));
    assert(rawRotation, 'a failed gzip must leave the complete raw rotation for retry');
    assert.equal(afterFailure.some((name) => name.endsWith('.gz')), false);
    assert.equal(afterFailure.some((name) => name.includes('.tmp-')), false);

    const recovered = await runPm2LogRetention({
      directory,
      retentionDays: 60,
      now,
      commandRunner,
    });
    assert.equal(recovered.files_rotated, 0);
    assert.equal(recovered.files_compressed, 1);
    assert.equal(recovered.bytes_compressed_input, activeOutput.length);

    const compressedPath = path.join(directory, recovered.compressed_files[0]);
    assert.deepEqual(gunzipSync(await fs.readFile(compressedPath)), activeOutput);
    const compressedStat = await fs.stat(compressedPath);
    assert(Math.abs(compressedStat.mtimeMs - activeMtime.getTime()) < 2);
    await assert.rejects(() => fs.access(path.join(directory, rawRotation)), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function run() {
  await testRotationCompressionAndRetention();
  await testAtomicFailureCanBeRecovered();
  console.log('pm2_log_retention.test.js: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
