'use strict';

const GRANTED_VALUES = new Set([
  'granted',
  'grant',
  'accepted',
  'accept',
  'yes',
  'true',
  '1',
  'optin',
  'opt_in',
]);

const DENIED_VALUES = new Set([
  'denied',
  'deny',
  'rejected',
  'reject',
  'no',
  'false',
  '0',
  'optout',
  'opt_out',
]);

const CONTACT_PURPOSES = ['contact', 'phone', 'email', 'whatsapp'];
const ADVERTISING_PURPOSES = ['ad_user_data', 'adUserData', 'marketing'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeExplicitChoice(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (GRANTED_VALUES.has(normalized)) return true;
  if (DENIED_VALUES.has(normalized)) return false;
  return null;
}

function ownChoice(consent, key) {
  if (!Object.prototype.hasOwnProperty.call(consent, key)) return null;
  return normalizeExplicitChoice(consent[key]);
}

function cleanMetadata(value, maxLength) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function parseCapturedAt(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Extracts the denormalized LeadIntake consent fields emitted by intake.js.
 *
 * A plain object is only treated as consent evidence when it contains at
 * least one recognized, explicit decision. Denied decisions retain their
 * timestamp/source/version for audit, but never create a legal basis.
 */
function deriveLeadConsentMetadata(consent) {
  if (!isPlainObject(consent)) {
    return {
      basis: null,
      capturedAt: null,
      source: null,
      version: null,
    };
  }

  const contactChoices = CONTACT_PURPOSES.map((key) => ownChoice(consent, key));
  const advertisingChoices = ADVERTISING_PURPOSES.map((key) => ownChoice(consent, key));
  const recognizedChoices = [...contactChoices, ...advertisingChoices].filter((value) => value !== null);

  if (recognizedChoices.length === 0) {
    return {
      basis: null,
      capturedAt: null,
      source: null,
      version: null,
    };
  }

  const explicitContactGrant = contactChoices.includes(true);
  // As in the conversion uploader, an explicit advertising denial wins over
  // a simultaneous grant so contradictory state is never promoted.
  const explicitAdvertisingGrant = advertisingChoices.includes(true)
    && !advertisingChoices.includes(false);

  return {
    basis: explicitContactGrant || explicitAdvertisingGrant ? 'consent' : null,
    capturedAt: parseCapturedAt(consent.captured_at ?? consent.capturedAt),
    source: cleanMetadata(consent.source, 255),
    version: cleanMetadata(consent.version, 64),
  };
}

module.exports = {
  deriveLeadConsentMetadata,
  normalizeExplicitChoice,
};
