import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makePortable,parsePortable,portableSchemas} from '../public/portable.js';

const report={schema:'MediaScope/0.1',type:'inspect',file:'D:\\素材\\源.mp4',raw:{format:{duration:'1'},streams:[{index:0,codec_type:'video'}]},unknownEvidence:{precise:0.12345678901234568}};
const input={type:'analyze',file:'D:\\素材\\源.mp4',stream:null,complexity:true,sitiWorkers:'auto'};
const results=[{entryId:'result-1',report}],plans=[{entryId:'plan-1',input}];

test('results, plans and bundle round trip independently without changing report evidence or task settings',()=>{
 for(const kind of ['results','plan','bundle']){
  const value=makePortable(kind,{results,plans}),restored=parsePortable('\uFEFF'+JSON.stringify(value));
  assert.deepEqual(restored,value);
  assert.equal(value.schema,portableSchemas[kind]);
  assert.deepEqual(value.results,kind==='plan'?undefined:results);
  assert.deepEqual(value.plans,kind==='results'?undefined:plans);
 }
});

test('rejects unknown versions, mixed fields, duplicate identifiers and one damaged report',()=>{
 const value=makePortable('bundle',{results,plans});
 for(const broken of [
  {...value,schema:'MediaScopeBundle/99'},
  {...value,kind:'plan'},
  {...value,results:[...results,...results]},
  {...value,results:[{entryId:'result-1',report:{...report,raw:{}}}]},
  {...value,plans:[{entryId:'plan-1',input:{type:'unknown'}}]},
  {...makePortable('results',{results}),plans:[]}
 ])assert.throws(()=>parsePortable(JSON.stringify(broken)));
});
