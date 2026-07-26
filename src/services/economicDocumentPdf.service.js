'use strict';

const puppeteer = require('puppeteer-core');
const db = require('../../models');
const clinicalPrivateStorage = require('./clinicalPrivateStorage.service');

const {
  EconomicBudget,
  EconomicBudgetVersion,
  EconomicBudgetEvent,
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
    .invoice-doc { padding: 4mm 5mm; }
    .invoice-modern-head { display: grid; grid-template-columns: minmax(0, 1fr) 235px; gap: 32px; padding: 14px 0 22px; border-top: 4px solid #4f46e5; border-bottom: 1px solid #dfe5ed; }
    .invoice-reference h1 { margin: 5px 0 14px; overflow-wrap: anywhere; font-size: 23px; }
    .invoice-meta { display: grid; gap: 5px; margin: 0; }
    .invoice-meta div { display: grid; grid-template-columns: 115px minmax(0, 1fr); gap: 8px; }
    .invoice-meta dt { color: #64748b; }
    .invoice-meta dd { margin: 0; font-weight: bold; }
    .invoice-issuer { display: flex; min-width: 0; flex-direction: column; align-items: flex-end; line-height: 1.45; overflow-wrap: anywhere; text-align: right; }
    .invoice-logo { max-width: 145px; max-height: 42px; margin-bottom: 11px; object-fit: contain; object-position: right; }
    .invoice-recipient { display: flex; max-width: 430px; flex-direction: column; gap: 2px; padding: 20px 0 5px; line-height: 1.45; }
    .invoice-compact-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 30px; padding: 14px 0 20px; border-bottom: 4px solid #27324a; }
    .invoice-brand { display: flex; align-items: flex-start; gap: 14px; }
    .invoice-brand-copy, .invoice-compact-ref { display: flex; min-width: 0; flex-direction: column; }
    .invoice-brand-copy { line-height: 1.45; }
    .invoice-compact-ref { align-items: flex-end; overflow-wrap: anywhere; text-align: right; }
    .invoice-compact-ref h1 { margin: 5px 0 3px; font-size: 23px; }
    .invoice-compact-parties { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; padding: 20px 0 5px; }
    .invoice-compact-parties > div { display: flex; min-width: 0; flex-direction: column; gap: 2px; line-height: 1.45; }
    .invoice-lines { margin-top: 22px; }
    .invoice-lines table { margin: 0; }
    .invoice-lines th { padding: 8px 10px; background: #f3f6f9; font-size: 9px; }
    .invoice-lines td { padding: 10px; font-size: 11px; }
    .invoice-lines tbody tr:nth-child(even) { background: #f8fafc; }
    .invoice-total { display: flex; justify-content: flex-end; padding-top: 18px; }
    .invoice-total dl { width: 260px; margin: 0; }
    .invoice-total dl div { display: flex; justify-content: space-between; gap: 20px; padding: 4px 0; }
    .invoice-total dt { color: #64748b; }
    .invoice-total dd { margin: 0; font-weight: bold; }
    .invoice-total .grand-total { margin-top: 7px; padding-top: 10px; border-top: 2px solid #27324a; font-size: 20px; }
    .invoice-payment { margin-top: 20px; padding-top: 14px; border-top: 1px solid #dfe5ed; }
    .invoice-payment p { margin: 5px 0 0; }
    .budget-doc { padding: 4mm 5mm; }
    .budget-doc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding-top: 14px; border-top: 4px solid #4f46e5; }
    .budget-logo { max-width: 155px; max-height: 40px; object-fit: contain; object-position: left; }
    .budget-ref { text-align: right; }
    .budget-ref span, .budget-ref small { display: block; color: #64748b; font-size: 10px; }
    .budget-ref strong { display: block; margin: 3px 0; font-size: 16px; }
    .budget-intro { display: grid; grid-template-columns: minmax(0, 1fr) 145px; align-items: center; min-height: 120px; gap: 24px; padding: 20px 0; border-bottom: 1px solid #dfe5ed; }
    .budget-intro h1 { margin-top: 6px; font-size: 26px; }
    .budget-intro p { margin: 8px 0 0; color: #475569; font-size: 11px; }
    .budget-header-image { width: 145px; height: 90px; object-fit: cover; }
    .kicker { display: block; color: #64748b; font-size: 9px; font-weight: bold; text-transform: uppercase; }
    .budget-meta { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 20px; padding: 15px 0; border-bottom: 1px solid #dfe5ed; }
    .budget-meta span { display: block; margin-bottom: 4px; color: #64748b; font-size: 9px; text-transform: uppercase; }
    .budget-meta strong { font-size: 12px; }
    .budget-section { padding: 20px 0; border-bottom: 1px solid #dfe5ed; }
    .budget-section h2 { margin: 0; font-size: 16px; }
    .budget-table { margin-top: 12px; overflow: hidden; border: 1px solid #dfe5ed; border-radius: 6px; }
    .budget-table table { margin: 0; }
    .budget-table th { padding: 8px 10px; background: #f3f6f9; font-size: 9px; }
    .budget-table td { padding: 9px 10px; font-size: 11px; }
    .budget-table tbody tr:nth-child(even) { background: #f8fafc; }
    .budget-table small { display: block; margin-top: 2px; color: #64748b; font-size: 9px; }
    .budget-grand-total { display: flex; align-items: baseline; justify-content: flex-end; gap: 18px; padding-top: 12px; }
    .budget-grand-total span { color: #64748b; font-size: 11px; }
    .budget-grand-total strong { font-size: 22px; }
    .payment-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
    .payment-method { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; min-width: 165px; padding: 7px 10px; border: 1px solid #dfe5ed; border-radius: 6px; background: #f8fafc; color: #172033; font-size: 10px; font-weight: bold; }
    .payment-method span { color: #64748b; font-size: 8px; text-transform: uppercase; }
    .payment-method strong { font-size: 11px; }
    .payment-list { margin-top: 12px; overflow: hidden; border: 1px solid #dfe5ed; border-radius: 6px; }
    .payment-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 24px; padding: 11px 12px; border-bottom: 1px solid #e8edf3; }
    .payment-row:last-child { border-bottom: 0; }
    .payment-row small { display: block; margin-top: 3px; color: #64748b; font-size: 9px; }
    .payment-row .amount { text-align: right; font-size: 15px; }
    .payment-detail { margin-top: 7px; padding-top: 7px; border-top: 1px solid #e8edf3; }
    .payment-detail div { display: flex; justify-content: space-between; gap: 18px; padding: 3px 0; font-size: 10px; }
    .budget-conditions { padding: 18px 0; color: #475569; font-size: 10px; line-height: 1.5; white-space: pre-line; }
    .budget-footer { display: flex; justify-content: space-between; margin-top: 16px; padding-top: 10px; border-top: 1px solid #dfe5ed; color: #64748b; font-size: 9px; }
  `;
}

function acceptanceMetadata(budget, events = []) {
  if (!['accepted', 'partially_accepted'].includes(budget.status)) return {};
  const event = [...events]
    .reverse()
    .find((item) => ['accepted', 'partially_accepted'].includes(item.event_type));
  return parse(event?.metadata, {});
}

function collectionMethodLabel(method) {
  return {
    pending: 'Por concretar al cobrar',
    cash: 'Efectivo',
    card: 'Tarjeta',
    transfer: 'Transferencia',
    direct_debit: 'Domiciliación bancaria',
    bizum: 'Bizum',
    financing: 'Financiación',
    patient_balance: 'Saldo del paciente',
    insurance: 'Seguro',
    other: 'Otro',
  }[method] || '';
}

function paymentRows(budget, proposal, total, acceptance) {
  const included = Array.isArray(proposal.included_modes)
    ? proposal.included_modes
    : proposal.mode && proposal.mode !== 'none' ? [proposal.mode] : [];
  const accepted = ['accepted', 'partially_accepted'].includes(budget.status);
  const selected = included.includes(acceptance.selected_payment_mode)
    ? acceptance.selected_payment_mode
    : included.length === 1 ? included[0] : included.includes(proposal.mode) ? proposal.mode : null;
  const modes = accepted ? (selected ? [selected] : []) : included;
  return modes.map((mode) => {
    if (mode === 'single') {
      const savings = Number(proposal.single_payment?.savings || 0);
      return `<div class="payment-row"><div><strong>Pago único</strong><small>Un solo cobro${savings ? ` · ahorro ${escapeHtml(money(savings))}` : ''}</small></div><strong class="amount">${escapeHtml(money(proposal.single_payment?.amount ?? total))}</strong></div>`;
    }
    if (mode === 'clinic_installments') {
      const schedule = Array.isArray(proposal.schedule) ? proposal.schedule : [];
      return `<div class="payment-row"><div><strong>Aplazado en clínica</strong><small>${schedule.length} cobros acordados</small><div class="payment-detail">${schedule.map((phase) => `<div><span>${escapeHtml(phase.label)}${phase.due_date ? ` · ${escapeHtml(date(phase.due_date))}` : ''}</span><strong>${escapeHtml(money(phase.amount))}</strong></div>`).join('')}</div></div></div>`;
    }
    if (mode === 'external_financing') {
      const options = Array.isArray(proposal.financing_options) ? proposal.financing_options : [];
      const selectedMonths = Number(acceptance.selected_financing_months || proposal.selected_financing_months || 0);
      const visible = accepted
        ? options.filter((option) => Number(option.months) === selectedMonths)
        : options;
      return visible.map((option) => `<div class="payment-row"><div><strong>Financiación · ${escapeHtml(option.months)} meses</strong><small>Entrada ${escapeHtml(money(option.entry))} · total ${escapeHtml(money(option.total_financed))}</small></div><strong class="amount">${escapeHtml(money(option.monthly_amount))}<small>/mes</small></strong></div>`).join('');
    }
    return `<div class="payment-row"><div><strong>Saldo del paciente</strong><small>Importe aplicado al presupuesto</small></div><strong class="amount">${escapeHtml(money(proposal.balance_application?.amount || 0))}</strong></div>`;
  }).join('');
}

function budgetHtml(budget, version, events = []) {
  const lines = parse(version.lines, []);
  const totals = parse(version.totals, {});
  const proposal = parse(version.payment_proposal, {});
  const design = parse(version.design_config, {});
  const clinic = parse(version.clinic_snapshot, {});
  const patient = parse(version.patient_snapshot, {});
  const headerImage = assetUrl(design.header_asset_url);
  const logo = design.logo_mode === 'none' ? '' : assetUrl(design.logo_url || clinic.logo_url);
  const acceptance = acceptanceMetadata(budget, events);
  const payments = paymentRows(budget, proposal, totals.total, acceptance);
  const accepted = ['accepted', 'partially_accepted'].includes(budget.status);
  const collectionMethod = collectionMethodLabel(acceptance.collection_method);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyles()}</style></head><body>
    <main class="page budget-doc">
      <header class="budget-doc-head">
        <div>${logo ? `<img class="budget-logo" src="${escapeHtml(logo)}" alt="">` : `<strong>${escapeHtml(clinic.legal_name || clinic.name)}</strong>`}</div>
        <div class="budget-ref"><span>Presupuesto</span><strong>${escapeHtml(budget.number)}</strong><small>Versión ${escapeHtml(budget.current_version)}</small></div>
      </header>
      <section class="budget-intro">
        <div><span class="kicker">Propuesta clínica</span><h1>${escapeHtml(design.custom_title || 'Plan de tratamiento')}</h1>${design.clinic_message ? `<p>${escapeHtml(design.clinic_message)}</p>` : ''}</div>
        ${headerImage ? `<img class="budget-header-image" src="${escapeHtml(headerImage)}" alt="">` : '<div></div>'}
      </section>
      <section class="budget-meta"><div><span>Paciente</span><strong>${escapeHtml(patient.name)}</strong></div><div><span>Fecha</span><strong>${escapeHtml(date(budget.created_at))}</strong></div><div><span>Válido hasta</span><strong>${escapeHtml(date(budget.valid_until))}</strong></div></section>
      <section class="budget-section"><h2>Tratamientos y servicios</h2><div class="budget-table"><table><thead><tr><th>Concepto</th><th class="right">Cantidad</th><th class="right">Precio</th><th class="right">Importe</th></tr></thead><tbody>${lines.map((line) => `<tr><td><strong>${escapeHtml(line.name)}</strong>${line.tooth ? `<small>Pieza ${escapeHtml(line.tooth)}</small>` : ''}${line.discount_percent ? `<small>${escapeHtml(line.discount_percent)}% de descuento</small>` : ''}</td><td class="right">${escapeHtml(line.quantity)}</td><td class="right">${escapeHtml(money(line.unit_price))}</td><td class="right"><strong>${escapeHtml(money(line.total))}</strong></td></tr>`).join('')}</tbody></table></div><div class="budget-grand-total"><span>Total</span><strong>${escapeHtml(money(totals.total))}</strong></div></section>
      ${payments ? `<section class="budget-section"><div class="payment-head"><div><span class="kicker">${accepted ? 'Decisión del paciente' : 'Propuesta económica'}</span><h2>${accepted ? 'Forma de pago acordada' : 'Alternativas de pago'}</h2></div>${accepted && collectionMethod ? `<span class="payment-method"><span>Cobro previsto</span><strong>${escapeHtml(collectionMethod)}</strong></span>` : ''}</div><div class="payment-list">${payments}</div></section>` : ''}
      ${design.conditions || version.notes ? `<section class="budget-conditions"><strong>Condiciones</strong><br>${escapeHtml(design.conditions || version.notes)}</section>` : ''}
      <footer class="budget-footer"><span>${escapeHtml(clinic.legal_name || clinic.name)}</span><span>${escapeHtml(budget.number)} · ${escapeHtml(date(budget.created_at))}</span></footer>
    </main></body></html>`;
}

function fiscalHtml(document) {
  const issuer = parse(document.issuer_snapshot, {});
  const recipient = parse(document.recipient_snapshot, {});
  const lines = parse(document.lines, []);
  const totals = parse(document.totals, {});
  const template = parse(document.template_snapshot, {});
  const config = template.config || {};
  const renderer = config.renderer === 'compact' || config.header_variant === 'compact'
    ? 'compact'
    : 'modern';
  const logo = config.show_logo === false || config.logo_mode === 'none'
    ? ''
    : assetUrl(config.logo_url || issuer.logo_url);
  const typeLabel = document.document_type === 'receipt'
    ? 'Recibo'
    : document.document_type === 'credit_note' ? 'Factura rectificativa' : 'Factura';
  const issuerName = issuer.legal_name || issuer.name;
  const recipientName = recipient.legal_name || recipient.name;
  const issuerAddress = [issuer.address, issuer.postal_code, issuer.city, issuer.province, issuer.country]
    .filter(Boolean)
    .join(' · ');
  const recipientAddress = [
    recipient.address,
    recipient.postal_code,
    recipient.city,
    recipient.province,
    recipient.country,
  ].filter(Boolean).join(' · ');
  const modernHeader = `
    <header class="invoice-modern-head">
      <div class="invoice-reference"><span class="kicker">${escapeHtml(typeLabel)}</span><h1>${escapeHtml(document.number)}</h1><dl class="invoice-meta"><div><dt>Fecha de emisión</dt><dd>${escapeHtml(date(document.issue_date))}</dd></div><div><dt>Vencimiento</dt><dd>${document.due_date ? escapeHtml(date(document.due_date)) : 'Sin fecha'}</dd></div></dl></div>
      <section class="invoice-issuer">${logo ? `<img class="invoice-logo" src="${escapeHtml(logo)}" alt="">` : ''}<strong>${escapeHtml(issuerName)}</strong>${issuer.tax_id ? `<span>${escapeHtml(issuer.tax_id)}</span>` : ''}<span>${escapeHtml(issuerAddress)}</span>${issuer.email ? `<span>${escapeHtml(issuer.email)}</span>` : ''}${issuer.phone ? `<span>${escapeHtml(issuer.phone)}</span>` : ''}</section>
    </header>
    <section class="invoice-recipient"><span class="kicker">Facturar a</span><strong>${escapeHtml(recipientName)}</strong>${recipient.tax_id ? `<span>${escapeHtml(recipient.tax_id)}</span>` : ''}<span>${escapeHtml(recipientAddress)}</span>${recipient.email ? `<span>${escapeHtml(recipient.email)}</span>` : ''}</section>`;
  const compactHeader = `
    <header class="invoice-compact-head">
      <div class="invoice-brand">${logo ? `<img class="invoice-logo" src="${escapeHtml(logo)}" alt="">` : ''}<div class="invoice-brand-copy"><strong>${escapeHtml(issuerName)}</strong>${issuer.tax_id ? `<span>${escapeHtml(issuer.tax_id)}</span>` : ''}</div></div>
      <div class="invoice-compact-ref"><span class="kicker">${escapeHtml(typeLabel)}</span><h1>${escapeHtml(document.number)}</h1><span class="muted">${escapeHtml(date(document.issue_date))}</span></div>
    </header>
    <section class="invoice-compact-parties"><div><span class="kicker">Emisor</span><strong>${escapeHtml(issuerName)}</strong><span>${escapeHtml(issuerAddress)}</span></div><div><span class="kicker">Destinatario</span><strong>${escapeHtml(recipientName)}</strong>${recipient.tax_id ? `<span>${escapeHtml(recipient.tax_id)}</span>` : ''}<span>${escapeHtml(recipientAddress)}</span></div></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyles()}</style></head><body>
    <main class="page invoice-doc">
      ${renderer === 'compact' ? compactHeader : modernHeader}
      <section class="invoice-lines"><table><thead><tr><th>Concepto</th><th class="right">Precio</th><th class="right">Cant.</th><th class="right">IVA</th><th class="right">Total</th></tr></thead>
      <tbody>${lines.map((line) => `<tr><td><strong>${escapeHtml(line.description)}</strong>${line.discount_percent ? `<small class="muted">${escapeHtml(line.discount_percent)}% de descuento</small>` : ''}</td><td class="right">${escapeHtml(money(line.unit_price))}</td><td class="right">${escapeHtml(line.quantity)}</td><td class="right">${escapeHtml(line.tax_percent)}%</td><td class="right"><strong>${escapeHtml(money(line.total))}</strong></td></tr>`).join('')}</tbody></table></section>
      <section class="invoice-total"><dl><div><dt>Base imponible</dt><dd>${escapeHtml(money(totals.taxable_base))}</dd></div><div><dt>Impuestos</dt><dd>${escapeHtml(money(totals.taxes))}</dd></div><div class="grand-total"><dt>Total</dt><dd>${escapeHtml(money(totals.total))}</dd></div></dl></section>
      ${config.show_payment_details !== false && issuer.bank_account ? `<section class="invoice-payment"><span class="kicker">Datos de pago</span><p>Cuenta: <strong>${escapeHtml(issuer.bank_account)}</strong></p></section>` : ''}
      ${document.notes || config.show_legal_footer !== false ? `<footer class="footer">${document.notes ? `<div>${escapeHtml(document.notes)}</div>` : ''}${config.show_legal_footer !== false ? `<div>Documento emitido por ${escapeHtml(issuerName)}. Conserva este documento para tus registros.</div>` : ''}</footer>` : ''}
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
  const [version, events] = await Promise.all([
    EconomicBudgetVersion.findOne({
      where: { budget_id: budget.id, version_number: budget.current_version },
    }),
    EconomicBudgetEvent.findAll({
      where: { budget_id: budget.id },
      order: [['created_at', 'ASC']],
    }),
  ]);
  if (!version) throw domainError(404, 'budget_version_not_found', 'Versión del presupuesto no encontrada.');
  return {
    buffer: await render(budgetHtml(budget, version, events)),
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
      metadata: {
        immutable_snapshot: true,
        number: document.number,
        renderer_version: 'invoice-pdf-v2',
      },
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
