'use strict';
// Synthetic documents only: no source patient, employee or supplier data.
const invoiceLines = [
  'Proveedor: Proveedor ficticio QA', 'NIF: B12345674', 'Direccion: Calle ficticia 1',
  'Factura No: QA-2026-001', 'Fecha de emision: 25/10/2026', 'Vencimiento: 25/11/2026',
  'Base imponible: 100,00', 'IVA 21%: 21,00', 'Retencion: 0,00', 'Total: 121,00 EUR',
];
const payrollLines = [
  'Empleado: Persona ficticia QA', 'Mes: 10/2026', 'Salario bruto: 2.000,00 EUR',
  'SS trabajador: 130,00', 'IRPF 10%: 200,00', 'Neto: 1.670,00', 'Otros importes: 0,00',
];
const columns = (left, right = '', column = 76) => left.padEnd(column, ' ') + right;
const spanishPayrollLines = [
  columns('Empresa: Sociedad ficticia QA', 'Trabajador: Persona ficticia Dos Columnas'),
  columns('N.I.F.: B12345674', 'N.I.F.: 12345678Z          Numero empleado: 17'),
  columns('Domicilio: Calle de prueba 1', 'Categoria: Personal de prueba'),
  'Periodo de liquidacion: del 1 de Septiembre al 30 de Septiembre de 2025   Total dias [30]',
  'I. DEVENGOS',
  columns('1. Percepciones salariales', '2. Percepciones no salariales'),
  'Salario base                     2.000,00',
  columns('', 'A. TOTAL DEVENGADO (1 + 2) .......... 2.400,00'),
  'II. DEDUCCIONES',
  columns('1. Aportacion del trabajador a la Seguridad Social', '2. Impuesto sobre la renta de las personas'),
  columns('Contingencias comunes   2.400,00 4,70 % 112,80', 'fisicas    2.400,00 12,00 %                 288,00'),
  columns('Desempleo               2.400,00 1,55 % 37,20', '3. Anticipos'),
  columns('Formacion profesional   2.400,00 0,10 % 2,40', '4. Valor de productos recibidos en especie'),
  columns('', 'B. TOTAL A DEDUCIR ..................... 440,40'),
  columns('', 'LIQUIDO TOTAL A PERCIBIR (A - B) ....... 1.959,60'),
  columns('TOTAL APORTACIONES .............. 152,40', 'RECIBI'),
  'DETERMINACION DE LAS BASES DE COTIZACION Y APORTACION DE LA EMPRESA',
  columns('Seguridad Social de la EMPRESA', 'BASE              TIPO             APORTACION'),
  columns('TOTAL APORTACIONES .............. 999,99', '2.400,00          30,00 %            720,00'),
  'Base sujeta a retencion del IRPF ............. 2.400,00',
];
function pdf(lines, options = {}) {
  const escaped = value => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 ${options.monospace ? 8 : 14} Tf 30 780 Td ${options.monospace ? 25 : 24} TL\n` + lines.map((line, index) => (index ? 'T* ' : '') + '(' + escaped(line) + ') Tj').join('\n') + '\nET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${options.monospace ? 842 : 595} 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${options.monospace ? 'Courier' : 'Helvetica'} >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let value = '%PDF-1.4\n', offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}
module.exports = { pdf, invoiceLines, payrollLines, spanishPayrollLines };
