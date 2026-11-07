import {projectTest} from '../../helpers/case-test.mjs';
import assert from '../../helpers/assert.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {analyzeRepeats,MAX_REPEAT_FRAME_BYTES} from '../../helpers/subject.mjs';
const test=projectTest(import.meta.url);

test('repeat admission rejects oversized native frame metadata before starting a decoder',async()=>{
 await mkdir(workRoot,{recursive:true});const file=workPath('small-control.y4m');
 // A real tiny mono Y4M control. The oversized descriptor is deliberately an
 // invalid API argument; it is never described as measured media dimensions.
 await writeFile(file,Buffer.concat([Buffer.from('YUV4MPEG2 W4 H4 F1:1 Ip A1:1 Cmono\nFRAME\n'),Buffer.alloc(16,16)]));
 const commands=[];
 await assert.rejects(analyzeRepeats(file,{index:0,pix_fmt:'gray',width:MAX_REPEAT_FRAME_BYTES+1,height:1},{commands}),/原生帧字节/);
 assert.equal(commands.length,0,'the product must reject before tool identity or decoding');
});
