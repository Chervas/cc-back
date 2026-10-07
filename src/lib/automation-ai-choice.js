'use strict';

// Representation normalization only, never a clinical/intent synonym map.
// A model may put literal quotes (or their HTML representation) around a tool
// enum. Accept only an exact allowlisted value after removing ONE such pair.
function canonicalAiChoice(value, allowed) {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate.startsWith('&quot;') && candidate.endsWith('&quot;')) {
    candidate = candidate.slice(6, -6);
  } else if (candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1);
  }
  return allowed.includes(candidate) ? candidate : null;
}

module.exports = { canonicalAiChoice };
