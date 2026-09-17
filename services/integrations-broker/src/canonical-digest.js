'use strict';

const { createHash } = require('node:crypto');

// Same bytes as canonical() for parsed JSON, without rebuilding a large file
// string at every enclosing array/object. Existing idempotency digests survive.
function canonicalDigest(value) {
  const hash = createHash('sha256');
  function write(item) {
    if (Array.isArray(item)) {
      hash.update('[');
      item.forEach((entry, index) => { if (index) hash.update(','); write(entry); });
      hash.update(']');
    } else if (item && typeof item === 'object') {
      hash.update('{');
      Object.keys(item).sort().forEach((key, index) => {
        if (index) hash.update(',');
        hash.update(JSON.stringify(key)); hash.update(':'); write(item[key]);
      });
      hash.update('}');
    } else hash.update(JSON.stringify(item));
  }
  write(value);
  return hash.digest('hex');
}

module.exports = { canonicalDigest };
