import {MAX_ANALYSIS_FRAMES} from './analysis-limits.js';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const safeKey=k=>typeof k==='string'&&!['__proto__','constructor','prototype'].includes(k);
const fail=()=>{throw Error('0.4 明细表结构、数量、列或索引无效');};
const same=(a,b)=>a===b||object(a)&&object(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]))||Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));

// Only the explicit report paths below use tables. Raw evidence is never traversed.
export function encodeTable(rows,indexField=null){
  if(!Array.isArray(rows)||rows.length>MAX_ANALYSIS_FRAMES)fail();
  const fields=new Map();
  for(const [i,row] of rows.entries()){
    if(!object(row)||indexField&&row[indexField]!==i)fail();
    for(const [key,value]of Object.entries(row)){
      if(!safeKey(key)||value===undefined)fail();
      if(key===indexField)continue;
      const field=fields.get(key);
      if(!field)fields.set(key,{count:1,value,constant:true});
      else{field.count++;if(field.constant&&!same(value,field.value))field.constant=false;}
    }
  }
  const constants={},columns=[],sparse={};
  for(const [key,field]of fields){
    if(field.count!==rows.length)sparse[key]=[];
    else if(field.constant)constants[key]=field.value;
    else columns.push(key);
  }
  const sparseKeys=Object.keys(sparse),values=[];
  for(const [i,row]of rows.entries()){
    values.push(columns.map(key=>row[key]));
    for(const key of sparseKeys)if(Object.hasOwn(row,key))sparse[key].push([i,row[key]]);
  }
  return {count:rows.length,columns,rows:values,...(Object.keys(constants).length?{constants}:{}),...(sparseKeys.length?{sparse}:{})};
}

export function decodeTable(table,indexField=null,limit=MAX_ANALYSIS_FRAMES){
  if(!object(table)||Object.keys(table).some(k=>!['count','columns','rows','constants','sparse'].includes(k))||!Number.isSafeInteger(table.count)||table.count<0||table.count>limit||!Array.isArray(table.columns)||!Array.isArray(table.rows)||table.rows.length!==table.count)fail();
  const constants=table.constants??{},sparse=table.sparse??{};
  if(!object(constants)||!object(sparse)||table.constants===null||table.sparse===null)fail();
  const keys=[...table.columns,...Object.keys(constants),...Object.keys(sparse)];
  if(keys.some(k=>!safeKey(k)||k===indexField)||new Set(keys).size!==keys.length)fail();
  if(!table.count&&keys.length)fail();
  const rows=table.rows.map((values,i)=>{
    if(!Array.isArray(values)||values.length!==table.columns.length)fail();
    return {...structuredClone(constants),...(indexField?{[indexField]:i}:{}),...Object.fromEntries(table.columns.map((key,j)=>[key,values[j]]))};
  });
  for(const [key,pairs]of Object.entries(sparse)){
    if(!Array.isArray(pairs)||!pairs.length||pairs.length>=table.count)fail();
    let previous=-1;
    for(const pair of pairs){
      if(!Array.isArray(pair)||pair.length!==2||!Number.isSafeInteger(pair[0])||pair[0]<=previous||pair[0]>=table.count)fail();
      previous=pair[0];rows[pair[0]][key]=pair[1];
    }
  }
  return rows;
}

function structuralVersion(value,encode){
  if(!object(value))fail();
  const copy={...value};
  if(encode){if(copy.version!==1)fail();delete copy.version;}
  else{if(Object.hasOwn(copy,'version'))fail();copy.version=1;}
  return copy;
}

function transformReport(report,encode){
  if(!object(report)||Object.hasOwn(report,'schema')||Object.hasOwn(report,'formatVersion'))throw Error('0.4 报告不使用嵌套格式版本');
  const r={...report};
  const table=(parent,key,indexField=null,limit=MAX_ANALYSIS_FRAMES)=>{
    if(Object.hasOwn(parent,key)){
      if(encode&&(!Array.isArray(parent[key])||parent[key].length>limit))fail();
      parent[key]=encode?encodeTable(parent[key],indexField):decodeTable(parent[key],indexField,limit);
    }
  };
  table(r,'frames');
  if(r.content){
    if(!object(r.content))fail();
    r.content={...r.content};table(r.content,'points','frame');table(r.content,'scenes','index',2048);
    if(r.content.sceneAnalysis)r.content.sceneAnalysis=structuralVersion(r.content.sceneAnalysis,encode);
  }
  if(r.coding){
    if(!object(r.coding))fail();
    r.coding={...r.coding};table(r.coding,'packets','index',500000);table(r.coding,'events','id',750000);table(r.coding,'gops','index');
  }
  if(r.tracks){
    if(!Array.isArray(r.tracks))fail();
    r.tracks=r.tracks.map(track=>{
      if(!object(track))fail();
      const t={...track};table(t,'bins',null,1000001);
      if(t.bitrateCurve){t.bitrateCurve=structuralVersion(t.bitrateCurve,encode);table(t.bitrateCurve,'bins',null,1000000);}
      if(t.packetDistribution)t.packetDistribution=structuralVersion(t.packetDistribution,encode);
      return t;
    });
  }
  if(r.type==='analyze' && (r.analysisTargets?.frames!==false || r.analysisTargets?.bitrate!==false)){
    const selected=report.tracks?.filter(t=>t.index===r.stream);
    if(selected?.length!==1)throw Error('0.4 所选视频轨道索引无效');
    if(encode){
      if(!same(report.packets,selected[0]))throw Error('所选视频轨道的重复记录不一致');
      delete r.packets;
    }else{
      if(Object.hasOwn(r,'packets'))throw Error('0.4 不重复保存所选视频轨道');
      r.packets=r.tracks.find(t=>t.index===r.stream);
    }
  }
  return r;
}

export const encodeReport=report=>transformReport(report,true);
export const decodeReport=report=>transformReport(report,false);
