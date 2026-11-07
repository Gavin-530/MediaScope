import nativeTest from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {caseCatalog,caseContext,project,selectionPath} from './case-catalog.mjs';
import {recordObservation} from './observations.mjs';

const chosen=process.env.MEDIASCOPE_TEST_SELECTION?new Set(JSON.parse(fs.readFileSync(selectionPath(process.env.MEDIASCOPE_TEST_SELECTION),'utf8')).caseIds):null;
export function selectedCases(url){const file=path.relative(project,fileURLToPath(url)).replaceAll('\\','/');return caseCatalog.cases.filter(c=>c.file===file&&(!chosen||chosen.has(c.id)));}
export const selectedNeedsMedia=url=>selectedCases(url).some(c=>c.requiresMedia!==false);
export function projectTest(url){
  const file=path.relative(project,fileURLToPath(url)).replaceAll('\\','/'),registered=new Set();
  return function test(name,...args){
    const entry=caseCatalog.cases.find(c=>c.file===file&&c.name===name);
    if(!entry)throw Error('TEST_INFRA: unregistered formal case: '+file+' / '+name);
    if(registered.has(entry.id))throw Error('TEST_INFRA: duplicate case registration: '+entry.id);registered.add(entry.id);
    if(chosen&&!chosen.has(entry.id))return;
    const callback=args.at(-1);
    if(typeof callback==='function')args[args.length-1]=async function(context){
      const active={id:entry.id,file,assertions:0,assertionMethods:{},observations:0};
      return caseContext.run(active,async()=>{
        let returned=false;
        try{const result=await callback(context);returned=true;return result;}
        finally{
          context.after(()=>caseContext.run(active,async()=>{
            await recordObservation('case-checks',{callbackReturned:returned,assertions:active.assertions,assertionMethods:active.assertionMethods,productionObservations:active.observations});
            process.stdout.write('MEDIASCOPE_CHECKS '+JSON.stringify({caseId:entry.id,file,assertions:active.assertions,productionObservations:Math.max(0,active.observations-1)})+'\n');
            if(returned&&!active.assertions&&process.env.MEDIASCOPE_TEST_SOURCE_KIND!=='git')throw Error('TEST_INFRA: case executed no checked assertions: '+entry.id);
          }));
        }
      });
    };
    return nativeTest('['+entry.id+'] '+name,...args);
  };
}
