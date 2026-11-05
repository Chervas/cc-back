'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../../lib/manual-appointment-notice');
test('manual notice keeps one copy contract in three languages with exact Utility approval',()=>{
  for(const locale of ['es','ca','en']) {
    const template={status:'APPROVED',category:'UTILITY',is_active:true,language:locale,components:[{type:'BODY',text:C.COPY[locale]}]};
    assert(C.templateValid(template,locale));
    for(const patch of [{category:'MARKETING'},{status:'PENDING'},{retired_at:new Date()},{superseded_by_template_id:9},
      {language:locale==='en'?'es':'en'},{components:[{type:'BODY',text:C.COPY[locale]+' edited'}]},
      {components:[...template.components,{type:'BUTTONS',buttons:[]}]}])assert(!C.templateValid({...template,...patch},locale));
    assert.deepEqual([...C.COPY[locale].matchAll(/\{\{(\d+)\}\}/g)].map(m=>m[1]),['1','2','3','4','5']);
  }
});
test('appointment data uses local calendar date and 24h time across winter and summer',()=>{
  const patient={nombre:'Alex'},clinic={nombre_clinica:'Clínica de ejemplo',direccion:'Calle de ejemplo 1',configuracion:{timezone:'Europe/Madrid'}};
  const winter=C.parameters({inicio:'2026-11-12 17:30:00'},patient,clinic);
  assert.deepEqual([winter[2],winter[3]],['12-11-2026','18:30']);
  const summer=C.parameters({inicio:'2026-07-12 17:30:00'},patient,clinic);
  assert.equal(summer[3],'19:30');
  assert(!C.render('es',winter).includes('{{'));
  assert.throws(()=>C.parameters({inicio:'2026-11-12T17:30Z'},patient,{...clinic,direccion:''}),{code:'manual_appointment_details_missing'});
});
test('manual resend cannot revive past, terminal, provisional or held appointments',()=>{
  const now=new Date('2026-11-05T12:00Z'),a={inicio:'2026-11-12T17:30Z',estado:'recordatorio_confirmado'};
  assert.doesNotThrow(()=>C.validateAppointment(a,now));
  assert.doesNotThrow(()=>C.validateAppointment({...a,source_system:'cliniccloud',source_reference:'released_qa'},now));
  for(const patch of [{inicio:'2026-11-04T17:30Z'},{estado:'cancelada'},{estado:'ha_acudido'},{estado:'completada'},
    {es_provisional:true},{import_metadata:{automation_policy:'hold'}},{import_metadata:{notification_suppression:{appointment_details:true}}}])assert.throws(()=>C.validateAppointment({...a,...patch},now));
  assert.equal(C.revision({a:1}),C.revision({a:1}));assert.notEqual(C.revision({a:1}),C.revision({a:2}));
});
