'use strict';

function installHistoricalConversationClock(contextModule, currentCase) {
  const original = contextModule.buildConversationContext;
  contextModule.buildConversationContext = (input) => {
    const now = new Date(currentCase()?.at);
    if (!Number.isFinite(now.getTime())) throw Error('historical_replay_time_missing');
    return original({...input,now});
  };
  return () => {contextModule.buildConversationContext=original;};
}

module.exports={installHistoricalConversationClock};
