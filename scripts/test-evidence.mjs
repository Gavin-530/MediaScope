import {caseCatalog} from '../testing-tools/helpers/case-catalog.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {saveObservedMeasurements} from '../testing-tools/helpers/measurement-store.mjs';

// Explicit measurement locations, not a recursive extension-based archive of fixtures.
export function measurementFile(relative) {
  const name=path.posix.basename(relative),top=relative.split('/')[0];
  if(/^bitrate-validation-[A-Za-z0-9]{6}$/.test(top))return /\.json(?:\.gz)?$/.test(name);
  if(/^(psnr|ssim|vmaf)\.(log|json)$/.test(name)&&(!relative.includes('/')||['bitdepth','trial','trial-libx265','trial-libaom-av1'].includes(top)))return true;
  if(/^(metrics-equivalence|reference-cache|vfr-equivalence|structure-equivalence|siti-parallel|siti-gpu|siti-p910|bitrate-equivalence|vmaf-official|repeat-analysis)-[A-Za-z0-9]{6}$/.test(top))return name.endsWith('.json');
  if(['browser','server-reports','chroma-assumption','portable','report-validation'].includes(top))return name==='report.json'||/^theme-.*\.json$/.test(name)||name==='sidebar-links.json';
  if(['trials-expanded','chart-model'].includes(top))return name==='measured-trial.json';
  if(top==='bd-reference')return ['bd-reference.json','bd-measurement.json','bd-trial-report.json'].includes(name);
  if(top==='startup-desktop')return ['cache-result.json','page-timing.json'].includes(name);
  if(top==='runtime-data')return /^measured-.*\.json$/.test(name);
  if(top==='basic-properties')return name==='measured-properties.json';
  return false;
}

export const criticalMeasurements=caseCatalog.cases.flatMap(c=>(c.artifacts??[]).map(pattern=>({caseId:c.id,testName:c.name,pathPattern:new RegExp(pattern)})));
export async function saveMeasurements(generated,evidence,{failed=false,requiredMeasurements=[],observationRoot,caseIds}={}) {
  if(observationRoot)return saveObservedMeasurements(generated,evidence,{failed,requiredMeasurements,observationRoot,caseIds});
  const entries=[],diagnostics=[];
  async function visit(directory) {
    for(const item of await fs.readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,item.name),relative=path.relative(generated,file).replaceAll('\\','/');
      if(item.isSymbolicLink())throw Error('Linked test measurement: '+relative);
      if(item.isDirectory()) {
        // Protocol fixture archives and browser profiles never contain product measurements.
        if(relative.split('/').some(part=>['desktop-profile','node_modules','runtimes','evidence-archive','github-archive'].includes(part)))continue;
        if(relative.split('/')[0].match(/^(archive-layout|local-import|github-evidence|test-system|independent-evidence)-/))continue;
        await visit(file);
      } else if(measurementFile(relative)) {
        const bytes=await fs.readFile(file),raw=(relative.endsWith('.gz')?gunzipSync(bytes):bytes).toString('utf8');
        if(relative.endsWith('.log')){
          let data;try{data=JSON.parse(raw)}catch{data=raw}
          entries.push({path:relative,data});
        }else entries.push({path:relative,data:JSON.parse(raw)});
      } else if(failed&&(/\/(failure\.png|failure\.json|browser-errors\.json|launcher\.log|server\.log)$/.test(relative))) {
        const bytes=await fs.readFile(file);
        if(item.name==='browser-errors.json'&&JSON.parse(bytes.toString()).length===0)continue;
        const output=path.join(evidence,'diagnostics',relative+'.gz');
        await fs.mkdir(path.dirname(output),{recursive:true});
        await fs.writeFile(output,gzipSync(bytes));diagnostics.push(relative+'.gz');
      }
    }
  }
  const root=await fs.lstat(generated).catch(error=>{if(error.code==='ENOENT')return null;throw error});
  if(root?.isSymbolicLink())throw Error('Linked test measurement root');
  if(root)await visit(generated);
  entries.sort((a,b)=>a.path.localeCompare(b.path));
  for(const requirement of requiredMeasurements) if(!entries.some(e=>requirement.pathPattern.test(e.path)&&e.data?.outcome==='passed')) throw Error('Missing critical measurement evidence: '+requirement.testName);
  if(entries.length)await fs.writeFile(path.join(evidence,'measurements.json.gz'),gzipSync(Buffer.from(JSON.stringify({schema:1,entries})+'\n')));
  return {measurements:entries.length,diagnostics:diagnostics.length};
}

export function compactResults(counts,cases) {
  return {counts,cases:cases.map((item,index)=>({id:item.caseId??index+1,name:item.name,file:item.file,status:item.skip?'skipped':item.todo?'todo':item.event==='test:pass'?'passed':/cancelled/.test(item.details?.error?.failureType||'')?'cancelled':'failed',durationMs:item.details?.duration_ms,skipReason:item.skip||undefined,todoReason:item.todo||undefined,error:item.details?.error,classification:item.classification}))};
}
