'use strict';

/**
 * One deliberately live Propdental intake submission.
 *
 * This file creates a real CF7 email and one real LeadIntake when, and only
 * when, both --execute and the exact confirmation environment value are set.
 * It must first be reviewed and run only once with team-owned contact data.
 *
 * It intentionally:
 * - uses a fresh browser context and a URL without gclid/gbraid/wbraid;
 * - stores a unique CC-E2E-* marker as the lead name and reason;
 * - saves Clinicaclick consent with Marketing disabled;
 * - blocks browser-side Google Ads/Analytics endpoints (reCAPTCHA remains
 *   available because CF7 requires it);
 * - selects one explicit clinic (Badalona or Sant Martí);
 * - captures cc_session_id and the /api/intake/leads response;
 * - aborts the /mensaje-enviado/ navigation so evidence remains observable.
 */

const fs = require('node:fs');
const path = require('node:path');

const EXECUTION_CONFIRMATION = 'CREATE_EXACTLY_ONE_LIVE_PROPDENTAL_E2E_LEAD';
const DEFAULT_URL = 'https://www.propdental.es/pedir-hora/';
const DEFAULT_CHROMIUM = '/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell';
const CLINICS = Object.freeze({
  'badalona': 'Propdental Badalona',
  'sant-marti': 'Propdental Sant Martí',
});
const GOOGLE_MEASUREMENT_HOST_SUFFIXES = Object.freeze([
  'google-analytics.com',
  'googleadservices.com',
  'googlesyndication.com',
  'googletagmanager.com',
  'doubleclick.net',
]);

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (const raw of argv) {
    if (!raw.startsWith('--')) throw new Error(`Argumento posicional no permitido: ${raw}`);
    const separator = raw.indexOf('=');
    if (separator === -1) {
      flags.add(raw.slice(2));
      continue;
    }
    const key = raw.slice(2, separator);
    if (values.has(key)) throw new Error(`--${key} solo puede indicarse una vez`);
    values.set(key, raw.slice(separator + 1));
  }
  const allowedValues = new Set(['marker', 'clinic', 'email', 'phone', 'url', 'timeout-ms']);
  const allowedFlags = new Set(['execute', 'headed']);
  for (const key of values.keys()) {
    if (!allowedValues.has(key)) throw new Error(`Opción desconocida: --${key}`);
  }
  for (const flag of flags) {
    if (!allowedFlags.has(flag)) throw new Error(`Flag desconocido: --${flag}`);
  }

  const marker = String(values.get('marker') || '').trim();
  if (!/^CC-E2E-[A-Za-z0-9][A-Za-z0-9_-]{8,72}$/.test(marker)) {
    throw new Error('--marker debe ser un identificador único CC-E2E-*');
  }
  const clinicKey = String(values.get('clinic') || '').trim().toLowerCase();
  if (!CLINICS[clinicKey]) {
    throw new Error('--clinic debe ser badalona o sant-marti');
  }
  const email = String(values.get('email') || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('--email debe ser una dirección controlada por el equipo');
  }
  const phone = String(values.get('phone') || '').replace(/[\s()+.-]/g, '');
  if (!/^\d{9,15}$/.test(phone)) {
    throw new Error('--phone debe ser un número controlado por el equipo (9-15 dígitos)');
  }

  const targetUrl = new URL(values.get('url') || DEFAULT_URL);
  if (targetUrl.protocol !== 'https:' || targetUrl.hostname !== 'www.propdental.es' || targetUrl.pathname !== '/pedir-hora/') {
    throw new Error('--url debe ser https://www.propdental.es/pedir-hora/');
  }
  for (const key of ['gclid', 'gbraid', 'wbraid', 'dclid', 'msclkid']) {
    if (targetUrl.searchParams.has(key)) throw new Error(`La URL no puede contener ${key}`);
  }
  targetUrl.searchParams.set('cc_e2e_run', marker);

  const timeoutMs = Number(values.get('timeout-ms') || 60_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 20_000 || timeoutMs > 120_000) {
    throw new Error('--timeout-ms debe estar entre 20000 y 120000');
  }

  return {
    execute: flags.has('execute'),
    headless: !flags.has('headed'),
    marker,
    clinicKey,
    clinicLabel: CLINICS[clinicKey],
    email,
    phone,
    targetUrl: targetUrl.toString(),
    timeoutMs,
  };
}

function findCachedPlaywright() {
  const root = '/home/ubuntu/.cache/pnpm/dlx';
  if (!fs.existsSync(root)) return null;
  for (const dlxHash of fs.readdirSync(root)) {
    const dlxDir = path.join(root, dlxHash);
    if (!fs.statSync(dlxDir).isDirectory()) continue;
    for (const versionDir of fs.readdirSync(dlxDir)) {
      const pnpmDir = path.join(dlxDir, versionDir, 'node_modules', '.pnpm');
      if (!fs.existsSync(pnpmDir)) continue;
      const packageDir = fs.readdirSync(pnpmDir).find((entry) => entry.startsWith('playwright@'));
      if (!packageDir) continue;
      const candidate = path.join(pnpmDir, packageDir, 'node_modules', 'playwright');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function loadPlaywright() {
  const explicitModule = process.env.PLAYWRIGHT_MODULE;
  const candidates = [explicitModule, 'playwright', findCachedPlaywright()].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Playwright no está disponible: ${lastError?.message || 'module_not_found'}`);
}

function isGoogleMeasurementHost(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return GOOGLE_MEASUREMENT_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function truthyField(payload, names) {
  for (const name of names) {
    if (payload?.[name]) return payload[name];
    if (payload?.attribution?.[name]) return payload.attribution[name];
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.execute || process.env.CC_LIVE_E2E_CONFIRM !== EXECUTION_CONFIRMATION) {
    throw new Error(
      'Guard activo: este script crea un lead real. Requiere --execute y '
      + `CC_LIVE_E2E_CONFIRM=${EXECUTION_CONFIRMATION}`
    );
  }

  const { chromium } = loadPlaywright();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || DEFAULT_CHROMIUM;
  const browser = await chromium.launch({
    executablePath,
    headless: options.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(options.timeoutMs);

    let redirectedNavigationBlocked = 0;
    let blockedGoogleMeasurementRequests = 0;
    const intakeRequests = [];

    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.isNavigationRequest() && url.hostname === 'www.propdental.es' && url.pathname === '/mensaje-enviado/') {
        redirectedNavigationBlocked += 1;
        await route.abort('blockedbyclient');
        return;
      }
      // Keep reCAPTCHA reachable: only measurement/ad hosts are blocked.
      if (isGoogleMeasurementHost(url.hostname)) {
        blockedGoogleMeasurementRequests += 1;
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });

    const page = await context.newPage();
    page.on('request', (request) => {
      if (request.method() !== 'POST' || !request.url().includes('/api/intake/leads')) return;
      let payload = null;
      try { payload = request.postDataJSON(); } catch (_error) { /* validated after response */ }
      intakeRequests.push({ url: request.url(), payload });
    });

    await page.goto(options.targetUrl, { waitUntil: 'networkidle', timeout: options.timeoutMs });
    await page.waitForSelector('#cc-consent-banner');

    await page.locator('[data-cc-consent-config]').click();
    await page.locator('[data-cc-consent-preferences]').setChecked(true);
    await page.locator('[data-cc-consent-analytics]').setChecked(true);
    await page.locator('[data-cc-consent-marketing]').setChecked(false);
    await page.locator('[data-cc-consent-save]').click();
    await page.waitForFunction(() => !document.querySelector('#cc-consent-banner'));

    const browserState = await page.evaluate(() => {
      const consentRaw = localStorage.getItem('cc_consent_v2') || sessionStorage.getItem('cc_consent');
      const attributionRaw = sessionStorage.getItem('cc_attribution');
      return {
        session_id: sessionStorage.getItem('cc_session_id'),
        consent: consentRaw ? JSON.parse(consentRaw) : null,
        attribution: attributionRaw ? JSON.parse(attributionRaw) : {},
        runtime_version: window.ClinicaClickIntake?.version || null,
      };
    });

    if (!browserState.session_id) throw new Error('Clinicaclick no generó cc_session_id');
    if (browserState.consent?.marketing !== false
      || browserState.consent?.ad_user_data !== 'denied'
      || browserState.consent?.ad_personalization !== 'denied') {
      throw new Error('Marketing no quedó denegado antes del envío');
    }
    if (truthyField(browserState.attribution, ['gclid', 'gbraid', 'wbraid'])) {
      throw new Error('La sesión contiene un click id publicitario inesperado');
    }

    const form = page.locator('form[action*="wpcf7-f77822"]').first();
    await form.locator('input[name="nombre"]').fill(options.marker);
    await form.locator('input[name="email"]').fill(options.email);
    await form.locator('input[name="tel-778"]').fill(options.phone);
    await form.locator('select[name="clinica"]').selectOption({ label: options.clinicLabel });
    await form.locator('textarea[name="motivo"]').fill(`Prueba técnica controlada ${options.marker}`);
    for (const checkbox of await form.locator('input[type="checkbox"]').all()) {
      await checkbox.check();
    }

    const selectedClinic = await form.locator('select[name="clinica"]').inputValue();
    if (selectedClinic !== options.clinicLabel) {
      throw new Error(`Sede seleccionada inesperada: ${selectedClinic}`);
    }

    const cf7ResponsePromise = page.waitForResponse(
      (response) => response.request().method() === 'POST'
        && response.url().includes('/contact-form-7/v1/contact-forms/77822/feedback'),
      { timeout: options.timeoutMs },
    );
    const intakeResponsePromise = page.waitForResponse(
      (response) => response.request().method() === 'POST'
        && response.url().includes('/api/intake/leads'),
      { timeout: options.timeoutMs },
    );

    await form.locator('input[type="submit"]').click();
    const cf7Response = await cf7ResponsePromise;
    const cf7Body = await cf7Response.json();
    if (!cf7Response.ok() || cf7Body?.status !== 'mail_sent') {
      throw new Error(`CF7 no aceptó la prueba: HTTP ${cf7Response.status()} / ${cf7Body?.status || 'unknown'}`);
    }

    const intakeResponse = await intakeResponsePromise;
    const intakeBody = await intakeResponse.json();
    const leadId = Number(intakeBody?.id);
    if (!intakeResponse.ok() || !Number.isInteger(leadId) || leadId <= 0) {
      throw new Error(`Clinicaclick no devolvió un lead id válido: HTTP ${intakeResponse.status()}`);
    }

    await page.waitForTimeout(1000);
    if (intakeRequests.length !== 1) {
      throw new Error(`Se esperaban 1 POST de intake y hubo ${intakeRequests.length}`);
    }
    const intakePayload = intakeRequests[0].payload || {};
    if (truthyField(intakePayload, ['gclid', 'gbraid', 'wbraid'])) {
      throw new Error('El payload del lead contiene un click id inesperado');
    }
    const payloadConsent = intakePayload.consent || intakePayload.consentimiento_canal || {};
    if (payloadConsent.marketing !== false
      || payloadConsent.ad_user_data !== 'denied'
      || payloadConsent.ad_personalization !== 'denied') {
      throw new Error('El payload del lead no conserva Marketing/ad data denegados');
    }

    console.log(JSON.stringify({
      status: 'created_one_controlled_live_lead',
      marker: options.marker,
      clinic: options.clinicLabel,
      lead_id: leadId,
      session_id: browserState.session_id,
      runtime_version: browserState.runtime_version,
      cf7_status: cf7Body.status,
      intake_http_status: intakeResponse.status(),
      intake_post_count: intakeRequests.length,
      marketing: browserState.consent.marketing,
      ad_user_data: browserState.consent.ad_user_data,
      ad_personalization: browserState.consent.ad_personalization,
      click_ids_present: false,
      blocked_google_measurement_requests: blockedGoogleMeasurementRequests,
      blocked_success_redirects: redirectedNavigationBlocked,
      cleanup_command: `node scripts/cleanup-intake-e2e-run.js --group-id=5 --marker=${options.marker} --lead-ids=${leadId} --session-ids=${browserState.session_id}`,
    }, null, 2));
  } finally {
    if (context) await context.close();
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  EXECUTION_CONFIRMATION,
  isGoogleMeasurementHost,
  parseArgs,
};
