// Independent qualification matrix; do not derive this list from product acceptance.
export function repeatLayouts(){
  const names=['gray','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp','gbrap','nv12','nv21',
    'yuv420p','yuv422p','yuv444p','yuva420p','yuva422p','yuva444p'];
  for(const depth of [9,10,12,14,16])for(const endian of ['le','be'])for(const group of ['yuv420p','yuv422p','yuv444p','gray','gbrp'])names.push(group+depth+endian);
  for(const sampling of ['420','422','444'])for(const depth of [9,10,16,...(sampling==='420'?[]:[12])])for(const endian of ['le','be'])names.push(`yuva${sampling}p${depth}${endian}`);
  for(const depth of [10,12,14,16])for(const endian of ['le','be'])names.push(`gbrap${depth}${endian}`);
  for(const depth of [10,12,16])for(const endian of ['le','be'])names.push(`p0${depth}${endian}`);
  return names;
}
export function componentLabels(name){
  if(name.startsWith('gray'))return ['Y'];
  if(name.startsWith('gbr'))return name.startsWith('gbra')?['G','B','R','A']:['G','B','R'];
  if(name.startsWith('yuv'))return name.startsWith('yuva')?['Y','U','V','A']:['Y','U','V'];
  if(name.startsWith('p0')||name==='nv12')return ['Y','U','V'];
  if(name==='nv21')return ['Y','V','U'];
  return name.replace('24','').toUpperCase().split('');
}
export function canonicalLayout(name,depth){
  if(name.startsWith('p0'))return `yuv420p${depth}le`;
  if(name.startsWith('nv'))return 'yuv420p';
  if(['rgb24','bgr24'].includes(name))return 'gbrp';
  if(['rgba','bgra','argb','abgr'].includes(name))return 'gbrap';
  if(name.startsWith('gbrap14'))return 'gbrap16le';
  if(/^yuva\d+p12/.test(name))return name.replace('12be','16le').replace('12le','16le');
  return name.replace(/be$/,'le');
}
