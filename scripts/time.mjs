// Compare instants without dropping source fractional digits beyond milliseconds.
export function compareTimes(a='',b=''){
  const parse=value=>{
    const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if(!match)return null;
    const seconds=Date.parse(match[1]+match[3]);
    return Number.isFinite(seconds)?{seconds,fraction:match[2]??''}:null;
  };
  const left=parse(a),right=parse(b);
  // Preserve the existing deterministic ordering for missing/legacy invalid values.
  if(!left||!right)return a.localeCompare(b);
  if(left.seconds!==right.seconds)return left.seconds-right.seconds;
  const width=Math.max(left.fraction.length,right.fraction.length);
  const x=left.fraction.padEnd(width,'0'),y=right.fraction.padEnd(width,'0');
  return x<y?-1:x>y?1:0;
}
