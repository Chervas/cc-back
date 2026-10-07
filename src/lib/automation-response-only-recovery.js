'use strict';

// This internal marker may only remove a timeout branch. It never grants a
// send, revives a stopped execution or changes how an actual reply is analysed.
function isResponseOnlyRecoveryWait(execution, node) {
  const wait = execution?.waiting_meta;
  const review = execution?.context?.recovery_review;
  return node?.type === 'delay/wait_response'
    && wait?.recovery_response_only === true
    && review?.kind === 'operator_reviewed_response_wait_recovery'
    && review.first_notice_replayed === false
    && Number(review.source_execution_id) === Number(execution.id)
    && Number(review.clinic_id) === Number(execution.clinic_id)
    && review.wait_node_id === node.id
    && Number(review.source_outbound_id) > 0;
}

module.exports = { isResponseOnlyRecoveryWait };
