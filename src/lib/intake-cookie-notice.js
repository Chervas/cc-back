'use strict';

// Our consent bootstrap contains compatibility selectors and cookie names for
// external CMPs. Those references do not mean a second CMP is installed.
function detectExternalCookieProviders(source) {
  const html = String(source || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, (tag, attributes) =>
      /\bdata-clinicaclick-consent-bootstrap\s*=/i.test(attributes) ? '' : tag);
    const providers = [];
    const add = (name, pattern) => {
      if (pattern.test(html) && !providers.includes(name)) providers.push(name);
    };

    add('Complianz', /cmplz-|complianz/i);
    add('Cookiebot', /cookiebot|CybotCookiebot/i);
    add('OneTrust', /onetrust|Optanon/i);
    add('CookieYes', /cookieyes|cky-consent/i);
    add('Iubenda', /iubenda/i);
    add('Didomi', /didomi/i);
    add('Borlabs Cookie', /borlabs-cookie/i);
    add('Cookie Notice', /cookie-notice|cn-notice/i);
    add('GDPR Cookie Compliance', /moove_gdpr|gdpr-cookie-compliance/i);

  return providers;
}

module.exports = { detectExternalCookieProviders };
