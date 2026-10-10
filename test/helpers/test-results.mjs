// These are evidence/protocol checks, not simulated media measurements.
export function featureResults(coverage,cases,suite){
  return coverage.features.filter(feature=>(feature.scope==='gpu')===(suite==='gpu')).map(feature=>{
    const selected=cases.filter(c=>feature.files.includes(c.file)&&new RegExp(feature.names,'i').test(c.name));
    const missingFiles=feature.files.filter(file=>!selected.some(c=>c.file===file));
    const checks=selected.map(c=>({name:c.name,file:c.file,status:c.skip?'skipped':c.event==='test:pass'?'passed':'failed',skipReason:c.skip||undefined}));
    const status=!selected.length?'not-run':checks.some(c=>c.status==='failed')?'failed':checks.every(c=>c.status==='skipped')?'skipped':missingFiles.length||checks.some(c=>c.status==='skipped')?'partial':'passed';
    return {...feature,checks,missingFiles,status};
  });
}

export function releaseReadiness(counts,features){
  const reasons=[];
  if(!counts||counts.tests<=0||counts.passed<=0)reasons.push('No executed passing checks');
  if(counts?.failed||counts?.cancelled||counts?.skipped||counts?.todo)reasons.push('Failed, cancelled, skipped or TODO checks remain');
  for(const feature of features)if(feature.status!=='passed')reasons.push(`${feature.id}: ${feature.status}`);
  if(!features.length)reasons.push('Feature mapping is empty');
  return {ready:reasons.length===0,reasons};
}

export function testSuiteFiles(names,suite){
  const browserFiles=['browser.test.mjs','desktop-browser.test.mjs','runtime-data-browser.test.mjs'];
  return names.filter(name=>name.endsWith('.test.mjs')&&(suite==='gpu'?name==='siti-gpu-hardware.test.mjs':name!=='siti-gpu-hardware.test.mjs'&&(suite==='full'||(suite==='browser')===browserFiles.includes(name)))).sort();
}

// General and GPU coverage have separate gates; neither record alone accepts a release.
export function regressionAssessment(counts,features,{suite='full',historical=false,processExitCode=0}={}){
  const readiness=releaseReadiness(counts,features);
  const mode=historical?'historical-comparison':suite==='full'?'full-regression':suite==='gpu'?'gpu-regression':'partial-regression';
  const mapped=mode==='full-regression'||mode==='gpu-regression';
  const failed=processExitCode!==0||!counts||counts.tests<=0||counts.passed<=0||!!counts.failed||!!counts.cancelled;
  const incomplete=!!counts?.skipped||!!counts?.todo;
  const accepted=!failed&&(!mapped||readiness.ready);
  const status=failed?'failed':mapped?(readiness.ready?'complete':'incomplete'):incomplete?'incomplete':'partial';
  const reasons=mapped?[...readiness.reasons,...(processExitCode!==0?['Test process exited unsuccessfully']:[])]:[
    historical?'Historical source comparison; current-version acceptance was not evaluated':`Only the ${suite} suite was executed`,
    ...(incomplete?['Skipped or TODO checks remain; verification is incomplete']:[]),
    ...(failed?['Failed, cancelled or no executed passing checks']:[])
  ];
  return {schema:1,mode,status,accepted,reasons,processExitCode};
}

export function sourceTestReadiness(general,gpu,measurement,{commit,version}={}){
  const reasons=[];
  if(!/^[a-f0-9]{40}$/.test(commit||''))reasons.push('Exact release commit is required');
  for(const [scope,record,mode] of [['full',general,'full-regression'],['gpu',gpu,'gpu-regression']]){
    const counts=record?.testSummary;
    if(record?.scope!==scope||record?.outcome!=='passed'||record?.exitCode!==0||record?.validation?.mode!==mode||record?.validation?.status!=='complete'||record?.validation?.accepted!==true||record?.validation?.processExitCode!==0||!releaseReadiness(counts,[{id:scope,status:'passed'}]).ready||counts.passed!==counts.tests)reasons.push(`${scope}: complete passing verification required`);
    if(record?.source?.kind!=='working-tree'||record?.source?.commit!==commit||record?.harness?.commit!==commit||!Array.isArray(record?.source?.workingTree)||record.source.workingTree.length||!Array.isArray(record?.harness?.workingTree)||record.harness.workingTree.length)reasons.push(`${scope}: clean exact commit required`);
    if(!version||record?.version!==version)reasons.push(`${scope}: release version mismatch`);
  }
  for(const part of ['source','harness'])if(!/^[a-f0-9]{64}$/.test(general?.[part]?.sha256||'')||general[part].sha256!==gpu?.[part]?.sha256)reasons.push(`${part}: verification inputs differ`);
  for(const name of ['node','ffmpeg','ffprobe']){
    const digest=general?.environment?.executables?.find(e=>e.name===name)?.sha256;
    if(!/^[a-f0-9]{64}$/.test(digest||'')||digest!==gpu?.environment?.executables?.find(e=>e.name===name)?.sha256)reasons.push(`${name}: runtime executables differ`);
  }
  if(general?.releaseCheck?.requested!==true||general?.releaseCheck?.ready!==true)reasons.push('Strict general release check required');
  if(measurement?.outcome!=='passed'||measurement?.capability?.available!==true||!measurement.capability.device||!Number.isFinite(measurement.capability.selfTestMaxError)||!measurement?.cases?.length||measurement.cases.some(c=>c.gpu?.execution?.device!=='gpu'||c.cpu?.execution?.device!=='cpu'||!Number.isFinite(c.maxError)||c.maxError<0||c.maxError>0.0100001))reasons.push('Real GPU equivalence measurements required; CPU fallback cannot satisfy GPU acceptance');
  return {ready:reasons.length===0,reasons};
}
