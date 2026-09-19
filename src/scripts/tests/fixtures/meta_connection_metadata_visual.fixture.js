'use strict';
// Actual Settings and shared selector classes/templates. Their metadata HTTP
// reads use the owned SQL API; unrelated services use explicit fixture data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
module.exports=async({app,server,report,token,reads,models,gates})=>{
  const front=path.resolve(__dirname,'../../../../../front-dev'),req=createRequire(path.join(front,'package.json'));
  const ts=req('typescript'),buildReq=createRequire(req.resolve('@angular-devkit/build-angular/package.json'));
  const esbuild=buildReq('esbuild'),sass=buildReq('sass'),puppeteer=require('puppeteer-core');
  const entry=`
import 'zone.js';import '@angular/compiler';
import {Component,ViewChild,ChangeDetectorRef,inject} from '@angular/core';import {bootstrapApplication,DomSanitizer} from '@angular/platform-browser';
import {provideNoopAnimations} from '@angular/platform-browser/animations';import {HttpClient,provideHttpClient,withInterceptors} from '@angular/common/http';
import {MatDialog} from '@angular/material/dialog';import {MatSnackBar} from '@angular/material/snack-bar';import {MatIconRegistry} from '@angular/material/icon';
import {Router,ActivatedRoute,convertToParamMap} from '@angular/router';import {of,BehaviorSubject} from 'rxjs';
import {TranslocoService,provideTransloco} from '@ngneat/transloco';
import {UserService} from './src/app/core/user/user.service';import {AuthService} from './src/app/core/auth/auth.service';
import {FuseConfirmationService} from './src/@fuse/services/confirmation';import {FuseLoadingService} from './src/@fuse/services/loading';
import {ClinicFilterService} from './src/app/core/services/clinic-filter-service';import {RoleService} from './src/app/core/services/role.service';
import {PatientDirectionService} from './src/app/core/services/patient-direction.service';
import {SettingsConnectedAccountsComponent} from './src/app/modules/admin/pages/settings/connected-accounts/connected-accounts.component';
import {GoogleRevocationStatusComponent} from './src/app/modules/admin/pages/settings/connected-accounts/google-revocation-status.component';
import {WhatsappRoutingSettingsComponent} from './src/app/shared/whatsapp-routing-settings/whatsapp-routing-settings.component';
import {AssetMappingComponent} from './src/app/modules/admin/pages/settings/shared/asset-mapping.component';
import {accountDiscoveryStep,workspaceErrorMessage} from './src/app/modules/admin/apps/marketing/campaign-workspace/campaign-account-selection.model';
GoogleRevocationStatusComponent.ctorParameters=()=>[HttpClient,ChangeDetectorRef].map(type=>({type}));
WhatsappRoutingSettingsComponent.ctorParameters=()=>[HttpClient,MatSnackBar,ChangeDetectorRef,Router].map(type=>({type}));
SettingsConnectedAccountsComponent.ctorParameters=()=>[ChangeDetectorRef,HttpClient,UserService,AuthService,FuseConfirmationService,FuseLoadingService,MatSnackBar,Router,ActivatedRoute,ClinicFilterService,RoleService,MatDialog,TranslocoService,PatientDirectionService].map(type=>({type}));
const clinics=[{id_clinica:59,nombre_clinica:'Clínica ficticia A',grupoClinica:{id_grupo:5,nombre_grupo:'Grupo ficticio'}},{id_clinica:71,nombre_clinica:'Clínica ficticia B',grupoClinica:{id_grupo:5,nombre_grupo:'Grupo ficticio'}}];
const selected=new BehaviorSubject('59'), filtered=new BehaviorSubject([clinics[0]]);
const filter={selectedClinicId$:selected,selectedGroupName$:of(null),filteredClinics$:filtered,getCurrentClinicFilter:()=>selected.value,getCurrentSelectedGroupName:()=>null,getCurrentFilteredClinics:()=>filtered.value,isCurrentUserAdmin:()=>false};
class Fixture{settings;mapping;showMapping=false; constructor(){this.cdr=inject(ChangeDetectorRef);const icons=inject(MatIconRegistry),safe=inject(DomSanitizer);for(const ns of ['heroicons_outline','heroicons_solid','brand','feather'])icons.addSvgIconSetInNamespace(ns,safe.bypassSecurityTrustResourceUrl('/'+ns+'.svg'));window.QA_COMPONENT=this;window.QA_ACCOUNT_STEP=accountDiscoveryStep;window.QA_WORKSPACE_MESSAGE=workspaceErrorMessage;}
select(id){selected.next(String(id));filtered.next([clinics.find(c=>c.id_clinica===id)]);this.cdr.markForCheck();} }
ViewChild(SettingsConnectedAccountsComponent)(Fixture.prototype,'settings');ViewChild(AssetMappingComponent)(Fixture.prototype,'mapping');
Component({selector:'qa-root',standalone:true,imports:[SettingsConnectedAccountsComponent,AssetMappingComponent],template:'<main style="padding:16px;max-width:1100px;margin:auto"><p>QA · Datos ficticios · MySQL temporal</p><nav style="display:flex;gap:12px;margin:16px 0"><button id="clinic-a" (click)="select(59)">Clínica A</button><button id="clinic-b" (click)="select(71)">Clínica B</button><button id="mapping" (click)="showMapping=!showMapping">Selector de activos</button></nav>@if(!showMapping){<settings-connected-accounts></settings-connected-accounts>}@else{<app-asset-mapping [scopeClinicId]="59" scopeAssignmentScope="clinic"></app-asset-mapping>}</main>'})(Fixture);
class Loader{http=inject(HttpClient);getTranslation(){return this.http.get('/es.json');}}
bootstrapApplication(Fixture,{providers:[provideNoopAnimations(),provideHttpClient(withInterceptors([(req,next)=>next(req.url.includes('/oauth/')?req.clone({setHeaders:{authorization:'Bearer '+window.QA_TOKEN}}):req)])),
{provide:ClinicFilterService,useValue:filter},{provide:UserService,useValue:{user$:of(null)}},{provide:AuthService,useValue:{getCurrentUser:()=>of({id_usuario:91002,nombre:'Usuario ficticio'}),accessToken:window.QA_TOKEN}},
{provide:RoleService,useValue:{getCurrentRole:()=> 'marketing',clinicas$:of(clinics)}},{provide:FuseConfirmationService,useValue:{open:()=>{throw Error('UNEXPECTED_CONFIRMATION');}}},{provide:FuseLoadingService,useValue:{show(){},hide(){}}},
{provide:PatientDirectionService,useValue:{}},{provide:Router,useValue:{url:'/',navigate:()=>Promise.resolve(true)}},{provide:ActivatedRoute,useValue:{queryParamMap:of(convertToParamMap({})),snapshot:{queryParams:{}}}},
provideTransloco({config:{availableLangs:['es'],defaultLang:'es',reRenderOnLangChange:true,prodMode:true},loader:Loader})]});`;
  const bundle=await esbuild.build({stdin:{contents:entry,resolveDir:front,sourcefile:'meta-settings-visual.ts',loader:'ts'},absWorkingDir:front,bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',tsconfig:path.join(front,'tsconfig.json'),logLevel:'silent',
    plugins:[{name:'actual-angular-components',setup(build){build.onLoad({filter:/\.ts$/},async({path:file})=>{
      let source=fs.readFileSync(file,'utf8');source=source.replace(/templateUrl:\s*'([^']+)'/g,(_m,p)=>'template: '+JSON.stringify(fs.readFileSync(path.resolve(path.dirname(file),p),'utf8')))
        .replace(/styleUrls:\s*\[([^\]]+)\]/g,(_m,p)=>'styles: '+JSON.stringify([...p.matchAll(/'([^']+)'/g)].map(m=>sass.compile(path.resolve(path.dirname(file),m[1])).css)));
      return {contents:ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,experimentalDecorators:true,useDefineForClassFields:false}}).outputText,loader:'js',resolveDir:path.dirname(file)};
    });}}]});
  const styles='/home/ubuntu/www/front-dev-preview',cssName=fs.readdirSync(styles).find(v=>/^styles(?:[.-].+)?\.css$/.test(v));assert(cssName);
  app.get('/fixture.js',(_req,res)=>res.type('application/javascript').send(Buffer.from(bundle.outputFiles[0].contents)));
  app.get('/styles.css',(_req,res)=>res.type('text/css').send(fs.readFileSync(path.join(styles,cssName))));
  app.get('/es.json',(_req,res)=>res.type('application/json').send(fs.readFileSync(path.join(front,'src/assets/i18n/es.json'))));
  for(const [name,file] of [['heroicons_outline','heroicons-outline'],['heroicons_solid','heroicons-solid'],['brand','brand'],['feather','feather']])app.get('/'+name+'.svg',(_req,res)=>res.type('image/svg+xml').send(fs.readFileSync(path.join(front,'src/assets/icons/'+file+'.svg'))));
  app.use('/assets',require('express').static(path.join(front,'src/assets')));app.get('/favicon.ico',(_req,res)=>res.sendStatus(204));
  app.get('/',(_req,res)=>res.type('html').send('<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="light theme-default"><qa-root></qa-root><script>window.QA_TOKEN='+JSON.stringify(token())+';</script><script src="/fixture.js"></script></body></html>'));
  // Unrelated providers have no real credentials or external calls in this harness.
  app.get('*',(req,res)=>res.json(req.path.includes('/phones')?{phones:[]}:req.path.includes('bootstrap')?{meta_ads:{connected:false}}:{connected:false,authorizations:[],groups:[],clinics:[],mappings:[]}));
  const output=path.join(report.root,'visual');fs.mkdirSync(output,{mode:0o700});let browser;const errors=[],blocked=[],shots=[],writes=[],metaCalls=[];
  try {
    browser=await puppeteer.launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage(),base='http://127.0.0.1:'+server.address().port;
    await page.setRequestInterception(true);page.on('request',r=>{if(r.url().includes('/oauth/meta/'))metaCalls.push(new URL(r.url()).pathname);
      if(!['GET','HEAD'].includes(r.method())){writes.push(r.url());r.abort();}else if(r.url().startsWith(base+'/')||r.url().startsWith('data:'))r.continue();else{blocked.push(r.url().split('?')[0]);r.abort();}});
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',msg=>{if(msg.type()==='error')fs.appendFileSync(path.join(output,'browser-errors.log'),msg.text()+'\n');});
    const ready=()=>page.waitForFunction(()=>window.QA_COMPONENT?.settings?.metaConnectionState==='paused'&&!window.QA_COMPONENT.settings.isLoadingMappings);
    for(const view of [{name:'desktop',width:1440,height:1100},{name:'mobile',width:390,height:844}]){
      await page.setViewport(view);const prior=reads();await page.goto(base,{waitUntil:'networkidle0'});await ready();assert(reads()>prior);
      assert.equal(await page.evaluate(()=>window.QA_COMPONENT.settings.accounts.find(a=>a.id==='meta').connected),false);
      assert.equal(await page.evaluate(()=>window.QA_COMPONENT.settings.accounts.find(a=>a.id==='meta').connectionStored),true);
      const banner=await page.$('[data-qa="meta-paused-notice"]');assert(banner);await banner.evaluate(e=>e.scrollIntoView({block:'center'}));
      assert.match(await banner.evaluate(e=>e.innerText),/No necesitas volver a conectar/);assert.match(await page.$eval('body',e=>e.innerText),/Responsable ficticio A/);
      assert.match(await page.$eval('body',e=>e.innerText),/Cuenta ficticia A/);
      const priorCalls=metaCalls.length;await page.evaluate(()=>{const c=window.QA_COMPONENT.settings;c.connectAccount('meta');c.openAssetMapping();});
      assert.equal(metaCalls.length,priorCalls);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      await page.screenshot({path:path.join(output,view.name+'-settings.png')});shots.push(view.name+'-settings');
    }
    await page.setViewport({width:1440,height:1000});await page.goto(base,{waitUntil:'networkidle0'});await ready();
    const gate={path:'/oauth/meta/connection-status',clinic:'59'};gates.push(gate);
    await page.click('[data-qa="meta-refresh"]');
    for(let i=0;!gate.captured&&i<100;i++)await new Promise(r=>setTimeout(r,20));assert(gate.captured);
    await page.click('#clinic-b');await ready();assert.match(await page.$eval('body',e=>e.innerText),/Responsable ficticio B/);gate.deliver();
    await new Promise(r=>setTimeout(r,100));assert.doesNotMatch(await page.$eval('body',e=>e.innerText),/Responsable ficticio A|Cuenta ficticia A/);
    await page.screenshot({path:path.join(output,'changed-clinic.png')});shots.push('changed-clinic');
    await page.click('#clinic-a');await ready();
    const mappingGate={path:'/oauth/meta/mappings',clinic:'59'};gates.push(mappingGate);
    await page.click('[data-qa="meta-refresh"]');
    for(let i=0;!mappingGate.captured&&i<100;i++)await new Promise(r=>setTimeout(r,20));assert(mappingGate.captured);
    await models.ClinicMetaAsset.update({metaAssetName:'Cuenta ficticia A revisada'},{where:{id:1}});
    await page.click('#clinic-b');await ready();await page.click('#clinic-a');await ready();mappingGate.deliver();
    await new Promise(r=>setTimeout(r,100));assert.doesNotMatch(await page.$eval('body',e=>e.innerText),/Responsable ficticio B|Cuenta ficticia B/);
    assert.match(await page.$eval('body',e=>e.innerText),/Cuenta ficticia A revisada/);
    await models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_clinica:59}});
    await page.click('[data-qa="meta-refresh"]');await page.waitForFunction(()=>window.QA_COMPONENT.settings.metaConnectionState==='unavailable');
    assert.doesNotMatch(await page.$eval('body',e=>e.innerText),/Responsable ficticio A|Cuenta ficticia A/);
    await page.screenshot({path:path.join(output,'permission-revoked.png')});shots.push('permission-revoked');
    await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_clinica:59}});
    await page.click('#mapping');await page.waitForFunction(()=>window.QA_COMPONENT.mapping?.metaConnectionState==='paused');
    assert(await page.$('[data-qa="meta-mapping-unavailable"]'));assert.equal(await page.$('mat-stepper'),null);
    await page.evaluate(()=>window.QA_COMPONENT.mapping.connectMeta());await page.screenshot({path:path.join(output,'selector-paused.png')});shots.push('selector-paused');
    const paused=await page.evaluate(()=>{try{window.QA_ACCOUNT_STEP({connected:true,reason:'meta_security_quarantine'});return null;}catch(e){return window.QA_WORKSPACE_MESSAGE(e);}});assert.match(paused,/Meta Ads está en pausa/);
    assert(metaCalls.every(p=>/\/(connection-status|mappings)$/.test(p)));assert.deepEqual(writes,[]);assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
    report.visual={shots,metaRequests:metaCalls.length,errors,writes,blocked,actualComponents:['SettingsConnectedAccountsComponent','AssetMappingComponent'],workspace:'actual decision model; no full workspace rendering'};
  } catch(error) {fs.writeFileSync(path.join(output,'failure.txt'),error.stack);if(browser){const pages=await browser.pages();await pages.at(-1)?.screenshot({path:path.join(output,'failure.png'),fullPage:true});}throw error;
  } finally {if(browser)await browser.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({shots,errors,writes,blocked},null,2));}
};
