import original from 'node:assert/strict';
import {caseContext} from './case-catalog.mjs';

const methods=new Map();
function count(name){const active=caseContext.getStore();if(active){active.assertions=(active.assertions??0)+1;active.assertionMethods??={};active.assertionMethods[name]=(active.assertionMethods[name]??0)+1;}}
export default new Proxy(original,{
 apply(target,thisArg,args){count('ok');return Reflect.apply(target,thisArg,args);},
 get(target,name){
  const value=Reflect.get(target,name);
  if(typeof value!=='function'||['AssertionError','CallTracker'].includes(name))return value;
  if(!methods.has(name))methods.set(name,function(...args){count(String(name));return Reflect.apply(value,target,args);});
  return methods.get(name);
 }
});
