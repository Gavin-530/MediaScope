import {writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe,scan} from '../../engine.mjs';
export async function sitiInputFixture(dir,c,{count=5,metadata=false,interlaced=false,lossless=false}={},ctx={}){
  const exr=c.format==='grayf32le',raw=path.join(dir,c.name+'.raw'),file=path.join(dir,c.name+(lossless||exr?'.mkv':'.nut'));
  await writeFile(raw,Buffer.concat(Array.from({length:count},(_,i)=>Buffer.from(c.frames[i%5],'base64'))));
  const transfer=c.domain==='pq'?'smpte2084':c.domain==='hlg'?'arib-std-b67':c.domain==='srgb'?'iec61966-2-1':'bt709';
  const tags=metadata?`,setparams=range=${c.range==='tv'?'limited':'full'}:color_trc=${transfer}:color_primaries=${c.matrix==='bt2020'?'bt2020':'bt709'}:colorspace=${c.matrix==='bt2020'?'bt2020nc':'bt709'}`:'';
  await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format',c.format,'-video_size',`${c.width}x${c.height}`,'-framerate','24','-i',raw,'-vf',`setfield=${interlaced?'tff':'prog'},setpts='(N+floor(N/7))/(24*TB)+7200/TB'${tags}`,'-fps_mode','passthrough','-c:v',lossless?'ffv1':exr?'exr':'rawvideo',...(lossless?['-level','3']:exr?['-format','float','-gamma','1']:[]),...(metadata?['-color_range',c.range,'-color_trc',transfer,'-color_primaries',c.matrix==='bt2020'?'bt2020':'bt709','-colorspace',c.matrix==='bt2020'?'bt2020nc':'bt709']:[]),'-threads:v','1',file],ctx);
  await unlink(raw);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);
  return {file,stream,frames};
}
