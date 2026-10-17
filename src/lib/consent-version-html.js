'use strict';

const privacy = require('./bs-privacy-digital-template');

// Digital templates remain versioned legal content. Identity is rendered from
// the issuance context, never inferred from the current mutable patient record.
function renderConsentVersionHtml(version, context, legacyRenderer) {
  const composed = require('./consent-document-blocks').renderVersion(version, context);
  if (composed !== null) return composed;
  let body = version?.body_json;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (require('./registration-privacy-template').schema(body)) {
    return require('./registration-privacy-template').render(version, context);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'digital_presentation')) {
    if (!privacy.isApprovedPrivacyPresentation({ bodyHtml: version.body_html, bodyJson: body })) {
      throw Object.assign(new Error('consent_digital_presentation_invalid'), {
        code: 'consent_digital_presentation_invalid', statusCode: 409,
      });
    }
    return privacy.buildBsPrivacyDigitalHtml(context).html;
  }
  return legacyRenderer(version?.body_html || '', context);
}

module.exports = { renderConsentVersionHtml };
