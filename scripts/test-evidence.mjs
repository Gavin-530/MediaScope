import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

// Explicit measurement locations, not a recursive extension-based archive of fixtures.
export function measurementFile(relative) {
  const name=path.posix.basename(relative),top=relative.split('/')[0];
  if(/^(psnr|ssim|vmaf)\.(log|json)$/.test(name)&&(!relative.includes('/')||['bitdepth','trial','trial-libx265','trial-libaom-av1'].includes(top)))return true;
  if(/^(metrics-equivalence|reference-cache|vfr-equivalence|structure-equivalence|siti-parallel)-[A-Za-z0-9]{6}$/.test(top))return name.endsWith('.json');
  if(['browser','server-reports','chroma-assumption','portable','report-validation'].includes(top))return name==='report.json'||/^theme-.*\.json$/.test(name)||name==='sidebar-links.json';
  if(['trials-expanded','chart-model'].includes(top))return name==='measured-trial.json';
  if(top==='startup-desktop')return ['cache-result.json','page-timing.json'].includes(name);
  return false;
}

export async function saveMeasurements(generated,evidence,{failed=false}={}) {
  const entries=[],diagnostics=[];
  async function visit(directory) {
    for(const item of await fs.readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,item.name),relative=path.relative(generated,file).replaceAll('\\','/');
      if(item.isSymbolicLink())throw Error('Linked test measurement: '+relative);
      if(item.isDirectory()) {
        // Protocol fixture archives and browser profiles never contain product measurements.
        if(relative.split('/').some(part=>['desktop-profile','node_modules','runtimes','evidence-archive'].includes(part)))continue;
        if(relative.split('/')[0].match(/^(archive-layout|local-import|github-evidence|test-system|independent-evidence)-/))continue;
        await visit(file);
      } else if(measurementFile(relative)) {
        const raw=await fs.readFile(file,'utf8');
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
  if(entries.length)await fs.writeFile(path.join(evidence,'measurements.json.gz'),gzipSync(Buffer.from(JSON.stringify({schema:1,entries})+'\n')));
  return {measurements:entries.length,diagnostics:diagnostics.length};
}

export function compactResults(counts,cases) {
  return {counts,cases:cases.map((item,index)=>({id:index+1,name:item.name,file:item.file,status:item.skip?'skipped':item.todo?'todo':item.event==='test:pass'?'passed':/cancelled/.test(item.details?.error?.failureType||'')?'cancelled':'failed',durationMs:item.details?.duration_ms,skipReason:item.skip||undefined,todoReason:item.todo||undefined,error:item.details?.error,classification:item.classification}))};
}
