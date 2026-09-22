'use strict';
// Activation and its template-provisioning command share the SQL transaction.
// Only the normal business worker creates templates; the gateway never sends
// messages or starts a template worker to finish an authorization.
async function enqueue({activation,actor,transaction,models}, {environment=process.env,
  enqueueUnique=(...args)=>require('./jobRequests.service').enqueueUniqueJobRequest(...args)}={}) {
  if(activation.state!=='active')return null;
  const runtime=environment.RUNTIME_ROLE==='gateway'
    ? environment.AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE||'staging'
    : environment.JOB_RUNTIME_NAMESPACE||environment.RUNTIME_NAMESPACE;
  if(!['dev','staging','prod','production'].includes(runtime))throw Error('whatsapp_template_runtime_invalid');
  return enqueueUnique({type:'whatsapp_template_create',priority:'normal',origin:'whatsapp_activation',maxAttempts:3,
    requestedBy:actor.userId,dedupeScope:'whatsapp-activation:'+activation.authorization_id,
    payload:{wabaId:activation.waba_id,clinicId:activation.scope_type==='clinic'?activation.scope_id:null,
      groupId:activation.scope_type==='group'?activation.scope_id:null,assignmentScope:activation.scope_type,
      __runtime_namespace:runtime}},
    {transaction,JobRequestModel:models.JobRequest,sequelizeInstance:models.sequelize,
      // A later status/completion read must not recreate completed or manually
      // cancelled work. Failed commands retain their normal operator recovery.
      activeStatuses:['pending','queued','running','waiting','completed','failed','cancelled']});
}
module.exports={enqueue};
