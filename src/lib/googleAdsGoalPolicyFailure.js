'use strict';
const uuid=x=>typeof x==='string'&&x.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const sha=x=>typeof x==='string'&&x.length===64&&/^[a-f0-9]{64}$/.test(x);
function goalPolicyFailureSummary(error){
 if(error?.goalPolicyFailure!==true||error.retryable!==false||error.manualRecoveryRequired!==true
  ||typeof error.code!=='string'||error.code.length>100||!/^GOAL_POLICY_[A-Z0-9_]+$/.test(error.code))return null;
 let outcome=null;const p=error.goalPolicyOutcome;
 if(p&&['goal','campaign_config','campaign_goals'].includes(p.phase)&&p.dispatched===true&&['ACK','UNKNOWN'].includes(p.outcome)
  &&uuid(p.requestId)&&(p.receiptSha256===null||sha(p.receiptSha256))
  &&(p.ownGoalResourceName===null||typeof p.ownGoalResourceName==='string'&&p.ownGoalResourceName.match(/^customers\/[0-9]{10}\/customConversionGoals\/[1-9][0-9]{0,19}$/)?.[0]===p.ownGoalResourceName)
  &&[p.knownMutationCount,p.attemptedMutationCount].every(x=>x===null||Number.isSafeInteger(x)&&x>=0&&x<=2000)){
  outcome={phase:p.phase,dispatched:true,outcome:p.outcome,requestId:p.requestId,
   knownMutationCount:p.knownMutationCount,attemptedMutationCount:p.attemptedMutationCount,
   receiptSha256:p.receiptSha256,ownGoalResourceName:p.ownGoalResourceName};
 }
 return{code:error.code,journalId:uuid(error.goalPolicyJournalId)?error.goalPolicyJournalId:null,manualRecoveryRequired:true,outcome};
}
module.exports={goalPolicyFailureSummary};
