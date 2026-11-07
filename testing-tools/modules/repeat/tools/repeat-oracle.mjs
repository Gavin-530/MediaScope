// Test-only scalar oracle. No application imports or application format descriptors.
// Enumerate component sample addresses first, then calculate each complete/edge tile.
export function oracleComponents(name,w,h){
  const bits=Number(/(9|10|12|14|16)(?:le|be)$/.exec(name)?.[1]??8),word=bits>8?2:1;
  const little=!name.endsWith('be'),shift=name.startsWith('p0')?16-bits:0;
  const sampling=name.includes('420')||name.startsWith('p0')||name.startsWith('nv')?[2,2]:name.includes('422')?[2,1]:[1,1];
  let sizes;
  if(name.startsWith('yuv'))sizes=[[w,h,1],[Math.ceil(w/sampling[0]),Math.ceil(h/sampling[1]),1],[Math.ceil(w/sampling[0]),Math.ceil(h/sampling[1]),1],...(name.startsWith('yuva')?[[w,h,1]]:[])];
  else if(name.startsWith('gbr'))sizes=Array.from({length:name.startsWith('gbra')?4:3},()=>[w,h,1]);
  else if(name.startsWith('gray'))sizes=[[w,h,1]];
  else if(name.startsWith('p0')||name.startsWith('nv'))sizes=[[w,h,1],[Math.ceil(w/2),Math.ceil(h/2),2]];
  else if(['rgb24','bgr24','rgba','bgra','argb','abgr'].includes(name))sizes=[[w,h,name.length===4?4:3]];
  else throw Error('Oracle format not specified');
  let base=0;const components=[];
  for(const [width,height,stride]of sizes){
    for(let c=0;c<stride;c++){
      const addresses=Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>base+(y*width*stride+x*stride+c)*word));
      components.push({width,height,addresses,read:(buffer,offset)=>word===1?buffer[offset]:(little?buffer.readUInt16LE(offset):buffer.readUInt16BE(offset))/2**shift});
    }
    base+=width*height*stride*word;
  }
  return {components,bytes:base,bits,word,shift,little};
}
export function oracleDifference(a,b,layout){
  return layout.components.map(c=>{
    const deltas=c.addresses.map(row=>row.map(p=>Math.abs(c.read(a,p)-c.read(b,p)))),flat=deltas.flat();
    let best={sum:0,count:Math.min(16,c.width)*Math.min(16,c.height),x:0,y:0};
    for(let y=0;y<c.height;y+=16)for(let x=0;x<c.width;x+=16){
      const tile=deltas.slice(y,y+16).flatMap(row=>row.slice(x,x+16)),sum=tile.reduce((n,v)=>n+v,0);
      if(sum/tile.length>best.sum/best.count)best={sum,count:tile.length,x,y};
    }
    return [flat.reduce((n,v)=>n+v,0),flat.filter(v=>v!==0).length,flat.reduce((n,v)=>Math.max(n,v),0),best.sum,best.count,best.x,best.y];
  });
}
export function writeOracleValue(buffer,offset,value,layout){
  if(layout.word===1)buffer[offset]=value;
  else if(layout.little)buffer.writeUInt16LE(value*2**layout.shift,offset);
  else buffer.writeUInt16BE(value*2**layout.shift,offset);
}
