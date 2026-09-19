'use strict';
// Exact lead table template and production LeadsComponent methods/service/list
// controller. Fixture shell selects clinics; other page modules and public MFA
// are deliberately outside this isolated visual acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
module.exports=async({sql,models,report,registerOwnedLoopbackServer})=>{
  for(const name of ['Usuario','Campana','ExternalCampaignInventory','Paciente','PacienteClinica','CitaPaciente','Tratamiento','Conversation','LeadContactAttempt']){
    const m=models[name];for(const attr of Object.values(m.rawAttributes))delete attr.references;m.refreshAttributes();await m.sync();
  }
  const belongs=(from,to,as,foreignKey)=>models[from].belongsTo(models[to],{as,foreignKey});
  belongs('LeadIntake','Clinica','clinica','clinica_id');belongs('LeadIntake','GrupoClinica','grupoClinica','grupo_clinica_id');belongs('LeadIntake','Campana','campana','campana_id');
  belongs('Paciente','Clinica','clinica','clinica_id');models.Paciente.hasMany(models.PacienteClinica,{as:'clinicasVinculadas',foreignKey:'paciente_id'});
  belongs('PacienteClinica','Clinica','clinica','clinica_id');belongs('CitaPaciente','Clinica','clinica','clinica_id');belongs('CitaPaciente','Paciente','paciente','paciente_id');belongs('CitaPaciente','Tratamiento','tratamiento','tratamiento_id');
  for(const name of ['20260912220000-create-auth-sessions','20260913130000-create-auth-email-challenges','20260914220000-create-auth-trusted-devices'])await require('../../../../migrations/'+name).up(sql.getQueryInterface(),require('sequelize'));
  const actor=require('../../../lib/role-helpers').ADMIN_USER_IDS[0];assert(actor);
  const user=await models.Usuario.create({id_usuario:actor,nombre:'Visual fixture admin',email_usuario:'visual-fixture@example.invalid',password_usuario:'FICTITIOUS_HASH'});
  const audit=require('../../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const access=require('../../../services/accessSession.service'),sessions={...access,...access.createService({models,audit,config:()=>({mode:'enforce',ttl:3600,secret:'FICTITIOUS_LEAD_VISUAL_SESSION'})})};
  const token=(await sessions.authenticated(user)).body.token;
  const express=require('express'),app=express(),server=require('node:http').createServer(app);let browser,reads=0;const apiErrors=[];
  app.get('/api/intake/leads/search',async(req,res,next)=>{try{req.userData=await sessions.verify(sessions.bearer(req.headers.authorization));reads++;next();}catch(error){next(error);}},require('../../../controllers/intake.controller').listLeads);
  app.use((error,_req,res,_next)=>{apiErrors.push(error.message);res.status(error.status||500).json({error:error.code||'fixture_error'});});
  const front=fs.realpathSync(process.env.GOOGLE_VISUAL_FRONTEND_SOURCE||path.resolve(__dirname,'../../../../../front-dev')),req=createRequire(path.join(front,'package.json'));
  const ts=req('typescript'),buildReq=createRequire(req.resolve('@angular-devkit/build-angular/package.json')),esbuild=buildReq('esbuild'),sass=buildReq('sass');
  const dir='src/app/modules/admin/apps/marketing/leads/',html=fs.readFileSync(path.join(front,dir+'leads.component.html'),'utf8');
  const start=html.indexOf('<div class="grid">',html.indexOf('<!-- Leads list -->')),end=html.indexOf('<!-- Paginator',start);assert(start>0&&end>start);
  const table=html.slice(start,end),template='<main class="p-4"><p>QA · Leads ficticios recibidos por Google · Clínica seleccionada: {{qaClinic}}</p><div class="flex gap-4 my-4"><button id="clinic-b" mat-raised-button (click)="select(71)">Clínica B</button><button id="clinic-a" mat-raised-button (click)="select(59)">Clínica A</button><button id="reload" mat-raised-button (click)="loadLeads()">Actualizar</button></div>'+table+'</main>';
  const componentCss=(await req('postcss')([req('tailwindcss')({...req('./tailwind.config.js'),content:[{raw:html,extension:'html'}]})]).process(sass.compile(path.join(front,dir+'leads.component.scss')).css,{from:undefined})).css;
  assert(!componentCss.includes('@screen'));
  const entry=[
    "import 'zone.js';import '@angular/compiler';import {Component,inject,ChangeDetectorRef} from '@angular/core';import {bootstrapApplication,DomSanitizer} from '@angular/platform-browser';import {CommonModule,registerLocaleData} from '@angular/common';import es from '@angular/common/locales/es';registerLocaleData(es);",
    "import {HttpClient,provideHttpClient,withInterceptors} from '@angular/common/http';import {FormBuilder} from '@angular/forms';import {provideNoopAnimations} from '@angular/platform-browser/animations';import {TranslocoModule,TranslocoService,provideTransloco} from '@ngneat/transloco';import {MatIconModule,MatIconRegistry} from '@angular/material/icon';import {MatButtonModule} from '@angular/material/button';import {MatSortModule} from '@angular/material/sort';import {MatTooltipModule} from '@angular/material/tooltip';",
    "import {LeadsComponent} from './"+dir+"leads.component';import {LeadsService} from './"+dir+"leads.service';import {ClinicFilterService} from './src/app/core/services/clinic-filter-service';",
    "const filter={value:'71',getCurrentClinicFilter(){return this.value;}};LeadsService.ctorParameters=()=>[HttpClient,ClinicFilterService,TranslocoService].map(type=>({type}));",
    "class Fixture extends LeadsComponent{qaClinic=71;constructor(){super(inject(ChangeDetectorRef),inject(LeadsService),filter,null,inject(TranslocoService),null,null,new FormBuilder(),null,null,null,null,null);const icons=inject(MatIconRegistry),safe=inject(DomSanitizer);for(const ns of ['heroicons_outline','heroicons_solid','brand'])icons.addSvgIconSetInNamespace(ns,safe.bypassSecurityTrustResourceUrl('/'+ns+'.svg'));window.QA_COMPONENT=this;}ngOnInit(){this.loadLeads();}select(id){filter.value=String(id);this.qaClinic=id;this.loadLeads();}}",
    "Component({selector:'qa-root',standalone:true,imports:[CommonModule,TranslocoModule,MatIconModule,MatButtonModule,MatSortModule,MatTooltipModule],template:"+JSON.stringify(template)+",styles:"+JSON.stringify([componentCss])+"})(Fixture);",
    "class Loader{http=inject(HttpClient);getTranslation(){return this.http.get('/es.json');}}bootstrapApplication(Fixture,{providers:[provideNoopAnimations(),provideHttpClient(withInterceptors([(req,next)=>next(req.url.startsWith('/api/')?req.clone({setHeaders:{authorization:'Bearer '+window.QA_TOKEN}}):req)])),LeadsService,{provide:ClinicFilterService,useValue:filter},provideTransloco({config:{availableLangs:['es'],defaultLang:'es',reRenderOnLangChange:true,prodMode:true},loader:Loader})]});"
  ].join('\n');
  const bundle=await esbuild.build({stdin:{contents:entry,resolveDir:front,sourcefile:'leads-visual.ts',loader:'ts'},absWorkingDir:front,bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',tsconfig:path.join(front,'tsconfig.json'),logLevel:'silent',
    plugins:[{name:'actual-angular',setup(build){build.onLoad({filter:/\.ts$/},async({path:file})=>{
      let source=fs.readFileSync(file,'utf8');source=source.replace(/templateUrl:\s*'([^']+)'/g,(_m,p)=>'template: '+JSON.stringify(fs.readFileSync(path.resolve(path.dirname(file),p),'utf8')))
        .replace(/styleUrls:\s*\[([^\]]+)\]/g,(_m,p)=>'styles: '+JSON.stringify([...p.matchAll(/'([^']+)'/g)].map(m=>sass.compile(path.resolve(path.dirname(file),m[1])).css)));
      return {contents:ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,experimentalDecorators:true,useDefineForClassFields:false}}).outputText,loader:'js',resolveDir:path.dirname(file)};
    });}}]});
  const styles='/home/ubuntu/www/front-dev-preview',cssName=fs.readdirSync(styles).find(v=>/^styles(?:[.-].+)?\.css$/.test(v));assert(cssName);
  app.get('/fixture.js',(_req,res)=>res.type('application/javascript').send(Buffer.from(bundle.outputFiles[0].contents)));
  app.get('/styles.css',(_req,res)=>res.type('text/css').send(fs.readFileSync(path.join(styles,cssName))));
  app.get('/es.json',(_req,res)=>res.json(JSON.parse(fs.readFileSync(path.join(front,'src/assets/i18n/es.json')))));
  for(const [name,file] of [['heroicons_outline','heroicons-outline'],['heroicons_solid','heroicons-solid'],['brand','brand']])app.get('/'+name+'.svg',(_req,res)=>res.type('image/svg+xml').send(fs.readFileSync(path.join(front,'src/assets/icons/'+file+'.svg'))));
  app.use('/assets',express.static(path.join(front,'src/assets')));app.get('/favicon.ico',(_req,res)=>res.sendStatus(204));
  app.get('/',(_req,res)=>res.type('html').send('<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="light theme-default"><qa-root></qa-root><script>window.QA_TOKEN='+JSON.stringify(token)+';</script><script src="/fixture.js"></script></body></html>'));
  const output=path.join(report.root,'visual');fs.mkdirSync(output,{mode:0o700});const errors=[],blocked=[],shots=[];
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));registerOwnedLoopbackServer(server);
    browser=await require('puppeteer-core').launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage(),base='http://127.0.0.1:'+server.address().port;
    await page.setRequestInterception(true);page.on('request',r=>{if(['GET','HEAD'].includes(r.method())&&(r.url().startsWith(base+'/')||r.url().startsWith('data:')))r.continue();else{blocked.push(r.url().split('?')[0]);r.abort();}});
    page.on('pageerror',error=>errors.push(error.message));
    for(const viewport of [{name:'desktop',width:1440,height:700},{name:'mobile',width:390,height:844}]){
      await page.setViewport(viewport);await page.goto(base,{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelectorAll('[data-lead-id]').length===2);
      const body=await page.$eval('body',e=>e.innerText);assert.match(body,/Contacto ficticio Google/);assert.match(body,/Clínica ficticia B/);if(viewport.width>=960)assert.match(body,/Google Ads/);assert.equal(await page.evaluate(()=>window.QA_COMPONENT.leads.every(l=>l.marketing_origin==='google_ads'&&l.contact_method==='platform_form')),true);assert.doesNotMatch(body,/NEVER_RETAIN/);
      await page.screenshot({path:path.join(output,viewport.name+'-clinic-b.png')});shots.push(viewport.name+'-clinic-b');
      const before=reads;await page.click('#reload');await page.waitForFunction(()=>!window.QA_COMPONENT.isLoading);assert(reads>before);assert.equal((await page.$$('[data-lead-id]')).length,2);
      await page.click('#clinic-a');await page.waitForFunction(()=>!window.QA_COMPONENT.isLoading&&window.QA_COMPONENT.qaClinic===59);assert.equal((await page.$$('[data-lead-id]')).length,0);
      await page.screenshot({path:path.join(output,viewport.name+'-clinic-a.png')});shots.push(viewport.name+'-clinic-a');
    }
    assert.deepEqual(apiErrors,[]);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
    report.visual={screenshots:shots,actualTable:true,actualComponentMethods:true,actualLeadsService:true,actualListController:true,actualSession:true,publicMfa:false,realGoogle:false,reads,errors,apiErrors,blocked};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report.visual,null,2),{mode:0o600});
    report.checks.push('real Angular lead table/methods/service and authenticated list controller show received SQL leads on assigned clinic B, refresh without duplicates and clinic A empty in desktop/mobile; no write or external request');
  }catch(error){if(browser){const page=(await browser.pages()).at(-1);await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});fs.writeFileSync(path.join(output,'failure.txt'),JSON.stringify({errors,apiErrors,blocked})+'\n'+await page.$eval('body',e=>e.innerText));}throw error;
  }finally{if(browser)await browser.close();if(server.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
};
