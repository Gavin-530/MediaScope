// A separately built experiment; previous whole-file evidence/source snapshots stay intact.
import assert from 'node:assert/strict';
import {wholeKernelSource,wholeHostSource} from './whole-file-gpu-source.mjs';
function once(source,a,b){assert.equal(source.split(a).length,2,'Expected exactly one patch target: '+a.slice(0,70));return source.replace(a,b);}
let kernel=wholeKernelSource;
kernel=once(kernel,'uint bytes,uint count,uint blocks){','uint bytes,uint count,uint blocks,uint cpuCount){');
kernel=once(kernel,'uint f=k%count,w=k/count;','uint f=k%count,w=k/count;if(f<cpuCount)return;');
kernel=once(kernel,'uint count,uint blocks,uint base,uint span){','uint count,uint blocks,uint base,uint span,uint cpuCount){');
kernel=once(kernel,'uint id=get_global_id(0);if(id>=count)return;uint h0=','uint id=get_global_id(0);if(id>=count||id<cpuCount)return;uint h0=');
export const cooperativeKernelSource=kernel;
let host=wholeHostSource.replace('public static class WholeFileGpu','public static class CooperativeGpu');
host=once(host,' static Dictionary<string,object> Obj(object o)',String.raw`
 [DllImport(Dll)] static extern int clGetEventInfo(IntPtr ev,uint key,UIntPtr size,out int value,out UIntPtr actual);
 static Dictionary<string,object> Obj(object o)`);
host=once(host,'   byte[] host=new byte[checked((int)(bytes*capacity))];',String.raw`
   int cpuPercent=job.ContainsKey("cpuHashPercent")?Convert.ToInt32(job["cpuHashPercent"]):0,cpuWorkers=job.ContainsKey("cpuHashWorkers")?Convert.ToInt32(job["cpuHashWorkers"]):4;
   if(cpuPercent<0||cpuPercent>100||cpuWorkers<1||cpuWorkers>32)throw new Exception("Invalid CPU hash partition");
   if(cpuPercent>0&&U(job,"packed")!=0)throw new Exception("CPU/GPU split hashing currently requires software-decoded canonical input");
   result["cpuHashPercent"]=cpuPercent;result["cpuHashWorkers"]=cpuWorkers;result["cpuHashProvider"]="System.Security.Cryptography.SHA256Cng (Windows CNG), one reusable instance per worker per batch";
   int totalCpuFrames=0,totalGpuFrames=0,observedOverlap=0;double cpuHashSeconds=0;long epoch=Stopwatch.GetTimestamp();
   byte[] host=new byte[checked((int)(bytes*capacity))];`);
host=once(host,'    var ev=new List<IntPtr>();I(can,3,count);Enqueue(q,can,(ulong)bytes*count,0,ev);I(prep,3,count);Enqueue(q,prep,(ulong)blocks*16*count,0,ev);I(sha,3,count);for(uint start=0;start<blocks;start+=2048){I(sha,5,start);Enqueue(q,sha,count,0,ev);}',String.raw`
    uint cpuCount=(uint)((count*cpuPercent+99)/100);int cpuStarted=0;long cpuStart=0,cpuEnd=0;
    System.Threading.Tasks.Task<byte[][]> cpuTask=null;
    if(cpuCount>0){cpuTask=System.Threading.Tasks.Task.Factory.StartNew(()=>{
     cpuStart=Stopwatch.GetTimestamp();System.Threading.Interlocked.Exchange(ref cpuStarted,1);var values=new byte[cpuCount][];
     System.Threading.Tasks.Parallel.For(0,Math.Min(cpuWorkers,(int)cpuCount),new System.Threading.Tasks.ParallelOptions{MaxDegreeOfParallelism=cpuWorkers},lane=>{
      using(var h=new System.Security.Cryptography.SHA256Cng()){for(int f=lane;f<cpuCount;f+=Math.Min(cpuWorkers,(int)cpuCount))values[f]=h.ComputeHash(actual,checked(f*(int)bytes),(int)bytes);}
     });cpuEnd=Stopwatch.GetTimestamp();return values;
    },System.Threading.Tasks.TaskCreationOptions.LongRunning);}
    var ev=new List<IntPtr>();I(can,3,count);Enqueue(q,can,(ulong)bytes*count,0,ev);I(prep,3,count);I(prep,5,cpuCount);I(sha,3,count);I(sha,7,cpuCount);
    if(cpuCount<count){Enqueue(q,prep,(ulong)blocks*16*count,0,ev);for(uint start=0;start<blocks;start+=2048){I(sha,5,start);Enqueue(q,sha,count,0,ev);}}`);
host=once(host,'Enqueue(q,cs,1,0,ev);Check(clFinish(q));double ks=0;',String.raw`Enqueue(q,cs,1,0,ev);
    bool concurrent=false;long observation=Stopwatch.GetTimestamp();if(cpuTask!=null&&System.Threading.Interlocked.CompareExchange(ref cpuStarted,0,0)==1&&!cpuTask.IsCompleted){int status;UIntPtr sz;Check(clGetEventInfo(ev[0],0x11D3,(UIntPtr)4,out status,out sz));concurrent=status==0&&!cpuTask.IsCompleted;if(concurrent)observedOverlap++;}
    Check(clFinish(q));long gpuFinished=Stopwatch.GetTimestamp();double ks=0;`);
host=once(host,'    for(int f=0;f<count;f++){var rows=',String.raw`
    if(cpuTask!=null){var values=cpuTask.Result;for(int f=0;f<cpuCount;f++)System.Buffer.BlockCopy(values[f],0,hashes,f*32,32);cpuHashSeconds+=(cpuEnd-cpuStart)/(double)Stopwatch.Frequency;}
    totalCpuFrames+=(int)cpuCount;totalGpuFrames+=(int)(count-cpuCount);
    for(int f=0;f<count;f++){var rows=`);
host=once(host,'readWaitSeconds=wait.Elapsed.TotalSeconds});',String.raw`readWaitSeconds=wait.Elapsed.TotalSeconds,cpuHashFrames=cpuCount,gpuHashFrames=count-cpuCount,cpuHashStartSeconds=cpuTask==null?(double?)null:(cpuStart-epoch)/(double)Stopwatch.Frequency,cpuHashEndSeconds=cpuTask==null?(double?)null:(cpuEnd-epoch)/(double)Stopwatch.Frequency,gpuFinishedHostSeconds=(gpuFinished-epoch)/(double)Stopwatch.Frequency,observationHostSeconds=(observation-epoch)/(double)Stopwatch.Frequency,gpuEventCompletedWhileCpuTaskRunning=concurrent});`);
host=once(host,'result["kernelEventSeconds"]=kernel;result["outcome"]="passed";',String.raw`result["kernelEventSeconds"]=kernel;result["cpuHashFrameCount"]=totalCpuFrames;result["gpuHashFrameCount"]=totalGpuFrames;result["cpuHashTaskSecondsSum"]=cpuHashSeconds;result["observedConcurrentBatches"]=observedOverlap;result["concurrencyEvidence"]="Completed actual GPU canonicalization event observed while CPU hashing task had started and had not completed; this is an overlap observation, not a measured device-time overlap percentage";result["outcome"]="passed";`);
export const cooperativeHostSource=host;
