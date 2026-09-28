import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseReport} from '../public/report.js';
import * as portable from '../public/portable.js';
import * as trial from '../public/trial-model.js';

const base={schema:'MediaScope/0.2',file:'D:\\已移动\\源.mp4',size:12345,raw:{format:{duration:'1.25'},streams:[{index:0,codec_type:'video',codec_name:'h264',width:16,height:16}]},commands:[{args:['原始参数']}],unknownEvidence:{precise:0.12345678901234568}};
const metric={pooled:'Infinity',values:['Infinity',42.12345678901234,null],worst:[]};
const fixtures=[
 {...base,type:'inspect'},
 {...base,type:'analyze',frames:[{t:0,bytes:100,type:'I',key:true},{t:0.04,bytes:20,type:'P',key:false}],summary:{nonIncreasing:0},packets:{bytes:120,bins:[{second:0,mbps:0.00096}]},content:{available:true,si:{mean:1},points:[{t:0,si:1,ti:0}]}},
 {schema:base.schema,type:'compare',reference:base,candidate:base,alignment:{frames:3},metrics:{psnr:metric,ssim:{pooled:1,values:[1,0.99,1]}}},
 {schema:base.schema,type:'trial',source:base,experiment:{start:0,duration:1,actualFrames:3,retainedFiles:[]},rows:[{crf:20,videoBytes:321,encodeSeconds:1.123456789,metrics:{psnr:metric,ssim:{pooled:1,values:[1,1,1]}}}]}
];
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^api\('status'\)[\s\S]*$/m,'');
function frontend(){
 const nodes=new Map(),plots=[];
 const classList=()=>{const values=new Set();return {add:v=>values.add(v),remove:v=>values.delete(v),contains:v=>values.has(v),toggle(v,on){if(on??!values.has(v))values.add(v);else values.delete(v)}}};
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:({'#rd-axis':'videoKiB','#rd-metric':'psnr','#trial-row':'0','#trial-frame-metric':'psnr','#trial-crfs':'20','#export-result-scope':'all','#export-plan-scope':'none'})[id]??'',checked:['#import-results','#import-plans'].includes(id),content:'token',innerHTML:'',textContent:'',classList:classList(),addEventListener(){},querySelectorAll(){return []},click(){this.onclick?.()}});return nodes.get(id)};
 const tabs=['inspect','compare','trial'].map(mode=>Object.assign(node('.tab-'+mode),{dataset:{mode}}));
 const document={querySelector:node,querySelectorAll:s=>s==='.tab'?tabs:[]};
 const chart=(host,data,options)=>{plots.push({id:host.id,data,options});return {dispose(){},setRange(){},select(){}}};
 const context=vm.createContext({document,...trial,...portable,parseReport,plot:chart,gopOverview:chart,Blob,console,setTimeout,setInterval(){},fetch(){throw Error('导入不应访问网络')}});
 vm.runInContext(source,context);
 const lookup=id=>node(/^#(result|result-title|summary|details|export)$/.test(id)?'#'+vm.runInContext('activeMode',context)+'-'+id.slice(1):id);
 return {context,node:lookup,preview:()=>JSON.stringify({summary:lookup('#summary').innerHTML,details:lookup('#details').innerHTML,frames:node('#frames').innerHTML,detail:node('#frame-detail').innerHTML,plots},(k,v)=>typeof v==='function'?undefined:v),clear:()=>{plots.length=0}};
}
for(const fixture of fixtures)test(`${fixture.type}: JSON round trip retains all data and the same rendered tables and chart inputs`,async()=>{
 const saved=JSON.stringify(fixture),restored=parseReport('\uFEFF'+saved);
 assert.deepEqual(restored,fixture);
 const app=frontend();app.context.input=fixture;vm.runInContext('report=input;render(report)',app.context);
 const before=app.preview();app.clear();
 const input=app.node('#import-report');input.files=[{name:'report.json',size:saved.length,text:async()=>saved}];
 await input.onchange({target:input});
 assert.match(app.node('#task-message').textContent,/已导入/);
 assert.equal(app.preview(),before);assert.equal(vm.runInContext('JSON.stringify(report)',app.context),saved);
});
test('invalid and unsupported reports are rejected; existing preview and exported report survive',async()=>{
 const app=frontend();app.context.input=fixtures[0];vm.runInContext('report=input;render(report)',app.context);const before=app.preview();
 for(const saved of ['{','null',JSON.stringify({...fixtures[0],schema:'MediaScope/99'}),JSON.stringify({...fixtures[1],packets:{}})]){
  assert.throws(()=>parseReport(saved));const input=app.node('#import-report');input.files=[{name:'bad.json',size:saved.length,text:async()=>saved}];await input.onchange({target:input});assert.equal(app.preview(),before);assert.equal(vm.runInContext('JSON.stringify(report)',app.context),JSON.stringify(fixtures[0]));
 }
});
test('SI/TI worker control enables with measurement and sends the selected upper limit',()=>{
 const app=frontend(),complexity=app.node('#complexity'),workers=app.node('#siti-workers');
 assert.equal(workers.disabled,true);complexity.checked=true;complexity.onchange();assert.equal(workers.disabled,false);workers.value='8';
 app.context.sent=null;vm.runInContext('launch=input=>{sent=input}',app.context);app.node('#analyze').click();
 assert.equal(app.context.sent.complexity,true);assert.equal(app.context.sent.sitiWorkers,'8');
});
test('chroma confirmation requires an explicit checkbox and sends only selected assumptions',()=>{
 const app=frontend();app.context.sent=null;vm.runInContext('launch=input=>{sent=input}',app.context);
 app.node('#chroma-confirm-mode').checked=true;
 app.node('#reference-chroma').value='left';
 app.node('#compare').click();assert.equal(app.context.sent,null);
 app.node('#chroma-confirm').checked=true;
 app.node('#compare').click();
 assert.equal(app.context.sent.chromaConfirmed,true);
 assert.equal(app.context.sent.chromaAssumptions.reference,'left');
 assert.equal(app.context.sent.chromaAssumptions.candidate,undefined);
});
test('legacy trial summary remains available without invented per-frame measurements',()=>{
 const r=structuredClone(fixtures[3]);r.schema='MediaScope/0.1';delete r.rows[0].metrics.psnr.values;delete r.rows[0].metrics.ssim.values;
 assert.deepEqual(parseReport(JSON.stringify(r)),r);
 const app=frontend();app.context.input=r;vm.runInContext('render(input)',app.context);assert.match(app.node('#trial-frames').textContent,/未保存/);
});
test('GOP boundaries, AV1 events, audio bins and metadata survive restoration',async()=>{
 const r=structuredClone(fixtures[1]);
 r.coding={codec:'av1',counts:{encoded:1,hidden:0,showExisting:1,shown:2},events:[{id:0,kind:'KEY',referenceSlots:[]},{id:1,kind:'SHOW_EXISTING',showExisting:true,sourceEvent:0}],sequences:[{profile:0}],gops:[{index:0,start:0,end:1,count:2,label:'KEY'}]};
 r.tracks=[{index:1,type:'audio',codec:'pcm_s16le',bytes:100,bins:[{second:0,mbps:0.0008}]}];r.metadata={items:[{name:'HDR',sources:['stream'],occurrences:1,value:{evidence:'<原始值>'}}]};
 const saved=JSON.stringify(r),app=frontend();app.context.input=r;vm.runInContext('report=input;render(report)',app.context);const before=app.preview();app.clear();
 const input=app.node('#import-report');input.files=[{name:'av1.json',size:saved.length,text:async()=>saved}];await input.onchange({target:input});assert.equal(app.preview(),before);
 r.coding.gops[0].end=2;assert.throws(()=>parseReport(JSON.stringify(r)),/coding.gops/);
});
test('oversized files and active jobs cannot replace the current report',async()=>{
 const app=frontend();app.context.input=fixtures[0];vm.runInContext('report=input;render(report)',app.context);const before=app.preview(),input=app.node('#import-report');
 input.files=[{name:'large.json',size:256*1024*1024+1,text(){throw Error('should not read')}}];await input.onchange({target:input});assert.match(app.node('#task-message').textContent,/256 MiB/);assert.equal(app.preview(),before);
 vm.runInContext("current='active-job'",app.context);input.files=[{name:'report.json',size:1,text(){throw Error('should not read')}}];await input.onchange({target:input});assert.equal(app.preview(),before);
});
test('truncated per-frame metrics cannot silently produce a partial preview',()=>{
 const r=structuredClone(fixtures[2]);r.metrics.psnr.values.pop();assert.throws(()=>parseReport(JSON.stringify(r)),/values.length/);
});
test('tabs retain their own report DOM and controls without redrawing or replacing other previews',()=>{
 const app=frontend();app.context.media=fixtures[1];app.context.comparison=fixtures[2];app.context.trialReport=fixtures[3];
 vm.runInContext('render(media);render(comparison);render(trialReport)',app.context);
 const details=app.node('#trial-details'),html=details.innerHTML;
 app.node('#trial-frame-metric').value='ssim';
 app.clear();vm.runInContext("switchMode('inspect')",app.context);
 assert.equal(vm.runInContext('report.type',app.context),'analyze');
 assert.equal(app.node('#inspect-result').classList.contains('hidden'),false);
 assert.equal(app.node('#trial-result').classList.contains('hidden'),true);
 vm.runInContext("switchMode('compare')",app.context);assert.equal(vm.runInContext('report.type',app.context),'compare');
 vm.runInContext("switchMode('trial')",app.context);
 assert.equal(app.node('#trial-details'),details);assert.equal(details.innerHTML,html);assert.equal(app.node('#trial-frame-metric').value,'ssim');
 assert.equal(JSON.parse(app.preview()).plots.length,0);
 app.context.exported=null;vm.runInContext('download=(text)=>{exported=JSON.parse(text)}',app.context);app.node('#trial-export').click();assert.equal(app.context.exported.schema,portable.portableSchema);assert.equal(app.context.exported.results[0].report.type,'trial');
});
test('completion in another tab preserves the selected report and keeps it browsable during computation',async()=>{
 const app=frontend();app.context.media=fixtures[1];
 vm.runInContext("render(media);current='background-job';autoOpen='background-job';busy(true);switchMode('trial');switchMode('inspect')",app.context);
 const before=app.node('#inspect-details').innerHTML;
 assert.equal(app.node('#analyze').disabled,false);assert.equal(app.node('#inspect-result').classList.contains('hidden'),false);
 const requests=[];app.context.fetch=async url=>{requests.push(url);return {ok:true,json:async()=>url.endsWith('/report')?fixtures[3]:{queueRunning:false,jobs:[{id:'background-job',type:'trial',status:'done',message:'完成'}]}}};
 await vm.runInContext('poll()',app.context);
 assert.equal(vm.runInContext('activeMode',app.context),'inspect');assert.equal(vm.runInContext('report.type',app.context),'analyze');assert.equal(app.node('#inspect-details').innerHTML,before);
 assert.equal(app.node('#trial-result').classList.contains('hidden'),true);assert.ok(app.node('#trial-details').innerHTML.includes('逐帧质量叠加'));
 assert.equal(requests.length,2);vm.runInContext("switchMode('trial')",app.context);assert.equal(vm.runInContext('report.type',app.context),'trial');
});
test('large trial sample tables start collapsed while small tables stay expanded',()=>{
 const large=structuredClone(fixtures[3]);large.rows=Array.from({length:13},(_,i)=>({...structuredClone(large.rows[0]),id:'row-'+i,crf:i}));
 const app=frontend();app.context.large=large;vm.runInContext('render(large)',app.context);
 assert.match(app.node('#trial-details').innerHTML,/<details id="trial-samples" >/);
 assert.match(app.node('#trial-details').innerHTML,/查看 13 个实测点/);
 const small=frontend();small.context.small=fixtures[3];vm.runInContext('render(small)',small.context);
 assert.match(small.node('#trial-details').innerHTML,/<details id="trial-samples" open>/);
});

test('structured task progress shows exact counts and refuses to invent a percentage',()=>{
 const app=frontend();app.context.progress={stage:'完整扫描视频帧',detail:'已读取 1,200 帧',phaseIndex:2,phaseCount:4,completed:1200,total:null,unit:'帧',subtasks:{}};
 vm.runInContext("message(progress.detail,false,progress,'2026-01-01T00:00:00.000Z','running')",app.context);
 assert.equal(app.node('#task-stage').textContent,'完整扫描视频帧');assert.equal(app.node('#task-phase').textContent,'阶段 2 / 4');assert.match(app.node('#task-count').textContent,/1,200.*帧/);assert.equal(app.node('#task-percent').textContent,'总量待核验');assert.equal(app.node('#task-progress-track').classList.contains('indeterminate'),true);
 app.context.progress={...app.context.progress,completed:1200,total:2400};vm.runInContext("message(progress.detail,false,progress,'2026-01-01T00:00:00.000Z','running')",app.context);
 assert.equal(app.node('#task-percent').textContent,'50%');assert.equal(app.node('#task-progress-bar').style.width,'50%');assert.equal(app.node('#task-progress-track').classList.contains('indeterminate'),false);
});

test('queue controls capture analysis and trial settings without requiring a preliminary probe',()=>{
 const app=frontend();vm.runInContext('launch=input=>{sent=input}',app.context);
 app.node('#file').value='D:\\next.mp4';app.node('#complexity').checked=true;app.node('#siti-workers').value='4';
 app.node('#enqueue-analyze').click();assert.equal(app.context.sent.type,'analyze');assert.equal(app.context.sent.enqueue,true);assert.equal(app.context.sent.stream,null);assert.equal(app.context.sent.complexity,true);assert.equal(app.context.sent.sitiWorkers,'4');
 app.node('#file').value='D:\\later.mp4';assert.equal(app.context.sent.file,'D:\\next.mp4');
 app.node('#trial-file').value='D:\\trial.mp4';app.node('#enqueue-trial').click();assert.equal(app.context.sent.type,'trial');assert.equal(app.context.sent.enqueue,true);assert.equal(app.context.sent.file,'D:\\trial.mp4');
});
test('background media report does not overwrite the next queued task form',()=>{
 const app=frontend();app.context.input=fixtures[1];app.node('#file').value='D:\\new-choice.mp4';
 vm.runInContext('render(input,false)',app.context);assert.equal(app.node('#file').value,'D:\\new-choice.mp4');assert.equal(app.node('#analyze').disabled,true);
});
test('paused queue stays actionable and cancelled work has a visible retry',async()=>{
 const app=frontend(),jobs=[
  {id:'one',type:'analyze',file:'D:\\Videos\\first.mov',description:'视频轨道 自动',status:'cancelled',message:'已取消'},
  {id:'two',type:'trial',file:'D:\\Videos\\next.mov',description:'0–5 秒',status:'queued',message:'等待运行'}
 ];
 app.context.fetch=async()=>({ok:true,json:async()=>({queueRunning:false,jobs})});
 await vm.runInContext('poll()',app.context);
 assert.equal(app.node('#queue-start').disabled,false);
 assert.equal(app.node('#queue-pause').disabled,true);
 assert.match(app.node('#queue-list').innerHTML,/next\.mov/);
 assert.doesNotMatch(app.node('#queue-list').innerHTML,/first\.mov/);
 assert.match(app.node('#queue-history-list').innerHTML,/first\.mov.*重新排队/);
 assert.match(app.node('#queue-history-list').innerHTML,/data-action="retry"/);
});

test('a result table imports multiple reports of the same mode without changing their measurements',async()=>{
 const app=frontend(),a=structuredClone(fixtures[1]),b=structuredClone(fixtures[1]);b.file='D:\\second.mp4';b.frames[0].bytes=999;
 const saved=portable.makePortable({results:[{entryId:'a',report:a},{entryId:'b',report:b}]});
 app.context.fetch=async()=>({ok:true,json:async()=>({queueRunning:false,jobs:[]})});
 const input=app.node('#import-report');input.files=[{name:'MediaScope-queue.json',size:100,text:async()=>JSON.stringify(saved)}];await input.onchange({target:input});
 assert.match(app.node('#task-message').textContent,/2 份结果/);
 const list=app.node('#result-list').innerHTML,ids=[...list.matchAll(/data-result-open="([^"]+)"/g)].map(x=>x[1]);assert.equal(ids.length,2);
 for(const [id,expected]of [[ids[0],a],[ids[1],b]]){
  await app.node('#result-list').onclick({target:{closest(){return {dataset:{resultOpen:id}}}}});
  assert.equal(vm.runInContext('JSON.stringify(report)',app.context),JSON.stringify(expected));
 }
});

test('a damaged unified file is rejected without replacing the visible report',async()=>{
 const app=frontend();app.context.currentReport=fixtures[1];vm.runInContext('render(currentReport)',app.context);const before=app.preview();
 const saved={...portable.makePortable({results:[{entryId:'a',report:fixtures[1]}]}),plans:undefined};
 const input=app.node('#import-report');input.files=[{name:'wrong.json',size:100,text:async()=>JSON.stringify(saved)}];await input.onchange({target:input});
 assert.match(app.node('#task-message').textContent,/plans/);assert.equal(app.preview(),before);
});

test('result export keeps every original report and the bundle keeps results separate from plans',async()=>{
 const app=frontend();app.context.fetch=async url=>({ok:true,json:async()=>url.endsWith('/plans')?portable.makePortable({plans:[{entryId:'waiting',input:{type:'inspect',file:'D:\\wait.mp4'}}]}):{queueRunning:false,jobs:[]}});
 const saved=portable.makePortable({results:[{entryId:'a',report:fixtures[1]},{entryId:'b',report:fixtures[2]}]});
 const input=app.node('#import-report');input.files=[{name:'results.json',size:100,text:async()=>JSON.stringify(saved)}];await input.onchange({target:input});
 app.context.exported=null;vm.runInContext('download=(text,name)=>{exported={value:JSON.parse(text),name}}',app.context);
 app.node('#export-plan-scope').value='all';await app.node('#export-portable').onclick();
 const exported=app.context.exported;assert.match(exported.name,/^MediaScope-bundle-\d{8}-\d{6}\.json$/);
 assert.equal(exported.value.schema,portable.portableSchema);assert.equal(JSON.stringify(exported.value.results.map(x=>x.report)),JSON.stringify([fixtures[1],fixtures[2]]));
 assert.equal(JSON.stringify(exported.value.plans),JSON.stringify([{entryId:'waiting',input:{type:'inspect',file:'D:\\wait.mp4'}}]));
});

test('bundle import sends only plans to the queue and keeps reports in the result list',async()=>{
 const app=frontend(),calls=[];app.context.fetch=async(url,options)=>{calls.push({url,body:options?.body});return {ok:true,json:async()=>url.endsWith('/plans/import')?{imported:1,ids:['new-job'],queueRunning:false}:{queueRunning:false,jobs:[]}}};
 const value=portable.makePortable({results:[{entryId:'finished',report:fixtures[3]}],plans:[{entryId:'waiting',input:{type:'inspect',file:'D:\\wait.mp4'}}]});
 const input=app.node('#import-report');input.files=[{name:'bundle.json',size:100,text:async()=>JSON.stringify(value)}];await input.onchange({target:input});
 const submission=calls.find(x=>x.url.endsWith('/plans/import'));assert.ok(submission);
 const body=JSON.parse(submission.body);assert.equal(body.plans.length,1);assert.equal(body.plans[0].input.file,'D:\\wait.mp4');assert.equal(body.results,undefined);
 assert.equal((app.node('#result-list').innerHTML.match(/data-result-open=/g)||[]).length,1);
 assert.equal(vm.runInContext('report',app.context),null);
});

test('import choices apply only selected content without submitting unchecked plans',async()=>{
 const app=frontend(),calls=[];app.context.fetch=async(url,options)=>{calls.push({url,body:options?.body});return {ok:true,json:async()=>({queueRunning:false,jobs:[]})}};
 const value=portable.makePortable({results:[{entryId:'finished',report:fixtures[1]}],plans:[{entryId:'waiting',input:{type:'inspect',file:'D:\\wait.mp4'}}]});
 app.node('#import-plans').checked=false;app.node('#import-plans').onchange();
 const input=app.node('#import-report');input.files=[{name:'combined.json',size:100,text:async()=>JSON.stringify(value)}];await input.onchange({target:input});
 assert.equal(calls.some(x=>x.url.endsWith('/plans/import')),false);
 assert.equal((app.node('#result-list').innerHTML.match(/data-result-open=/g)||[]).length,1);
 assert.equal(vm.runInContext('report.type',app.context),'analyze');
 assert.match(app.node('#task-message').textContent,/1 份结果、0 项计划/);
});

test('plan-only import and export use the unified schema without touching results',async()=>{
 const app=frontend(),calls=[],plans=[{entryId:'waiting',input:{type:'inspect',file:'D:\\wait.mp4'}}];
 app.context.fetch=async(url,options)=>{calls.push({url,body:options?.body});return {ok:true,json:async()=>url.endsWith('/plans')?portable.makePortable({plans}):url.endsWith('/plans/import')?{imported:1,ids:['new-job'],queueRunning:false}:{queueRunning:false,jobs:[]}}};
 app.node('#import-results').checked=false;app.node('#import-results').onchange();
 const input=app.node('#import-report');input.files=[{name:'plan.json',size:100,text:async()=>JSON.stringify(portable.makePortable({results:[{entryId:'ignored',report:fixtures[1]}],plans}))}];await input.onchange({target:input});
 assert.equal(JSON.parse(calls.find(x=>x.url.endsWith('/plans/import')).body).plans.length,1);
 assert.equal((app.node('#result-list').innerHTML.match(/data-result-open=/g)||[]).length,0);
 app.context.exported=null;vm.runInContext('download=(text,name)=>{exported={value:JSON.parse(text),name}}',app.context);
 app.node('#export-result-scope').value='none';app.node('#export-plan-scope').value='all';await app.node('#export-portable').onclick();
 assert.equal(app.context.exported.value.schema,portable.portableSchema);
 assert.equal(app.context.exported.value.results.length,0);
 assert.equal(app.context.exported.value.plans.length,1);
 assert.match(app.context.exported.name,/^MediaScope-plan-\d{8}-\d{6}\.json$/);
});

test('current-report export uses the unified schema and preserves its report exactly',async()=>{
 const app=frontend();app.context.input=fixtures[2];vm.runInContext('render(input)',app.context);
 app.context.exported=null;vm.runInContext('download=(text,name)=>{exported={value:JSON.parse(text),name}}',app.context);
 app.node('#export-result-scope').value='current';await app.node('#export-portable').onclick();
 assert.equal(app.context.exported.value.schema,portable.portableSchema);
 assert.equal(JSON.stringify(app.context.exported.value.results[0].report),JSON.stringify(fixtures[2]));
 assert.equal(app.context.exported.value.plans.length,0);
 assert.match(app.context.exported.name,/^MediaScope-compare-.*\.json$/);
});

test('selected result and plan scopes independently include only checked rows',async()=>{
 const app=frontend(),plans=[{entryId:'waiting-1',input:{type:'inspect',file:'D:\\one.mp4'}},{entryId:'waiting-2',input:{type:'inspect',file:'D:\\two.mp4'}}];
 app.context.fetch=async url=>({ok:true,json:async()=>url.endsWith('/plans')?portable.makePortable({plans}):{queueRunning:false,jobs:[{id:'waiting-1',type:'inspect',file:'D:\\one.mp4',status:'queued'},{id:'waiting-2',type:'inspect',file:'D:\\two.mp4',status:'queued'}]}});
 const value=portable.makePortable({results:[{entryId:'a',report:fixtures[1]},{entryId:'b',report:fixtures[2]}]});
 const input=app.node('#import-report');input.files=[{name:'results.json',size:100,text:async()=>JSON.stringify(value)}];await input.onchange({target:input});
 const resultId=[...app.node('#result-list').innerHTML.matchAll(/data-result-select="([^"]+)"/g)][1][1];
 app.node('#result-list').onchange({target:{dataset:{resultSelect:resultId},checked:true}});
 app.node('#queue-list').onchange({target:{dataset:{planSelect:'waiting-2'},checked:true}});
 app.node('#export-result-scope').value='selected';app.node('#export-plan-scope').value='selected';
 app.context.exported=null;vm.runInContext('download=(text)=>{exported=JSON.parse(text)}',app.context);await app.node('#export-portable').onclick();
 assert.equal(app.context.exported.schema,portable.portableSchema);
 assert.equal(app.context.exported.results.length,1);
 assert.equal(JSON.stringify(app.context.exported.results[0].report),JSON.stringify(fixtures[2]));
 assert.equal(app.context.exported.plans.length,1);
 assert.equal(app.context.exported.plans[0].input.file,'D:\\two.mp4');
});
