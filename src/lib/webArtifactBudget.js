'use strict';

const { canonicalSerialize } = require('./webDocument');

// Authenticated WordPress fallback stores the complete immutable bundle in a
// JSON row. Keep the publishable unit small enough to validate once and retain
// atomically without allowing a sequence of file requests to amplify DB/heap.
const MAX_WEB_ARTIFACT_BUNDLE_BYTES = 8 * 1024 * 1024;

function webArtifactBundleFootprintBytes(manifest) {
  if (
    !manifest
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || !manifest.files
    || typeof manifest.files !== 'object'
    || Array.isArray(manifest.files)
  ) return null;
  let total;
  try {
    total = Buffer.byteLength(canonicalSerialize(manifest), 'utf8');
  } catch {
    return null;
  }
  for (const [path, metadata] of Object.entries(manifest.files)) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const bodyBytes = Number(metadata.size_bytes);
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0) return null;
    total += bodyBytes;
    total += Buffer.byteLength(String(path), 'utf8');
    total += Buffer.byteLength(String(metadata.sha256 || ''), 'utf8');
    total += Buffer.byteLength(String(metadata.content_type || ''), 'utf8');
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

module.exports = {
  MAX_WEB_ARTIFACT_BUNDLE_BYTES,
  webArtifactBundleFootprintBytes,
};
