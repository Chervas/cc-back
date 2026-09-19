'use strict';

const { schema } = require('./contracts');
const { fail } = require('./errors');
const empty = schema({});

// Providers are selected by broker policy; consumers cannot supply hosts, URLs, GAQL or headers.
// Each new real operation needs a reviewed input/output projection and cohort approval.
const OPERATIONS = Object.freeze({
  'fictitious.connection.check.v1': Object.freeze({
    provider: 'fictitious', effect: 'read', validate: empty,
    async execute({ secret, signal }) {
      if (!secret.length || signal.aborted) fail('provider_failed');
      return { fixture: true, status: 'available' };
    },
    project(value) {
      if (value?.fixture !== true || value?.status !== 'available') fail('provider_failed');
      return { fixture: true, status: 'available' };
    },
  }),
});
module.exports = { OPERATIONS };
