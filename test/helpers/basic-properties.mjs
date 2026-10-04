import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {FF,FP,run,decodeThreadCount} from '../../engine.mjs';
import {summarizeSample} from '../../public/properties.js';

// Generate actual old-format evidence only for import compatibility tests.
// The application no longer performs this read.
export async function legacyFrameSample(file,streams,ctx={}) {
  const frameSample=JSON.parse(await run(FP,['-v','error','-threads',String(decodeThreadCount(ctx.decodeThreads)),'-select_streams','v','-read_intervals','%+#32','-show_frames','-of','json',file],ctx));
  return {frameSample,frameSampleScope:'旧版读取范围：开头视频轨道合计最多 32 包；不代表全片。',frameSampleRead:{...summarizeSample(streams,frameSample),commands:ctx.commands??[],packetBudget:32}};
}
export async function makePropertyMedia(directory) {
  await mkdir(directory,{recursive:true});
  const commands=[],files={},encode=async(name,args)=>{
    const file=path.join(directory,name);await run(FF,['-v','error','-y',...args,file],{commands});files[name]=file;return file;
  };
  for(const sampling of ['420','422','444'])for(const depth of [8,10,12]){
    const pix=`yuv${sampling}p${depth===8?'':depth+'le'}`;
    await encode(pix+'.mkv',['-f','lavfi','-i',`testsrc2=s=64x48:r=4:d=1,format=${pix}`,'-c:v','ffv1','-level','3','-pix_fmt',pix]);
  }
  for(const pix of ['rgb24','rgba','gray','nv12','rgb565le'])await encode(pix+'.nut',['-f','lavfi','-i',`testsrc=s=64x48:r=4:d=1,format=${pix}`,'-c:v','rawvideo','-pix_fmt',pix]);
  const tagged=await encode('tagged.mp4',['-f','lavfi','-i','testsrc2=s=64x48:r=4:d=1,setsar=4/3','-c:v','libx264','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-chroma_sample_location','left','-bsf:v','h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1']);
  await encode('rotated.mp4',['-display_rotation:v:0','90','-i',tagged,'-c','copy']);
  await encode('interlaced.mkv',['-f','lavfi','-i','testsrc2=s=64x48:r=4:d=1,setfield=tff','-c:v','ffv1','-level','3','-flags','+ilme+ildct']);
  await encode('hdr.mkv',['-f','lavfi','-i','testsrc2=s=64x48:r=4:d=1','-c:v','libx265','-preset','ultrafast','-pix_fmt','yuv420p10le','-x265-params','log-level=error:pools=1:colorprim=9:transfer=16:colormatrix=9:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400']);
  await encode('multi.mkv',['-f','lavfi','-i','testsrc2=s=64x48:r=20:d=2','-f','lavfi','-i','testsrc2=s=80x64:r=10:d=2','-f','lavfi','-i','sine=d=2','-map','0:v','-map','1:v','-map','2:a','-c:v','ffv1','-level','3','-c:a','pcm_s16le']);
  const cover=await encode('cover.jpg',['-f','lavfi','-i','testsrc=s=64x48:r=1:d=1','-frames:v','1','-c:v','mjpeg','-update','1']);
  await encode('attached.mp4',['-i',tagged,'-i',cover,'-map','0:v','-map','1:v','-c','copy','-disposition:v:1','attached_pic']);
  await encode('audio.wav',['-f','lavfi','-i','sine=d=0.2','-c:a','pcm_s16le']);
  return {files,commands};
}
