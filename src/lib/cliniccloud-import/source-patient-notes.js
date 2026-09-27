'use strict';
const { norm } = require('./adapter');
const REASON = 'SOURCE_NOTE_REFERS_TO_OTHER_PATIENT';
// A narrow review signal, not identity inference or a clinical language parser.
// A relative calling/accompanying the patient is not the beneficiary of care.
// Start-of-sentence anchoring deliberately avoids negations and quoted context.
const OTHER_PATIENT = /(?:^|[.!?\n]\s*)(?:(?:(?:ESTA|LA)\s+(?:CITA|VISITA)\s+ES|(?:CITA|VISITA)|ES)\s+PARA\s+(?:SU|MI)\s+(?:HERMAN[OA]S?|HIJ[OA]S?|MADRE|PADRE|MARIDO|MUJER|ESPOS[OA]|PAREJA|AMIG[OA]S?))\b/u;
function refersToOtherPatient(note) {
  // Preserve sentence boundaries before normalizing whitespace/case/accents.
  return String(note || '').split(/\r?\n/).some(line => OTHER_PATIENT.test(norm(line)));
}
function assertSourcePatientUnambiguous(note) {
  if (refersToOtherPatient(note)) throw Error(REASON);
}
module.exports = { REASON, refersToOtherPatient, assertSourcePatientUnambiguous };
