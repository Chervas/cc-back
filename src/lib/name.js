'use strict';

const LOWERCASE_PARTICLES = new Set([
  'a',
  'de',
  'del',
  'la',
  'las',
  'los',
  'y',
  'e',
  'da',
  'das',
  'do',
  'dos',
  'van',
  'von'
]);

function capitalizeWord(value) {
  const lower = String(value || '').toLocaleLowerCase('es-ES');
  return lower.replace(/(^|[-'’])(\p{L})/gu, (_match, prefix, letter) => (
    `${prefix}${letter.toLocaleUpperCase('es-ES')}`
  ));
}

function normalizeHumanName(value, { preserveParticles = true } = {}) {
  const cleaned = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return '';
  }

  return cleaned
    .split(' ')
    .map((word, index) => {
      const lower = word.toLocaleLowerCase('es-ES');
      if (preserveParticles && index > 0 && LOWERCASE_PARTICLES.has(lower)) {
        return lower;
      }
      return capitalizeWord(word);
    })
    .join(' ');
}

module.exports = {
  normalizeHumanName,
};
