'use strict';

const {
  HOURS_72,
} = require('../../services/integrations-broker/src/meta-marketing-social-history');
const { events } = require('../services/socialInboxEvents');
const { resolveRoute, sameRoute } = require('../services/socialInboxRoute.service');

function options(argv) {
  const [runtime, id, channel, accountId, inputEnd, mode, filter, conversation] = argv;
  const end = Date.parse(inputEnd);
  if (
    (argv.length !== 6 && (argv.length !== 8 || filter !== '--conversation' || channel !== 'instagram' ||
      !/^[1-9]\d*$/.test(conversation) || !Number.isSafeInteger(Number(conversation)))) ||
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
    ...(conversation ? { conversationId: Number(conversation) } : {}),
  };
}

async function run(input, { routeFor, provider, accept, participantFor }) {
  const { clinicId, channel, accountId, runtime, start, end, apply, conversationId } = input;
  const account = { channel, accountId };
  const route = await routeFor(account);
  if (!route || route.clinicId !== clinicId) throw Error('social_history_account_unassigned');
  let participantId;
  if (conversationId) {
    participantId = await participantFor(conversationId, { clinicId, channel, accountId });
    if (typeof participantId !== 'string' || !/^[1-9]\d{0,29}$/.test(participantId) || participantId === accountId)
      throw Error('social_history_conversation_unassigned');
  }
  const report = {
    clinicId,
    channel,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    apply,
    ...(conversationId ? { conversationId } : {}),
    kinds: {},
  };
  for (const kind of channel === 'instagram' && !conversationId ? ['dm', 'comment'] : ['dm']) {
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
    let smallPages = false;
    try {
      while (stack.length) {
        if (!sameRoute(route, await routeFor(account))) throw Error('social_history_route_changed');
        const cursor = stack.pop();
        let page;
        try {
          page = await provider.history(route, kind, start, end, cursor, participantId, smallPages);
        } catch (error) {
          if (error.code !== 'provider_timeout' || channel !== 'instagram' || kind !== 'dm' || participantId || smallPages) throw error;
          if (!sameRoute(route, await routeFor(account))) throw Error('social_history_route_changed');
          smallPages = true;
          page = await provider.history(route, kind, start, end, cursor, undefined, true);
        }
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
                (participantId && e.senderId !== participantId) ||
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
      participantFor: async (id, { clinicId, channel, accountId }) => {
        const row = await db.Conversation.findOne({
          where: { id, clinic_id: clinicId, channel, social_account_id: accountId },
          attributes: ['contact_id'],
          raw: true,
        });
        return row?.contact_id;
      },
      accept: require('../services/socialInboxIntake.service').accept,
    });
    return report;
  } finally {
    await db.sequelize.close();
  }
}
if (require.main === module) {
  main(process.argv.slice(2)).then(
    (report) => {
      const code = Object.values(report.kinds).some((r) => !r.complete) ? 2 : 0;
      process.stdout.write(JSON.stringify(report) + '\n', () => process.exit(code));
    },
    (error) => {
      const reason = /^social_history_[a-z_]+$/.test(error.message) ? error.message : 'social_history_unavailable';
      process.stderr.write(reason + '\n', () => process.exit(1));
    },
  );
}
module.exports = { options, run };
