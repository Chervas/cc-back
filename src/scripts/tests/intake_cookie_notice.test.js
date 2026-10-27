'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { detectExternalCookieProviders } = require('../../lib/intake-cookie-notice');
const bootstrap = `<script data-clinicaclick-consent-bootstrap="3.4.6">document.cookie='cmplz_marketing=deny'; var style='html #cmplz-cookiebanner-container';</script>`;
test('our compatibility bootstrap and commented assets do not claim an external CMP', () => {
  assert.deepEqual(detectExternalCookieProviders(bootstrap + '<!-- <script src="/complianz.js"></script> -->'), []);
});
test('a real CMP resource remains visible alongside our bootstrap', () => {
  assert.deepEqual(detectExternalCookieProviders(bootstrap + '<script src="/wp-content/plugins/complianz-gdpr/cookiebanner/js/complianz.min.js"></script>'), ['Complianz']);
  assert.deepEqual(detectExternalCookieProviders(bootstrap + '<script src="https://consent.cookiebot.com/uc.js"></script>'), ['Cookiebot']);
});
test('external inline configuration is retained and providers are deduplicated', () => {
  assert.deepEqual(detectExternalCookieProviders('<script>var cmplz = {"banner_class":"cmplz-cookiebanner"};</script><div class="cmplz-cookiebanner"></div><script src="https://cdn.cookielaw.org/onetrust.js"></script>'), ['Complianz','OneTrust']);
});
