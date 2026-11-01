'use strict';
const crypto=require('node:crypto');
function defaultRate(){const n=Number(process.env.MARKETING_BULK_SEND_MAX_OPT_OUT_RATE||.03);return Number.isFinite(n)&&n>0&&n<=1?n:.03;}
function snapshot(row) {
 const settings=row?.settings||{},n=Number(settings.max_opt_out_rate),rate=Number.isFinite(n)&&n>0&&n<=1?n:defaultRate();
 const revision=settings.quality_policy_revision||crypto.createHash('sha256').update(JSON.stringify([row?.id||null,row?.updated_at||row?.updatedAt||null,rate])).digest('hex');
 return {max_opt_out_rate:rate,revision,configured:!!row,updated_by:row?.updated_by||null,updated_at:row?.updated_at||row?.updatedAt||null};
}
function createService({db}) {
 const {MarketingBulkSendSetting:Settings,WhatsappDeliveryEvent:Events,sequelize}=db;
 return {
  async read(){return snapshot(await Settings.findOne({where:{scope_key:'global'}}));},
  async update({rate,revision,actorId}){
   if(typeof rate!=='number'||!Number.isFinite(rate)||rate<.001||rate>1)throw Object.assign(Error('El límite de bajas debe estar entre 0,1 % y 100 %.'),{status:400});
   if(!Number.isSafeInteger(Number(actorId))||Number(actorId)<=0)throw Object.assign(Error('Administrador requerido.'),{status:403});
   return sequelize.transaction(async transaction=>{
    let row=await Settings.findOne({where:{scope_key:'global'},transaction,lock:transaction.LOCK.UPDATE});
    const before=snapshot(row);if(revision!==before.revision)throw Object.assign(Error('La configuración ha cambiado. Recárgala antes de guardar.'),{status:409});
    if(before.max_opt_out_rate===rate)return before;
    if(!row)row=await Settings.create({scope_key:'global',settings:{},updated_by:Number(actorId)},{transaction});
    await row.update({settings:{...(row.settings||{}),max_opt_out_rate:rate,quality_policy_revision:crypto.randomBytes(32).toString('hex')},updated_by:Number(actorId)},{transaction});
    await Events.create({dedupe_key:crypto.createHash('sha256').update('global:marketing-quality:'+row.settings.quality_policy_revision).digest('hex'),source:'admin_monitoring',
     event_type:'global_quality_policy_updated',severity:'info',occurred_at:new Date(),
     payload:{before:{max_opt_out_rate:before.max_opt_out_rate},after:{max_opt_out_rate:rate},actor_id:Number(actorId)}},{transaction});
    return snapshot(row);
   }).catch(error=>{if(['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT','ER_DUP_ENTRY'].includes(error?.parent?.code)||error.name==='SequelizeUniqueConstraintError')throw Object.assign(Error('La configuración ha cambiado. Recárgala antes de guardar.'),{status:409});throw error;});
  }
 };
}
let instance;module.exports={snapshot,createService,current:()=>instance||(instance=createService({db:require('../../models')}))};
