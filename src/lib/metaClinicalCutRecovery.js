'use strict';
// Recovery must observe the process manager again. A failure between stopping
// WhatsApp and stopping the APIs must never restart an untouched public API.
async function recoverStoppedParticipants({ participants, inspect, start, verify }) {
  const ids = new Set();
  for (const participant of participants) {
    if (!participant.id || ids.has(participant.id) || !Number.isInteger(participant.originalPid)
      || participant.originalPid <= 0 || typeof participant.stopRequested !== 'boolean') throw Error('meta_cut_recovery_plan_invalid');
    ids.add(participant.id);
  }
  const actions = [];
  for (const participant of participants) {
    const current = await inspect(participant.id);
    if (current.state === 'running' && current.pid === participant.originalPid) {
      await verify(participant.id, current);
      actions.push({ id: participant.id, action: 'preserved', pid: current.pid });
      continue;
    }
    if (current.state !== 'stopped' || current.pid !== 0 || !participant.stopRequested) {
      throw Error('meta_cut_recovery_unexpected_process_state');
    }
    await start(participant.id);
    const resumed = await inspect(participant.id);
    if (resumed.state !== 'running' || !Number.isInteger(resumed.pid) || resumed.pid <= 0) throw Error('meta_cut_recovery_start_failed');
    await verify(participant.id, resumed);
    actions.push({ id: participant.id, action: 'started', pid: resumed.pid });
  }
  return actions;
}
module.exports = { recoverStoppedParticipants };
