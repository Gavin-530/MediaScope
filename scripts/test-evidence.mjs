import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

// Explicit measurement locations, not a recursive extension-based archive of fixtures.
export function measurementFile(relative) {
  const name=path.posix.basename(relative),top=relative.split('/')[0];
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

export const criticalMeasurements = [
  {testName:'[repeat-analysis] native integer layouts preserve every plane, alpha, edge and LSB against independent known bytes',pathPattern:/^repeat-analysis-[A-Za-z0-9]{6}\/native-layouts\.json$/},
  {testName:'[repeat-analysis] original PTS, offset and VFR holds agree with separate FFprobe integer evidence',pathPattern:/^repeat-analysis-[A-Za-z0-9]{6}\/timestamps\.json$/},
  {testName:'[repeat-analysis] missing source PTS never borrows generated framehash timestamps',pathPattern:/^repeat-analysis-[A-Za-z0-9]{6}\/missing-pts\.json$/},
  {testName:'[repeat-analysis] freezedetect metadata matches upstream events and preserves open EOF in native 8, 10, 12, 16-bit and alpha',pathPattern:/^repeat-analysis-[A-Za-z0-9]{6}\/freeze\.json$/},
  {testName:'[repeat-analysis] P010 P012 P016 native raw paths match official hashes and reject non-sample bits without a container claim',pathPattern:/^repeat-analysis-[A-Za-z0-9]{6}\/semiplanar-raw\.json$/},
  {testName:'[repeat-analysis] closed and open freeze events reproduce upstream strings, event frames and durations',pathPattern:/^repeat-analysis-[A-Za-z0-9]{6}\/closed-freeze\.json$/},
  {testName:'[repeat-analysis] bad padding, truncated decode, unsupported representation and mid-process cancel cannot succeed',pathPattern:/^repeat-analysis-[A-Za-z0-9]{6}\/failure-boundaries\.json$/},
  {testName:'[bd-rate] exact integer pixel oracle 8-bit tv: frame mean, peak, zero MSE and bitstream bytes',pathPattern:/^bd-reference\/known-8-tv-false-[A-Za-z0-9]{6}\/bd-measurement\.json$/},
  {testName:'[bd-rate] exact integer pixel oracle 8-bit pc: frame mean, peak, zero MSE and bitstream bytes',pathPattern:/^bd-reference\/known-8-pc-false-[A-Za-z0-9]{6}\/bd-measurement\.json$/},
  {testName:'[bd-rate] exact integer pixel oracle 10-bit tv: frame mean, peak, zero MSE and bitstream bytes',pathPattern:/^bd-reference\/known-10-tv-false-[A-Za-z0-9]{6}\/bd-measurement\.json$/},
  {testName:'[bd-rate] exact integer pixel oracle 10-bit pc: frame mean, peak, zero MSE and bitstream bytes',pathPattern:/^bd-reference\/known-10-pc-false-[A-Za-z0-9]{6}\/bd-measurement\.json$/},
  {testName:'[bd-rate] 801 original JVET workbook cells: 780 numerical answers and 21 original errors',pathPattern:/^bd-reference\/jvet-[A-Za-z0-9]{6}\/bd-reference\.json$/},
  {testName:'[bd-rate] real SDR trial, strict adapter, legacy compatibility and tamper-detecting JSON round trip',pathPattern:/^bd-reference\/trial-[A-Za-z0-9]{6}\/bd-trial-report\.json$/},
  {testName:'[analysis-limits] SI/TI really decodes the 8192x4320 boundary and matches analytic PQ edge statistics',pathPattern:/^siti-p910-[A-Za-z0-9]{6}\/8k-boundary\.json$/},
  {testName:'[analysis-limits] SI/TI processes two million real frames and saves every result without one giant JSON string',pathPattern:/^siti-p910-[A-Za-z0-9]{6}\/two-million-boundary\.json$/},
  {testName:'GPU SI/TI hardware measures real 8192x4320 frames against analytic values and CPU',pathPattern:/^siti-gpu-[A-Za-z0-9]{6}\/8k-boundary\.json$/},
  {testName:'SI/TI independent byte oracle validates 150 layouts and 900 CPU input cases',pathPattern:/^siti-p910-[A-Za-z0-9]{6}\/independent-layout-cpu\.json$/},
  {testName:'SI/TI invalid NUT layout fixtures are rejected before CPU or GPU calculation',pathPattern:/^siti-p910-[A-Za-z0-9]{6}\/fixture-rejections\.json$/},
  {testName:'real video and two audio tracks: 100 ms aggregation matches direct 1 s without changing legacy accounting',pathPattern:/^bitrate-equivalence-[A-Za-z0-9]{6}\/measured-equivalence\.json$/},
  {testName:'GPU SI/TI hardware validates real frames against CPU without accepting CPU fallback',pathPattern:/^siti-gpu-[A-Za-z0-9]{6}\/hardware-equivalence\.json$/},
  {testName:'P.910 SI/TI CPU decodes lossless native SDR frames and preserves source time and reference values',pathPattern:/^siti-p910-[A-Za-z0-9]{6}\/normative-cpu\.json$/},
  {testName:'P.910 SI/TI CPU frame parallel preserves every unrounded value, overlap TI and source VFR time',pathPattern:/^siti-p910-[A-Za-z0-9]{6}\/parallel-equivalence\.json$/},
  {testName:'SI/TI explicitly selected BWDIF measures progressive output with preserved frames and time',pathPattern:/^siti-p910-[A-Za-z0-9]{6}\/deinterlace-equivalence\.json$/}
];
export async function saveMeasurements(generated,evidence,{failed=false,requiredMeasurements=[]}={}) {
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
  for(const requirement of requiredMeasurements) if(!entries.some(e=>requirement.pathPattern.test(e.path)&&e.data?.outcome==='passed')) throw Error('Missing critical measurement evidence: '+requirement.testName);
  if(entries.length)await fs.writeFile(path.join(evidence,'measurements.json.gz'),gzipSync(Buffer.from(JSON.stringify({schema:1,entries})+'\n')));
  return {measurements:entries.length,diagnostics:diagnostics.length};
}

export function compactResults(counts,cases) {
  return {counts,cases:cases.map((item,index)=>({id:index+1,name:item.name,file:item.file,status:item.skip?'skipped':item.todo?'todo':item.event==='test:pass'?'passed':/cancelled/.test(item.details?.error?.failureType||'')?'cancelled':'failed',durationMs:item.details?.duration_ms,skipReason:item.skip||undefined,todoReason:item.todo||undefined,error:item.details?.error,classification:item.classification}))};
}
