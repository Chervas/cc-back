'use strict';
const SocialConsent = require('../../services/integrations-broker/src/meta-marketing-social-consent');

function configuredQuickChat() {
  const raw = process.env.META_SOCIAL_INBOX_CONSENT_TARGETS;
  if (!raw) return [];
  try { return SocialConsent.config(JSON.parse(raw)); }
  catch { return []; }
}

// The authenticated owner chooses the channels in its single environment setting.
// CRM independently constrains the returned consent URL to the known scope sets.
function permittedConsentScopes(scopes, targets, scopeKey, clinicIds) {
  const choices = SocialConsent.singleChannels(['messenger','instagram'], scopeKey, clinicIds);
  return [[], ...choices.map(channel => [channel]), choices].map(channels => SocialConsent.scopesFor(scopes, targets, channels));
}

module.exports = { configuredQuickChat, permittedConsentScopes };
