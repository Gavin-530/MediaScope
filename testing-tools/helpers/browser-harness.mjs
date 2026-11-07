import assert from './assert.mjs';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {startServer} from './server.mjs';
import {recordObservation,fileIdentity} from './observations.mjs';

export function createBrowserScenario({test,root,browser}){
let sequence=0;
return function scenario(name,body,{serverEnv={}}={}){
  test(name,{timeout:90000},async t=>{
    await mkdir(root,{recursive:true});
    const dir=await mkdtemp(path.join(root,String(++sequence).padStart(2,'0')+'-'));
    let app,context,page;const errors=[],responses=[];
    try{
      app=await startServer(path.join(dir,'reports'),{env:serverEnv});
      context=await browser().newContext({acceptDownloads:true,colorScheme:'dark',timezoneId:'America/Los_Angeles',viewport:{width:1440,height:900}});
      page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
      await page.coverage.startJSCoverage({resetOnNavigation:false});
      await page.addInitScript(()=>{
        window.__formalControlEvents=[];
        for(const type of ['click','input','change'])document.addEventListener(type,event=>{
          const target=event.target.closest?.('button,input,select');if(!target)return;
          window.__formalControlEvents.push({type,id:target.id||null,mode:target.dataset.mode,target:target.dataset.target,value:target.type==='file'?'[file selection]':target.value,checked:target.checked});
        },true);
      });
      page.on('response',response=>{
        if(!response.url().startsWith(app.base+'/api/'))return;
        responses.push((async()=>{const request=response.request();let result;try{result=await response.json()}catch{return;}let input;try{input=request.postDataJSON()}catch{}
          const inputs=await Promise.all(['file','reference','candidate'].filter(k=>typeof input?.[k]==='string').map(k=>fileIdentity(input[k])));
          await recordObservation('browser.api',{method:request.method(),url:new URL(response.url()).pathname,status:response.status(),input,inputs,result});
        })());
      });
      await page.goto(app.base);
      await page.waitForFunction(()=>document.querySelector('#environment')?.textContent.includes('ffmpeg version'));
      await body({t,page,context,app,dir});
      assert.deepEqual(errors,[],'the real ES modules must initialize without browser exceptions');
    }catch(error){
      await page?.screenshot({path:path.join(dir,'failure.png'),fullPage:false}).catch(()=>{});
      await writeFile(path.join(dir,'browser-errors.json'),JSON.stringify(errors));
      throw error;
    }finally{
      if(page&&!page.isClosed())await recordObservation('browser.state',{result:await page.evaluate(()=>({text:document.body.innerText,events:window.__formalControlEvents,controls:[...document.querySelectorAll('button,input,select')].map(e=>({id:e.id||null,tag:e.tagName,type:e.type,value:e.type==='file'?'[file selection]':e.value,checked:e.checked,disabled:e.disabled,visible:!!e.getClientRects().length,mode:e.dataset.mode,target:e.dataset.target}))}))});
      if(page&&!page.isClosed())await recordObservation('browser.coverage',{result:(await page.coverage.stopJSCoverage()).filter(s=>s.url.startsWith(app.base+'/')).map(s=>({file:'public'+new URL(s.url).pathname,functions:s.functions}))});
      await Promise.all(responses);
      try{await context?.close()}finally{await app?.stop()}
    }
  });
}
}
