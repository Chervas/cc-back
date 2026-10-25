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

function payrollPeriod(value) {
  const fullDate = date(value);
  if (fullDate) return fullDate.slice(0, 7) + '-01';
  const numeric = /\b(?:(\d{4})[-/](\d{1,2})|(\d{1,2})[/\-](\d{4}))\b/.exec(value || '');
  if (numeric) return date(`${numeric[1] || numeric[4]}-${String(numeric[2] || numeric[3]).padStart(2, '0')}-01`);
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const normalized = fold(value), year = /\b((?:19|20|21)\d{2})\b/.exec(normalized);
  const found = months.map((name, index) => new RegExp(`\\b${name}\\b`).test(normalized) ? index : -1).filter(index => index >= 0);
  return year && found.length === 1 ? `${year[1]}-${String(found[0] + 1).padStart(2, '0')}-01` : null;
}

// Payrolls commonly put company and employee details, and deduction bases and
// amounts, on the same physical row. Keep the layout instead of reading the
// company NIF or the employer's contributions as employee data.
function parsePayroll(lines, warnings) {
  const employeeLabel = /(?:^|\s{2,})(trabajador(?:a)?|empleado(?:a)?|nombre y apellidos)\s*:\s*/g;
  const taxLabel = /\b(?:n\.?\s*i\.?\s*f\.?|d\.?\s*n\.?\s*i\.?)(?:\s+del?\s+trabajador(?:a)?)?\s*:\s*/g;
  const taxId = value => /^(?:[A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/i.exec(clean(value))?.[0].toUpperCase() || null;
  const employees = [];
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row], normalized = fold(line);
    for (const match of normalized.matchAll(employeeLabel)) {
      const start = match.index + match[0].length;
      const value = line.slice(start).split(/\s{2,}(?=(?:n\.?i\.?f\.?|d\.?n\.?i\.?|n[ºo.]?(?:mero)?\s+(?:de\s+)?empleado|categoria|grupo|antiguedad)\s*:)/i)[0];
      const name = clean(value).slice(0, 180);
      if (name && !/^\d+$/.test(name)) employees.push({ name, row, column: match.index + match[0].indexOf(match[1]) });
    }
  }
  const worker = employees[0];
  let employeeTaxId = null;
  if (worker) {
    for (let row = worker.row; row < Math.min(lines.length, worker.row + 8); row++) {
      for (const match of fold(lines[row]).matchAll(taxLabel)) {
        const explicitWorker = /trabajador/.test(match[0]);
        if (!explicitWorker && (worker.column > 12 ? match.index < worker.column - 8 : match.index > 12)) continue;
        const candidate = taxId(lines[row].slice(match.index + match[0].length));
        if (candidate) { employeeTaxId = candidate; break; }
      }
      if (employeeTaxId) break;
    }
  }
  const periods = lines.filter(line => /^\s*(?:periodo(?: de liquidacion)?|mes)\b\s*:?/.test(fold(line)))
    .map(line => payrollPeriod(line)).filter(Boolean);
  const uniquePeriods = new Set(periods);
  const decimalValues = value => [...value.replace(/(\d[.,])\s+(?=\d{2}\b)/g, '$1').matchAll(/-?\d[\d.,]*[.,]\d{2}(?!\d)(?:\s*€)?/g)].map(match => amount(match[0])).filter(value => value != null);
  const labelledPayrollAmount = (pattern, wrapped = false) => {
    const row = lines.findIndex(line => pattern.test(fold(line.trim())));
    if (row < 0) return null;
    const line = lines[row].trim(), match = pattern.exec(fold(line));
    // Formula numbers such as “(1 + 2)” are never monetary amounts.
    const tail = line.slice(match[0].length).replace(/\([^)]*\)/g, '').replace(/\d[\d.,]*\s*%/g, '');
    const values = decimalValues(tail);
    if (values.length) return values[values.length - 1];
    const integer = /^\s*[:.\-]?\s*(-?\d+)\s*(?:EUR|€)?\s*$/i.exec(tail);
    if (integer) return amount(integer[1]);
    if (wrapped && row + 1 < lines.length) {
      const next = /^[\s.o·:_]*(-?\d[\d.,]*(?:\s*€)?)(?:\s*EUR)?\s*$/i.exec(lines[row + 1]);
      if (next) return amount(next[1]);
    }
    return null;
  };
  const rowAmount = line => {
    const withoutRates = line.replace(/\d[\d.,]*\s*%/g, '');
    const values = decimalValues(withoutRates);
    return values.length ? values[values.length - 1] : null;
  };
  let deductions = false, workerContributions = null, incomeTax = null;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row], normalized = fold(line);
    if (/^\s*ii\.?\s*deducciones\b/.test(normalized)) deductions = true;
    if (deductions && /\btotal aportaciones\b/.test(normalized)) workerContributions = rowAmount(line.split(/recibi/i)[0]);
    const heading = /\bimpuesto\s+sobre\s+la\s+renta\s+de\s+las\s+personas\b/.exec(normalized);
    if (heading) {
      // The right column may wrap “físicas” onto the next row. Only a value
      // printed after the percentage is a deduction, never its taxable base.
      for (let next = row; next < Math.min(lines.length, row + 3); next++) {
        const rightColumn = lines[next].slice(Math.max(0, heading.index - 3));
        if (next > row && /^\s*\d\s*[.)]\s*(?!\d)/.test(rightColumn)) break;
        const rate = /\d[\d.,]*\s*%/.exec(rightColumn);
        if (rate) {
          const values = decimalValues(rightColumn.slice(rate.index + rate[0].length));
          if (values.length) incomeTax = values[values.length - 1];
          break;
        }
      }
    }
    if (/\brecibi\b/.test(normalized) || /^\s*(?:determinacion de las bases|aportacion de la empresa)\b/.test(normalized)) deductions = false;
  }
  const data = {
    employee_name: worker?.name || null, employee_tax_id: employeeTaxId,
    period_month: uniquePeriods.size === 1 ? periods[0] : null,
    gross_salary: labelledPayrollAmount(/^(?:[a-z]\.\s*)?(?:salario bruto|total devengado|total ingresos)\b/, true),
    employee_social_security: workerContributions ?? labelledPayrollAmount(/^(?:ss trabajador|seguridad social (?:del )?trabajador|total aportaciones (?:del )?trabajador)\b/),
    irpf_withholding: incomeTax ?? labelledPayrollAmount(/^(?:retencion(?:es)? (?:de )?irpf|irpf)\b/),
    net_salary: labelledPayrollAmount(/^(?:neto(?: a percibir)?|liquido(?: total)? a percibir|total liquido)\b/, true),
    other_amounts: labelledPayrollAmount(/^otros importes\b/),
  };
  if (new Set(employees.map(employee => fold(employee.name))).size > 1) {
    warnings.unshift('El archivo contiene varias personas. Importa una nómina por archivo y comprueba persona, mes e importes.');
    data.employee_name = null; data.employee_tax_id = null; data.period_month = null;
    for (const key of PAYROLL_AMOUNTS) data[key] = null;
  } else if (uniquePeriods.size > 1) {
    warnings.unshift('El archivo contiene varios meses. Importa una nómina por persona y mes y comprueba los importes.');
    for (const key of PAYROLL_AMOUNTS) data[key] = null;
  }
  return data;
}

function parseDocumentText(text, kind = 'expense') {
  text = String(text || '').slice(0, 512 * 1024);
  const layoutLines = text.split(/[\r\n\f]+/).filter(line => line.trim());
  const lines = layoutLines.map(line => line.trim());
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
  const currencies = new Set((text.match(/\b(?:EUR|USD|GBP|CHF|CAD|AUD|JPY|CNY|MAD|MXN|ARS|COP|CLP|BRL|PEN)\b/gi) || []).map(value => value.toUpperCase()));
  if (/€|\beuros?\b/i.test(text)) currencies.add('EUR');
  if (/£/.test(text)) currencies.add('GBP');
  const currency = currencies.size === 1 ? [...currencies][0] : currencies.size > 1 ? null : /\$/.test(text) ? '$' : null;
  if (currencies.size > 1) warnings.push('El documento contiene varias monedas. Comprueba la moneda de los importes antes de registrar.');
  let data;
  if (kind === 'payroll') {
    data = parsePayroll(layoutLines, warnings);
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

module.exports = { readLocalDocument, parseDocumentText, amount, date, EXPENSE_AMOUNTS, PAYROLL_AMOUNTS, runLocalDecoder: run };
