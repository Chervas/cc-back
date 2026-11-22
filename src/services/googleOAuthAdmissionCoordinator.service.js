'use strict';

const C = require('./googleOAuthAdmissionAttempt.contract');
const { createGoogleOAuthAdmissionAttempts } = require('./googleOAuthAdmissionAttempt.repository');
const { closed } = require('./googleOAuthAdmissionAuthority.service');
const O = require('./googleOAuthAdmissionOwner.adapter');
const fail = () => { throw C.problem('google_oauth_admission_attempt_conflict', 409); };

// Executable CRM coordination, with no singleton, HTTP route, credential
// configuration, background retries, provider call or mapping write.
function createGoogleOAuthAdmissionCoordinator({ model, publicationModel, sequelize, authority, owner, now = () => new Date() } = {}) {
  if (typeof authority?.capture !== 'function' || typeof publicationModel?.findByPk !== 'function'
    || ['begin', 'status', 'finish', 'abort'].some(name => typeof owner?.[name] !== 'function')) {
    throw C.problem('google_oauth_admission_attempt_unavailable', 503);
  }
  function publicDto(local, remote) {
    // Deliberately no binding digest, session reference, candidate identity,
    // provider metadata or credential location in a product response.
    return Object.freeze({ attemptId: local.attemptId, scopeKey: local.scopeKey, service: local.service,
      state: local.state, revision: local.revision, expiresAt: local.expiresAt, authorizationState: remote.state,
      authorizationConfirmed: false, connected: false });
  }
  async function run(req, command, action, input) {
    let code;
    try {
      if (!C.exact(command, ['attemptId', 'scopeKey', 'service'])) throw C.problem();
      const selection = Object.freeze({ ...command });
      let transient;
      if (action === 'finish') {
        if (!C.exact(input, ['state', 'codeBuffer']) || typeof input.state !== 'string'
          || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || !Buffer.isBuffer(input.codeBuffer)
          || !input.codeBuffer.length || input.codeBuffer.length > 4096
          || input.codeBuffer.some(byte => byte < 33 || byte > 126)) throw C.problem();
        code = Buffer.from(input.codeBuffer); transient = Object.freeze({ state: input.state, codeBuffer: code });
      } else if (action === 'abort') {
        if (!C.exact(input, ['expectedRevision']) || !Number.isSafeInteger(input.expectedRevision)
          || input.expectedRevision < 0 || input.expectedRevision > 1) throw C.problem();
        transient = Object.freeze({ expectedRevision: input.expectedRevision });
      } else if (input !== undefined) throw C.problem();
      const captured = await authority.capture(req, selection);
      const context = C.input(captured.context);
      const attempts = createGoogleOAuthAdmissionAttempts({ model, publicationModel, sequelize, authorize: captured.authorize, now });
      let local = await (action === 'begin' ? attempts.prepare(context) : attempts.read(context));
      const bound = O.proof({ attemptId: context.attemptId, bindingDigest: C.bindingDigest(context),
        service: context.service, expiresAt: Date.parse(local.expiresAt) });
      const refs = O.envelope(context);
      if (action === 'abort') {
        // Local cancellation is durable before the possibly unknown Owner ACK.
        // Owner abort must create a tombstone even if begin was never seen.
        local = await attempts.cancel(context, transient);
      } else if (action !== 'status' && local.state !== 'prepared') fail();
      let remote;
      if (action === 'finish') {
        remote = O.response(await owner.status(bound, refs), bound);
        // A repeated return observes the Owner lifecycle; it never replays a
        // code after exchanging/staging/interruption. Concurrent returns are
        // additionally fenced by Owner's durable burn, not a CRM memory flag.
        if (remote.state === 'prepared') {
          const fresh = await attempts.read(context); // Fresh own session/full scope before dispatch.
          if (fresh.state !== 'prepared' || fresh.revision !== local.revision) fail();
          local = fresh;
          remote = O.response(await owner.finish(bound, refs, transient), bound);
        }
      } else {
        const received = await owner[action](bound, refs);
        // URL validation belongs to the typed Owner adapter. The coordinator
        // only passes this begin-only field from that injected boundary.
        const withoutUrl = { ...received }; delete withoutUrl.authorizationUrl;
        remote = O.response(withoutUrl, bound);
        if (action === 'begin' && Object.hasOwn(received, 'authorizationUrl')) {
          if (received.state !== 'prepared' || typeof received.authorizationUrl !== 'string' || received.authorizationUrl.length > 8192) {
            throw C.problem('google_oauth_admission_attempt_unavailable', 503);
          }
          remote = { ...remote, authorizationUrl: received.authorizationUrl };
        } else if (Object.hasOwn(received, 'authorizationUrl')) throw C.problem('google_oauth_admission_attempt_unavailable', 503);
      }
      // An authorization change during the Owner call cannot release either
      // its URL or metadata. No network call is held inside a SQL transaction.
      local = await attempts.read(context);
      if (action === 'begin' && local.state !== 'prepared' || action === 'finish' && local.state !== 'prepared') fail();
      const result = publicDto(local, remote);
      return remote.authorizationUrl === undefined ? result : Object.freeze({ ...result, authorizationUrl: remote.authorizationUrl });
    } catch (error) { throw closed(error); }
    finally { if (code) code.fill(0); }
  }
  return Object.freeze({ start: (req, command) => run(req, command, 'begin'),
    status: (req, command) => run(req, command, 'status'),
    return: (req, command, input) => run(req, command, 'finish', input),
    cancel: (req, command, input) => run(req, command, 'abort', input) });
}

module.exports = { createGoogleOAuthAdmissionCoordinator };
