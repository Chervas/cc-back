'use strict';
const security=require('../services/securityMonitoring.service');
const pricing=require('../services/aiPricing.service');
const handler=work=>async(req,res)=>{
  res.set('Cache-Control','private, no-store');
  try{res.json(await work(req));}catch(e){const known=/^(security_|ai_price_|technical_admin_)/.test(e.code||'');res.status(known?(e.status||400):500).json({error:known?e.code:'security_monitoring_unavailable'});}
};
exports.overview=handler(req=>security.overview(req.userData?.userId));
exports.rules=handler(req=>security.updateRules(req.body?.rules,req.userData?.userId));
exports.measure=handler(req=>security.setPaused(req.body,req.userData?.userId));
exports.acknowledge=handler(req=>security.acknowledge(req.params.id,req.userData?.userId));
exports.prices=handler(()=>pricing.list());
exports.updatePrice=handler(req=>pricing.update(req.body,req.userData?.userId));

exports.targets=handler(req=>security.searchTargets(req.query.q,req.userData?.userId));
