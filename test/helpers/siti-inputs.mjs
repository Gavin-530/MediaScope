import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe,scan} from '../../engine.mjs';
export async function sitiInputFixture(dir,c,{count=5,metadata=false}={},ctx={}){
  const exr=c.format==='grayf32le',raw=path.join(dir,c.name+'.raw'),file=path.join(dir,c.name+(exr?'.mkv':'.nut'));
  await writeFile(raw,Buffer.concat(Array.from({length:count},(_,i)=>Buffer.from(c.frames[i%5],'base64'))));
  const tags=metadata?`,setparams=range=${c.range==='tv'?'limited':'full'}:color_trc=${c.domain==='pq'?'smpte2084':c.domain==='hlg'?'arib-std-b67':'bt709'}:color_primaries=${c.matrix==='bt2020'?'bt2020':'bt709'}:colorspace=${c.matrix==='bt2020'?'bt2020nc':'bt709'}`:'';
  await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format',c.format,'-video_size',`${c.width}x${c.height}`,'-framerate','24','-i',raw,'-vf',`setfield=prog,setpts='(N+floor(N/7))/(24*TB)+7200/TB'${tags}`,'-fps_mode','passthrough','-c:v',exr?'exr':'rawvideo',...(exr?['-format','float','-gamma','1']:[]),'-threads:v','1',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);
  return {file,raw,stream,frames};
}
