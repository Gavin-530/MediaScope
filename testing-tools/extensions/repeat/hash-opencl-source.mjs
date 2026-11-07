// Test-only integer implementations of FIPS 180-4 SHA-256/SHA-512 and
// FIPS 202 SHA3-256. They are not a product backend or a certified module.
// One work-item owns one message. State is carried between bounded launches;
// splitting launches does NOT replace a standard digest with a tree hash.
export const hashKernelSource=String.raw`
uint r32(uint x,uint n){return (x>>n)|(x<<(32-n));}
ulong r64(ulong x,uint n){return (x>>n)|(x<<(64-n));}
ulong l64(ulong x,uint n){return n?((x<<n)|(x>>(64-n))):x;}
__constant uint k256[64]={
0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
__constant ulong k512[80]={
0x428a2f98d728ae22UL,0x7137449123ef65cdUL,0xb5c0fbcfec4d3b2fUL,0xe9b5dba58189dbbcUL,
0x3956c25bf348b538UL,0x59f111f1b605d019UL,0x923f82a4af194f9bUL,0xab1c5ed5da6d8118UL,
0xd807aa98a3030242UL,0x12835b0145706fbeUL,0x243185be4ee4b28cUL,0x550c7dc3d5ffb4e2UL,
0x72be5d74f27b896fUL,0x80deb1fe3b1696b1UL,0x9bdc06a725c71235UL,0xc19bf174cf692694UL,
0xe49b69c19ef14ad2UL,0xefbe4786384f25e3UL,0x0fc19dc68b8cd5b5UL,0x240ca1cc77ac9c65UL,
0x2de92c6f592b0275UL,0x4a7484aa6ea6e483UL,0x5cb0a9dcbd41fbd4UL,0x76f988da831153b5UL,
0x983e5152ee66dfabUL,0xa831c66d2db43210UL,0xb00327c898fb213fUL,0xbf597fc7beef0ee4UL,
0xc6e00bf33da88fc2UL,0xd5a79147930aa725UL,0x06ca6351e003826fUL,0x142929670a0e6e70UL,
0x27b70a8546d22ffcUL,0x2e1b21385c26c926UL,0x4d2c6dfc5ac42aedUL,0x53380d139d95b3dfUL,
0x650a73548baf63deUL,0x766a0abb3c77b2a8UL,0x81c2c92e47edaee6UL,0x92722c851482353bUL,
0xa2bfe8a14cf10364UL,0xa81a664bbc423001UL,0xc24b8b70d0f89791UL,0xc76c51a30654be30UL,
0xd192e819d6ef5218UL,0xd69906245565a910UL,0xf40e35855771202aUL,0x106aa07032bbd1b8UL,
0x19a4c116b8d2d0c8UL,0x1e376c085141ab53UL,0x2748774cdf8eeb99UL,0x34b0bcb5e19b48a8UL,
0x391c0cb3c5c95a63UL,0x4ed8aa4ae3418acbUL,0x5b9cca4f7763e373UL,0x682e6ff3d6b2b8a3UL,
0x748f82ee5defb2fcUL,0x78a5636f43172f60UL,0x84c87814a1f0ab72UL,0x8cc702081a6439ecUL,
0x90befffa23631e28UL,0xa4506cebde82bde9UL,0xbef9a3f7b2c67915UL,0xc67178f2e372532bUL,
0xca273eceea26619cUL,0xd186b8c721c0c207UL,0xeada7dd6cde0eb1eUL,0xf57d4f7fee6ed178UL,
0x06f067aa72176fbaUL,0x0a637dc5a2c898a6UL,0x113f9804bef90daeUL,0x1b710b35131c471bUL,
0x28db77f523047d84UL,0x32caab7b40c72493UL,0x3c9ebe0a15c9bebcUL,0x431d67c49c100d4cUL,
0x4cc5d4becb3e42b6UL,0x597f299cfc657e2aUL,0x5fcb6fab3ad6faecUL,0x6c44198c4a475817UL};
__constant ulong iv512[8]={0x6a09e667f3bcc908UL,0xbb67ae8584caa73bUL,0x3c6ef372fe94f82bUL,0xa54ff53a5f1d36f1UL,0x510e527fade682d1UL,0x9b05688c2b3e6c1fUL,0x1f83d9abfb41bd6bUL,0x5be0cd19137e2179UL};
__constant uint iv256[8]={0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
// All audit messages are byte-aligned and below 2^61 bytes. SHA-512's upper
// 64 length bits are therefore zero; bit-oriented CAVP messages are excluded.
uchar shaByte(__global const uchar *p,ulong off,ulong n,ulong i,ulong total){
 if(i<n)return p[off+i];if(i==n)return 0x80;
 if(i>=total-8)return (uchar)((n*8)>>(8*(total-1-i)));return 0;
}
#define ARGS __global const uchar *data,__global const ulong *offsets,__global const ulong *lengths,__global ulong *states,__global uchar *out,uint base,uint span,uint count
__kernel void sha256(ARGS){
 uint id=get_global_id(0);if(id>=count)return;ulong n=lengths[id],off=offsets[id],blocks=(n+9+63)/64;if(base>=blocks)return;
 uint h[8];for(int j=0;j<8;j++)h[j]=base?(uint)states[id*32+j]:iv256[j];ulong end=min((ulong)base+span,blocks);
 for(ulong block=base;block<end;block++){
  uint w[16];for(int j=0;j<16;j++){w[j]=0;for(int z=0;z<4;z++)w[j]=(w[j]<<8)|shaByte(data,off,n,block*64+j*4+z,blocks*64);}
  uint a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
  for(int t=0;t<64;t++){
   if(t>=16){uint x=w[(t-15)&15],y=w[(t-2)&15];w[t&15]+=(r32(x,7)^r32(x,18)^(x>>3))+w[(t-7)&15]+(r32(y,17)^r32(y,19)^(y>>10));}
   uint t1=hh+(r32(e,6)^r32(e,11)^r32(e,25))+((e&f)^(~e&g))+k256[t]+w[t&15];
   uint t2=(r32(a,2)^r32(a,13)^r32(a,22))+((a&b)^(a&c)^(b&c));hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
  }
  h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
 }
 for(int j=0;j<8;j++){states[id*32+j]=h[j];if(end==blocks)for(int z=0;z<4;z++)out[id*32+j*4+z]=(uchar)(h[j]>>(24-z*8));}
}
__kernel void sha512(ARGS){
 uint id=get_global_id(0);if(id>=count)return;ulong n=lengths[id],off=offsets[id],blocks=(n+17+127)/128;if(base>=blocks)return;
 ulong h[8];for(int j=0;j<8;j++)h[j]=base?states[id*32+j]:iv512[j];ulong end=min((ulong)base+span,blocks);
 for(ulong block=base;block<end;block++){
  ulong w[16];for(int j=0;j<16;j++){w[j]=0;for(int z=0;z<8;z++)w[j]=(w[j]<<8)|shaByte(data,off,n,block*128+j*8+z,blocks*128);}
  ulong a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
  for(int t=0;t<80;t++){
   if(t>=16){ulong x=w[(t-15)&15],y=w[(t-2)&15];w[t&15]+=(r64(x,1)^r64(x,8)^(x>>7))+w[(t-7)&15]+(r64(y,19)^r64(y,61)^(y>>6));}
   ulong t1=hh+(r64(e,14)^r64(e,18)^r64(e,41))+((e&f)^(~e&g))+k512[t]+w[t&15];
   ulong t2=(r64(a,28)^r64(a,34)^r64(a,39))+((a&b)^(a&c)^(b&c));hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
  }
  h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
 }
 for(int j=0;j<8;j++){states[id*32+j]=h[j];if(end==blocks)for(int z=0;z<8;z++)out[id*64+j*8+z]=(uchar)(h[j]>>(56-z*8));}
}
__constant ulong rc[24]={0x0000000000000001UL,0x0000000000008082UL,0x800000000000808aUL,0x8000000080008000UL,0x000000000000808bUL,0x0000000080000001UL,0x8000000080008081UL,0x8000000000008009UL,0x000000000000008aUL,0x0000000000000088UL,0x0000000080008009UL,0x000000008000000aUL,0x000000008000808bUL,0x800000000000008bUL,0x8000000000008089UL,0x8000000000008003UL,0x8000000000008002UL,0x8000000000000080UL,0x000000000000800aUL,0x800000008000000aUL,0x8000000080008081UL,0x8000000000008080UL,0x0000000080000001UL,0x8000000080008008UL};
__constant uint rho[25]={0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14};
__kernel void sha3_256(ARGS){
 uint id=get_global_id(0);if(id>=count)return;ulong n=lengths[id],off=offsets[id],blocks=n/136+1;if(base>=blocks)return;
 ulong a[25];for(int j=0;j<25;j++)a[j]=base?states[id*32+j]:0;ulong end=min((ulong)base+span,blocks);
 for(ulong block=base;block<end;block++){
  for(int j=0;j<136;j++){ulong i=block*136+j;uchar v=i<n?data[off+i]:i==n?6:0;if(i==blocks*136-1)v|=128;a[j/8]^=(ulong)v<<(8*(j%8));}
  for(int round=0;round<24;round++){
   ulong c[5],d[5],b[25];for(int x=0;x<5;x++)c[x]=a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20];
   for(int x=0;x<5;x++)d[x]=c[(x+4)%5]^l64(c[(x+1)%5],1);
   for(int y=0;y<5;y++)for(int x=0;x<5;x++)a[x+5*y]^=d[x];
   for(int y=0;y<5;y++)for(int x=0;x<5;x++)b[y+5*((2*x+3*y)%5)]=l64(a[x+5*y],rho[x+5*y]);
   for(int y=0;y<5;y++)for(int x=0;x<5;x++)a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]);a[0]^=rc[round];
  }
 }
 for(int j=0;j<25;j++)states[id*32+j]=a[j];if(end==blocks)for(int j=0;j<32;j++)out[id*32+j]=(uchar)(a[j/8]>>(8*(j%8)));
}
`;

export const hashHostSource=String.raw`
using System;using System.IO;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Diagnostics;using System.Web.Script.Serialization;
public static class HashAuditGpu {
 const string Dll="OpenCL.dll";
 [DllImport(Dll)] static extern int clGetPlatformIDs(uint n,[Out] IntPtr[] p,out uint count);
 [DllImport(Dll)] static extern int clGetDeviceIDs(IntPtr p,ulong type,uint n,[Out] IntPtr[] d,out uint count);
 [DllImport(Dll)] static extern int clGetDeviceInfo(IntPtr d,uint key,UIntPtr size,[Out] byte[] value,out UIntPtr actual);
 [DllImport(Dll)] static extern IntPtr clCreateContext(IntPtr props,uint n,IntPtr[] d,IntPtr cb,IntPtr data,out int error);
 [DllImport(Dll)] static extern IntPtr clCreateCommandQueue(IntPtr c,IntPtr d,ulong props,out int error);
 [DllImport(Dll)] static extern IntPtr clCreateProgramWithSource(IntPtr c,uint n,string[] source,IntPtr lengths,out int error);
 [DllImport(Dll)] static extern int clBuildProgram(IntPtr p,uint n,IntPtr[] d,string options,IntPtr cb,IntPtr data);
 [DllImport(Dll)] static extern int clGetProgramBuildInfo(IntPtr p,IntPtr d,uint key,UIntPtr size,[Out] byte[] value,out UIntPtr actual);
 [DllImport(Dll)] static extern IntPtr clCreateKernel(IntPtr p,string name,out int error);
 [DllImport(Dll)] static extern IntPtr clCreateBuffer(IntPtr c,ulong flags,UIntPtr size,IntPtr data,out int error);
 [DllImport(Dll)] static extern int clSetKernelArg(IntPtr k,uint i,UIntPtr size,ref IntPtr value);
 [DllImport(Dll,EntryPoint="clSetKernelArg")] static extern int ArgInt(IntPtr k,uint i,UIntPtr size,ref uint value);
 [DllImport(Dll)] static extern int clEnqueueNDRangeKernel(IntPtr q,IntPtr k,uint dim,IntPtr off,UIntPtr[] global,IntPtr local,uint n,IntPtr wait,out IntPtr ev);
 [DllImport(Dll)] static extern int clEnqueueWriteBuffer(IntPtr q,IntPtr b,uint blocking,UIntPtr off,UIntPtr size,IntPtr data,uint n,IntPtr wait,out IntPtr ev);
 [DllImport(Dll)] static extern int clEnqueueReadBuffer(IntPtr q,IntPtr b,uint blocking,UIntPtr off,UIntPtr size,IntPtr data,uint n,IntPtr wait,out IntPtr ev);
 [DllImport(Dll)] static extern int clGetEventProfilingInfo(IntPtr ev,uint key,UIntPtr size,out ulong value,out UIntPtr actual);
 [DllImport(Dll)] static extern int clFinish(IntPtr q);
 [DllImport(Dll)] static extern int clReleaseEvent(IntPtr p);
 [DllImport(Dll)] static extern int clReleaseMemObject(IntPtr p);
 [DllImport(Dll)] static extern int clReleaseKernel(IntPtr p);
 [DllImport(Dll)] static extern int clReleaseProgram(IntPtr p);
 [DllImport(Dll)] static extern int clReleaseCommandQueue(IntPtr p);
 [DllImport(Dll)] static extern int clReleaseContext(IntPtr p);
 static void Check(int e){if(e!=0)throw new Exception("OpenCL error "+e);}
 static string Info(IntPtr d,uint key){UIntPtr len;Check(clGetDeviceInfo(d,key,UIntPtr.Zero,null,out len));byte[] b=new byte[(int)len.ToUInt64()];Check(clGetDeviceInfo(d,key,len,b,out len));return Encoding.UTF8.GetString(b).TrimEnd('\0');}
 static ulong Numeric(IntPtr d,uint key){UIntPtr n;byte[] b=new byte[8];Check(clGetDeviceInfo(d,key,(UIntPtr)8,b,out n));return BitConverter.ToUInt64(b,0);}
 static double Time(IntPtr ev){ulong start,end;UIntPtr n;Check(clGetEventProfilingInfo(ev,0x1282,(UIntPtr)8,out start,out n));Check(clGetEventProfilingInfo(ev,0x1283,(UIntPtr)8,out end,out n));Check(clReleaseEvent(ev));return (end-start)*1e-9;}
 static IntPtr Buffer(IntPtr c,int bytes){int e;IntPtr b=clCreateBuffer(c,1,(UIntPtr)Math.Max(1,bytes),IntPtr.Zero,out e);Check(e);return b;}
 static double Transfer(IntPtr q,IntPtr b,byte[] data,bool upload){if(data.Length==0)return 0;GCHandle pin=GCHandle.Alloc(data,GCHandleType.Pinned);try{IntPtr ev;Check(upload?clEnqueueWriteBuffer(q,b,1,UIntPtr.Zero,(UIntPtr)data.Length,pin.AddrOfPinnedObject(),0,IntPtr.Zero,out ev):clEnqueueReadBuffer(q,b,1,UIntPtr.Zero,(UIntPtr)data.Length,pin.AddrOfPinnedObject(),0,IntPtr.Zero,out ev));return Time(ev);}finally{pin.Free();}}
 static Dictionary<string,object> Run(IntPtr c,IntPtr q,IntPtr program,Dictionary<string,object> job){
  string alg=(string)job["algorithm"];uint count=Convert.ToUInt32(job["count"]),span=256;int size=alg=="sha512"?64:32;
  byte[] data=File.ReadAllBytes((string)job["dataFile"]),offsets=File.ReadAllBytes((string)job["offsetsFile"]),lengths=File.ReadAllBytes((string)job["lengthsFile"]),output=new byte[count*size];
  ulong longest=0;for(int i=0;i<count;i++){ulong len=BitConverter.ToUInt64(lengths,i*8),offset=BitConverter.ToUInt64(offsets,i*8);if(offset+len>(ulong)data.Length)throw new Exception("Input bounds");longest=Math.Max(longest,len);}
  uint blocks=(uint)(alg=="sha256"?(longest+72)/64:alg=="sha512"?(longest+144)/128:longest/136+1);
  IntPtr input=IntPtr.Zero,offs=IntPtr.Zero,lens=IntPtr.Zero,state=IntPtr.Zero,digest=IntPtr.Zero,kernel=IntPtr.Zero;
  var timings=new List<object>();
  try{
   input=Buffer(c,data.Length);offs=Buffer(c,offsets.Length);lens=Buffer(c,lengths.Length);state=Buffer(c,(int)count*32*8);digest=Buffer(c,output.Length);
   int e;kernel=clCreateKernel(program,alg,out e);Check(e);IntPtr[] buffers={input,offs,lens,state,digest};for(uint i=0;i<5;i++)Check(clSetKernelArg(kernel,i,(UIntPtr)IntPtr.Size,ref buffers[i]));
   Check(ArgInt(kernel,6,(UIntPtr)4,ref span));Check(ArgInt(kernel,7,(UIntPtr)4,ref count));
   Transfer(q,offs,offsets,true);Transfer(q,lens,lengths,true);Transfer(q,input,data,true);
   int warmups=Convert.ToInt32(job["warmups"]),repetitions=Convert.ToInt32(job["repetitions"]);bool benchmark=(bool)job["benchmark"];
   foreach(string mode in benchmark?new string[]{"resident","upload-inclusive"}:new string[]{"verification"}){
    for(int rep=-warmups;rep<repetitions;rep++){
     double upload=0,compute=0,read=0;Stopwatch wall=Stopwatch.StartNew();if(mode!="resident")upload=Transfer(q,input,data,true);
     var events=new List<IntPtr>();
     for(uint start=0;start<blocks;start+=span){Check(ArgInt(kernel,5,(UIntPtr)4,ref start));IntPtr ev;Check(clEnqueueNDRangeKernel(q,kernel,1,IntPtr.Zero,new UIntPtr[]{(UIntPtr)count},IntPtr.Zero,0,IntPtr.Zero,out ev));events.Add(ev);}
     Check(clFinish(q));foreach(IntPtr ev in events)compute+=Time(ev);read=Transfer(q,digest,output,false);wall.Stop();
     // Keep every measured digest, not only a last-result spot check.
     string[] hashes=new string[count];for(int i=0;i<count;i++)hashes[i]=BitConverter.ToString(output,i*size,size).Replace("-","").ToLowerInvariant();
     if(rep>=0)timings.Add(new{mode,rep,uploadSeconds=upload,kernelSeconds=compute,readSeconds=read,wallSeconds=wall.Elapsed.TotalSeconds,hashes});
    }
   }
   return new Dictionary<string,object>{{"name",job["name"]},{"algorithm",alg},{"count",count},{"bytes",data.Length},{"blocksPerLaunch",span},{"launchesPerHashBatch",(blocks+span-1)/span},{"measurements",timings},{"outcome","executed"}};
  }finally{if(kernel!=IntPtr.Zero)clReleaseKernel(kernel);foreach(IntPtr b in new IntPtr[]{input,offs,lens,state,digest})if(b!=IntPtr.Zero)clReleaseMemObject(b);}
 }
 public static int Main(string[] args){
  var json=new JavaScriptSerializer{MaxJsonLength=1024*1024*1024};var devices=new List<object>();var report=new Dictionary<string,object>{{"devices",devices},{"outcome","running"},{"cpuFallbackAllowed",false}};int code=0;
  try{
   object[] jobs=(object[])json.DeserializeObject(File.ReadAllText(args[1]));uint np;Check(clGetPlatformIDs(0,null,out np));IntPtr[] platforms=new IntPtr[np];Check(clGetPlatformIDs(np,platforms,out np));int index=0;
   foreach(IntPtr p in platforms){uint nd;int result=clGetDeviceIDs(p,4,0,null,out nd);if(result==-1)continue;Check(result);IntPtr[] ds=new IntPtr[nd];Check(clGetDeviceIDs(p,4,nd,ds,out nd));
    foreach(IntPtr d in ds){var runs=new List<object>();var device=new Dictionary<string,object>{{"index",index++},{"name",Info(d,0x102B)},{"vendor",Info(d,0x102C)},{"driver",Info(d,0x102D)},{"version",Info(d,0x102F)},{"openclC",Info(d,0x103D)},{"deviceType",Numeric(d,0x1000)},{"runs",runs},{"outcome","running"}};devices.Add(device);
     IntPtr c=IntPtr.Zero,q=IntPtr.Zero,program=IntPtr.Zero;
     try{if((Numeric(d,0x1000)&4)==0)throw new Exception("Selected device is not a GPU");int e;c=clCreateContext(IntPtr.Zero,1,new IntPtr[]{d},IntPtr.Zero,IntPtr.Zero,out e);Check(e);q=clCreateCommandQueue(c,d,2,out e);Check(e);
      device["stage"]="compiling";File.WriteAllText(args[2],json.Serialize(report),new UTF8Encoding(false));Stopwatch build=Stopwatch.StartNew();program=clCreateProgramWithSource(c,1,new string[]{File.ReadAllText(args[0])},IntPtr.Zero,out e);Check(e);e=clBuildProgram(program,1,new IntPtr[]{d},"-cl-std=CL1.2",IntPtr.Zero,IntPtr.Zero);
      if(e!=0){UIntPtr n;clGetProgramBuildInfo(program,d,0x1183,UIntPtr.Zero,null,out n);byte[] b=new byte[(int)n.ToUInt64()];clGetProgramBuildInfo(program,d,0x1183,n,b,out n);throw new Exception("Build: "+Encoding.UTF8.GetString(b));}build.Stop();device["buildSeconds"]=build.Elapsed.TotalSeconds;
      foreach(object j in jobs){var job=(Dictionary<string,object>)j;device["stage"]="executing "+job["name"];File.WriteAllText(args[2],json.Serialize(report),new UTF8Encoding(false));Console.Error.WriteLine("GPU "+device["name"]+" / "+job["name"]);runs.Add(Run(c,q,program,job));File.WriteAllText(args[2],json.Serialize(report),new UTF8Encoding(false));}device["stage"]="finished";device["outcome"]="executed";
     }catch(Exception ex){device["outcome"]="failed";device["error"]=ex.ToString();code=1;}
     finally{if(program!=IntPtr.Zero)clReleaseProgram(program);if(q!=IntPtr.Zero)clReleaseCommandQueue(q);if(c!=IntPtr.Zero)clReleaseContext(c);}
    }
   }
   if(index==0)throw new Exception("No actual OpenCL GPU; CPU fallback is prohibited");report["outcome"]=code==0?"executed":"failed";
  }catch(Exception ex){report["outcome"]="failed";report["error"]=ex.ToString();code=1;}
  finally{File.WriteAllText(args[2],json.Serialize(report),new UTF8Encoding(false));}return code;
 }
}
`;
