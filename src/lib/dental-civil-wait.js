'use strict';
const {addDays}=require('./personal-schedule-recurring'),D=require('./clinical-episode-contract');
function advanceCivil(date,value,unit='days'){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(value)||value<0||value>3650||!['days','weeks','months'].includes(unit))throw D.error(409,'dental_wait_review_required','Revisa la unidad y el plazo clínico de esta dependencia.');
 if(unit!=='months')return addDays(date,value*(unit==='weeks'?7:1));
 const [year,month,day]=date.split('-').map(Number),index=year*12+month-1+value,y=Math.floor(index/12),m=index%12;
 const result=new Date(Date.UTC(y,m,Math.min(day,new Date(Date.UTC(y,m+1,0)).getUTCDate())));return result.toISOString().slice(0,10);
}
function dateForDependency(date,dependency){return advanceCivil(date,dependency.wait_min_value??dependency.min_wait_days,dependency.wait_min_unit??'days');}
module.exports={advanceCivil,dateForDependency};
