'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMetaMarketingAdsReader } = require('../../services/metaMarketingAdsReader.service');
const A = require('../../../services/integrations-broker/src/meta-marketing-ads-contract');

function fixture({ maximum, stopAt, creativeVersion }) {
  let calls = 0;
  const state = { kind: 'ad_account', connectionRef: 'meta:fixture', assetRef: 'meta-ad_account:301', tenantRef: 'clinic:11' };
  const reader = createMetaMarketingAdsReader({ enabled: () => true,
    scope: { prepare: async () => ({}), assertContext: async () => state },
    client: { execute: async command => {
      calls++; assert.equal(command.operation, A.OPERATIONS.ads); assert.equal(command.payload.creativeVersion, creativeVersion);
      const size = [1, 2].includes(creativeVersion) ? 10 : 50;
      const results = Array.from({ length: size }, (_, index) => ({ id: String((calls - 1) * size + index + 1),
        name: 'Synthetic', campaign_id: '401', adset_id: '402' }));
      return { requestId: command.requestId, data: { results,
        nextPageToken: calls === stopAt ? null : 'x'.repeat(40) + calls,
        usage: { usagePct: 0, nextAllowedAt: 0, pauseUntil: 0 } } };
    } },
  });
  return { reader, calls: () => calls, maximum };
}

test('creative inventory preserves the existing10,000-ad maximum with1,000 bounded pages; legacy remains200 pages', async () => {
  for (const [creativeVersion, maximum] of [[1, 1000], [2, 1000], [undefined, 200]]) {
    const f = fixture({ creativeVersion, maximum, stopAt: maximum });
    const source = await f.reader.sourceForAsset(1); let rows = 0;
    for await (const page of source.pages('ads', creativeVersion ? { creativeVersion } : {})) rows += page.length;
    assert.equal(rows, 10000); assert.equal(f.calls(), maximum);
  }
});

test('an endless creative or legacy cursor fails at its existing total coverage cap without one extra read', async () => {
  for (const [creativeVersion, maximum] of [[1, 1000], [2, 1000], [undefined, 200]]) {
    const f = fixture({ creativeVersion, maximum }); const source = await f.reader.sourceForAsset(1);
    await assert.rejects(async () => { for await (const _page of source.pages('ads', creativeVersion ? { creativeVersion } : {})) {} }, { code: 'broker_response_invalid' });
    assert.equal(f.calls(), maximum);
  }
});
