'use strict';
const D=require('./dental-plan-contract');
// A configured discipline is independent of an area's published workspace flags.
const DENTAL_AREA_ALIASES=new Set(['dental','dental_clinica','odontologia','odontologia_general','odontologico']);
function normalizedArea(value){return String(value??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'_');}
function configuredDentalArea(clinic){
 let config=clinic?.configuracion;
 if(typeof config==='string'){try{config=JSON.parse(config);}catch{return false;}}
 return Array.isArray(config?.disciplinas)&&config.disciplinas.some(area=>DENTAL_AREA_ALIASES.has(normalizedArea(area&&typeof area==='object'?area.code??area.codigo:area)));
}
function assertDentalAreaConfigured(clinic){if(!configuredDentalArea(clinic))D.fail('area_not_configured','Esta clínica no tiene configurada el área Dental. Puedes consultar su historia existente.',403);}
module.exports={configuredDentalArea,assertDentalAreaConfigured,normalizedArea};
