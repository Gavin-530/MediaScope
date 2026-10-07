// Display names are derived from sealed identity; the four-character token is
// not a checksum. Keep this spelling in sync with evidence-lib.ps1.
export function identityTime(id){
  const m=/^(\d{8}(?:T\d{6}(?:\d{3}|\.\d+)?Z)?|undated)-([a-f0-9]{4}|[a-f0-9]{8})$/.exec(id??'');
  if(!m)throw Error('Invalid evidence run identifier');
  let stamp=m[1];if(/^\d{8}T\d{9}Z$/.test(stamp))stamp=stamp.slice(0,15)+'.'+stamp.slice(15,18)+'Z';
  if(stamp!=='undated'){
    const p=/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z)?$/.exec(stamp);
    const day=`${p[1]}-${p[2]}-${p[3]}`,base=day+'T'+(p[4]?`${p[4]}:${p[5]}:${p[6]}`:'00:00:00');
    if(p[1]==='0000'||!Number.isFinite(Date.parse(base+'Z'))||new Date(base+'Z').toISOString().slice(0,19)!==base)throw Error('Invalid UTC evidence timestamp');
  }
  return {stamp,token:m[2]};
}
export function readableEvidenceName(manifest,id=manifest.archiveRevision===1?manifest.archive.identifier:manifest.runId,{generic=false}={}){
  const {stamp,token}=identityTime(id),kind=manifest.kind;
  if(typeof kind!=='string'||!/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/.test(kind)||kind.length>32)throw Error('Invalid evidence kind for directory description');
  let label=kind;
  if(manifest.scope&&(!generic||kind==='App')){
    if(typeof manifest.scope!=='string'||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(manifest.scope))throw Error('Invalid evidence scope for directory description');
    if(kind.length+1+manifest.scope.length<=32)label+='-'+manifest.scope;
  }else if(!generic&&kind==='Custom'&&typeof manifest.label==='string'&&/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(manifest.label)&&kind.length+1+manifest.label.length<=32){
    label+='-'+manifest.label;
  }
  return stamp.replace(/\.\d+(?=Z$)/,'')+'_'+token.slice(-4)+'_'+label;
}
export function evidenceNameAliases(manifest,envelope){
  const logical=envelope?.originalRelative??manifest.archive?.originalRelative;
  const id=manifest.archive?.identifier??manifest.runId??(logical?.match(/(?:^|[-/])((?:\d{8}(?:T\d{6}(?:\d{3}|\.\d+)?Z)?|undated)-(?:[a-f0-9]{4}|[a-f0-9]{8}))$/)?.[1]);
  if(!/^(?:\d{8}(?:T\d{6}(?:\d{3}|\.\d+)?Z)?|undated)-(?:[a-f0-9]{4}|[a-f0-9]{8})$/.test(id??''))return [envelope?.path?.split('/').at(-1)].filter(Boolean);
  const {stamp,token}=identityTime(id);
  const separated=stamp==='undated'?stamp:stamp.replace(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(.*))?$/,(_,y,m,d,h,min,s,end)=>`${y}-${m}-${d}`+(h?`T${h}-${min}-${s}${end}`:''));
  const aliases=[readableEvidenceName(manifest,id),readableEvidenceName(manifest,id,{generic:true}),stamp+'-'+token,separated+'-'+token,envelope?.path?.split('/').at(-1)];
  if(logical&&logical.endsWith('-'+id)){
    const label=logical.slice(0,-id.length-1);if(/^[a-z][a-z0-9-]{0,31}$/.test(label))aliases.push(stamp+'_'+label+'_'+token,separated+'_'+label+'_'+token);
  }
  return aliases.filter(Boolean);
}
