import {isDeepStrictEqual} from 'node:util';
import {gzipSync,gunzipSync} from 'node:zlib';

const zip=value=>gzipSync(Buffer.from(JSON.stringify(value)+'\n'));
const isReport=entry=>['api.response','browser.api'].includes(entry.kind)&&
  typeof entry.data?.url==='string'&&entry.data.url.endsWith('/report')&&entry.data.result&&typeof entry.data.result==='object';

export function encodeMeasurements(source){
  const serialized=JSON.stringify(source);
  const plain=gzipSync(Buffer.from(serialized+'\n'));
  source=JSON.parse(serialized);
  if(source.schema!==2)return plain;
  const entries=structuredClone(source.entries);
  const sharedValues={},references=[],values=new Map(),counts=new Map();
  function detach(scope,parent,key,path,type){
    const serialized=type+':'+JSON.stringify(parent[key]);
    let id=values.get(serialized);
    if(id===undefined){
      id=type+'-'+values.size;
      values.set(serialized,id);
      sharedValues[id]=parent[key];
    }
    references.push({...scope,path,value:id});
    delete parent[key];
  }
  function extractPixels(scope,value,path=[]){
    if(!value||typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)){
      const next=[...path,Array.isArray(value)?Number(key):key];
      if(key==='pixel_formats'&&Array.isArray(child)&&child.length>40)detach(scope,value,key,next,'pixels');
      else extractPixels(scope,child,next);
    }
  }
  for(const entry of entries){
    if(!isReport(entry))continue;
    const key=JSON.stringify(entry.data.result);
    counts.set(key,(counts.get(key)??0)+1);
  }
  for(const [index,entry] of entries.entries()){
    if(isReport(entry)&&counts.get(JSON.stringify(entry.data.result))>1){
      detach({entry:index},entry.data,'result',['data','result'],'report');
    }
    extractPixels({entry:index},entry);
  }
  for(const [id,value] of Object.entries(sharedValues)){
    if(id.startsWith('report-'))extractPixels({shared:id},value);
  }
  if(!references.length)return plain;
  const packed={schema:3,entries,sharedValues,references};
  const compressed=zip(packed);
  if(compressed.length>=plain.length)return plain;
  if(!isDeepStrictEqual(decodeMeasurements(compressed),source))throw Error('Measurement compaction changed recorded values');
  return compressed;
}

export function decodeMeasurements(bytes){
  const document=JSON.parse(gunzipSync(bytes));
  if(!Array.isArray(document?.entries))throw Error('Invalid measurement entries');
  if(document.schema===1||document.schema===2)return document;
  if(document.schema!==3||!document.sharedValues||typeof document.sharedValues!=='object'||
    Array.isArray(document.sharedValues)||!Array.isArray(document.references))throw Error('Unsupported measurement format');

  const {entries,sharedValues,references}=document;
  function restore(target,reference){
    const {path,value}=reference;
    if(!target||!Array.isArray(path)||!path.length||typeof value!=='string'||
        !Object.hasOwn(sharedValues,value))throw Error('Invalid measurement reference');
    let parent=target;
    for(const key of path.slice(0,-1)){
      if(!parent||typeof parent!=='object'||!validKey(parent,key)||!Object.hasOwn(parent,key)){
        throw Error('Invalid measurement reference path');
      }
      parent=parent[key];
    }
    const key=path.at(-1);
    if(!parent||typeof parent!=='object'||Array.isArray(parent)||!validKey(parent,key)||Object.hasOwn(parent,key)){
      throw Error('Invalid or overlapping measurement reference');
    }
    Object.defineProperty(parent,key,{value:structuredClone(sharedValues[value]),enumerable:true,writable:true,configurable:true});
  }
  function validKey(parent,key){
    return Array.isArray(parent)?Number.isInteger(key)&&key>=0:typeof key==='string';
  }
  for(const reference of references){
    if(!reference||typeof reference!=='object'||Array.isArray(reference))throw Error('Invalid measurement reference');
    if(Object.hasOwn(reference,'shared')){
      if(Object.hasOwn(reference,'entry')||typeof reference.shared!=='string'||!reference.shared.startsWith('report-')||
        !Object.hasOwn(sharedValues,reference.shared)||typeof reference.value!=='string'||!reference.value.startsWith('pixels-')){
        throw Error('Invalid nested measurement reference');
      }
      restore(sharedValues[reference.shared],reference);
    }
  }
  for(const reference of references){
    if(Object.hasOwn(reference,'shared'))continue;
    if(!Number.isInteger(reference.entry)||reference.entry<0||reference.entry>=entries.length){
      throw Error('Invalid measurement reference entry');
    }
    restore(entries[reference.entry],reference);
  }
  return {schema:2,entries};
}
