'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildExternalPatientHistory,paginateExternalHistory,buildImportedClinicalCatalog}=require('../../lib/external-patient-history');

function field(clinicId=70,patch={}){
  const envelope={version:'arriaga_patient_source_record/1',provider:'arriaga_excel',source_instance:`arriaga-excel-20261026:clinic-${clinicId}`,
    source_patient_id:'master-row-2',source_history_number:'TESTONLY',clinic_id:clinicId,source_database:'TESTONLY activity.xlsx',source_table:'TESTONLY sheet',
    source_row:9,source_key:'a'.repeat(64),row_sha256:'b'.repeat(64),bundle_sha256:'c'.repeat(64),record_date:'2025-03-04',category:'historical',
    record:{service_label:'TESTONLY Quiropodía',service_family:'TESTONLY Podología',source_classification:'TESTONLY Clinical',site_assignment:'default_arenal',
      private_notes:'TESTONLY MUST NOT BE PROJECTED',payment:'TESTONLY MUST NOT BE PROJECTED',completed_at:'2025-03-04T12:00:00Z'},...patch};
  return{clinica_id:clinicId,source:'arriaga_excel',archive_source_instance:`arriaga-excel-20261026:clinic-${clinicId}`,
    archive_source_patient_id:'master-row-2',archive_source_key:'a'.repeat(64),last_imported_at:'2026-10-26',value:JSON.stringify(envelope)};
}

test('Arriaga projection retains dated service evidence and source row without creating a clinical or financial assertion',()=>{
  const view=buildExternalPatientHistory([field()],{clinics:[{id_clinica:70,nombre_clinica:'TESTONLY Arenal'}]});
  assert.deepEqual(view.providers,['arriaga_excel']);assert.equal(view.entries.length,1);
  const entry=view.entries[0];assert.equal(entry.provider,'arriaga_excel');assert.equal(entry.source,'Excel Arriaga');assert.equal(entry.category,'historical');
  assert.equal(entry.title,'TESTONLY Quiropodía');assert.equal(entry.clinic_id,70);assert.equal(entry.clinic_name,'TESTONLY Arenal');
  assert.equal(entry.record_date,'2025-03-04');assert.equal(entry.imported_date,'2026-10-26');assert.equal(entry.source_date,null);assert.equal(entry.author,null);
  assert.equal(entry.source_document.record_id,'9');assert.equal(entry.source_document.database,'TESTONLY activity.xlsx');
  assert.equal(entry.source_document.row_sha256,'b'.repeat(64));assert.equal(entry.source_document.batch_sha256,'c'.repeat(64));
  assert(entry.sections[0].items.some(item=>item.label==='Sede del registro'&&item.value.includes('archivo no indica sede')));
  assert.doesNotMatch(JSON.stringify(entry),/MUST NOT BE PROJECTED|completed_at|financial|anatomy|Eurodent|ClinicCloud/);
  const clinical=paginateExternalHistory(view,{scope:'clinical',search:'podologia'});assert.equal(clinical.total,1);
  assert.equal(paginateExternalHistory(view,{scope:'economy'}).total,0);assert.equal(paginateExternalHistory(view,{scope:'profile'}).total,0);
});

test('Arriaga rejects cross-clinic, cross-identity, wrong-provider and malformed source envelopes',()=>{
  const invalid=[
    field(70,{clinic_id:1}),field(70,{source_instance:'arriaga-excel-20261026:clinic-1'}),
    field(70,{source_instance:'TESTONLY unaffiliated archive'}),field(70,{source_patient_id:'master-row-3'}),
    field(70,{source_key:'d'.repeat(64)}),field(70,{provider:'eurodent'}),
    field(70,{version:'eurodent_source_record/1'}),field(70,{category:'economic'}),
    field(70,{record_date:'2025-02-30'}),field(70,{record_date:'2026-10-26T00:00:00Z'}),
    field(70,{source_row:1}),field(70,{source_row:'9'}),field(70,{record:[]}),
    field(70,{record:{private_notes:'TESTONLY notes are not a clinical service'}}),
    {...field(),source:'eurodent'}, {...field(),clinica_id:0}, {...field(),value:'not JSON'},
  ];
  for(const row of invalid)assert.equal(buildExternalPatientHistory([row]).entries.length,0);
});

test('Arriaga dates, pagination and search remain source-based and clinic-bound',()=>{
  const a=field(1,{record_date:'2025-01-01',source_key:'1'.repeat(64),record:{service_label:'TESTONLY Estudio biomecánico',site_assignment:'explicit_aju'}});
  a.archive_source_key='1'.repeat(64);
  const b=field(70,{record_date:'2026-01-01',source_key:'2'.repeat(64),record:{service_label:'TESTONLY Cura simple',site_assignment:'explicit_arenal'}});
  b.archive_source_key='2'.repeat(64);
  const view=buildExternalPatientHistory([a,b]);assert.deepEqual(view.entries.map(e=>e.clinic_id),[70,1]);
  const first=paginateExternalHistory(view,{scope:'clinical',limit:'1'});assert.equal(first.total,2);assert(first.next_cursor);
  const next=paginateExternalHistory(view,{scope:'clinical',limit:'1',cursor:first.next_cursor});assert.equal(next.entries[0].clinic_id,1);
  assert.equal(paginateExternalHistory(view,{scope:'clinical',search:'biomecanico'}).entries[0].clinic_id,1);
  assert.equal(paginateExternalHistory(view,{scope:'clinical',from:'2026-01-01'}).total,1);
});

test('Arriaga import context cannot masquerade as a Eurodent dental catalogue',()=>{
  const arriaga={source_system:'arriaga_excel',source_instance:'arriaga-excel-20261026:clinic-70',context_json:JSON.stringify({version:'arriaga_import_context/1',
    Tratamiento:[{record:{ID:'TESTONLY unrelated',Nombre:'TESTONLY must not appear as Eurodent'}}]})};
  assert.deepEqual(buildImportedClinicalCatalog([arriaga]).items,[]);
  const eurodent={source_system:'eurodent',source_instance:'TESTONLY eurodent',context_json:JSON.stringify({Tratamiento:[{record:{ID:'1',Nombre:'TESTONLY original dental catalogue'}}]})};
  const view=buildImportedClinicalCatalog([arriaga,eurodent]);assert.equal(view.source_instance,'TESTONLY eurodent');assert.equal(view.items[0].name,'TESTONLY original dental catalogue');
});
