'use strict';
// ClinicCloud intake rows use a given name followed by "PV" (first visit),
// not a family name. That two-token label alone is not an identity match.
// Longer names retain the conservative full-name/variant protections.
function isIntakePlaceholderName(value) {
  const tokens = String(value || '').trim().toUpperCase().split(/\s+/);
  return tokens.length === 2 && tokens.includes('PV');
}
module.exports = { isIntakePlaceholderName };
