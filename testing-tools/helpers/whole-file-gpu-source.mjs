// Research backend: actual OpenCL GPU execution; not a production backend or certification.
import {hashKernelSource,hashHostSource} from './hash-opencl-source.mjs';

function shaRounds(){
  const out=[];
  for(let t=0;t<64;t++){
    const j=t%16;
    if(t>=16)out.push(`w${j}+=(r32(w${(t-15)%16},7)^r32(w${(t-15)%16},18)^(w${(t-15)%16}>>3))+w${(t-7)%16}+(r32(w${(t-2)%16},17)^r32(w${(t-2)%16},19)^(w${(t-2)%16}>>10));`);
    out.push(`{uint t1=h+(r32(e,6)^r32(e,11)^r32(e,25))+((e&f)^(~e&g))+k256[${t}]+w${j};uint t2=(r32(a,2)^r32(a,13)^r32(a,22))+((a&b)^(a&c)^(b&c));h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;}`);
  }return out.join('\n');
}
export const wholeKernelSource=hashKernelSource.slice(0,hashKernelSource.indexOf('#define ARGS'))+String.raw`
// Exact equivalent of FFmpeg's binary64 (sad / count / 2^depth <= 0.001).
// 0.001 = M*2^-62, M=4611686018427388 (even significand). Dividing by
// 2^depth is exact throughout the qualified frame domain. RN-even quotient
// compares <= threshold iff sad/count <= its upper rounding midpoint:
// (2*M+1)*2^(depth-63). Compare the two 128-bit integer products exactly.
uint frozen_integer(ulong sad,ulong count,uint depth){uint shift=63-depth;ulong lh=sad>>(64-shift),ll=sad<<shift,m=9223372036854777UL,rh=mul_hi(count,m),rl=count*m;return lh<rh||(lh==rh&&ll<=rl);}
__kernel void threshold_probe(__global const ulong* cases,__global uint* out,uint count){uint i=get_global_id(0);if(i<count)out[i]=frozen_integer(cases[i*3],cases[i*3+1],(uint)cases[i*3+2]);}
// cfg: bytes,storage,shift,bigEndian,depth,components,tileCount,capacity,paddingMask
// component descriptors: byte offset,width,height,pixel stride,channel byte offset,tile offset
uint sample(__global const uchar* p,ulong o,__global const uint* c){uint a=p[o];if(c[1]==2)a=c[3]?(a<<8)|p[o+1]:a|((uint)p[o+1]<<8);return a>>c[2];}
__kernel void canonical(__global const uchar* raw,__global uchar* data,uint bytes,uint count,uint width,uint height,uint depth,uint packed,__global uint* invalid){
 ulong k=get_global_id(0),n=(ulong)bytes*count;if(k>=n)return;uint f=k/bytes,j=k%bytes,src=j;
 if(packed){uint st=depth>8?2:1,s=j/st,byte=j%st,luma=width*height,chroma=luma/4;
  src=s<luma?s*st+byte:s<luma+chroma?(luma+2*(s-luma))*st+byte:(luma+2*(s-luma-chroma)+1)*st+byte;
  if(st==2){uint v=(uint)raw[(ulong)f*bytes+(src&~1u)]|((uint)raw[(ulong)f*bytes+(src&~1u)+1]<<8);if(v&63)atomic_or(invalid,1u);data[(ulong)(f+1)*bytes+j]=(uchar)((v>>6)>>(byte*8));return;}
 }data[(ulong)(f+1)*bytes+j]=raw[(ulong)f*bytes+src];
}
// Word-major SHA input makes adjacent messages' word loads coalesced. Padding is
// done here on the GPU; the following compression is the standard SHA-256 chain.
__kernel void sha_prepare(__global const uchar* data,__global uint* words,uint bytes,uint count,uint blocks){
 ulong k=get_global_id(0),total=(ulong)blocks*16*count;if(k>=total)return;uint f=k%count,w=k/count;ulong i=(ulong)w*4,n=bytes,totalBytes=(ulong)blocks*64;uint v=0;
 for(uint z=0;z<4;z++){ulong q=i+z;uchar b=q<n?data[(ulong)(f+1)*bytes+q]:q==n?128:q>=totalBytes-8?(uchar)((n*8)>>(8*(totalBytes-1-q))):0;v=(v<<8)|b;}words[k]=v;
}
__kernel void sha_complete(__global const uint* words,__global uint* states,__global uchar* digest,uint count,uint blocks,uint base,uint span){
 uint id=get_global_id(0);if(id>=count)return;uint h0=base?states[id*8]:iv256[0],h1=base?states[id*8+1]:iv256[1],h2=base?states[id*8+2]:iv256[2],h3=base?states[id*8+3]:iv256[3],h4=base?states[id*8+4]:iv256[4],h5=base?states[id*8+5]:iv256[5],h6=base?states[id*8+6]:iv256[6],h7=base?states[id*8+7]:iv256[7];
 for(uint block=base;block<min(base+span,blocks);block++){
`+Array.from({length:16},(_,j)=>`uint w${j}=words[((ulong)block*16+${j})*count+id];`).join('\n')+String.raw`
 uint a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
`+shaRounds()+String.raw`
 h0+=a;h1+=b;h2+=c;h3+=d;h4+=e;h5+=f;h6+=g;h7+=h;
 }uint h[8]={h0,h1,h2,h3,h4,h5,h6,h7};for(uint j=0;j<8;j++){states[id*8+j]=h[j];if(base+span>=blocks)for(uint z=0;z<4;z++)digest[id*32+j*4+z]=(uchar)(h[j]>>(24-z*8));}
}
__kernel void difference_tiles(__global const uchar* data,__global const uint* cfg,__global const uint* desc,__global ulong* tiles,uint count,uint first){
 uint tile=get_global_id(0),f=get_global_id(1);if(tile>=cfg[6]||f>=count)return;uint ci=0;while(ci+1<cfg[5]&&tile>=desc[(ci+1)*6+5])ci++;__global const uint* d=desc+ci*6;
 uint cols=(d[1]+15)/16,localTile=tile-d[5],x0=(localTile%cols)*16,y0=(localTile/cols)*16;ulong sad=0,changed=0,maxd=0,padding=0;
 if(!(first&&f==0))for(uint y=y0;y<min(y0+16,d[2]);y++)for(uint x=x0;x<min(x0+16,d[1]);x++){
  ulong off=d[0]+((ulong)y*d[1]+x)*d[3]+d[4],aa=(ulong)f*cfg[0]+off,bb=(ulong)(f+1)*cfg[0]+off;uint a=sample(data,aa,cfg),b=sample(data,bb,cfg),v=a>b?a-b:b-a;sad+=v;changed+=(v!=0);maxd=max(maxd,(ulong)v);
 }
 // Padding is checked even for frame zero and exact repeats.
 if(cfg[1]==2)for(uint y=y0;y<min(y0+16,d[2]);y++)for(uint x=x0;x<min(x0+16,d[1]);x++){
  ulong off=(ulong)(f+1)*cfg[0]+d[0]+((ulong)y*d[1]+x)*d[3]+d[4];uint v=cfg[3]?((uint)data[off]<<8)|data[off+1]:data[off]|((uint)data[off+1]<<8);padding|=v&cfg[8];
 }ulong k=((ulong)f*cfg[6]+tile)*4;tiles[k]=sad;tiles[k+1]=changed;tiles[k+2]=maxd;tiles[k+3]=padding;
}
__kernel void difference_reduce(__global const ulong* tiles,__global const uint* cfg,__global const uint* desc,__global ulong* output,uint count){
 uint ci=get_global_id(0),f=get_global_id(1);if(ci>=cfg[5]||f>=count)return;__global const uint* d=desc+ci*6;uint cols=(d[1]+15)/16,rows=(d[2]+15)/16;ulong sad=0,changed=0,maxd=0,best=0,bc=min(16u,d[1])*min(16u,d[2]),bx=0,by=0,padding=0;
 for(uint t=0;t<cols*rows;t++){ulong k=((ulong)f*cfg[6]+d[5]+t)*4,s=tiles[k],x=(t%cols)*16,y=(t/cols)*16,c=min(16ul,(ulong)d[1]-x)*min(16ul,(ulong)d[2]-y);sad+=s;changed+=tiles[k+1];maxd=max(maxd,tiles[k+2]);padding|=tiles[k+3];if(s*bc>best*c){best=s;bc=c;bx=x;by=y;}}
 ulong k=((ulong)f*cfg[5]+ci)*8;output[k]=sad;output[k+1]=changed;output[k+2]=maxd;output[k+3]=best;output[k+4]=bc;output[k+5]=bx;output[k+6]=by;output[k+7]=padding;
}
// Freeze uses FFmpeg's persistent reference, not merely the adjacent frame.
__kernel void freeze_tiles(__global const uchar* data,__global const uint* cfg,__global const uint* desc,__global long* state,__global ulong* sums,uint f){
 uint tile=get_global_id(0);if(tile>=cfg[6])return;long ref=state[0];if(ref<0){sums[tile]=0;return;}uint ci=0;while(ci+1<cfg[5]&&tile>=desc[(ci+1)*6+5])ci++;__global const uint* d=desc+ci*6;uint cols=(d[1]+15)/16,t=tile-d[5],x0=t%cols*16,y0=t/cols*16;ulong sad=0;
 for(uint y=y0;y<min(y0+16,d[2]);y++)for(uint x=x0;x<min(x0+16,d[1]);x++){ulong o=d[0]+((ulong)y*d[1]+x)*d[3]+d[4];uint a=sample(data,(ulong)ref*cfg[0]+o,cfg),b=sample(data,(ulong)f*cfg[0]+o,cfg);sad+=a>b?a-b:b-a;}sums[tile]=sad;
}
__kernel void freeze_reduce(__global const ulong* sums,__global const uint* cfg,__global long* state,__global const long* pts,__global long* events,uint f,uint tbN,uint tbD,uint samples){
 if(get_global_id(0))return;long ref=state[0],pt=pts[f-1],duration=0;int frozen=0,flags=0;ulong sad=0;for(uint t=0;t<cfg[6];t++)sad+=sums[t];
 if(ref>=0){duration=((pt-state[1])*(long)tbN*1000000L+tbD/2)/tbD;frozen=frozen_integer(sad,samples,cfg[4]);
  if(duration>=2000000){if(!state[2])flags|=1;if(!frozen)flags|=6;state[2]=frozen;}}
 ulong k=(ulong)(f-1)*4;events[k]=flags;events[k+1]=state[1];events[k+2]=duration;events[k+3]=(long)sad;if(!frozen){state[0]=f;state[1]=pt;}
}
__kernel void carry(__global uchar* data,__global const uint* cfg,__global long* state,uint count){
 uint j=get_global_id(0);if(j>=cfg[0])return;data[j]=data[(ulong)count*cfg[0]+j];long ref=state[0];if(ref>=0)data[(ulong)(cfg[7]+1)*cfg[0]+j]=data[(ulong)ref*cfg[0]+j];
}
__kernel void carry_state(__global long* state,__global const uint* cfg){if(!get_global_id(0)&&state[0]>=0)state[0]=cfg[7]+1;}
`;

const hostPrefix=hashHostSource.slice(0,hashHostSource.indexOf(' static Dictionary<string,object> Run(')).replace('public static class HashAuditGpu','public static class WholeFileGpu');
export const wholeHostSource=hostPrefix+String.raw`
 [DllImport(Dll)] static extern int clEnqueueCopyBuffer(IntPtr q,IntPtr src,IntPtr dst,UIntPtr so,UIntPtr dest,UIntPtr bytes,uint n,IntPtr wait,out IntPtr ev);
 static Dictionary<string,object> Obj(object o){return (Dictionary<string,object>)o;}
 static uint U(Dictionary<string,object> d,string k){return Convert.ToUInt32(d[k]);}
 static byte[] Bytes(Array a){byte[] b=new byte[System.Buffer.ByteLength(a)];System.Buffer.BlockCopy(a,0,b,0,b.Length);return b;}
 static void Put(IntPtr q,IntPtr b,byte[] data,ulong offset){GCHandle h=GCHandle.Alloc(data,GCHandleType.Pinned);try{IntPtr ev;Check(clEnqueueWriteBuffer(q,b,1,(UIntPtr)offset,(UIntPtr)data.Length,h.AddrOfPinnedObject(),0,IntPtr.Zero,out ev));Time(ev);}finally{h.Free();}}
 static IntPtr Make(IntPtr p,string name){int e;IntPtr k=clCreateKernel(p,name,out e);Check(e);return k;}
 static void B(IntPtr k,uint i,IntPtr b){Check(clSetKernelArg(k,i,(UIntPtr)IntPtr.Size,ref b));}
 static void I(IntPtr k,uint i,uint v){Check(ArgInt(k,i,(UIntPtr)4,ref v));}
 static void Enqueue(IntPtr q,IntPtr k,ulong x,ulong y,List<IntPtr> events){IntPtr ev;Check(clEnqueueNDRangeKernel(q,k,y==0?1u:2u,IntPtr.Zero,y==0?new UIntPtr[]{(UIntPtr)x}:new UIntPtr[]{(UIntPtr)x,(UIntPtr)y},IntPtr.Zero,0,IntPtr.Zero,out ev));events.Add(ev);}
 static bool ReadFrame(Stream s,byte[] b,int offset,int bytes){int n=0;while(n<bytes){int r=s.Read(b,offset+n,bytes-n);if(r==0){if(n!=0)throw new Exception("Truncated native frame");return false;}n+=r;}return true;}
 static string Quote(string s){if(s.IndexOf('"')>=0)throw new Exception("Unexpected quote");return "\""+s+"\"";}
 public static int Main(string[] args){
  var json=new JavaScriptSerializer{MaxJsonLength=1024*1024*1024};var result=new Dictionary<string,object>{{"outcome","running"},{"cpuFallbackAllowed",false}};var output=new List<object>();result["frames"]=output;
  IntPtr c=IntPtr.Zero,q=IntPtr.Zero,program=IntPtr.Zero;var buffers=new List<IntPtr>();var kernels=new List<IntPtr>();Process proc=null;
  try{
   var job=Obj(json.DeserializeObject(File.ReadAllText(args[1])));uint wanted=U(job,"device"),index=0;IntPtr device=IntPtr.Zero;uint np;Check(clGetPlatformIDs(0,null,out np));IntPtr[] ps=new IntPtr[np];Check(clGetPlatformIDs(np,ps,out np));
   foreach(IntPtr p in ps){uint nd;int e=clGetDeviceIDs(p,4,0,null,out nd);if(e==-1)continue;Check(e);IntPtr[] ds=new IntPtr[nd];Check(clGetDeviceIDs(p,4,nd,ds,out nd));foreach(IntPtr d in ds){if(index++==wanted)device=d;}}
   if(device==IntPtr.Zero||(Numeric(device,0x1000)&4)==0)throw new Exception("Requested actual GPU unavailable");
   result["device"]=new{name=Info(device,0x102B),driver=Info(device,0x102D),version=Info(device,0x102F),deviceType=Numeric(device,0x1000),fp64=Numeric(device,0x1032)};
   Stopwatch setup=Stopwatch.StartNew();int err;c=clCreateContext(IntPtr.Zero,1,new IntPtr[]{device},IntPtr.Zero,IntPtr.Zero,out err);Check(err);q=clCreateCommandQueue(c,device,2,out err);Check(err);program=clCreateProgramWithSource(c,1,new string[]{File.ReadAllText(args[0])},IntPtr.Zero,out err);Check(err);err=clBuildProgram(program,1,new IntPtr[]{device},"-cl-std=CL1.2",IntPtr.Zero,IntPtr.Zero);
   if(err!=0){UIntPtr n;clGetProgramBuildInfo(program,device,0x1183,UIntPtr.Zero,null,out n);byte[] b=new byte[(int)n.ToUInt64()];clGetProgramBuildInfo(program,device,0x1183,n,b,out n);throw new Exception(Encoding.UTF8.GetString(b));}
   if(job.ContainsKey("thresholdCases")){byte[] cases=File.ReadAllBytes((string)job["thresholdCases"]),answers=new byte[cases.Length/24*4];IntPtr cb=Buffer(c,cases.Length),ob=Buffer(c,answers.Length);buffers.Add(cb);buffers.Add(ob);Put(q,cb,cases,0);IntPtr tk=Make(program,"threshold_probe");kernels.Add(tk);B(tk,0,cb);B(tk,1,ob);I(tk,2,(uint)(cases.Length/24));var te=new List<IntPtr>();Enqueue(q,tk,(ulong)(cases.Length/24),0,te);Check(clFinish(q));double ts=0;foreach(IntPtr e in te)ts+=Time(e);Transfer(q,ob,answers,false);File.WriteAllBytes((string)job["thresholdOutput"],answers);result["thresholdCount"]=cases.Length/24;result["kernelSeconds"]=ts;result["outcome"]="passed";return 0;}
   uint bytes=U(job,"bytes"),capacity=U(job,"capacity"),components=U(job,"components"),tileCount=U(job,"tiles"),depth=U(job,"depth"),width=U(job,"width"),height=U(job,"height"),tbN=U(job,"tbN"),tbD=U(job,"tbD"),samples=U(job,"samples"),blocks=(bytes+72)/64;
   object[] pp=(object[])job["pts"],dd=(object[])job["descriptors"];long[] allPts=new long[pp.Length];for(int i=0;i<pp.Length;i++)allPts[i]=Convert.ToInt64(pp[i]);uint[] desc=new uint[dd.Length];for(int i=0;i<dd.Length;i++)desc[i]=Convert.ToUInt32(dd[i]);
   uint[] cfg={bytes,U(job,"storage"),U(job,"shift"),U(job,"bigEndian"),depth,components,tileCount,capacity,U(job,"paddingMask")};
   Func<int,IntPtr> alloc=n=>{IntPtr b=Buffer(c,n);buffers.Add(b);return b;};
   IntPtr raw=alloc(checked((int)(bytes*capacity))),data=alloc(checked((int)(bytes*(capacity+2)))),words=alloc(checked((int)(blocks*64*capacity))),states=alloc(checked((int)(capacity*32))),digest=alloc(checked((int)(capacity*32))),config=alloc(cfg.Length*4),descriptors=alloc(desc.Length*4),tiles=alloc(checked((int)(tileCount*capacity*32))),diff=alloc(checked((int)(components*capacity*64))),fsums=alloc((int)tileCount*8),fstate=alloc(24),pts=alloc((int)capacity*8),fevents=alloc((int)capacity*32),invalid=alloc(4);
   Put(q,config,Bytes(cfg),0);Put(q,descriptors,Bytes(desc),0);Put(q,fstate,Bytes(new long[]{-1,0,0}),0);
   Func<string,IntPtr> make=n=>{IntPtr k=Make(program,n);kernels.Add(k);return k;};
   IntPtr can=make("canonical"),prep=make("sha_prepare"),sha=make("sha_complete"),dt=make("difference_tiles"),dr=make("difference_reduce"),ft=make("freeze_tiles"),fr=make("freeze_reduce"),carry=make("carry"),cs=make("carry_state");
   B(can,0,raw);B(can,1,data);I(can,2,bytes);I(can,4,width);I(can,5,height);I(can,6,depth);I(can,7,U(job,"packed"));B(can,8,invalid);
   B(prep,0,data);B(prep,1,words);I(prep,2,bytes);I(prep,4,blocks);B(sha,0,words);B(sha,1,states);B(sha,2,digest);I(sha,4,blocks);I(sha,6,2048);
   B(dt,0,data);B(dt,1,config);B(dt,2,descriptors);B(dt,3,tiles);B(dr,0,tiles);B(dr,1,config);B(dr,2,descriptors);B(dr,3,diff);
   B(ft,0,data);B(ft,1,config);B(ft,2,descriptors);B(ft,3,fstate);B(ft,4,fsums);B(fr,0,fsums);B(fr,1,config);B(fr,2,fstate);B(fr,3,pts);B(fr,4,fevents);I(fr,6,tbN);I(fr,7,tbD);I(fr,8,samples);B(carry,0,data);B(carry,1,config);B(carry,2,fstate);B(cs,0,fstate);B(cs,1,config);
   setup.Stop();result["setupSeconds"]=setup.Elapsed.TotalSeconds;result["capacity"]=capacity;result["shaBlocksPerLaunch"]=2048;result["allocatedDeviceBytesEstimate"]=(long)bytes*(capacity*3+2)+(long)tileCount*capacity*32;
   byte[] host=new byte[checked((int)(bytes*capacity))];var batches=new List<object>();result["batches"]=batches;
   var psi=new ProcessStartInfo((string)job["ffmpeg"]){UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true};var sa=new List<string>();foreach(object a in (object[])job["decodeArgs"])sa.Add(Quote((string)a));psi.Arguments=String.Join(" ",sa.ToArray());
   Stopwatch pipeline=Stopwatch.StartNew();proc=Process.Start(psi);var stderr=proc.StandardError.ReadToEndAsync();int total=0;double waiting=0,upload=0,read=0,kernel=0;
   while(true){Stopwatch bw=Stopwatch.StartNew(),wait=Stopwatch.StartNew();uint count=0;while(count<capacity&&ReadFrame(proc.StandardOutput.BaseStream,host,(int)(count*bytes),(int)bytes))count++;wait.Stop();waiting+=wait.Elapsed.TotalSeconds;if(count==0)break;if(total+count>allPts.Length)throw new Exception("Decoded frames exceed source scan");
    byte[] actual=count==capacity?host:new byte[count*bytes];if(actual!=host)System.Buffer.BlockCopy(host,0,actual,0,actual.Length);Stopwatch uw=Stopwatch.StartNew();Put(q,raw,actual,0);Put(q,invalid,new byte[4],0);long[] pt=new long[count];Array.Copy(allPts,total,pt,0,count);Put(q,pts,Bytes(pt),0);uw.Stop();upload+=uw.Elapsed.TotalSeconds;
    var ev=new List<IntPtr>();I(can,3,count);Enqueue(q,can,(ulong)bytes*count,0,ev);I(prep,3,count);Enqueue(q,prep,(ulong)blocks*16*count,0,ev);I(sha,3,count);for(uint start=0;start<blocks;start+=2048){I(sha,5,start);Enqueue(q,sha,count,0,ev);}
    I(dt,4,count);I(dt,5,total==0?1u:0u);Enqueue(q,dt,tileCount,count,ev);I(dr,4,count);Enqueue(q,dr,components,count,ev);
    for(uint f=1;f<=count;f++){I(ft,5,f);Enqueue(q,ft,tileCount,0,ev);I(fr,5,f);Enqueue(q,fr,1,0,ev);}I(carry,3,count);Enqueue(q,carry,bytes,0,ev);Enqueue(q,cs,1,0,ev);Check(clFinish(q));double ks=0;foreach(IntPtr e in ev)ks+=Time(e);kernel+=ks;
    byte[] hashes=new byte[count*32],difference=new byte[count*components*64],freeze=new byte[count*32],bad=new byte[4];Stopwatch rw=Stopwatch.StartNew();Transfer(q,digest,hashes,false);Transfer(q,diff,difference,false);Transfer(q,fevents,freeze,false);Transfer(q,invalid,bad,false);rw.Stop();read+=rw.Elapsed.TotalSeconds;if(BitConverter.ToUInt32(bad,0)!=0)throw new Exception("P010 non-sample low bits are not zero");
    for(int f=0;f<count;f++){var rows=new List<object>();bool equal=true;for(int ci=0;ci<components;ci++){int o=(f*(int)components+ci)*64;ulong[] row=new ulong[7];for(int j=0;j<7;j++)row[j]=BitConverter.ToUInt64(difference,o+j*8);if(BitConverter.ToUInt64(difference,o+56)!=0)throw new Exception("Nonzero native sample padding");if(row[1]!=0)equal=false;rows.Add(row);}long[] fe=new long[4];for(int j=0;j<4;j++)fe[j]=BitConverter.ToInt64(freeze,f*32+j*8);output.Add(new Dictionary<string,object>{{"frame",total+f},{"sha256",BitConverter.ToString(hashes,f*32,32).Replace("-","").ToLowerInvariant()},{"equalPrevious",total+f==0?(object)null:equal},{"difference",total+f==0||equal?null:rows},{"freeze",fe}});}
    bw.Stop();batches.Add(new{startFrame=total,count,kernelSeconds=ks,wallSeconds=bw.Elapsed.TotalSeconds,readWaitSeconds=wait.Elapsed.TotalSeconds});total+=(int)count;Console.Error.WriteLine("GPU frames "+total+" / "+allPts.Length);
   }
   proc.WaitForExit();pipeline.Stop();result["decoderStderr"]=stderr.Result;result["decoderExitCode"]=proc.ExitCode;if(proc.ExitCode!=0)throw new Exception(stderr.Result);if(total!=allPts.Length)throw new Exception("Decoded frame count differs from source scan");result["pipelineSeconds"]=pipeline.Elapsed.TotalSeconds;result["readWaitSeconds"]=waiting;result["uploadWallSeconds"]=upload;result["readbackWallSeconds"]=read;result["kernelEventSeconds"]=kernel;result["outcome"]="passed";
  }catch(Exception e){result["outcome"]="failed";result["error"]=e.ToString();}
  finally{if(proc!=null&&!proc.HasExited)proc.Kill();foreach(IntPtr k in kernels)clReleaseKernel(k);foreach(IntPtr b in buffers)clReleaseMemObject(b);if(program!=IntPtr.Zero)clReleaseProgram(program);if(q!=IntPtr.Zero)clReleaseCommandQueue(q);if(c!=IntPtr.Zero)clReleaseContext(c);File.WriteAllText(args[2],json.Serialize(result),new UTF8Encoding(false));}return (string)result["outcome"]=="passed"?0:1;
 }
}
`;
