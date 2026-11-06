'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const S=require('sequelize'),source=fs.readFileSync(require.resolve('../../controllers/citas.controller'),'utf8');
const start=source.indexOf('async function findOrCreatePaciente('),end=source.indexOf('\nconst parseBool',start);assert(start>0&&end>start);
for(const mode of ['explicit_existing','matched_existing','new'])test('native booking marks only a newly registered patient for initial chat binding: '+mode,async()=>{
 const p={id_paciente:1,clinica_id:35,telefono_movil:'34600000001',clinicasVinculadas:[{clinica_id:35}]};
 let creations=0;const sandbox={Op:S.Op,db:{PacienteClinica:{}},findPacienteByIdentifier:async()=>p,
  ensurePacienteClinica:async()=>{},normalizePhoneDigits:v=>v?.replace(/\D/g,''),normalizePhone:v=>v?.replace(/\D/g,''),
  normalizeHumanName:v=>v,generateUniquePacientePublicId:async()=> 'TESTONLY',
  Paciente:{findAll:async()=>mode==='matched_existing'?[p]:[],create:async()=>{creations++;return p}}};
 vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);
 const result=await sandbox.findOrCreatePaciente({clinica_id:35,nombre:'Fictitious',telefono:'34600000001',...(mode==='explicit_existing'?{id_paciente:1}:{})});
 assert.equal(result.patient,p);assert.equal(result.created,mode==='new');assert.equal(creations,mode==='new'?1:0);
});
