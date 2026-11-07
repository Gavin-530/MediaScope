import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {FF,run} from './subject.mjs';
// Small, deterministic ordinary controls. No maximum dimensions or endurance
// defaults live here; scale is chosen only by explicit extension tools.
export async function engineControl(directory,{candidate=false}={}){
 await mkdir(directory,{recursive:true});const source=path.join(directory,'参考 多音轨.mp4');
 const color=['-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-bsf:v','h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1'];
 await run(FF,['-hide_banner','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x108:rate=12:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-f','lavfi','-i','sine=frequency=880:duration=1','-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-crf','18',...color,'-c:a','aac',source]);
 if(candidate)await run(FF,['-hide_banner','-v','error','-y','-i',source,'-map','0:v','-c:v','libx264','-crf','42',...color,path.join(directory,'candidate.mp4')]);
 return source;
}
export async function hdrControl(directory){
 await mkdir(directory,{recursive:true});const file=path.join(directory,'hdr-pcm.mov');
 await run(FF,['-hide_banner','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x108:rate=12:duration=0.5','-f','lavfi','-i','sine=duration=0.5','-c:v','libx265','-preset','ultrafast','-pix_fmt','yuv420p10le','-x265-params','log-level=error:pools=1:colorprim=9:transfer=16:colormatrix=9:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400','-tag:v','hvc1','-c:a','pcm_s16le',file]);return file;
}
export async function av1Control(directory){
 await mkdir(directory,{recursive:true});const file=path.join(directory,'av1.mp4');
 await run(FF,['-hide_banner','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x108:rate=12:duration=0.5','-c:v','libaom-av1','-cpu-used','8','-crf','35',file]);return file;
}
