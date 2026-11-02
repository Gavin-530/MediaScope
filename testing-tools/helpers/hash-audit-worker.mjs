// CPU batch parallelism for the explicit research audit. Shared inputs are
// read-only; standard hash messages are never split into nonstandard tree hashes.
import {parentPort} from 'node:worker_threads';
import {createHash} from 'node:crypto';
let configuration;
parentPort.on('message',message=>{
 try{
  if(message.kind==='configure'){configuration={...message,data:Buffer.from(message.data)};parentPort.postMessage({configured:true});return;}
  if(message.kind!=='hash'||!configuration)throw Error('Invalid hash worker protocol');
  const c=configuration,results=[];for(let i=c.lane;i<c.offsets.length;i+=c.workers){const b=c.data.subarray(c.offsets[i],c.offsets[i]+c.lengths[i]);results.push([i,createHash(c.algorithm).update(b).digest()]);}
  parentPort.postMessage({results});
 }catch(error){parentPort.postMessage({error:error.stack});}
});
parentPort.postMessage({ready:true});
