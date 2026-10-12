import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe,scan} from '../../engine.mjs';

export function lumaBytes(codes,depth){const raw=Buffer.alloc(codes.length*(depth===8?1:2));for(let i=0;i<codes.length;i++)if(depth===8)raw[i]=codes[i];else raw.writeUInt16LE(codes[i],i*2);return raw}
export async function extendedSitiFixture(dir,c,{gray=false,sampling='444',count=5,interlaced=false,unknown=false,transfer=null}={},ctx={}){
  const name=`${c.name}-${gray?'gray':sampling}-${count}-${interlaced?'interlaced':'progressive'}-${unknown?'unknown':'declared'}`;
  const pix=(gray?'gray':`yuv${sampling}p`)+(c.depth===8?'':c.depth+'le'),raw=path.join(dir,name+'.raw'),file=path.join(dir,name+'.mkv');
  const chroma=gray?Buffer.alloc(0):lumaBytes(Array(c.width*c.height*(sampling==='420'?.5:sampling==='422'?1:2)).fill(128*2**(c.depth-8)),c.depth);
  await writeFile(raw,Buffer.concat(Array.from({length:count},(_,i)=>[lumaBytes(c.frames[i%c.frames.length],c.depth),chroma]).flat()));
  const trc=transfer??(c.domain==='pq'?'smpte2084':c.domain==='hlg'?'arib-std-b67':'bt709');
  const params=unknown?'':`,setparams=range=${c.range==='tv'?'limited':'full'}:color_trc=${trc}:color_primaries=bt709:colorspace=bt709`;
  await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format',pix,'-video_size',`${c.width}x${c.height}`,'-framerate','24','-i',raw,'-vf',`setfield=${interlaced?'tff':'prog'}${params},setpts='(N+floor(N/7))/(24*TB)+7200/TB'`,'-fps_mode','passthrough','-c:v','ffv1','-level','3',...(unknown?[]:['-color_range',c.range,'-color_trc',trc,'-color_primaries','bt709','-colorspace','bt709']),file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);
  return {file,raw,pix,stream,frames};
}
