'use strict';
const { norm, hash } = require('./adapter');

/** Explicit client answers, not clinical inference. Unknown answers stay for review. */
function clientReplies(sheets, fileHash) {
  const answers = [];
  for (const sheet of sheets) {
    const answerColumn = sheet.name === 'Programas' ? 'C' : 'E';
    if (!['Tratamientos', 'Precios y documentos', 'Programas', 'Cabinas y personal'].includes(sheet.name)) continue;
    for (const row of sheet.rows) {
      if (row.source_row <= 4 || !row.cells[answerColumn]?.trim()) continue;
      answers.push({ sheet: sheet.name, row: row.source_row, topic: row.cells.B || row.cells.A || '', answer: row.cells[answerColumn].trim(),
        source: { file_sha256: fileHash, sheet: sheet.name, source_row: row.source_row, row_sha256: hash(row.cells) } });
    }
  }
  return answers;
}
function applyClientReplies(row, answers = []) {
  const evidence = [];
  const decisions = [];
  const find = (sheet, match) => answers.find(a => a.sheet === sheet && match(norm(a.topic)));
  const use = (answer, decision) => { evidence.push(answer.source); decisions.push(decision); };
  const category = norm(row.category); const name = norm(row.name);
  if (row.sheet === 'Facial · tratamientos') {
    const price = category === 'POLINUCLEOTIDOS COREANOS REJURAN'
      ? find('Precios y documentos', t => t.includes('REJURAN') && (name.includes('BONO') ? t.includes('BONO') : t.includes('SESION SUELTA')))
      : category === 'EXOSOMAS' ? find('Precios y documentos', t => t.startsWith('EXOSOMAS') && (name.includes('BONO') ? t.includes('BONO') : t.includes('SESION SUELTA'))) : null;
    if (price) {
      if (category.includes('REJURAN') && name.includes('BONO') && norm(price.answer) === '690 € BONO') { row.price = '690 €'; use(price, 'CLIENT_GROSS_PRICE_REPLACES_TARIFF'); }
      else if (category.includes('REJURAN') && !name.includes('BONO') && norm(price.answer) === '250 € SESION') { row.price = '250 €'; use(price, 'CLIENT_GROSS_PRICE_REPLACES_TARIFF'); }
      else if (category === 'EXOSOMAS' && !name.includes('BONO') && norm(price.answer) === '160 € SESION') { row.price = '160 €'; use(price, 'CLIENT_GROSS_PRICE_REPLACES_TARIFF'); }
      else if (category === 'EXOSOMAS' && name.includes('BONO') && norm(price.answer) === '420 € SESION') {
        row.price = 'Pendiente: respuesta de bono indica precio por sesión'; use(price, 'CLIENT_VOUCHER_PRICE_UNIT_AMBIGUOUS');
      }
    }
    const duration = find('Tratamientos', t => t === 'PRP FACIAL / POLINUCLEOTIDOS REJURAN');
    if (duration && norm(duration.answer) === '30 MINUTOS' && (category === 'PRP FACIAL' || category.includes('REJURAN'))) {
      row.duration = '30 min'; use(duration, 'CLIENT_FIXED_DURATION_30_MIN');
    }
    const threads = find('Tratamientos', t => t.includes('HILOS PDO') && t.includes('25, 38'));
    if (threads && /5 MINTUOS AL TOTAL/.test(norm(threads.answer)) && /HILO .*PDO/.test(category)) {
      row.quantity_duration = { preparation_minutes: 5, per_unit_minutes: /60 MM|90 MM/.test(name) ? 5 : 2, quantity_required: true };
      use(threads, 'CLIENT_PER_THREAD_DURATION_PLUS_PREPARATION');
    }
  }
  if (row.sheet === 'Capilar · sesiones y bonos' && category === 'ANALITICAS') {
    const answer = find('Tratamientos', t => t.startsWith('ANALITICA PREQUIRURGICA Y ANALITICA HORMONAL'));
    if (answer && /15 MINUTOS/.test(norm(answer.answer))) {
      row.duration = '15 min'; row.operational_note = 'Preoperatorio QX: entrega de volantes, no realización de la analítica.';
      use(answer, 'CLIENT_PREOPERATIVE_CONSULTATION_15_MIN');
    }
  }
  // Administrative/external acts are preserved as concepts, not zero-minute appointments.
  const administrative = find('Tratamientos', t => t === name || t.startsWith(name + ' /'));
  if (administrative && norm(administrative.answer) === 'CITA ADMINISTRATIVA') {
    row.booking_mode = 'administrative_review'; use(administrative, 'CLIENT_ADMINISTRATIVE_NOT_AUTOMATIC_BOOKING');
  }
  row.client_reply_evidence = evidence;
  row.client_reply_decisions = decisions;
  return row;
}
module.exports = { clientReplies, applyClientReplies };
