'use strict';

const { spawn } = require('node:child_process');

const EXPENSE_AMOUNTS = ['taxable_base', 'tax_amount', 'withholding_amount', 'total'];
const PAYROLL_AMOUNTS = ['gross_salary', 'employee_social_security', 'irpf_withholding', 'net_salary', 'other_amounts'];
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

// Fixed local decoders receive private bytes on stdin. No shell, filenames,
// temporary public files, remote URLs or provider credentials are involved.
function run(binary, args, buffer, limit = 512 * 1024, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', OMP_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1' } });
    const chunks = []; let length = 0, done = false;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(Error('local_document_timeout')), timeout);
    child.stdout.on('data', chunk => { length += chunk.length; if (length > limit) return finish(Error('local_document_limit')); chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => finish(Error('local_document_unavailable')));
    child.on('close', code => code === 0 ? finish(null, Buffer.concat(chunks)) : finish(Error('local_document_invalid')));
    child.stdin.end(buffer);
  });
}

function amount(value) {
  let text = String(value || '').replace(/[\s€]/g, '').trim();
  if (!/^-?\d[\d.,]*$/.test(text)) return null;
  if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else if (text.includes(',')) text = text.replace(',', '.');
  const parsed = Number(text);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 100000000 ? Math.round(parsed * 100) / 100 : null;
}

function date(value) {
  const match = /\b(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}))\b/.exec(value || '');
  if (!match) return null;
  const year = Number(match[1] || match[6]), month = Number(match[2] || match[5]), day = Number(match[3] || match[4]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2200 && parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? parsed.toISOString().slice(0, 10) : null;
}

function parseDocumentText(text, kind = 'expense') {
  text = String(text || '').slice(0, 512 * 1024);
  const lines = String(text || '').slice(0, 512 * 1024).split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
  const warnings = ['Lectura local: comprueba los datos propuestos con el documento original.'];
  const find = pattern => lines.find(line => pattern.test(fold(line))) || '';
  const labelValue = pattern => {
    const line = find(pattern); if (!line) return null;
    const match = pattern.exec(fold(line));
    return clean(line.slice((match?.index || 0) + (match?.[0].length || 0)).replace(/^\s*[:#\-]\s*/, '')) || null;
  };
  const labelledAmount = pattern => {
    const line = find(pattern); if (!line) return null;
    // The last monetary number on a labelled row is the amount, not a tax rate.
    const values = line.replace(/\d[\d.,]*\s*%/g, '').match(/-?\d[\d.,]*(?:\s*€)?/g) || [];
    return values.length ? amount(values[values.length - 1]) : null;
  };
  const foreign = /\b(?:USD|GBP|CHF|CAD|AUD|JPY|CNY|MAD|MXN|ARS|COP|CLP|BRL|PEN)\b/i.exec(text);
  const currency = foreign ? foreign[0].toUpperCase() : /\$/.test(text) ? '$' : /£/.test(text) ? 'GBP' : /\bEUR\b|€|\beuros?\b/i.test(text) ? 'EUR' : null;
  let data;
  if (kind === 'payroll') {
    const period = labelValue(/^(?:periodo(?: de liquidacion)?|mes)\s*:?\s*/);
    let periodMonth = date(period);
    if (!periodMonth) {
      const numeric = /\b(?:(\d{4})[-/](\d{1,2})|(\d{1,2})[/\-](\d{4}))\b/.exec(period || '');
      if (numeric) periodMonth = date(`${numeric[1] || numeric[4]}-${String(numeric[2] || numeric[3]).padStart(2, '0')}-01`);
      else {
        const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
        const year = /\b(20\d{2})\b/.exec(period || ''), month = months.findIndex(value => fold(period).includes(value));
        if (year && month >= 0) periodMonth = `${year[1]}-${String(month + 1).padStart(2, '0')}-01`;
      }
    }
    data = {
      employee_name: labelValue(/^(?:trabajador(?:a)?|empleado(?:a)?|nombre y apellidos)\s*:?\s*/)?.slice(0, 180) || null,
      employee_tax_id: labelValue(/^(?:nif(?: del trabajador)?|dni)\s*:?\s*/)?.slice(0, 40) || null,
      period_month: periodMonth ? periodMonth.slice(0, 7) + '-01' : null,
      gross_salary: labelledAmount(/^(?:salario bruto|total devengado|total ingresos)\b/),
      employee_social_security: labelledAmount(/^(?:ss trabajador|seguridad social (?:del )?trabajador|total aportaciones (?:del )?trabajador)\b/),
      irpf_withholding: labelledAmount(/^(?:retencion(?:es)? (?:de )?irpf|irpf)\b/),
      net_salary: labelledAmount(/^(?:neto(?: a percibir)?|liquido(?: total)? a percibir|total liquido)\b/),
      other_amounts: labelledAmount(/^otros importes\b/),
    };
  } else {
    const taxIds = [...new Set((text.match(/\b(?:[A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/g) || []))];
    data = {
      supplier_name: labelValue(/^(?:proveedor|razon social(?: del proveedor)?)\s*:?\s*/)?.slice(0, 180) || null,
      supplier_tax_id: labelValue(/^(?:nif|cif)(?:\s+(?:del )?proveedor)?\s*:?\s*/)?.slice(0, 40) || (taxIds.length === 1 ? taxIds[0] : null),
      supplier_address: labelValue(/^direccion(?: del proveedor)?\s*:?\s*/)?.slice(0, 500) || null,
      document_number: labelValue(/^(?:factura(?:\s*(?:n[ºo°.]|numero|num\.?))?|numero de factura)\s*[:#]?\s*/)?.slice(0, 100) || null,
      issue_date: date(labelValue(/^(?:fecha(?: de emision)?|emision)\s*:?\s*/)),
      due_date: date(labelValue(/^(?:vencimiento|fecha de vencimiento)\s*:?\s*/)),
      category: null, payment_method: null,
      taxable_base: labelledAmount(/^(?:base imponible|base iva|subtotal)\b/),
      tax_amount: labelledAmount(/^(?:importe (?:del )?iva|iva|cuota iva)\b/),
      withholding_amount: labelledAmount(/^(?:retencion(?:es)?(?: irpf)?|irpf)\b/),
      total: labelledAmount(/^(?:total(?: factura| a pagar)?|importe total)\b/),
    };
  }
  if (kind === 'payroll') {
    const names = new Set(lines.filter(line => /^(?:trabajador(?:a)?|empleado(?:a)?|nombre y apellidos)\s*:/i.test(fold(line))).map(fold));
    if (names.size > 1) {
      warnings.unshift('El archivo contiene varias personas. Importa una nómina por archivo y comprueba persona, mes e importes.');
      data.employee_name = null; data.period_month = null;
      for (const key of PAYROLL_AMOUNTS) data[key] = null;
    }
  }
  const missing = (kind === 'payroll' ? PAYROLL_AMOUNTS : EXPENSE_AMOUNTS).filter(key => data[key] == null);
  if (missing.length) warnings.push('Hay importes sin leer. Complétalos; un campo vacío no equivale a cero.');
  if (!currency) warnings.push('La moneda no se ha podido leer. Confírmala antes de registrar.');
  return { ...data, currency, confidence: 0, warnings };
}

async function readLocalDocument({ buffer, contentType, documentKind }) {
  let text = '', model = 'manual';
  try {
    if (contentType === 'application/pdf') {
      text = (await run('/usr/bin/pdftotext', ['-layout', '-f', '1', '-l', '20', '-enc', 'UTF-8', '-', '-'], buffer)).toString('utf8');
      if (text.trim().length > 30) model = 'pdftotext';
    }
    if (text.trim().length <= 30) {
      const image = contentType === 'application/pdf' ? await run('/usr/bin/pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '1800', '-png', '-'], buffer, 12 * 1024 * 1024) : buffer;
      text = (await run('/usr/bin/tesseract', ['stdin', 'stdout', '-l', 'spa+eng', '--psm', '3'], image, 512 * 1024, 20000)).toString('utf8');
      model = 'tesseract';
    }
  } catch {
    // A missing decoder, unreadable scan or timeout remains a human review,
    // with empty fields. Never claim that an unread amount is zero.
  }
  const data = parseDocumentText(text, documentKind);
  if (!text.trim()) data.warnings.unshift('No se pudo leer el documento localmente. Introduce sus datos y comprueba el original.');
  if (contentType === 'application/pdf') data.warnings.push('Se leen hasta 20 páginas de texto; los PDF escaneados se revisan a partir de la primera página.');
  return { data, provider: model === 'manual' ? 'manual' : 'local', model };
}

module.exports = { readLocalDocument, parseDocumentText, amount, date, EXPENSE_AMOUNTS, PAYROLL_AMOUNTS };
