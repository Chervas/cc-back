'use strict';
const SocialConsent = require('../../services/integrations-broker/src/meta-marketing-social-consent');

function configuredQuickChat() {
  const raw = process.env.META_SOCIAL_INBOX_CONSENT_TARGETS;
  if (!raw) return [];
  try { return SocialConsent.config(JSON.parse(raw)); }
  catch { return []; }
}

function normalConsentScopes(scopes, clinicIds) {
  const targets = configuredQuickChat().filter(account => clinicIds.includes(account.clinicId));
  return SocialConsent.scopesFor(scopes, targets);
}

module.exports = { configuredQuickChat, normalConsentScopes };
