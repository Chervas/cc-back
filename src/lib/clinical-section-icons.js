'use strict';

// Only names from the bundled outline icon set are stored in clinical snapshots.
const SECTION_ICON_KEYS = Object.freeze([
  'document-text', 'clipboard-document-list', 'chat-bubble-left-right',
  'magnifying-glass', 'heart', 'beaker', 'shield-check', 'arrow-trending-up',
  'clipboard-document-check', 'calendar-days', 'lock-closed', 'user', 'camera',
  'chart-bar', 'sparkles', 'hand-raised', 'check-circle', 'information-circle',
]);
const allowed = new Set(SECTION_ICON_KEYS);
function sectionIcon(value, invalid) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) throw invalid();
  return value;
}
module.exports = { SECTION_ICON_KEYS, sectionIcon };
