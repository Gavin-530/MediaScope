import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {makePortable,parsePortable,portableFormat,portableVersion,portableFilename} from '../public/portable.js';
import {encodeTable,decodeTable} from '../public/report-codec.js';
import {makeMedia} from './helpers/real-media.mjs';
import {startServer} from './helpers/server.mjs';
import {writeReportFile} from '../scripts/runtime-data.mjs';

const applicationVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
let report,results,plans,app;
before(async()=>{
  const root=path.resolve('.build/testing-work/portable'),media=await makeMedia(path.join(root,'media'));
  app=await startServer(path.join(root,'reports'));
  report=await app.request('probe','POST',{file:media.source});
  results=[{entryId:'result-1',report}];plans=[{entryId:'plan-1',input:{type:'analyze',file:media.source,stream:null,complexity:true,sitiWorkers:'auto'}}];
});
after(async()=>{await app?.stop();});

test('[portable-04] single report, result table, plan and combined content share 0.4 and round trip exactly',()=>{
  for(const content of [{results},{plans},{results,plans}]){
    const value=makePortable({...content,applicationVersion}),restored=parsePortable('\uFEFF'+JSON.stringify(value));
    assert.equal(value.format,portableFormat);assert.equal(value.formatVersion,portableVersion);
    assert.deepEqual(restored.results,content.results??[]);assert.deepEqual(restored.plans,content.plans??[]);
    assert.equal(value.schema,undefined);assert.equal(value.kind,undefined);assert.equal(value.results[0]?.report.schema,undefined);
    assert.match(value.createdAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(value.producer.applicationVersion,applicationVersion);
  }
});

test('[portable-04] old files and unknown versions are rejected rather than silently normalized',()=>{
  const value=makePortable({results,applicationVersion});
  for(const broken of [report,...['MediaScope/0.1','MediaScope/0.2','MediaScope/0.3','MediaScopePortable/1','MediaScopeResults/1','MediaScopePlan/1','MediaScopeBundle/1'].map(schema=>({...value,schema})),{...value,formatVersion:'0.5'},{...value,formatVersion:0.4}])assert.throws(()=>parsePortable(JSON.stringify(broken)),/格式|版本/);
});

test('[portable-04] changed writer preserves original report provenance, calculation times and raw evidence',()=>{
  const measured={...report,createdAt:'2026-09-01T01:02:03.123456Z',producer:{applicationVersion:'measurement-build'}};
  const value=makePortable({results:[{entryId:'original',report:measured}],applicationVersion:'export-build',createdAt:'2026-10-17T01:02:03Z'});
  const restored=parsePortable(JSON.stringify(value));assert.deepEqual(restored.results[0].report,measured);assert.equal(restored.producer.applicationVersion,'export-build');
});

test('[portable-04] specified table fixture preserves constants, sparse absence/null, large integer strings and source precision',()=>{
  // Protocol fixture only; these are not claimed media measurements.
  const rows=Array.from({length:40},(_,i)=>({id:i,t:i/3,tick:'900719925474099312345',value:i%2?0:0.12345678901234568,flags:[1,2],...(i===2?{optional:null}:i===5?{optional:'source\ntext'}:{})}));
  const table=encodeTable(rows,'id');assert.deepEqual(decodeTable(JSON.parse(JSON.stringify(table)),'id'),rows);
  assert.equal(table.constants.tick,rows[0].tick);assert.equal(table.columns.includes('id'),false);assert.equal(table.sparse.optional.length,2);
  const restored=decodeTable(table,'id');assert.equal(Object.hasOwn(restored[0],'optional'),false);assert.equal(restored[2].optional,null);
});

test('[portable-04] table validation rejects wrong columns, counts, overlapping fields and unsafe or out-of-order sparse indices',()=>{
  const table=encodeTable([{i:0,n:1},{i:1,n:2,x:null},{i:2,n:3}],'i');
  for(const mutate of [t=>t.count++,t=>t.rows.pop(),t=>t.rows[0].push(0),t=>t.columns.push('n'),t=>t.constants={n:0},t=>t.constants={i:0},t=>t.extra=1,t=>t.sparse.x=[[3,null]],t=>t.sparse.x=[[1,null],[1,2]],t=>t.sparse.x=[[-1,null]],t=>t.sparse.x=[[1,null],[0,2]],t=>t.sparse=JSON.parse('{"__proto__":[[1,null]]}')]){
    const broken=structuredClone(table);mutate(broken);assert.throws(()=>decodeTable(broken,'i'));
  }
  assert.throws(()=>decodeTable({count:2000001,columns:[],rows:[]}));assert.equal({}.polluted,undefined);
  assert.throws(()=>decodeTable({count:0,columns:['hidden'],rows:[]}));
});

test('[portable-04] duplicate entries, nested versions, changed timing and malformed reports are rejected',()=>{
  const value=makePortable({results,plans,applicationVersion});
  for(const broken of [{...value,kind:'plan'},{...value,plans:undefined},{...value,producer:{}},{...value,createdAt:'2026-02-31T00:00:00Z'},{...value,results:[...value.results,...value.results]},{...value,results:[{entryId:'bad',report:{...value.results[0].report,schema:'MediaScope/0.2'}}]},{...value,timing:{}},{...value,results:[],plans:[]},{...value,plans:[{entryId:'bad',input:{type:'unknown'}}]}])assert.throws(()=>parsePortable(JSON.stringify(broken)));
  const reordered={...value,timing:Object.fromEntries(Object.entries(value.timing).reverse())};assert.deepEqual(parsePortable(JSON.stringify(reordered)).results,results);
});

test('[portable-04] cancelled report saving publishes no partial file; successful saving is compact and lossless',async()=>{
  const root=path.resolve('.build/testing-work/portable');await mkdir(root,{recursive:true});const folder=await mkdtemp(path.join(root,'atomic-')),file=path.join(folder,'report.json');
  const value=makePortable({results,applicationVersion}),controller=new AbortController();controller.abort();
  await assert.rejects(writeReportFile(file,value,controller.signal));assert.deepEqual(await readdir(folder),[]);
  await writeReportFile(file,value);assert.deepEqual((await readdir(folder)),['report.json']);const saved=await readFile(file,'utf8');
  assert.equal(saved,JSON.stringify(value));assert.deepEqual(parsePortable(saved).results,results);
});

test('[portable-04] filenames have exactly four templates, actual count controls selection and only source name/time vary',()=>{
  const time='20261017T123456Z',single=report=>[{report}],plan=input=>[{input}];
  for(const type of ['inspect','analyze','trial']){
    const r={type,file:'D:\\private\\素材.mkv'},expected=`MediaScope-${type==='trial'?'trial':'analyze'}-素材.mkv-${time}.json`;
    assert.equal(portableFilename(single(r),[],time),expected);assert.equal(portableFilename([],plan(r),time),expected);
  }
  const compare={type:'compare',reference:{file:'private-reference'},candidate:{file:'private-candidate'}};
  assert.equal(portableFilename(single(compare),[],time),`MediaScope-compare-${time}.json`);
  assert.equal(portableFilename([],plan({type:'compare',reference:'a',candidate:'b'}),time),`MediaScope-compare-${time}.json`);
  for(const [r,p]of [[single(report),plans],[results.concat(results),[]],[[],plans.concat(plans)]])assert.equal(portableFilename(r,p,time),`MediaScope-queue-${time}.json`);
  assert.equal(portableFilename(single({type:'trial',source:{file:'D:/media/clip.mp4'}}),[],time),`MediaScope-trial-clip.mp4-${time}.json`);
  assert.throws(()=>portableFilename([],[],time));
  assert.match(portableFilename(single({type:'analyze',file:'D:/'+('x'.repeat(200))+'.mkv'}),[],time),/\.mkv-20261017T123456Z\.json$/);
});
