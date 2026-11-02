'use strict';

// Approval is durable before attempting the ordinary resume. Provider gates and
// the native transactional enqueue remain authoritative; this is not a bypass.
function createService({ governance, queues }) {
  return {
    async resolve(options) {
      const receipt = await governance.resolvePausedQueue(options);
      if (receipt.decision !== 'authorized') return receipt;
      try {
        const result = await queues.mutateSendQueue({ userId: options.adminUserId,
          queueId: `marketing:${receipt.queue_id}`, action: 'resume' });
        const dispatch = result.dispatch || result.campaign?.criteria?.dispatch || {};
        return { ...receipt, resumption: { status: 'resumed', already_running: !!result.already_running,
          dispatch_status: dispatch.status || null, next_at: dispatch.next_allowed_at || null } };
      } catch (error) {
        // A failed check leaves approval intact. An uncertain server response
        // must be reconciled from the queue, never retried automatically.
        const known = [400, 403, 404, 409, 422, 429].includes(error?.status);
        return { ...receipt, resumption: { status: known ? 'blocked' : 'unconfirmed',
          message: known ? error.message : 'No se ha podido confirmar la reanudación. Actualiza el estado de la cola antes de volver a intentarlo.' } };
      }
    },
  };
}
module.exports = { createService, resolve: options => createService({
  governance: require('./whatsappDeliveryGovernance.service'), queues: require('./sendQueues.service'),
}).resolve(options) };
