import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseReport} from '../public/report.js';
import * as trial from '../public/trial-model.js';

const base={schema:'MediaScope/0.2',file:'D:\\已移动\\源.mp4',size:12345,raw:{format:{duration:'1.25'},streams:[{index:0,codec_type:'video',codec_name:'h264',width:16,height:16}]},commands:[{args:['原始参数']}],unknownEvidence:{precise:0.12345678901234568}};
const metric={pooled:'Infinity',values:['Infinity',42.12345678901234,null],worst:[]};
const fixtures=[
 {...base,type:'inspect'},
 {...base,type:'analyze',frames:[{t:0,bytes:100,type:'I',key:true},{t:0.04,bytes:20,type:'P',key:false}],summary:{nonIncreasing:0},packets:{bytes:120,bins:[{second:0,mbps:0.00096}]},content:{available:true,si:{mean:1},points:[{t:0,si:1,ti:0}]}},
 {schema:base.schema,type:'compare',reference:base,candidate:base,alignment:{frames:3},metrics:{psnr:metric,ssim:{pooled:1,values:[1,0.99,1]}}},
 {schema:base.schema,type:'trial',source:base,experiment:{start:0,duration:1,actualFrames:3,retainedFiles:[]},rows:[{crf:20,videoBytes:321,encodeSeconds:1.123456789,metrics:{psnr:metric,ssim:{pooled:1,values:[1,1,1]}}}]}
];
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/api\('status'\)[\s\S]*$/,'');
function frontend(){
 const nodes=new Map(),plots=[];
 const classList=()=>{const values=new Set();return {add:v=>values.add(v),remove:v=>values.delete(v),contains:v=>values.has(v),toggle(v,on){if(on??!values.has(v))values.add(v);else values.delete(v)}}};
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:({'#rd-axis':'videoKiB','#rd-metric':'psnr','#trial-row':'0','#trial-frame-metric':'psnr','#trial-crfs':'20'})[id]??'',content:'token',innerHTML:'',textContent:'',classList:classList(),addEventListener(){},click(){this.onclick?.()}});return nodes.get(id)};
 const tabs=['inspect','compare','trial'].map(mode=>Object.assign(node('.tab-'+mode),{dataset:{mode}}));
 const document={querySelector:node,querySelectorAll:s=>s==='.tab'?tabs:[]};
 const chart=(host,data,options)=>{plots.push({id:host.id,data,options});return {dispose(){},setRange(){},select(){}}};
 const context=vm.createContext({document,...trial,parseReport,plot:chart,gopOverview:chart,console,setTimeout,fetch(){throw Error('导入不应访问网络')}});
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
 app.context.exported=null;vm.runInContext('download=(text)=>{exported=JSON.parse(text)}',app.context);app.node('#trial-export').click();assert.equal(app.context.exported.type,'trial');
});
test('completion in another tab preserves the selected report and keeps it browsable during computation',async()=>{
 const app=frontend();app.context.media=fixtures[1];
 vm.runInContext("render(media);current='background-job';busy(true);switchMode('trial');switchMode('inspect')",app.context);
 const before=app.node('#inspect-details').innerHTML;
 assert.equal(app.node('#analyze').disabled,true);assert.equal(app.node('#inspect-result').classList.contains('hidden'),false);
 const requests=[];app.context.fetch=async url=>{requests.push(url);return {ok:true,json:async()=>url.endsWith('/report')?fixtures[3]:{status:'done',message:'完成'}}};
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
