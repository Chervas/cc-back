'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');
const M = require('../../../services/integrations-broker/src/whatsapp-template-management');

function fixture(env = {}) {
  const calls = []; let bound = true; let failure = false;
  const broker = { templateBinding: async () => bound ? { assetId: 1 } : null,
    templates: async (waba, operation, payload) => {
      calls.push({ waba, operation, payload }); if (failure) throw Error('synthetic_upload_failed');
      return { handle: 'SYNTHETIC_REAL_UPLOAD_HANDLE' };
    } };
  const service = loadSource('whatsappTemplates.service', { '../../models': {}, './queue.service': { queues: {} },
    './jobRequests.service': {}, './whatsappTemplateAutomationSync.service': {},
    '../lib/whatsappAuthorizedBrokerClient': broker,
    '../../services/integrations-broker/src/whatsapp-template-management': M,
    '../lib/metaQuarantineHttp': new Proxy({}, { get: () => () => assert.fail('no legacy Meta transport') }),
  }, env);
  return { ...service._test, calls, unbind() { bound = false; }, fail() { failure = true; } };
}
const template = (format, sample) => ({ name: 'synthetic', components: [
  { type: 'HEADER', format, ...(sample ? { example: { header_handle: [sample] } } : {}) }, { type: 'BODY', text: 'Hello {{1}}' },
] });
const logger = { warn() {}, info() {} };

test('native catalog preparation replaces a VIDEO source URL with its broker-uploaded handle and preserves BODY', async () => {
  const f = fixture({ WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE: 'FORBIDDEN_IMAGE_HANDLE' });
  const input = template('VIDEO', 'https://video.cdninstagram.com/original.mp4');
  const result = await f.prepareTemplateImageHeaderForMeta({ template: input, wabaId: '301', logger });
  assert.equal(result.issue, null); assert.equal(result.source, 'meta_upload');
  assert.equal(result.template.components[0].example.header_handle[0], 'SYNTHETIC_REAL_UPLOAD_HANDLE');
  assert.equal(result.template.components[1].text, input.components[1].text);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [{ waba: '301', operation: M.HEADER, payload: { source: input.components[0].example.header_handle[0], format: 'VIDEO' } }]);
  assert.equal(f.getImageHeaderSampleIssue(result.template), null);
});

test('missing VIDEO sample or unavailable broker remains pending with an explicit reason and no legacy request', async () => {
  const f = fixture({ WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE: 'IMAGE_ONLY_HANDLE' });
  const missing = await f.prepareTemplateImageHeaderForMeta({ template: template('VIDEO'), wabaId: '301', logger });
  assert.equal(missing.issue, 'missing_video_header_sample'); assert.equal(f.calls.length, 0);
  assert.match(f.buildImageHeaderSamplePendingReason(missing.issue), /MP4 original/);
  f.unbind();
  const blocked = await f.prepareTemplateImageHeaderForMeta({ template: template('VIDEO', 'https://video.cdninstagram.com/original.mp4'), wabaId: '301', logger });
  assert.equal(blocked.issue, 'video_header_sample_upload_failed');
  assert.equal(blocked.error.message, 'whatsapp_template_video_header_authorized_broker_required'); assert.equal(f.calls.length, 0);
});

test('IMAGE sample preparation keeps its existing operation payload and IMAGE configured handle', async () => {
  const f = fixture();
  const result = await f.prepareTemplateImageHeaderForMeta({ template: template('IMAGE', 'https://scontent.fbcdn.net/photo.jpg'), wabaId: '301', logger });
  assert.equal(result.issue, null); assert.equal(f.calls[0].payload.format, undefined);
  const configured = fixture({ WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE: 'IMAGE_HANDLE' });
  const current = await configured.prepareTemplateImageHeaderForMeta({ template: template('IMAGE'), wabaId: '301', logger });
  assert.equal(current.template.components[0].example.header_handle[0], 'IMAGE_HANDLE'); assert.equal(configured.calls.length, 0);
});

test('VIDEO existing valid handle needs no upload while an upload failure never pretends readiness', async () => {
  const f = fixture();
  const ready = await f.prepareTemplateImageHeaderForMeta({ template: template('VIDEO', 'EXISTING_VIDEO_HANDLE'), wabaId: '301', logger });
  assert.equal(ready.issue, null); assert.equal(f.calls.length, 0);
  f.fail();
  const failed = await f.prepareTemplateImageHeaderForMeta({ template: template('VIDEO', 'https://video.cdninstagram.com/original.mp4'), wabaId: '301', logger });
  assert.equal(failed.issue, 'video_header_sample_upload_failed'); assert.equal(failed.template.components[0].example.header_handle[0], 'https://video.cdninstagram.com/original.mp4');
});
