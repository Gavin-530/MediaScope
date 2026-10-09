import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe} from '../../engine.mjs';
// Real encoded files and real probe output; never manufacture measured reports.
export async function makeMedia(directory) {
  await mkdir(directory,{recursive:true});
  const source=path.join(directory,'参考 多音轨.mp4'),candidate=path.join(directory,'候选.mp4'),commands=[];
  const color=['-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-chroma_sample_location','left','-bsf:v','h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1'];
  await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=size=128x96:rate=12:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-f','lavfi','-i','sine=frequency=880:duration=1','-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-crf','18','-g','6','-sc_threshold','0',...color,'-c:a','aac',source],{commands});
  await run(FF,['-v','error','-y','-i',source,'-map','0:v','-c:v','libx264','-crf','42',...color,candidate],{commands});
  const info=await probe(source,{commands});
  await writeFile(path.join(directory,'fixture-recipe.json'),JSON.stringify({source,candidate,commands,raw:info.raw},null,2));
  return {source,candidate,info};
}
