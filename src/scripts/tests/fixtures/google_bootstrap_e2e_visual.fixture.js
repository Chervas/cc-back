'use strict';
// Real stepper class/template plus the exact Web status card. Actual bootstrap
// HTTP/SQL/signed broker; isolated provider and selection, never public MFA.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
module.exports=async({app,apiServer,report,token,reads})=>{
  const front=path.resolve(__dirname,'../../../../../front-dev'),req=createRequire(path.join(front,'package.json'));
  const ts=req('typescript'),buildReq=createRequire(req.resolve('@angular-devkit/build-angular/package.json'));
  const esbuild=buildReq('esbuild'),sass=buildReq('sass'),puppeteer=require('puppeteer-core');
  const dir='src/app/modules/admin/apps/marketing/campanas/campaign-onboarding-stepper/';
  const web=fs.readFileSync(path.join(front,'src/app/modules/admin/apps/marketing/web/web.component.html'),'utf8');
  const start=web.indexOf('<div *ngIf="googleAdsBootstrapLoaded && googleAdsConnected && !googleDataManagerReady"');
  const end=web.indexOf('<!-- ═══ Cuentas conectadas',start);assert(start>0&&end>start);
  const card=web.slice(start,end).trim();
  const material=['button','checkbox','dialog','form-field','icon','select','slide-toggle','progress-spinner','stepper','tooltip'];
  const names=['MatButtonModule','MatCheckboxModule','MatDialogModule','MatFormFieldModule','MatIconModule','MatSelectModule','MatSlideToggleModule','MatProgressSpinnerModule','MatStepperModule','MatTooltipModule'];
  const entry=[
    "import 'zone.js';import '@angular/compiler';import {Component,NgModule,ViewChild,ChangeDetectorRef,inject} from '@angular/core';import {bootstrapApplication,DomSanitizer} from '@angular/platform-browser';import {CommonModule} from '@angular/common';",
    "import {FormsModule,ReactiveFormsModule,FormBuilder} from '@angular/forms';import {provideNoopAnimations} from '@angular/platform-browser/animations';import {HttpClient,provideHttpClient,withInterceptors} from '@angular/common/http';import {MatDialog} from '@angular/material/dialog';import {MatIconRegistry} from '@angular/material/icon';import {of} from 'rxjs';",
    "import {TranslocoModule,TranslocoService,provideTransloco} from '@ngneat/transloco';import {ClinicFilterService} from './src/app/core/services/clinic-filter-service';",
    "import {CampaignOnboardingService} from './src/app/modules/admin/apps/marketing/campanas/campaign-onboarding.service';import {CampaignOnboardingStepperComponent} from './"+dir+"campaign-onboarding-stepper.component';",
    ...material.map((p,i)=>"import {"+names[i]+"} from '@angular/material/"+p+"';"),
    "CampaignOnboardingService.ctorParameters=()=>[{type:HttpClient}];CampaignOnboardingStepperComponent.ctorParameters=()=>[HttpClient,FormBuilder,ChangeDetectorRef,MatDialog,CampaignOnboardingService,ClinicFilterService,TranslocoService].map(type=>({type}));",
    "class StepperModule{};NgModule({declarations:[CampaignOnboardingStepperComponent],exports:[CampaignOnboardingStepperComponent],imports:[CommonModule,FormsModule,ReactiveFormsModule,TranslocoModule,"+names.join(',')+"]})(StepperModule);",
    "class Fixture{step; constructor(){const icons=inject(MatIconRegistry),safe=inject(DomSanitizer);for(const ns of ['heroicons_outline','heroicons_solid','brand'])icons.addSvgIconSetInNamespace(ns,safe.bypassSecurityTrustResourceUrl('/'+ns+'.svg'));window.QA_COMPONENT=this;}get googleAdsBootstrapLoaded(){return this.step?.bootstrapLoaded;}get googleAdsConnected(){return this.step?.googleAds?.connected;}get googleDataManagerReady(){return this.step?.googleAds?.capabilities?.data_manager_ready;}get googleDataManagerMissing(){return this.step?.googleAds?.capabilities?.data_manager_missing||[];}}",
    "ViewChild(CampaignOnboardingStepperComponent)(Fixture.prototype,'step');Component({selector:'qa-root',standalone:true,imports:[StepperModule,CommonModule,TranslocoModule,MatIconModule],template:"+JSON.stringify('<main style="padding:16px;max-width:1000px;margin:auto"><p>QA · Grupo ficticio · API y broker locales</p><campaign-onboarding-stepper></campaign-onboarding-stepper><section id="web-card" style="margin-top:24px"><h2>Marketing Web · Estado de conversiones</h2>'+card+'</section></main>')+"})(Fixture);",
    "const filter={selectedClinicId$:of('59,71'),selectedGroupName$:of('Grupo ficticio'),filteredClinics$:of([]),getCurrentClinicFilter:()=> '59,71',getCurrentSelectedGroupName:()=> 'Grupo ficticio',getCurrentFilteredClinics:()=>[{id_clinica:59,grupoClinica:{id_grupo:5}},{id_clinica:71,grupoClinica:{id_grupo:5}}]};",
    "class Loader{http=inject(HttpClient);getTranslation(){return this.http.get('/es.json');}};bootstrapApplication(Fixture,{providers:[provideNoopAnimations(),provideHttpClient(withInterceptors([(req,next)=>next(req.url.startsWith('/api/')?req.clone({setHeaders:{authorization:'Bearer '+window.QA_TOKEN}}):req)])),{provide:ClinicFilterService,useValue:filter},provideTransloco({config:{availableLangs:['es'],defaultLang:'es',reRenderOnLangChange:true,prodMode:true},loader:Loader})]});"
  ].join('\n');
  const bundle=await esbuild.build({stdin:{contents:entry,resolveDir:front,sourcefile:'bootstrap-visual.ts',loader:'ts'},absWorkingDir:front,bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',tsconfig:path.join(front,'tsconfig.json'),logLevel:'silent',
    plugins:[{name:'actual-angular-components',setup(build){build.onLoad({filter:/\.ts$/},async({path:file})=>{
      let source=fs.readFileSync(file,'utf8');
      source=source.replace(/templateUrl:\s*'([^']+)'/g,(_m,p)=>'template: '+JSON.stringify(fs.readFileSync(path.resolve(path.dirname(file),p),'utf8')))
        .replace(/styleUrls:\s*\[([^\]]+)\]/g,(_m,p)=>'styles: '+JSON.stringify([...p.matchAll(/'([^']+)'/g)].map(m=>sass.compile(path.resolve(path.dirname(file),m[1])).css)));
      return {contents:ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,experimentalDecorators:true,useDefineForClassFields:false}}).outputText,loader:'js',resolveDir:path.dirname(file)};
    });}}]});
  const styles='/home/ubuntu/www/front-dev-preview',cssName=fs.readdirSync(styles).find(v=>/^styles(?:[.-].+)?\.css$/.test(v));assert(cssName);
  app.get('/fixture.js',(_req,res)=>res.type('application/javascript').send(Buffer.from(bundle.outputFiles[0].contents)));
  app.get('/styles.css',(_req,res)=>res.type('text/css').send(fs.readFileSync(path.join(styles,cssName))));
  app.get('/es.json',(_req,res)=>res.type('application/json').send(fs.readFileSync(path.join(front,'src/assets/i18n/es.json'))));
  for(const [name,file] of [['heroicons_outline','heroicons-outline'],['heroicons_solid','heroicons-solid'],['brand','brand']])app.get('/'+name+'.svg',(_req,res)=>res.type('image/svg+xml').send(fs.readFileSync(path.join(front,'src/assets/icons/'+file+'.svg'))));
  app.use('/assets',require('express').static(path.join(front,'src/assets')));
  app.get('/favicon.ico',(_req,res)=>res.sendStatus(204));
  app.get('/',(_req,res)=>res.set('Cache-Control','private, no-store').type('html').send('<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="light theme-default"><qa-root></qa-root><script>window.QA_TOKEN='+JSON.stringify(token())+';</script><script src="/fixture.js"></script></body></html>'));
  const output=path.join(report.root,'visual');fs.mkdirSync(output,{mode:0o700});let browser;const errors=[],blocked=[],shots=[],writes=[];
  try{
    browser=await puppeteer.launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage(),base='http://127.0.0.1:'+apiServer.address().port;
    await page.setRequestInterception(true);page.on('request',r=>{if(!['GET','HEAD'].includes(r.method())){writes.push(r.url());r.abort();}else if(r.url().startsWith(base+'/')||r.url().startsWith('data:'))r.continue();else{blocked.push(r.url().split('?')[0]);r.abort();}});
    page.on('pageerror',e=>errors.push(e.message));
    for(const v of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
      await page.setViewport(v);const prior=reads();await page.goto(base,{waitUntil:'networkidle0'});
      await page.waitForFunction(()=>window.QA_COMPONENT?.step?.bootstrapLoaded&&!window.QA_COMPONENT.step.conversionLoading);
      assert(reads()>prior);assert.equal(await page.evaluate(()=>window.QA_COMPONENT.step.googleAds.capabilities.data_manager_ready),false);
      await page.evaluate(()=>window.QA_COMPONENT.step.stepper.selectedIndex=1);
      await page.waitForFunction(()=>document.querySelector('#conversion-clinicaclick-title')?.getClientRects().length);
      const notice=await page.$eval('#conversion-clinicaclick-title',e=>e.parentElement.textContent);assert.match(notice,/envío de conversiones sigue desactivado/);
      assert.doesNotMatch(await page.$eval('body',e=>e.textContent),/Preparando automáticamente/);
      assert.equal(await page.$('#conversion-user-google-title'),null);
      assert.match(await page.$eval('#web-card',e=>e.textContent),/No necesitas reconectar Google/);
      assert.equal(await page.evaluate(()=>window.QA_COMPONENT.step.conversionsValid),false);
      for(const [name,selector] of [['stepper','#conversion-readiness-title'],['web','#web-card']]){
        await page.$eval(selector,e=>e.scrollIntoView({block:'center'}));
        await page.screenshot({path:path.join(output,v.name+'-'+name+'.png')});
        const overflow=await page.$eval(selector,e=>{const block=e.closest('section')||e.parentElement;return [...block.querySelectorAll('li,p,h5')].some(n=>n.getClientRects().length&&n.scrollWidth>n.clientWidth+2);});assert.equal(overflow,false);shots.push(v.name+'-'+name);
      }
    }
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.deepEqual(writes,[]);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({screenshots:shots,actualStepper:true,actualWebStatusCard:true,actualBootstrapHttp:true,actualSql:true,actualSignedTlsBroker:true,publicMfa:false,realProvider:false,errors,blocked,writes},null,2),{mode:0o600});
    report.visual={screenshots:shots.length,errors,blocked,writes};report.checks.push('real Angular stepper and exact Web status card, desktop/mobile, consume actual bootstrap HTTP; disabled delivery belongs to ClinicaClick, no reconnect request or validated state and no write attempted');
  }catch(error){if(browser){const page=(await browser.pages()).at(-1);await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});fs.writeFileSync(path.join(output,'failure.txt'),JSON.stringify(errors)+'\n'+await page.$eval('body',e=>e.innerText));}throw error;
  }finally{if(browser)await browser.close();}
};
