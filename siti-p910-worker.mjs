import {once} from 'node:events';
import {createSitiP910Calculator} from './siti-p910.mjs';
import {validateSitiSceneStarts} from './public/siti-scenes.js';

// A separate CPU process keeps the application event loop responsive and makes
// cancellation terminate both calculation and software decoding.
try{
  const [width,height,depth,range,boundaries='0',input='null',mode='measure']=process.argv.slice(2),calculator=createSitiP910Calculator(Number(width),Number(height),Number(depth),range,JSON.parse(input));
  const sceneStarts=boundaries.split(',').map(Number);validateSitiSceneStarts(sceneStarts);const starts=new Set(sceneStarts);let frame=0;
  const raw=Buffer.allocUnsafe(calculator.bytes);let offset=0;
  const prepared=mode==='preprocess'?new Float64Array(Number(width)*Number(height)):null;
  for await(const chunk of process.stdin){
    let position=0;
    while(position<chunk.length){
      const count=Math.min(raw.length-offset,chunk.length-position);chunk.copy(raw,offset,position,position+count);offset+=count;position+=count;
      if(offset===raw.length){
        if(prepared){calculator.preprocess(raw,prepared);frame++;await new Promise((resolve,reject)=>process.stdout.write(Buffer.from(prepared.buffer),e=>e?reject(e):resolve()))}
        else if(!process.stdout.write(JSON.stringify(calculator.measure(raw,starts.has(frame++)))+'\n'))await once(process.stdout,'drain');
        offset=0;
      }
    }
  }
  if(offset)throw Error('P.910 原始分量帧被截断');
  validateSitiSceneStarts(sceneStarts,frame);
}catch(e){process.stderr.write(e.message+'\n');process.exitCode=1}
