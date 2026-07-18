#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  MAX_SOURCE_BYTES,
  ModSuiteOfflineAdapterError,
  adaptModSuiteDocument,
} = require('../lib/modSuiteOfflineAdapter');

function usage() {
  return [
    'Uso:',
    '  node src/scripts/migrate_modsuite_web_document.js \\',
    '    --input export-local.json \\',
    '    --output web-document.json \\',
    '    --report migration-report.json [opciones]',
    '',
    'Opciones:',
    '  --page <nombre>       Selecciona una página por nombre; se puede repetir.',
    '  --title <texto>       Sobrescribe el título cuando se migra una única página.',
    '  --slug <slug>         Sobrescribe el slug cuando se migra una única página.',
    '  --locale <es-ES>      Locale del documento de salida (por defecto es-ES).',
    '  --force               Sustituye ficheros de salida regulares existentes.',
    '  --fail-on-review      Devuelve código 2 si el informe requiere revisión.',
    '  --help                Muestra esta ayuda.',
    '',
    'La herramienta solo lee JSON local. No acepta URLs, no hace red y no ejecuta contenido legacy.',
  ].join('\n');
}

function cliError(code, message, details = undefined) {
  const error = new Error(message);
  error.name = 'ModSuiteMigrationCliError';
  error.code = code;
  error.details = details;
  return error;
}

function parseArgs(argv) {
  const result = {
    pageNames: [],
    force: false,
    failOnReview: false,
  };
  const valueOptions = new Map([
    ['--input', 'input'],
    ['--output', 'output'],
    ['--report', 'report'],
    ['--page', 'page'],
    ['--title', 'title'],
    ['--slug', 'slug'],
    ['--locale', 'locale'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    if (argument === '--force') {
      result.force = true;
      continue;
    }
    if (argument === '--fail-on-review') {
      result.failOnReview = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) throw cliError('unknown_argument', `Argumento desconocido: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw cliError('missing_argument_value', `${argument} necesita un valor.`);
    index += 1;
    if (key === 'page') result.pageNames.push(value);
    else result[key] = value;
  }
  return result;
}

function rejectRemotePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw cliError(`missing_${label}`, `Falta --${label}.`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) {
    throw cliError('remote_paths_forbidden', `--${label} debe ser una ruta local, no una URL.`);
  }
  return path.resolve(value);
}

function readLocalJson(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
  } catch (error) {
    if (error.code === 'ENOENT') throw cliError('input_not_found', 'El fichero de entrada no existe.');
    if (error.code === 'ELOOP') {
      throw cliError('input_not_regular_file', 'La entrada debe ser un fichero regular, no un enlace simbólico.');
    }
    throw error;
  }

  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      throw cliError('input_not_regular_file', 'La entrada debe ser un fichero regular, no un enlace simbólico.');
    }
    if (stats.size > MAX_SOURCE_BYTES) {
      throw cliError(
        'input_too_large',
        `La entrada supera ${MAX_SOURCE_BYTES} bytes.`,
        { limit_bytes: MAX_SOURCE_BYTES, source_bytes: stats.size }
      );
    }
    const raw = fs.readFileSync(descriptor, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) throw cliError('input_invalid_json', 'La entrada local no es JSON válido.');
      throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertSafeOutput(filePath, inputPath, force, label) {
  const parent = path.dirname(filePath);
  const parentStats = fs.statSync(parent);
  if (!parentStats.isDirectory()) throw cliError('output_parent_not_directory', `La carpeta de --${label} no es válida.`);
  if (filePath === inputPath) throw cliError('output_overwrites_input', `--${label} no puede ser el fichero de entrada.`);
  if (!fs.existsSync(filePath)) return null;
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw cliError('unsafe_output_path', `--${label} debe apuntar a un fichero regular.`);
  }
  try {
    const inputStats = fs.lstatSync(inputPath);
    if (inputStats.isFile() && inputStats.dev === stats.dev && inputStats.ino === stats.ino) {
      throw cliError('output_overwrites_input', `--${label} no puede ser otro enlace al fichero de entrada.`);
    }
  } catch (error) {
    if (error?.name === 'ModSuiteMigrationCliError') throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  if (!force) throw cliError('output_exists', `--${label} ya existe; usa --force si quieres sustituirlo.`);
  return stats;
}

function writeAtomicJson(filePath, value) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const inputPath = rejectRemotePath(args.input, 'input');
  const outputPath = rejectRemotePath(args.output, 'output');
  const reportPath = rejectRemotePath(args.report, 'report');
  if (outputPath === reportPath) throw cliError('output_paths_must_differ', '--output y --report deben ser distintos.');
  const outputStats = assertSafeOutput(outputPath, inputPath, args.force, 'output');
  const reportStats = assertSafeOutput(reportPath, inputPath, args.force, 'report');
  if (outputStats && reportStats && outputStats.dev === reportStats.dev && outputStats.ino === reportStats.ino) {
    throw cliError('output_paths_must_differ', '--output y --report no pueden ser enlaces al mismo fichero.');
  }
  const source = readLocalJson(inputPath);
  const { document, report } = adaptModSuiteDocument(source, {
    pageNames: args.pageNames,
    title: args.title,
    slug: args.slug,
    locale: args.locale,
  });
  writeAtomicJson(outputPath, document);
  writeAtomicJson(reportPath, report);
  process.stdout.write([
    'Migración offline completada.',
    `Páginas: ${report.summary.pages}.`,
    `Nodos de salida: ${report.summary.target_nodes}.`,
    `Requiere revisión: ${report.summary.requires_review ? 'sí' : 'no'}.`,
  ].join(' ') + '\n');
  return args.failOnReview && report.summary.requires_review ? 2 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = run();
  } catch (error) {
    const code = error?.code || 'modsuite_migration_failed';
    const known = error instanceof ModSuiteOfflineAdapterError || error?.name === 'ModSuiteMigrationCliError';
    process.stderr.write(`${code}: ${known ? error.message : 'La migración offline ha fallado.'}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  readLocalJson,
  run,
  usage,
  writeAtomicJson,
};
