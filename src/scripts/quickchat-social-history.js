'use strict';

const {
  HOURS_72,
} = require('../../services/integrations-broker/src/meta-marketing-social-history');
const { events } = require('../services/socialInboxEvents');
const { resolveRoute, sameRoute } = require('../services/socialInboxRoute.service');

function options(argv) {
  const [runtime, id, channel, accountId, inputEnd, mode] = argv;
  const end = Date.parse(inputEnd);
  if (
    argv.length !== 6 ||
    !['dev', 'staging', 'prod'].includes(runtime) ||
    !/^[1-9]\d*$/.test(id) ||
    !Number.isSafeInteger(Number(id)) ||
    !['instagram', 'messenger'].includes(channel) ||
    !/^[1-9]\d{0,29}$/.test(accountId) ||
    !Number.isFinite(end) ||
    new Date(end).toISOString() !== inputEnd ||
    end > Date.now() ||
    !['--scan', '--apply'].includes(mode)
  )
    throw Error('social_history_arguments');
  return {
    runtime,
    clinicId: Number(id),
    channel,
    accountId,
    start: end - HOURS_72,
    end,
    apply: mode === '--apply',
  };
}

async function run(input, { routeFor, provider, accept }) {
  const { clinicId, channel, accountId, runtime, start, end, apply } = input;
  const account = { channel, accountId };
  const route = await routeFor(account);
  if (!route || route.clinicId !== clinicId) throw Error('social_history_account_unassigned');
  const report = {
    clinicId,
    channel,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    apply,
    kinds: {},
  };
  for (const kind of channel === 'instagram' ? ['dm', 'comment'] : ['dm']) {
    const result = (report.kinds[kind] = {
      complete: false,
      pages: 0,
      found: 0,
      queued: 0,
      duplicates: 0,
      omitted: 0,
      limitedThreads: 0,
    });
    const stack = [null];
    try {
      while (stack.length) {
        if (!sameRoute(route, await routeFor(account))) throw Error('social_history_route_changed');
        const cursor = stack.pop();
        const page = await provider.history(route, kind, start, end, cursor);
        if (!page.available) {
          result.reason = page.reason;
          break;
        }
        if (
          !Array.isArray(page.children) ||
          !Array.isArray(page.entries) ||
          !Number.isSafeInteger(page.omitted) ||
          page.omitted < 0 ||
          !Number.isSafeInteger(page.limitedThreads) ||
          page.limitedThreads < 0
        )
          throw Error('social_history_response_invalid');
        result.pages++;
        result.omitted += page.omitted;
        result.limitedThreads += page.limitedThreads;
        if (page.entries.length) {
          const body = {
            object: channel === 'instagram' ? 'instagram' : 'page',
            entry: page.entries,
          };
          if (page.entries.some((e) => e?.id !== accountId))
            throw Error('social_history_response_invalid');
          const normalized = events(body, { history: true });
          if (
            normalized.some(
              (e) =>
                e.channel !== channel ||
                e.accountId !== accountId ||
                e.type !== kind ||
                Date.parse(e.at) < start ||
                Date.parse(e.at) >= end,
            )
          )
            throw Error('social_history_response_invalid');
          result.found += normalized.length;
          if (apply) {
            const counts = await accept(body, {
              history: true,
              appId: route.appId,
              namespace: runtime,
              expectedRoute: route,
            });
            result.queued += counts.queued;
            result.duplicates += counts.duplicate;
          }
        }
        for (const child of [page.next, ...page.children].filter(Boolean)) {
          if (typeof child !== 'string' || !/^[A-Za-z0-9_-]{40,4096}$/.test(child))
            throw Error('social_history_response_invalid');
          stack.push(child);
        }
      }
      result.complete = !result.reason && !result.omitted && !result.limitedThreads;
    } catch (err) {
      const code = err.code || err.message;
      result.reason =
        /^(social_history_[a-z_]+|scope_denied|provider_[a-z_]+|rate_limited|invalid_request|connection_blocked|credential_revoked|operation_denied)$/.test(
          code,
        )
          ? code
          : 'social_history_interrupted';
      if (result.reason === 'social_history_route_changed') break;
    }
  }
  return report;
}

async function main(argv) {
  const input = options(argv);
  require('dotenv').config();
  require('./meta-lead-historical-recovery').assertRuntime(input.runtime);
  const db = require('../../models');
  try {
    const report = await run(input, {
      routeFor: (account) => db.sequelize.transaction((t) => resolveRoute(db, account, t)),
      provider: require('../services/socialInboxProvider.service').provider(),
      accept: require('../services/socialInboxIntake.service').accept,
    });
    console.log(JSON.stringify(report));
    if (Object.values(report.kinds).some((r) => !r.complete)) process.exitCode = 2;
  } finally {
    await db.sequelize.close();
  }
}
if (require.main === module)
  main(process.argv.slice(2)).catch((e) => {
    console.error(
      /^social_history_[a-z_]+$/.test(e.message) ? e.message : 'social_history_unavailable',
    );
    process.exitCode = 1;
  });
module.exports = { options, run };
