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

// The same current-source full-regression gate is used locally and in CI.
// Partial suites and historical comparisons report their narrower scope explicitly.
export function regressionAssessment(counts,features,{suite='full',historical=false,processExitCode=0}={}){
  const readiness=releaseReadiness(counts,features);
  const mode=historical?'historical-comparison':suite==='full'?'full-regression':'partial-regression';
  const failed=processExitCode!==0||!counts||counts.tests<=0||counts.passed<=0||!!counts.failed||!!counts.cancelled;
  const incomplete=!!counts?.skipped||!!counts?.todo;
  const accepted=!failed&&(mode!=='full-regression'||readiness.ready);
  const status=failed?'failed':mode==='full-regression'?(readiness.ready?'complete':'incomplete'):incomplete?'incomplete':'partial';
  const reasons=mode==='full-regression'?[...readiness.reasons,...(processExitCode!==0?['Test process exited unsuccessfully']:[])]:[
    historical?'Historical source comparison; current-version acceptance was not evaluated':`Only the ${suite} suite was executed`,
    ...(incomplete?['Skipped or TODO checks remain; verification is incomplete']:[]),
    ...(failed?['Failed, cancelled or no executed passing checks']:[])
  ];
  return {schema:1,mode,status,accepted,reasons,processExitCode};
}
