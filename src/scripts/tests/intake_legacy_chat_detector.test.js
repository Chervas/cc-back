'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  detectLegacyJoinChat,
  hasJoinChatAsset,
  hasJoinChatMarkup,
} = require('../../lib/intake-legacy-chat');

function run() {
  const coreAsset = `
    <link rel="stylesheet"
      href="/wp-content/plugins/creame-whatsapp-me/public/css/joinchat.min.css?ver=5.2.0">
  `;
  assert.equal(hasJoinChatAsset(coreAsset), true);
  assert.equal(detectLegacyJoinChat(coreAsset), true, 'JoinChat core asset must be detected');

  const premiumAsset = `
    <script src="https://example.test/wp-content/plugins/joinchat-premium/assets/js/premium.js"></script>
  `;
  assert.equal(hasJoinChatAsset(premiumAsset), true);
  assert.equal(detectLegacyJoinChat(premiumAsset), true, 'JoinChat premium asset must be detected');

  const themeIdMarkup = '<aside id="joinchat"></aside>';
  assert.equal(hasJoinChatMarkup(themeIdMarkup), true);
  assert.equal(detectLegacyJoinChat(themeIdMarkup), true, 'Real JoinChat id markup must be detected');

  const themeClassMarkup = '<button class="widget joinchat__button" type="button">WhatsApp</button>';
  assert.equal(hasJoinChatMarkup(themeClassMarkup), true);
  assert.equal(detectLegacyJoinChat(themeClassMarkup), true, 'Real JoinChat class markup must be detected');

  const selectorHookOnly = `
    <script>
      document.querySelectorAll('.joinchat__button').forEach((button) => button.remove());
    </script>
  `;
  assert.equal(hasJoinChatMarkup(selectorHookOnly), false);
  assert.equal(detectLegacyJoinChat(selectorHookOnly), false,
    'A theme JavaScript selector without assets or DOM must not be treated as an installation');

  const editorialText = `
    <article>
      <h2>Cómo migramos desde JoinChat</h2>
      <p>El plugin creame-whatsapp-me y JoinChat Premium ya están desactivados.</p>
      <code>/wp-content/plugins/creame-whatsapp-me/public/js/joinchat.js</code>
    </article>
  `;
  assert.equal(detectLegacyJoinChat(editorialText), false,
    'Editorial mentions must not be treated as installation evidence');

  const scriptTemplateOnly = `
    <script>const oldMarkup = '<div id="joinchat" class="joinchat"></div>';</script>
  `;
  assert.equal(detectLegacyJoinChat(scriptTemplateOnly), false,
    'HTML-looking strings inside JavaScript are not live DOM');

  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/intake.controller.js'),
    'utf8'
  );
  assert.match(controllerSource, /const joinChatDetected = detectLegacyJoinChat\(html\)/,
    'The live verifier must use the DOM-aware detector');
  assert.doesNotMatch(controllerSource, /\(\?:joinchat\|creame-whatsapp-me\|joinchat-premium\)/,
    'The legacy broad-text regex must not remain in the live verifier');

  console.log('intake_legacy_chat_detector.test.js OK');
}

run();
