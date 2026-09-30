import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {makePortable,parsePortable,portableSchema,legacyPortableSchemas} from '../public/portable.js';
import path from 'node:path';
import {makeMedia} from './helpers/real-media.mjs';
import {startServer} from './helpers/server.mjs';

let report,results,plans,app;
before(async()=>{
 const root=path.resolve('test-work/portable'),media=await makeMedia(path.join(root,'media'));
 app=await startServer(path.join(root,'reports'));
 report=await app.request('probe','POST',{file:media.source});
 results=[{entryId:'result-1',report}];plans=[{entryId:'plan-1',input:{type:'analyze',file:media.source,stream:null,complexity:true,sitiWorkers:'auto'}}];
});
after(async()=>{await app?.stop()});

test('single report, result table, plan and combined content share one schema and round trip exactly',()=>{
 for(const content of [{results},{plans},{results,plans}]){
  const value=makePortable(content),restored=parsePortable('\uFEFF'+JSON.stringify(value));
  assert.deepEqual(restored,value);
  assert.equal(value.schema,portableSchema);
  assert.deepEqual(value.results,content.results??[]);
  assert.deepEqual(value.plans,content.plans??[]);
  assert.equal(value.kind,undefined);
 }
});

test('old bare reports and three purpose-specific files import into the same structure',()=>{
 assert.deepEqual(parsePortable(JSON.stringify(report)).results,[{entryId:'legacy-report',report}]);
 for(const [kind,content] of Object.entries({results:{results},plan:{plans},bundle:{results,plans}})){
  const old={schema:legacyPortableSchemas[kind],kind,createdAt:'2026-09-27T15:30:45.000Z',...content};
  const restored=parsePortable(JSON.stringify(old));
  assert.equal(restored.schema,portableSchema);
  assert.equal(restored.createdAt,old.createdAt);
  assert.deepEqual(restored.results,content.results??[]);
  assert.deepEqual(restored.plans,content.plans??[]);
 }
});

test('earlier unified exports remain importable without changing nested reports',()=>{
 const earlier={...makePortable({results,plans}),schema:'MediaScopePortable/1'};
 const restored=parsePortable(JSON.stringify(earlier));
 assert.equal(restored.schema,portableSchema);
 assert.equal(restored.createdAt,earlier.createdAt);
 assert.deepEqual(restored.results,results);
 assert.deepEqual(restored.plans,plans);
});

test('rejects unknown versions, malformed tables, duplicate identifiers and damaged reports',()=>{
 const value=makePortable({results,plans});
 for(const broken of [
  {...value,schema:'MediaScope/0.4'},
  {...value,kind:'plan'},
  {...value,plans:undefined},
  {...value,results:[...results,...results]},
  {...value,results:[{entryId:'result-1',report:{...report,raw:{}}}]},
  {...value,plans:[{entryId:'plan-1',input:{type:'unknown'}}]},
  {schema:legacyPortableSchemas.results,kind:'plan',createdAt:value.createdAt,results}
 ])assert.throws(()=>parsePortable(JSON.stringify(broken)));
});
