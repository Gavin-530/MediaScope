// These are evidence/protocol checks, not simulated media measurements.
export function featureResults(coverage,cases,suite){
  return coverage.features.map(feature=>{
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
