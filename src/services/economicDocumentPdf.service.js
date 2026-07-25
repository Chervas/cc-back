'use strict';

const puppeteer = require('puppeteer-core');
const db = require('../../models');
const clinicalPrivateStorage = require('./clinicalPrivateStorage.service');

const {
  EconomicBudget,
  EconomicBudgetVersion,
  PatientFiscalDocument,
  ClinicalPrivateAsset,
} = db;

function domainError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function parse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function money(value) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' })
    .format(Number(value) || 0);
}

function date(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ''
    : new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'long', year: 'numeric' }).format(parsed);
}

function assetOrigins() {
  const values = [
    process.env.APP_PUBLIC_URL || 'http://localhost:4203',
    process.env.FRONTEND_PUBLIC_URL,
    process.env.PUBLIC_MEDIA_BASE_URL,
    ...String(process.env.ECONOMIC_PDF_ASSET_ORIGINS || '').split(','),
  ];
  return new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean));
}

function isAllowedAssetUrl(value) {
  const url = String(value || '').trim();
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(url)) return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && assetOrigins().has(parsed.origin);
  } catch {
    return false;
  }
}

function assetUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  const resolved = /^https?:\/\//i.test(url) || /^data:/i.test(url)
    ? url
    : `${String(process.env.APP_PUBLIC_URL || 'http://localhost:4203').replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
  return isAllowedAssetUrl(resolved) ? resolved : '';
}

function baseStyles() {
  return `
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #172033; font: 13px Arial, sans-serif; }
    .page { min-height: 270mm; }
    .muted { color: #64748b; }
    .header { display: grid; grid-template-columns: 1fr 235px; min-height: 150px; overflow: hidden; border-radius: 8px; background: #172033; color: white; }
    .header-copy { padding: 26px; }
    .header-image { width: 100%; height: 100%; object-fit: cover; }
    h1 { margin: 0; font-size: 28px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    .logo { max-width: 150px; max-height: 45px; margin-bottom: 20px; object-fit: contain; object-position: left; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 24px 0; }
    .panel { border: 1px solid #dbe3ee; border-radius: 8px; padding: 16px; }
    table { width: 100%; border-collapse: collapse; margin-top: 18px; }
    th { color: #64748b; font-size: 11px; text-align: left; text-transform: uppercase; }
    td, th { padding: 11px 8px; border-bottom: 1px solid #e8edf4; }
    .right { text-align: right; }
    .total { margin: 18px 0 0 auto; width: 260px; font-size: 16px; }
    .total strong { font-size: 24px; }
    .options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 18px; }
    .option { min-height: 125px; border: 1px solid #dbe3ee; border-radius: 8px; padding: 15px; }
    .option.single { border-color: #86efac; background: #f0fdf4; }
    .option.clinic_installments { border-color: #fcd34d; background: #fffbeb; }
    .option.external_financing { border-color: #7dd3fc; background: #f0f9ff; }
    .option.highlight { border: 2px solid #4f46e5; background: #f5f3ff; }
    .option strong { display: block; margin: 8px 0; font-size: 20px; }
    .footer { margin-top: 30px; padding-top: 16px; border-top: 1px solid #dbe3ee; color: #64748b; font-size: 11px; }
    .invoice-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 22px; border-radius: 8px; background: #f2f5f9; }
    .invoice-number { text-align: right; }
  `;
}

function paymentOptions(proposal, total, highlighted) {
  const included = Array.isArray(proposal.included_modes) ? proposal.included_modes : [];
  return included.map((mode) => {
    if (mode === 'single') {
      return {
        key: mode,
        title: 'Pago único',
        amount: proposal.single_payment?.amount ?? total,
        detail: proposal.single_payment?.savings ? `Ahorro ${money(proposal.single_payment.savings)}` : 'Un solo pago',
      };
    }
    if (mode === 'clinic_installments') {
      const schedule = Array.isArray(proposal.schedule) ? proposal.schedule : [];
      return {
        key: mode,
        title: 'Pago por fases',
        amount: proposal.clinic_installments?.amount ?? total,
        detail: `${schedule.length} pagos acordados con la clínica`,
      };
    }
    if (mode === 'external_financing') {
      const option = (proposal.financing_options || []).find(
        (item) => Number(item.months) === Number(proposal.selected_financing_months),
      ) || proposal.financing_options?.[0];
      return {
        key: mode,
        title: option ? `${option.months} meses` : 'Financiación',
        amount: option?.monthly_amount || 0,
        suffix: '/mes',
        detail: option ? `Total financiado ${money(option.total_financed)}` : 'Financiación externa',
      };
    }
    return {
      key: mode,
      title: 'Saldo del paciente',
      amount: proposal.balance_application?.amount || 0,
      detail: 'Se descuenta del saldo disponible',
    };
  }).map((option) => `
    <div class="option ${escapeHtml(option.key)} ${option.key === highlighted ? 'highlight' : ''}">
      <span class="muted">${escapeHtml(option.title)}</span>
      <strong>${escapeHtml(money(option.amount))}${escapeHtml(option.suffix || '')}</strong>
      <span class="muted">${escapeHtml(option.detail)}</span>
    </div>
  `).join('');
}

function budgetHtml(budget, version) {
  const lines = parse(version.lines, []);
  const totals = parse(version.totals, {});
  const proposal = parse(version.payment_proposal, {});
  const design = parse(version.design_config, {});
  const clinic = parse(version.clinic_snapshot, {});
  const patient = parse(version.patient_snapshot, {});
  const headerImage = assetUrl(design.header_asset_url);
  const logo = design.logo_mode === 'none' ? '' : assetUrl(design.logo_url || clinic.logo_url);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyles()}</style></head><body>
    <main class="page">
      <header class="header">
        <div class="header-copy">
          ${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt="">` : ''}
          <div class="muted" style="color:#cbd5e1">Presupuesto ${escapeHtml(budget.number)}</div>
          <h1>${escapeHtml(design.custom_title || 'Tu propuesta de tratamiento')}</h1>
          <p>${escapeHtml(design.clinic_message || `Preparado para ${patient.name || 'el paciente'}`)}</p>
        </div>
        ${headerImage ? `<img class="header-image" src="${escapeHtml(headerImage)}" alt="">` : '<div></div>'}
      </header>
      <section class="meta-grid">
        <div class="panel"><h2>Paciente</h2><strong>${escapeHtml(patient.name)}</strong><br><span class="muted">${escapeHtml(patient.tax_id || '')}</span></div>
        <div class="panel"><h2>Clínica</h2><strong>${escapeHtml(clinic.legal_name || clinic.name)}</strong><br><span class="muted">Válido hasta ${escapeHtml(date(budget.valid_until))}</span></div>
      </section>
      <table><thead><tr><th>Tratamiento o servicio</th><th class="right">Cantidad</th><th class="right">Precio</th><th class="right">Total</th></tr></thead>
      <tbody>${lines.map((line) => `<tr><td><strong>${escapeHtml(line.name)}</strong>${line.description ? `<br><span class="muted">${escapeHtml(line.description)}</span>` : ''}</td><td class="right">${escapeHtml(line.quantity)}</td><td class="right">${escapeHtml(money(line.unit_price))}</td><td class="right">${escapeHtml(money(line.total))}</td></tr>`).join('')}</tbody></table>
      <div class="total panel"><span class="muted">Total propuesta</span><br><strong>${escapeHtml(money(totals.total))}</strong></div>
      ${paymentOptions(proposal, totals.total, design.highlighted_block) ? `<section><h2>Opciones de pago</h2><div class="options">${paymentOptions(proposal, totals.total, design.highlighted_block)}</div></section>` : ''}
      ${design.conditions || version.notes ? `<footer class="footer">${escapeHtml(design.conditions || version.notes)}</footer>` : ''}
    </main></body></html>`;
}

function fiscalHtml(document) {
  const issuer = parse(document.issuer_snapshot, {});
  const recipient = parse(document.recipient_snapshot, {});
  const lines = parse(document.lines, []);
  const totals = parse(document.totals, {});
  const template = parse(document.template_snapshot, {});
  const config = template.config || {};
  const logo = config.logo_mode === 'none' ? '' : assetUrl(config.logo_url || issuer.logo_url);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyles()}</style></head><body>
    <main class="page">
      <header class="invoice-head">
        <div>${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt="">` : ''}<h1>${escapeHtml(issuer.legal_name || issuer.name)}</h1><div class="muted">${escapeHtml(issuer.tax_id || '')}<br>${escapeHtml([issuer.address, issuer.postal_code, issuer.city].filter(Boolean).join(', '))}</div></div>
        <div class="invoice-number"><span class="muted">${document.document_type === 'receipt' ? 'Recibo' : 'Factura'}</span><h1>${escapeHtml(document.number)}</h1><span class="muted">${escapeHtml(date(document.issue_date))}</span></div>
      </header>
      <section class="meta-grid"><div class="panel"><h2>Facturar a</h2><strong>${escapeHtml(recipient.legal_name || recipient.name)}</strong><br><span class="muted">${escapeHtml(recipient.tax_id || '')}<br>${escapeHtml([recipient.address, recipient.postal_code, recipient.city].filter(Boolean).join(', '))}</span></div><div class="panel"><h2>Estado</h2><strong>${document.status === 'issued' ? 'Emitida' : 'Borrador'}</strong><br><span class="muted">${document.due_date ? `Vencimiento ${escapeHtml(date(document.due_date))}` : 'Sin vencimiento'}</span></div></section>
      <table><thead><tr><th>Concepto</th><th class="right">Cantidad</th><th class="right">Precio</th><th class="right">IVA</th><th class="right">Total</th></tr></thead>
      <tbody>${lines.map((line) => `<tr><td>${escapeHtml(line.description)}</td><td class="right">${escapeHtml(line.quantity)}</td><td class="right">${escapeHtml(money(line.unit_price))}</td><td class="right">${escapeHtml(line.tax_percent)}%</td><td class="right">${escapeHtml(money(line.total))}</td></tr>`).join('')}</tbody></table>
      <div class="total panel"><span class="muted">Base ${escapeHtml(money(totals.taxable_base))} · Impuestos ${escapeHtml(money(totals.taxes))}</span><br><strong>${escapeHtml(money(totals.total))}</strong></div>
      ${document.notes ? `<footer class="footer">${escapeHtml(document.notes)}</footer>` : ''}
    </main></body></html>`;
}

async function render(html) {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
    || '/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell';
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url === 'about:blank' || isAllowedAssetUrl(url)) request.continue();
      else request.abort('blockedbyclient');
    });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return Buffer.from(await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    }));
  } finally {
    await browser.close();
  }
}

async function budgetPdf({ publicId }) {
  const budget = await EconomicBudget.findOne({ where: { public_id: publicId } });
  if (!budget) throw domainError(404, 'budget_not_found', 'Presupuesto no encontrado.');
  const version = await EconomicBudgetVersion.findOne({
    where: { budget_id: budget.id, version_number: budget.current_version },
  });
  if (!version) throw domainError(404, 'budget_version_not_found', 'Versión del presupuesto no encontrada.');
  return {
    buffer: await render(budgetHtml(budget, version)),
    filename: `${budget.number}.pdf`,
  };
}

async function fiscalPdf({ publicId, actorId }) {
  const document = await PatientFiscalDocument.findOne({ where: { public_id: publicId } });
  if (!document) throw domainError(404, 'fiscal_document_not_found', 'Documento fiscal no encontrado.');
  if (document.status === 'issued' && document.pdf_asset_id) {
    const asset = await ClinicalPrivateAsset.findByPk(document.pdf_asset_id);
    if (asset) {
      const stored = await clinicalPrivateStorage.readClinicalPrivateAsset(asset);
      return { buffer: stored.buffer, filename: `${document.number}.pdf` };
    }
  }
  const buffer = await render(fiscalHtml(document));
  if (document.status === 'issued') {
    const asset = await clinicalPrivateStorage.storeClinicalPrivateAsset({
      purpose: 'fiscal_document_pdf',
      clinicId: document.clinic_id,
      patientId: document.patient_id,
      ownerType: 'patient_fiscal_document',
      ownerId: document.public_id,
      originalFilename: `${document.number}.pdf`,
      contentType: 'application/pdf',
      buffer,
      createdBy: actorId,
      metadata: { immutable_snapshot: true, number: document.number },
    });
    await document.update({ pdf_asset_id: asset.id });
  }
  return { buffer, filename: `${document.number}.pdf` };
}

module.exports = {
  domainError,
  budgetPdf,
  fiscalPdf,
  __testing: { budgetHtml, fiscalHtml, assetUrl, isAllowedAssetUrl },
};
