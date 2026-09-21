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
  // Answers are scoped by the worksheet and the named act, not by a word
  // such as "carboxiterapia" shared by facial, corporal and capilar services.
  if (['Tratamientos individuales', 'Programas y mantenimientos'].includes(row.sheet)
    && /^ESTUDIO CORPORAL BS(?:$|\s)/.test(name)) {
    const answer = find('Tratamientos', topic => topic === 'ESTUDIO CORPORAL BS');
    if (answer && /DRA\.?\s*CAMACHO/.test(norm(answer.answer)) && /15 M\./.test(norm(answer.answer))) {
      row.duration = '15 min'; row.professional = 'Dr. Camacho';
      use(answer, 'CLIENT_BODY_ASSESSMENT_CAMACHO_15_MIN');
    }
  }
  if (row.sheet === 'Tratamientos individuales' && category === 'INYECTABLES CORPORALES'
    && /^(CARBOXITERAPIA CORPORAL|MESOTERAPIA LIPOLITICA|BIOESTIMULACION CORPORAL)/.test(name)) {
    const answer = find('Tratamientos', topic => topic === 'CARBOXITERAPIA / MESOTERAPIA LIPOLITICA / BIOESTIMULACION');
    if (answer && /PIEDAD/.test(norm(answer.answer)) && /10 MINUTOS/.test(norm(answer.answer))) {
      row.duration = '10 min'; row.professional = 'Aux. Piedad';
      use(answer, 'CLIENT_BODY_INJECTABLE_PIEDAD_10_MIN_PENDING_CLINICAL_VALIDATION');
    }
  }
  if (row.sheet === 'Cirugía plástica · tarifa' && name === 'PRIMERA VISITA · ENFERMERIA') {
    const answer = find('Tratamientos', topic => topic === 'PRIMERA VISITA DE ENFERMERIA');
    if (answer && /^MAR UNOS 45 MINUTOS$/.test(norm(answer.answer))) {
      row.duration = '45 min'; row.professional = 'Mar';
      use(answer, 'CLIENT_FIRST_NURSING_VISIT_MAR_45_MIN');
    }
  }
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
  const administrative = find('Tratamientos', t => t.split(' / ').includes(name));
  if (administrative && norm(administrative.answer) === 'CITA ADMINISTRATIVA') {
    row.booking_mode = 'administrative_review'; use(administrative, 'CLIENT_ADMINISTRATIVE_NOT_AUTOMATIC_BOOKING');
  }
  if (row.sheet === 'Obesidad · tarifa' && category === 'BALON INTRAGASTRICO'
    && /^(BALON INGERIBLE · 4 MESES|BALON · (6|12) MESES)$/.test(name)) {
    const answer = find('Tratamientos', topic => topic === 'BALON INGERIBLE / BALON 6 MESES / BALON 12 MESES');
    if (answer && norm(answer.answer) === 'CITA ADMINISTRATIVA') {
      row.booking_mode = 'administrative_review'; use(answer, 'CLIENT_BALLOON_EXTERNAL_ADMINISTRATIVE_NOT_AUTOMATIC_BOOKING');
    }
  }
  row.client_reply_evidence = evidence;
  row.client_reply_decisions = decisions;
  return row;
}
module.exports = { clientReplies, applyClientReplies };
