'use strict';
// Actual Angular component -> current Express routes -> SQL and signed broker.
// The parent owns all state and fake providers. Browser requests are loopback-only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
module.exports=async({app,apiServer,report,submissions,token,setProviderState,revoke,renew,reads,ingests})=>{
  const front=fs.realpathSync(process.env.GOOGLE_VISUAL_FRONTEND_SOURCE||path.resolve(__dirname,'../../../../../front-dev'));
  const req=createRequire(path.join(front,'package.json')),ts=req('typescript'),buildReq=createRequire(req.resolve('@angular-devkit/build-angular/package.json'));
  const esbuild=buildReq('esbuild'),sass=buildReq('sass'),puppeteer=require('puppeteer-core');
  const dir='src/app/modules/admin/apps/marketing/campaign-workspace/';
  const parentDir='src/app/modules/admin/apps/marketing/campanas/campaign-onboarding-stepper/';
  const parentSource=fs.readFileSync(path.join(front,parentDir+'campaign-onboarding-stepper.component.ts'),'utf8');
  const ast=ts.createSourceFile('stepper.ts',parentSource,ts.ScriptTarget.Latest,true);
  const parentClass=ast.statements.find(n=>n.name?.text==='CampaignOnboardingStepperComponent');assert(parentClass);
  const methods=['canReviewGoogleReceipts','reviewGoogleReceipts'].map(name=>{const node=parentClass.members.find(n=>n.name?.getText(ast)===name);assert(node);return node.getText(ast);});
  const parentMethods=ts.transpileModule('class ReceiptEntry {'+methods.join('\n')+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const parentHtml=fs.readFileSync(path.join(front,parentDir+'campaign-onboarding-stepper.component.html'),'utf8');
  const action=parentHtml.match(/<button\b[^>]*data-qa="stepper-google-receipts"[^>]*>[\s\S]*?<\/button>/)?.[0];assert(action);
  const entry=[
    "import 'zone.js'; import '@angular/compiler';",
    "import {Component,Inject,inject,ChangeDetectorRef,NgZone} from '@angular/core'; import {CommonModule} from '@angular/common'; import {MatButtonModule} from '@angular/material/button'; import {bootstrapApplication,DomSanitizer} from '@angular/platform-browser';",
    "import {provideNoopAnimations} from '@angular/platform-browser/animations'; import {HttpClient,provideHttpClient,withInterceptors} from '@angular/common/http';",
    "import {MatDialog,MatDialogModule,MatDialogRef,MAT_DIALOG_DATA} from '@angular/material/dialog'; import {MatIconRegistry} from '@angular/material/icon';",
    "import {GoogleReceiptsDialogComponent} from './"+dir+"google-receipts-dialog.component';",
    "import {CampaignOnboardingService} from './src/app/modules/admin/apps/marketing/campanas/campaign-onboarding.service';",
    "CampaignOnboardingService.ctorParameters=()=>[{type:HttpClient}];GoogleReceiptsDialogComponent.ctorParameters=()=>[{type:undefined,decorators:[{type:Inject,args:[MAT_DIALOG_DATA]}]},{type:MatDialogRef}];",
    parentMethods,
    "class Fixture extends ReceiptEntry {_dialog=inject(MatDialog);cdr=inject(ChangeDetectorRef);zone=inject(NgZone);account={customerId:'1234567890'};googleAccounts=[{customer_id:'1234567890',descriptive_name:'Cuenta ficticia · Recibos retirados'}];actionManagementByCustomer={'1234567890':{mode:'broker',receipts_enabled:false}};conversionLoading=false;scope={groupId:5};_getScopeContext(){return this.scope;}constructor(){super();window.QA_ENTRY=this;const icons=inject(MatIconRegistry),safe=inject(DomSanitizer);icons.addSvgIconSetInNamespace('brand',safe.bypassSecurityTrustResourceUrl('/brand.svg'));icons.addSvgIconSetInNamespace('heroicons_outline',safe.bypassSecurityTrustResourceUrl('/icons.svg'));}}",
    "Component({selector:'qa-root',standalone:true,imports:[CommonModule,MatButtonModule,MatDialogModule],template:"+JSON.stringify('<main style="padding:24px"><p>QA · Entrada real del asistente · API y broker locales · Proveedor ficticio</p>'+action+'</main>')+"})(Fixture);",
    "bootstrapApplication(Fixture,{providers:[provideNoopAnimations(),provideHttpClient(withInterceptors([(req,next)=>next(req.url.startsWith('/api/')?req.clone({setHeaders:{Authorization:'Bearer '+window.QA_TOKEN}}):req)]))]}).catch(e=>console.error(e));",
  ].join('\n');
  const bundle=await esbuild.build({stdin:{contents:entry,resolveDir:front,loader:'js'},bundle:true,write:false,absWorkingDir:front,format:'iife',platform:'browser',target:'es2022',tsconfig:path.join(front,'tsconfig.json'),logLevel:'silent',
    plugins:[{name:'actual-angular-fixture',setup(build){build.onLoad({filter:/\.ts$/},async({path:file})=>{
      let source=fs.readFileSync(file,'utf8');if(file.endsWith('google-receipts-dialog.component.ts'))source=source.replace(/styleUrls:\s*\[([^\]]+)\]/,(_m,p)=>'styles: '+JSON.stringify([...p.matchAll(/'([^']+)'/g)].map(m=>sass.compile(path.resolve(path.dirname(file),m[1])).css)));
      return {contents:ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,experimentalDecorators:true,useDefineForClassFields:false}}).outputText,loader:'js',resolveDir:path.dirname(file)};
    });}}]});
  const styles=process.env.GOOGLE_VISUAL_STYLES_DIR||'/home/ubuntu/www/front-dev-preview',cssName=fs.readdirSync(styles).find(v=>/^styles(?:[.-].+)?\.css$/.test(v));assert(cssName);
  app.get('/fixture.js',(_req,res)=>res.type('application/javascript').send(Buffer.from(bundle.outputFiles[0].contents)));
  app.get('/styles.css',(_req,res)=>res.type('text/css').send(fs.readFileSync(path.join(styles,cssName))));
  app.get('/brand.svg',(_req,res)=>res.type('image/svg+xml').send(fs.readFileSync(path.join(front,'src/assets/icons/brand.svg'))));
  app.get('/icons.svg',(_req,res)=>res.type('image/svg+xml').send(fs.readFileSync(path.join(front,'src/assets/icons/heroicons-outline.svg'))));
  app.get('/favicon.ico',(_req,res)=>res.sendStatus(204));
  app.get('/',(_req,res)=>res.set('Cache-Control','private, no-store').type('html').send('<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="light theme-default"><qa-root></qa-root><script>window.QA_TOKEN='+JSON.stringify(token())+';</script><script src="/fixture.js"></script></body></html>'));
  const output=path.join(report.root,'visual');fs.mkdirSync(output,{mode:0o700});let browser;const errors=[],blocked=[],shots=[],apiCalls=[];
  try{
    browser=await puppeteer.launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage(),base='http://127.0.0.1:'+apiServer.address().port;
    await page.setRequestInterception(true);page.on('request',r=>{if(r.url().startsWith(base+'/')||r.url().startsWith('data:'))r.continue();else{blocked.push(r.url().split('?')[0]);r.abort();}});
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().startsWith(base+'/api/'))apiCalls.push(r.method());});
    const ready=()=>page.waitForFunction(()=>document.querySelector('mat-dialog-content')&&!document.querySelector('mat-spinner')&&document.querySelector('[data-qa=receipt-row], [data-qa=receipt-empty], [role=alert]'));
    const shot=async name=>{
      const metrics=await page.$eval('mat-dialog-container',el=>{const r=el.getBoundingClientRect(),a=el.querySelector('mat-dialog-actions').getBoundingClientRect();return {fits:r.left>=0&&r.right<=innerWidth+1&&r.top>=23&&r.bottom<=innerHeight-23&&a.bottom<=innerHeight-23,overflow:[...el.querySelectorAll('p,code,h2,h3,button:not(.mat-mdc-icon-button)')].filter(v=>v.getClientRects().length&&v.scrollWidth>v.clientWidth+2).map(v=>v.textContent)};});
      await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});assert(metrics.fits&&!metrics.overflow.length,JSON.stringify(metrics));shots.push(name);
    };
    let i=0;for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
      await page.setViewport(viewport);await page.goto(base,{waitUntil:'networkidle0'});const prior=reads(),beforeCalls=apiCalls.length;
      assert.equal(await page.$('[data-qa=stepper-google-receipts]'),null);
      await page.evaluate(()=>{const c=window.QA_ENTRY;c.zone.run(()=>{c.reviewGoogleReceipts('1234567890');c.actionManagementByCustomer['1234567890'].receipts_enabled=true;c.actionManagementByCustomer['1234567890'].mode='legacy';c.reviewGoogleReceipts('1234567890');c.cdr.detectChanges();});});
      assert.equal(await page.$('[data-qa=stepper-google-receipts]'),null);
      await page.evaluate(()=>{const c=window.QA_ENTRY;c.zone.run(()=>{c.actionManagementByCustomer['1234567890'].mode='broker';c.scope={};c.reviewGoogleReceipts('1234567890');c.cdr.detectChanges();});});
      assert.equal(await page.$('[data-qa=stepper-google-receipts]'),null);
      await page.evaluate(()=>{const c=window.QA_ENTRY;c.zone.run(()=>{c.scope={groupId:5};c.reviewGoogleReceipts('9999999999');c.conversionLoading=true;c.reviewGoogleReceipts('1234567890');c.cdr.detectChanges();});});
      assert.equal(await page.$eval('[data-qa=stepper-google-receipts]',e=>e.disabled),true);assert.equal(await page.$('mat-dialog-container'),null);assert.equal(apiCalls.length,beforeCalls);
      await page.evaluate(()=>{const c=window.QA_ENTRY;c.zone.run(()=>{c.conversionLoading=false;c.cdr.detectChanges();});});
      await page.screenshot({path:path.join(output,viewport.name+'-stepper-entry.png')});shots.push(viewport.name+'-stepper-entry');
      await page.click('[data-qa=stepper-google-receipts]');await ready();
      assert.equal(await page.$$eval('[data-qa=receipt-row]',r=>r.length),4);assert.equal(reads(),prior);await shot(viewport.name+'-withdrawn-list');
      setProviderState(i?'PARTIAL_SUCCESS':'SUCCESS');const id=submissions[i].submissionId;
      const handle=await page.evaluateHandle(id=>[...document.querySelectorAll('[data-qa=receipt-row]')].find(row=>row.querySelector('code')?.textContent===id)?.querySelector('button'),id);
      const button=handle.asElement();assert(button);await button.click();await ready();
      assert.equal(reads(),prior+1);assert.equal(ingests(),4);
      assert.match(await page.$eval('[data-qa=receipt-result]',e=>e.textContent),i?/Procesamiento parcial/:/Procesamiento completado/);
      await shot(viewport.name+'-withdrawn-result');i++;
    }
    await revoke();const prior=reads();await page.click('[data-qa=receipt-refresh]');await ready();
    assert.equal(await page.$('[data-qa=receipt-row]'),null);assert.match(await page.$eval('[role=alert]',e=>e.textContent),/sesión ha caducado/);assert.equal(reads(),prior);await shot('mobile-revoked-session');await renew();
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({actualAngular:true,actualHttpApi:true,actualSqlManagedSession:true,actualSignedTlsBroker:true,realProvider:false,publicMfa:false,screenshots:shots,errors,blocked},null,2),{mode:0o600});
    report.visual={screenshots:shots.length,errors,blocked,actualHttpApi:true,actualSignedTlsBroker:true,actualStepperEntryFragment:true,entryGuardsVerified:true};
    report.checks.push('actual Angular desktop/mobile UI lists withdrawn receipts from SQL, checks SUCCESS/PARTIAL_SUCCESS through signed TLS broker and clears rows after real SQL session revocation; no additional ingests');
  }catch(error){if(browser){const page=(await browser.pages()).at(-1);await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});fs.writeFileSync(path.join(output,'failure.txt'),JSON.stringify({errors,blocked,apiCalls})+'\n'+await page.$eval('body',e=>e.innerText));}throw error;
  }finally{if(browser)await browser.close();}
};
