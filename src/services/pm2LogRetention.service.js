'use strict';

const fsNative = require('fs');
const fs = fsNative.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const { promisify } = require('util');
const { createGzip } = require('zlib');

const execFileAsync = promisify(execFile);
const DEFAULT_RETENTION_DAYS = 60;

const asPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const resolveLogDirectory = (explicitDirectory = null) => path.resolve(
  explicitDirectory
  || process.env.PM2_LOG_RETENTION_DIRECTORY
  || path.join(process.env.PM2_HOME || path.join(os.homedir(), '.pm2'), 'logs')
);

const isInsideDirectory = (candidate, directory) => {
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const rotationSuffix = (date) => date.toISOString().replace(/[:.]/g, '-');

async function uniqueRotationPath(sourcePath, now, fsImpl = fs) {
  const extension = path.extname(sourcePath);
  const base = extension ? sourcePath.slice(0, -extension.length) : sourcePath;
  const suffix = rotationSuffix(now);
  for (let index = 0; index < 1000; index += 1) {
    const discriminator = index ? `-${index}` : '';
    const candidate = `${base}.${suffix}${discriminator}${extension}`;
    let occupied = false;
    for (const reservedPath of [candidate, `${candidate}.gz`]) {
      try {
        await fsImpl.access(reservedPath);
        occupied = true;
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (!occupied) return candidate;
  }
  throw new Error(`No se pudo reservar un nombre de rotación para ${sourcePath}`);
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildRotatedLogMatcher = (activeLogPath) => {
  const extension = path.extname(activeLogPath);
  const fileName = path.basename(activeLogPath);
  const baseName = extension ? fileName.slice(0, -extension.length) : fileName;
  const timestampPattern = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';
  return new RegExp(
    `^${escapeRegExp(baseName)}\\.${timestampPattern}(?:-\\d+)?${escapeRegExp(extension)}$`
  );
};

async function listPendingRotatedLogs({ directory, activeLogPaths, rotatedPaths, fsImpl = fs }) {
  const entries = await fsImpl.readdir(directory, { withFileTypes: true });
  const currentRotationPaths = new Set(rotatedPaths.map((filePath) => path.resolve(filePath)));
  const matchers = activeLogPaths.map(buildRotatedLogMatcher);

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name))
    .filter((filePath) => (
      currentRotationPaths.has(path.resolve(filePath))
      || matchers.some((matcher) => matcher.test(path.basename(filePath)))
    ))
    .sort();
}

async function syncFile(filePath, fsImpl = fs) {
  const handle = await fsImpl.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function gzipFileAtomic(sourcePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const createReadStream = options.createReadStream || fsNative.createReadStream;
  const createWriteStream = options.createWriteStream || fsNative.createWriteStream;
  const gzipFactory = options.gzipFactory || createGzip;
  const pipelineImpl = options.pipelineImpl || pipeline;
  const sourceStat = await fsImpl.stat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size <= 0) return null;

  const targetPath = `${sourcePath}.gz`;
  let existingTargetStat = null;
  try {
    existingTargetStat = await fsImpl.stat(targetPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existingTargetStat) {
    if (!existingTargetStat.isFile()) {
      throw new Error(`El destino de compresión no es un fichero: ${targetPath}`);
    }

    // Una salida final solo aparece después del rename atómico. Si también
    // queda el origen, el intento anterior terminó entre rename y unlink.
    await fsImpl.utimes(targetPath, sourceStat.atime, sourceStat.mtime);
    const targetStat = await fsImpl.stat(targetPath);
    await fsImpl.unlink(sourcePath);
    return {
      sourcePath,
      targetPath,
      sourceBytes: sourceStat.size,
      targetBytes: targetStat.size,
      recovered: true,
    };
  }

  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await pipelineImpl(
      createReadStream(sourcePath),
      gzipFactory(),
      createWriteStream(temporaryPath, { flags: 'wx' })
    );
    await syncFile(temporaryPath, fsImpl);
    await fsImpl.utimes(temporaryPath, sourceStat.atime, sourceStat.mtime);
    await fsImpl.rename(temporaryPath, targetPath);
    const targetStat = await fsImpl.stat(targetPath);
    await fsImpl.unlink(sourcePath);
    return {
      sourcePath,
      targetPath,
      sourceBytes: sourceStat.size,
      targetBytes: targetStat.size,
      recovered: false,
    };
  } catch (error) {
    await fsImpl.unlink(temporaryPath).catch((cleanupError) => {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}

async function readActiveLogPaths({ commandRunner, pm2Binary, directory }) {
  const { stdout } = await commandRunner(pm2Binary, ['jlist'], {
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30000,
  });
  const processes = JSON.parse(String(stdout || '[]'));
  if (!Array.isArray(processes)) {
    throw new Error('pm2 jlist no devolvió una lista de procesos');
  }

  return Array.from(new Set(processes
    .filter((processInfo) => String(processInfo?.pm2_env?.status || '').toLowerCase() === 'online')
    .flatMap((processInfo) => [
      processInfo?.pm2_env?.pm_out_log_path,
      processInfo?.pm2_env?.pm_err_log_path,
    ])
    .filter(Boolean)
    .map((logPath) => path.resolve(String(logPath)))
    .filter((logPath) => isInsideDirectory(logPath, directory))));
}

async function runPm2LogRetention(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const retentionDays = asPositiveInteger(
    options.retentionDays ?? process.env.PM2_LOG_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS
  );
  const dryRun = options.dryRun === true;
  const directory = resolveLogDirectory(options.directory);
  const pm2Binary = String(options.pm2Binary || process.env.PM2_BIN || 'pm2');
  const commandRunner = options.commandRunner || execFileAsync;
  const fsImpl = options.fsImpl || fs;
  const cutoffMs = now.getTime() - (retentionDays * 24 * 60 * 60 * 1000);

  await fsImpl.mkdir(directory, { recursive: true });
  const activeLogPaths = await readActiveLogPaths({ commandRunner, pm2Binary, directory });
  const activePathSet = new Set(activeLogPaths);
  const report = {
    status: 'completed',
    dry_run: dryRun,
    directory,
    retention_days: retentionDays,
    cutoff_at: new Date(cutoffMs).toISOString(),
    active_log_paths: activeLogPaths.length,
    files_rotated: 0,
    bytes_rotated: 0,
    files_compressed: 0,
    bytes_compressed_input: 0,
    bytes_compressed_output: 0,
    bytes_saved: 0,
    files_deleted: 0,
    bytes_deleted: 0,
    rotated_files: [],
    compressed_files: [],
    deleted_files: [],
  };
  const rotatedPaths = [];

  for (const sourcePath of activeLogPaths) {
    let stat;
    try {
      stat = await fsImpl.stat(sourcePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.size <= 0) continue;

    const targetPath = await uniqueRotationPath(sourcePath, now, fsImpl);
    report.files_rotated += 1;
    report.bytes_rotated += stat.size;
    report.rotated_files.push(path.basename(targetPath));
    if (!dryRun) {
      await fsImpl.rename(sourcePath, targetPath);
      rotatedPaths.push(targetPath);
    }
  }

  // reloadLogs hace que PM2 cierre los descriptores renombrados y vuelva a
  // escribir en las rutas canónicas. Se ejecuta incluso si un reintento ya
  // encontró los ficheros renombrados por un intento anterior incompleto.
  if (!dryRun) {
    await commandRunner(pm2Binary, ['reloadLogs'], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30000,
    });

    // Se comprime secuencialmente para no multiplicar CPU/IO cuando varios
    // logs grandes (decenas de GB) se rotan en la misma ejecución. El escaneo
    // recupera rotaciones crudas dejadas por un fallo posterior a reloadLogs.
    const pendingRotatedLogs = await listPendingRotatedLogs({
      directory,
      activeLogPaths,
      rotatedPaths,
      fsImpl,
    });
    for (const sourcePath of pendingRotatedLogs) {
      let compressed;
      try {
        compressed = await gzipFileAtomic(sourcePath, {
          fsImpl,
          createReadStream: options.createReadStream,
          createWriteStream: options.createWriteStream,
          gzipFactory: options.gzipFactory,
          pipelineImpl: options.pipelineImpl,
        });
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!compressed) continue;
      report.files_compressed += 1;
      report.bytes_compressed_input += compressed.sourceBytes;
      report.bytes_compressed_output += compressed.targetBytes;
      report.bytes_saved += Math.max(0, compressed.sourceBytes - compressed.targetBytes);
      report.compressed_files.push(path.basename(compressed.targetPath));
    }
  }

  const entries = await fsImpl.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(directory, entry.name);
    if (activePathSet.has(filePath)) continue;

    let stat;
    try {
      stat = await fsImpl.stat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.mtimeMs >= cutoffMs) continue;

    report.files_deleted += 1;
    report.bytes_deleted += stat.size;
    report.deleted_files.push(entry.name);
    if (!dryRun) {
      await fsImpl.unlink(filePath);
    }
  }

  return report;
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  resolveLogDirectory,
  runPm2LogRetention,
  _isInsideDirectory: isInsideDirectory,
  _uniqueRotationPath: uniqueRotationPath,
  _gzipFileAtomic: gzipFileAtomic,
  _listPendingRotatedLogs: listPendingRotatedLogs,
};
