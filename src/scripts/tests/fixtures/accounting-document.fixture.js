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
function pdf(lines) {
  const escaped = value => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = 'BT /F1 14 Tf 50 780 Td 24 TL\n' + lines.map((line, index) => (index ? 'T* ' : '') + '(' + escaped(line) + ') Tj').join('\n') + '\nET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let value = '%PDF-1.4\n', offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}
module.exports = { pdf, invoiceLines, payrollLines };
