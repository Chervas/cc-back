#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const db = require('../../models');
const { metaSyncJobs } = require('../jobs/sync.jobs');

const HELP_TEXT = `Uso: node src/scripts/backfill_ads.js [opciones]

Opciones principales:
  --clinics=22,24           IDs de clínicas a incluir (coma separada)
  --groups=6                IDs de grupos a incluir (coma separada)
  --start=YYYY-MM-DD        Fecha inicial (inclusive)
  --end=YYYY-MM-DD          Fecha final (inclusive)
  --days=30                 Ventana en días (si no se indica start/end)
  --platforms=meta,google   Plataformas a procesar (meta|google)
  --mode=backfill           Modo: backfill (histórico) o recent (ventana corta)
  --chunk-days=7            Tamaño de chunk para Google Ads (opcional)
  --dry-run                 Muestra qué se ejecutaría sin lanzar jobs
  --help                    Muestra esta ayuda
`;

function parseList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((num) => Number.isFinite(num));
}

function parseArgs(argv) {
  const result = {
    clinics: [],
    groups: [],
    start: null,
    end: null,
    days: null,
    platforms: ['meta', 'google'],
    mode: 'backfill',
    chunkDays: null,
    dryRun: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (!entry.startsWith('--')) {
      continue;
    }

    const [rawKey, rawValue] = entry.split('=');
    const key = rawKey.replace(/^--/, '');
    const value = rawValue ?? null;

    switch (key) {
      case 'help':
      case 'h':
        result.help = true;
        break;
      case 'clinics':
        result.clinics = parseList(value);
        break;
      case 'groups':
        result.groups = parseList(value);
        break;
      case 'start':
        result.start = value;
        break;
      case 'end':
        result.end = value;
        break;
      case 'days':
        result.days = value ? Number(value) : null;
        break;
      case 'platforms':
        if (value) {
          result.platforms = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
        }
        break;
      case 'mode':
        if (value && ['backfill', 'recent'].includes(value)) {
          result.mode = value;
        }
        break;
      case 'chunk-days':
        result.chunkDays = value ? Number(value) : null;
        break;
      case 'dry-run':
        result.dryRun = true;
        break;
      default:
        console.warn(`⚠️ Opción desconocida ignorada: --${key}`);
    }
  }

  return result;
}

function buildJobOptions(parsed) {
  const jobOptions = {};

  if (parsed.clinics.length) {
    jobOptions.clinicIds = parsed.clinics;
  }
  if (parsed.groups.length) {
    jobOptions.groupIds = parsed.groups;
  }
  if (parsed.start) {
    jobOptions.startDate = parsed.start;
  }
  if (parsed.end) {
    jobOptions.endDate = parsed.end;
  }
  if (Number.isFinite(parsed.days) && parsed.days > 0) {
    jobOptions.windowDays = Math.floor(parsed.days);
  }
  if (Number.isFinite(parsed.chunkDays) && parsed.chunkDays > 0) {
    jobOptions.chunkDays = Math.floor(parsed.chunkDays);
  }

  return jobOptions;
}

async function run() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    console.log(HELP_TEXT);
    return;
  }

  const jobOptions = buildJobOptions(parsed);
  console.log('🛠️  Opciones recibidas:', {
    mode: parsed.mode,
    platforms: parsed.platforms,
    jobOptions,
    dryRun: parsed.dryRun
  });

  if (parsed.dryRun) {
    console.log('🔍 Dry-run activado: no se ejecutarán jobs.');
    return;
  }

  await metaSyncJobs.initialize().catch(() => {});

  const results = [];
  const platforms = Array.isArray(parsed.platforms) && parsed.platforms.length ? parsed.platforms : ['meta', 'google'];

  for (const platform of platforms) {
    if (platform === 'meta') {
      if (parsed.mode === 'recent') {
        console.log('▶️ Lanzando Meta Ads (recent)…');
        results.push({ platform: 'meta', mode: 'recent', report: await metaSyncJobs.executeAdsSync(jobOptions) });
      } else {
        console.log('▶️ Lanzando Meta Ads (backfill)…');
        results.push({ platform: 'meta', mode: 'backfill', report: await metaSyncJobs.executeAdsBackfill(jobOptions) });
      }
    } else if (platform === 'google') {
      if (parsed.mode === 'recent') {
        console.log('▶️ Lanzando Google Ads (recent)…');
        results.push({ platform: 'google', mode: 'recent', report: await metaSyncJobs.executeGoogleAdsSync(jobOptions) });
      } else {
        console.log('▶️ Lanzando Google Ads (backfill)…');
        results.push({ platform: 'google', mode: 'backfill', report: await metaSyncJobs.executeGoogleAdsBackfill(jobOptions) });
      }
    } else {
      console.warn(`⚠️ Plataforma no soportada: ${platform}`);
    }
  }

  console.log('✅ Ejecución finalizada:', results);
}

run()
  .catch((error) => {
    console.error('❌ Error ejecutando backfill:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.sequelize.close();
    } catch (closeErr) {
      console.warn('⚠️ No se pudo cerrar la conexión a la base de datos:', closeErr.message);
    }
  });
