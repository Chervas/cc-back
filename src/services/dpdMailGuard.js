'use strict';
const {EmailMessage,DpdContract}=require('../../models');
async function allowed(delivery){
 const msg=await EmailMessage.findOne({where:{public_id:delivery.outboxId},attributes:['id','related_id','related_type','status','template_key','stream'],raw:true,logging:false});
 if(!msg||msg.status!=='sending'||msg.related_type!=='dpd_contract'||msg.stream!=='transactional'||msg.template_key!==delivery.templateKey)return false;
 const row=await DpdContract.findByPk(msg.related_id,{attributes:['status','dossier','expires','email'],raw:true,logging:false});
 if(!row||row.email!==delivery.to)return false;
 if(msg.template_key==='dpd.signature_code')return row.status==='revisado'&&+new Date(row.expires)>Date.now()&&row.dossier.code?.until>Date.now()&&Number(row.dossier.code?.message)===Number(msg.id);
 return msg.template_key==='dpd.signed_copy'&&row.status==='firmado'&&Date.parse(row.dossier.receipt?.until)>Date.now()&&Number(row.dossier.receipt?.message)===Number(msg.id);
}
module.exports={allowed};
