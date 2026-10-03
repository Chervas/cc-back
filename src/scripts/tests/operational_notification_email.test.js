'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {renderTemplate}=require('../../services/emailTemplates.service');
const context={event_key:'whatsapp.reception_attention',incident_phase:'open',severity:'critical',
 title:'BS Medical: 10 eventos retenidos',operational_summary:'4 mensajes entrantes; 6 ecos del movil.',
 message:'Aviso tecnico completo. '.repeat(35)+'Las automatizaciones esperan sin cancelar citas.',
 action:'Revisar el monitor.',occurred_at:'2/10/2026, 09:52'};
test('subject and inbox preview say what happened; full detail is retained',()=>{
 const rendered=renderTemplate('ops.system_alert',context);
 assert.equal(rendered.subject,'[Clinicaclick] Revisar: BS Medical: 10 eventos retenidos');
 assert(rendered.text.startsWith(context.operational_summary));
 assert(rendered.text.includes(context.message));assert(rendered.html.includes('sin cancelar citas'));
 assert(rendered.text.includes(context.occurred_at));
});
test('resolution is distinguished and hostile HTML cannot become markup',()=>{
 const rendered=renderTemplate('ops.system_alert',{...context,incident_phase:'closed',severity:'info',message:'<script>bad()</script>'});
 assert.match(rendered.subject,/Resuelto/);assert.doesNotMatch(rendered.html,/<script>/);
});
test('clinical identifiers are rejected in subjects; other notification behavior stays unchanged',()=>{
 assert.equal(renderTemplate('ops.system_alert',{...context,title:'Numero +34 673 302 077'}).subject,'[Clinicaclick] Revisar: estado de WhatsApp');
 assert.equal(renderTemplate('ops.system_alert',{...context,event_key:'other'}).subject,'[Clinicaclick] Alerta operativa');
});
