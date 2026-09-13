'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { createGoogleHttp } = require('../src/google-http');
test('discovery transport sends fixed TLS GET requests and rejects account enumeration, extra fields and redirects', async () => {
  const calls = []; let statusCode = 200;
  const http = createGoogleHttp({ request: (options, receive) => {
    calls.push(options); const request = new EventEmitter(); request.destroy = () => {};
    request.end = body => { assert.equal(body, undefined); const response = new PassThrough(); response.statusCode = statusCode;
      response.headers = { 'content-type': 'application/json' }; receive(response); response.end('{}'); };
    return request;
  } });
  const token = Buffer.from('FICTITIOUS_ACCESS');
  const allowed = [{ hostname: 'www.googleapis.com', path: '/webmasters/v3/sites/sc-domain%3Aexample.invalid' },
    { hostname: 'analyticsadmin.googleapis.com', path: '/v1beta/properties/123' }];
  for (const target of allowed) await http({ ...target, token });
  assert(calls.every(c => c.method === 'GET' && c.rejectUnauthorized === true && c.minVersion === 'TLSv1.2'));
  for (const target of [{ hostname: 'www.googleapis.com', path: '/webmasters/v3/sites' },
    { hostname: 'analyticsadmin.googleapis.com', path: '/v1beta/accountSummaries' },
    { hostname: 'analyticsadmin.googleapis.com', path: '/v1beta/properties/123?fields=*' },
    { hostname: 'analyticsadmin.googleapis.com', path: '/v1beta/properties/123/dataStreams' },
    { ...allowed[1], json: {} }, { ...allowed[0], form: 'x=y' }]) await assert.rejects(http({ ...target, token }), { code: 'invalid_request' });
  assert.equal(calls.length, 2); statusCode = 302; await assert.rejects(http({ ...allowed[1], token }), { code: 'provider_failed' });
});
