'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';

const controller = require('../../controllers/notificationPreferences.controller');

const result = controller._test.buildPresentationPreferences([
  {
    preferenceKey: 'automation.appointment_data.confirmed_with_reply',
    enabled: false,
  },
]);

assert.deepEqual(result.map((item) => ({ key: item.key, enabled: item.enabled })), [
  {
    key: 'automation.appointment_data.confirmed_with_reply',
    enabled: false,
  },
  {
    key: 'automation.appointment_data.response_needs_human',
    enabled: true,
  },
]);

console.log('notification_presentation_preferences.test.js OK');
