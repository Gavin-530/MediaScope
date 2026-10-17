using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;

namespace MediaScope {
// fp64 backend. Layout, display parameters and luma LUT come from the shared JS configuration.
public sealed class SitiOpenCl : IDisposable {
    // Must agree with public/analysis-limits.js; these are engineering limits.
    const int MaxFrames=2000000, MaxPixels=8192*4320;
    const string Dll="OpenCL.dll";
    [DllImport(Dll)] static extern int clGetPlatformIDs(uint n,[Out] IntPtr[] p,out uint count);
    [DllImport(Dll)] static extern int clGetDeviceIDs(IntPtr p,ulong type,uint n,[Out] IntPtr[] devices,out uint count);
    [DllImport(Dll)] static extern int clGetDeviceInfo(IntPtr d,uint key,UIntPtr size,[Out] byte[] value,out UIntPtr actual);
    [DllImport(Dll)] static extern IntPtr clCreateContext(IntPtr props,uint n,IntPtr[] d,IntPtr cb,IntPtr data,out int error);
    [DllImport(Dll)] static extern IntPtr clCreateCommandQueue(IntPtr c,IntPtr d,ulong props,out int error);
    [DllImport(Dll)] static extern IntPtr clCreateProgramWithSource(IntPtr c,uint n,string[] source,IntPtr lengths,out int error);
    [DllImport(Dll)] static extern int clBuildProgram(IntPtr p,uint n,IntPtr[] devices,string options,IntPtr cb,IntPtr data);
    [DllImport(Dll)] static extern int clGetProgramBuildInfo(IntPtr p,IntPtr d,uint key,UIntPtr size,[Out] byte[] value,out UIntPtr actual);
    [DllImport(Dll)] static extern IntPtr clCreateKernel(IntPtr p,string name,out int error);
    [DllImport(Dll)] static extern IntPtr clCreateBuffer(IntPtr c,ulong flags,UIntPtr size,IntPtr data,out int error);
    [DllImport(Dll)] static extern int clSetKernelArg(IntPtr k,uint i,UIntPtr size,ref IntPtr value);
    [DllImport(Dll,EntryPoint="clSetKernelArg")] static extern int ArgInt(IntPtr k,uint i,UIntPtr size,ref int value);
    [DllImport(Dll)] static extern int clEnqueueNDRangeKernel(IntPtr q,IntPtr k,uint dim,IntPtr offset,UIntPtr[] global,UIntPtr[] local,uint n,IntPtr wait,IntPtr ev);
    [DllImport(Dll)] static extern int clEnqueueWriteBuffer(IntPtr q,IntPtr b,uint blocking,UIntPtr offset,UIntPtr size,IntPtr data,uint n,IntPtr wait,IntPtr ev);
    [DllImport(Dll)] static extern int clEnqueueReadBuffer(IntPtr q,IntPtr b,uint blocking,UIntPtr offset,UIntPtr size,IntPtr data,uint n,IntPtr wait,IntPtr ev);
    [DllImport(Dll)] static extern int clReleaseMemObject(IntPtr p);
    [DllImport(Dll)] static extern int clReleaseKernel(IntPtr p);
    [DllImport(Dll)] static extern int clReleaseProgram(IntPtr p);
    [DllImport(Dll)] static extern int clReleaseCommandQueue(IntPtr p);
    [DllImport(Dll)] static extern int clReleaseContext(IntPtr p);
    static void Check(int e){if(e!=0)throw new Exception("OpenCL error "+e);}
    static string Info(IntPtr d,uint key){UIntPtr len;Check(clGetDeviceInfo(d,key,UIntPtr.Zero,null,out len));byte[] b=new byte[(int)len.ToUInt64()];Check(clGetDeviceInfo(d,key,len,b,out len));return Encoding.UTF8.GetString(b).TrimEnd('\0');}
    static ulong MemoryInfo(IntPtr d,uint key){UIntPtr len;byte[] b=new byte[8];Check(clGetDeviceInfo(d,key,(UIntPtr)8,b,out len));return BitConverter.ToUInt64(b,0);}
    static IntPtr Device(){
        uint n;Check(clGetPlatformIDs(0,null,out n));IntPtr[] platforms=new IntPtr[n];Check(clGetPlatformIDs(n,platforms,out n));
        foreach(IntPtr p in platforms){uint count;int e=clGetDeviceIDs(p,4,0,null,out count);if(e==-1)continue;Check(e);IntPtr[] devices=new IntPtr[count];Check(clGetDeviceIDs(p,4,count,devices,out count));foreach(IntPtr d in devices)if(Info(d,0x1030).Contains("cl_khr_fp64"))return d;}
        throw new Exception("No OpenCL GPU with cl_khr_fp64 support");
    }
    const string Source=@"
#pragma OPENCL EXTENSION cl_khr_fp64 : enable
#pragma OPENCL FP_CONTRACT OFF
uint sample(__global const uchar *raw,int i,int bytes,int little) {
    return bytes==1?raw[i]:little?((uint)raw[2*i]|((uint)raw[2*i+1]<<8)):((uint)raw[2*i+1]|((uint)raw[2*i]<<8));
}
uint code_at(__global const uchar *raw,int i,int bytes,int little,int shift,int maxCode,__private int *flags) {
    uint word=sample(raw,i,bytes,little),code=word>>shift;
    if((word&((1u<<shift)-1))||code>maxCode)*flags|=4;return code;
}
double transfer(double v,__global const double *p) {
    if(p[5]==0)return v;double luminance;
    if(p[5]==3){double linear=v<=.5?v*v/3:exp((v-p[12])/p[10])-p[11];luminance=(p[6]-p[7])*pow(linear,p[8])+p[7];}
    else if(p[5]==2){double linear=v<=.04045?v/12.92:pow((v+.055)/1.055,p[8]);luminance=(p[6]-p[7])*linear+p[7];}
    else luminance=(p[6]-p[7])*pow(v,p[8])+p[7];
    double y=pow(luminance/10000,p[13]);return pow((p[15]+p[16]*y)/(1+p[17]*y),p[14]);
}
__kernel void convert(__global const uchar *raw,__global double *curr,__global const double *lut,__global int *invalid,int n,int bytes,int shift,int little,int alpha,int maxCode,int layout,int stride,int red,int green,int blue) {
    int i=get_global_id(0);if(i>=n)return;int flags=0;double value;
    if(bytes){
        int base=i*stride;
        if(layout==2){
            uint r=code_at(raw,stride?base+red:red+i,bytes,little,shift,maxCode,&flags),g=code_at(raw,stride?base+green:green+i,bytes,little,shift,maxCode,&flags),b=code_at(raw,stride?base+blue:blue+i,bytes,little,shift,maxCode,&flags);
            if(r<lut[3]||r>lut[4]||g<lut[3]||g>lut[4]||b<lut[3]||b>lut[4])flags|=1;
            double v=lut[0]*(r-lut[3])/(lut[4]-lut[3])+lut[1]*(g-lut[3])/(lut[4]-lut[3])+lut[2]*(b-lut[3])/(lut[4]-lut[3]);value=transfer(fmin(1,fmax(0,v)),lut);
        }else{uint code=code_at(raw,i,bytes,little,shift,maxCode,&flags);value=code<=maxCode?lut[code]:NAN;}
        if(alpha>=0){uint a=code_at(raw,layout==2&&stride?base+alpha:alpha+i,bytes,little,shift,maxCode,&flags);if(a!=maxCode)flags|=2;}
    }else value=((__global const double*)raw)[i];
    if(!isfinite(value))flags|=1;
    if(flags){atomic_or((volatile __global int*)invalid,flags);value=0;}curr[i]=value;
}
__kernel void metrics(__global const double *curr,__global const double *prev,__global double *v,int w,int h,int first) {
    int i=get_global_id(0),n=w*h;if(i>=n)return;
    if(!first)v[n+i]=curr[i]-prev[i];
    int x=i%w,y=i/w;
    if(x>0&&x<w-1&&y>0&&y<h-1){
        double tl=curr[i-w-1],tr=curr[i-w+1],bl=curr[i+w-1],br=curr[i+w+1];
        double gx=-tl+tr-2*curr[i-1]+2*curr[i+1]-bl+br;
        double gy=-tl-2*curr[i-w]-tr+bl+2*curr[i+w]+br;
        v[(y-1)*(w-2)+x-1]=hypot(gx,gy);
    }
}
__kernel void reduce_values(__global const double *v,int offset,int n,__global const double *stats,int channel,int variance,__global double *out) {
    int i=get_global_id(0),l=get_local_id(0);__local double sums[256];double value=0;
    if(i<n){double x=v[offset+i];if(variance){double d=x-stats[channel];value=d*d;}else value=x;}
    sums[l]=value;barrier(CLK_LOCAL_MEM_FENCE);
    for(int step=128;step>0;step>>=1){if(l<step)sums[l]+=sums[l+step];barrier(CLK_LOCAL_MEM_FENCE);}
    if(l==0)out[get_group_id(0)]=sums[0];
}
__kernel void finish_stat(__global const double *partial,int groups,int count,__global double *stats,int channel,int variance) {
    if(get_global_id(0)!=0)return;double total=0,correction=0;
    for(int i=0;i<groups;i++){double y=partial[i]-correction,t=total+y;correction=(t-total)-y;total=t;}
    stats[channel+(variance?2:0)]=variance?sqrt(total/count):total/count;
}";
    IntPtr context,queue,program,convert,metrics,reduce,finish,raw,curr,prev,values,partial,stats,invalid,lut;
    int w,h,n,sampleBytes,depth,shift,little,frameBytes,alpha,layout,stride,red,green,blue,planeCapacity,rawCapacity,lutCapacity;double[] table;readonly double[] result=new double[4];
    readonly int[] invalidFlag=new int[1];
    public readonly string Name,Driver;
    readonly ulong maxAllocation,globalMemory;
    public SitiOpenCl(int width,int height,int storage,int bits,int padding,int endian,int payloadBytes,int alphaOffset,double[] lookup){
        try{
            IntPtr device=Device();Name=Info(device,0x102B);Driver=Info(device,0x102D);maxAllocation=MemoryInfo(device,0x1010);globalMemory=MemoryInfo(device,0x101F);int e;
            context=clCreateContext(IntPtr.Zero,1,new[]{device},IntPtr.Zero,IntPtr.Zero,out e);Check(e);queue=clCreateCommandQueue(context,device,0,out e);Check(e);
            program=clCreateProgramWithSource(context,1,new[]{Source},IntPtr.Zero,out e);Check(e);e=clBuildProgram(program,1,new[]{device},"-cl-std=CL1.2",IntPtr.Zero,IntPtr.Zero);
            if(e!=0){UIntPtr len;clGetProgramBuildInfo(program,device,0x1183,UIntPtr.Zero,null,out len);byte[] b=new byte[(int)len.ToUInt64()];clGetProgramBuildInfo(program,device,0x1183,len,b,out len);throw new Exception("OpenCL build: "+Encoding.UTF8.GetString(b));}
            convert=clCreateKernel(program,"convert",out e);Check(e);metrics=clCreateKernel(program,"metrics",out e);Check(e);reduce=clCreateKernel(program,"reduce_values",out e);Check(e);finish=clCreateKernel(program,"finish_stat",out e);Check(e);
            Configure(width,height,storage,bits,padding,endian,payloadBytes,alphaOffset,storage==0?0:1,0,0,0,0,lookup);
        }catch{Dispose();throw;}
    }
    bool Configure(int width,int height,int storage,int bits,int padding,int endian,int payloadBytes,int alphaOffset,int family,int pixelStride,int r,int g,int b,double[] lookup){
        if(width<3||height<3||(long)width*height>MaxPixels)throw new InputException("Invalid SITI GPU dimensions");
        w=width;h=height;n=checked(w*h);sampleBytes=storage/8;depth=bits;shift=padding;little=endian;frameBytes=payloadBytes;alpha=alphaOffset;table=lookup;layout=family;stride=pixelStride;red=r;green=g;blue=b;
        if(storage!=0&&storage!=8&&storage!=16||Array.IndexOf(new[]{8,9,10,12,14,16},depth)<0||shift!=0&&shift!=16-depth||little!=0&&little!=1||storage==8&&depth!=8||layout<0||layout>2||layout==0&&storage!=0||layout!=0&&storage==0||frameBytes<n*(storage==0?8:sampleBytes)||alpha< -1||stride<0||stride>4||layout!=2&&stride!=0||table.Length!=(layout==2?20:storage==0?1:1<<depth))throw new InputException("Invalid SITI native layout");
        if(layout==2&&(stride==0?(red!=2*n||green!=0||blue!=n):(stride<3||red<0||red>=stride||green<0||green>=stride||blue<0||blue>=stride))||layout==2&&frameBytes!=n*(stride==0?(alpha>=0?4:3):stride)*sampleBytes||alpha>=0&&(layout==2&&stride>0?alpha>=stride:(long)(alpha+n)*sampleBytes>frameBytes))throw new InputException("Invalid SITI RGB layout");
        if(layout==2){foreach(double v in table)if(double.IsNaN(v)||double.IsInfinity(v))throw new InputException("Invalid SITI display parameters");if(table[3]<0||table[4]>((1<<depth)-1)||table[3]>=table[4]||table[5]<0||table[5]>3)throw new InputException("Invalid SITI RGB parameters");}
        int capacity=Math.Max(n,469),payload=Math.Max(frameBytes,469*8),entries=table.Length;bool reused=planeCapacity>=capacity&&rawCapacity>=payload&&lutCapacity>=entries;
        if(!reused){
            int nextPlane=Math.Max(planeCapacity,capacity),nextRaw=Math.Max(rawCapacity,payload),nextLut=Math.Max(lutCapacity,entries);
            ulong planeBytes=checked((ulong)nextPlane*16),total=checked((ulong)nextRaw+32UL*(ulong)nextPlane+8UL*(ulong)((nextPlane+255)/256)+8UL*(ulong)nextLut+36);
            if(Math.Max(planeBytes,(ulong)nextRaw)>maxAllocation||total>globalMemory)throw new Exception("GPU SI/TI buffers exceed device allocation or memory capacity");
            ReleaseBuffers();raw=Buffer(nextRaw);curr=Buffer(checked(nextPlane*8));prev=Buffer(checked(nextPlane*8));values=Buffer(checked(nextPlane*16));partial=Buffer(checked(((nextPlane+255)/256)*8));stats=Buffer(32);invalid=Buffer(4);lut=Buffer(checked(nextLut*8));planeCapacity=nextPlane;rawCapacity=nextRaw;lutCapacity=nextLut;
        }
        Write(lut,table,table.Length*8);return reused;
    }
    IntPtr Buffer(int bytes){int e;IntPtr b=clCreateBuffer(context,1,(UIntPtr)bytes,IntPtr.Zero,out e);Check(e);return b;}
    void Write(IntPtr buffer,Array data,int bytes){GCHandle pin=GCHandle.Alloc(data,GCHandleType.Pinned);try{Check(clEnqueueWriteBuffer(queue,buffer,1,UIntPtr.Zero,(UIntPtr)bytes,pin.AddrOfPinnedObject(),0,IntPtr.Zero,IntPtr.Zero));}finally{pin.Free();}}
    void Read(IntPtr buffer,Array data,int bytes){GCHandle pin=GCHandle.Alloc(data,GCHandleType.Pinned);try{Check(clEnqueueReadBuffer(queue,buffer,1,UIntPtr.Zero,(UIntPtr)bytes,pin.AddrOfPinnedObject(),0,IntPtr.Zero,IntPtr.Zero));}finally{pin.Free();}}
    static void Mem(IntPtr k,uint i,IntPtr b){Check(clSetKernelArg(k,i,(UIntPtr)IntPtr.Size,ref b));}
    static void Int(IntPtr k,uint i,int v){Check(ArgInt(k,i,(UIntPtr)4,ref v));}
    void Launch(IntPtr k,int count){Check(clEnqueueNDRangeKernel(queue,k,1,IntPtr.Zero,new[]{(UIntPtr)(((count+255)/256)*256)},new[]{(UIntPtr)256},0,IntPtr.Zero,IntPtr.Zero));}
    void Statistics(int offset,int count,int channel){
        for(int variance=0;variance<2;variance++){
            Mem(reduce,0,values);Int(reduce,1,offset);Int(reduce,2,count);Mem(reduce,3,stats);Int(reduce,4,channel);Int(reduce,5,variance);Mem(reduce,6,partial);Launch(reduce,count);
            Mem(finish,0,partial);Int(finish,1,(count+255)/256);Int(finish,2,count);Mem(finish,3,stats);Int(finish,4,channel);Int(finish,5,variance);Check(clEnqueueNDRangeKernel(queue,finish,1,IntPtr.Zero,new[]{(UIntPtr)1},new[]{(UIntPtr)1},0,IntPtr.Zero,IntPtr.Zero));
        }
    }
    double[] Measure(byte[] data,bool first,int testAlpha=-2){
        if(testAlpha==-2&&data.Length!=frameBytes)throw new InputException("Incomplete P.910 raw frame");
        invalidFlag[0]=0;Write(invalid,invalidFlag,4);Write(raw,data,data.Length);
        Mem(convert,0,raw);Mem(convert,1,curr);Mem(convert,2,lut);Mem(convert,3,invalid);Int(convert,4,n);Int(convert,5,sampleBytes);Int(convert,6,shift);Int(convert,7,little);Int(convert,8,testAlpha==-2?alpha:testAlpha);Int(convert,9,(1<<depth)-1);Int(convert,10,layout);Int(convert,11,stride);Int(convert,12,layout==2&&stride==0?2*n:red);Int(convert,13,green);Int(convert,14,layout==2&&stride==0?n:blue);Launch(convert,n);
        Mem(metrics,0,curr);Mem(metrics,1,prev);Mem(metrics,2,values);Int(metrics,3,w);Int(metrics,4,h);Int(metrics,5,first?1:0);Launch(metrics,n);
        Statistics(0,(w-2)*(h-2),0);if(!first)Statistics(n,n,1);Read(stats,result,32);Read(invalid,invalidFlag,4);
        if(invalidFlag[0]!=0)throw new InputException((invalidFlag[0]&2)!=0?"SI/TI 半透明输入缺少参考合成流程":(invalidFlag[0]&4)!=0?"SI/TI 填充位非零或样本超出位深":layout==2?"SI/TI RGB 分量超出声明范围；不裁剪或改判范围":"SI/TI 亮度样本超出声明范围；不裁剪或改判范围");
        IntPtr swap=prev;prev=curr;curr=swap;return new[]{result[2]*255,first?0:result[3]*255};
    }
    static double Std(double[] a){double sum=0,c=0;foreach(double v in a){double y=v-c,t=sum+y;c=(t-sum)-y;sum=t;}double mean=sum/a.Length;sum=0;c=0;foreach(double v in a){double d=v-mean,y=d*d-c,t=sum+y;c=(t-sum)-y;sum=t;}return Math.Sqrt(sum/a.Length);}
    double[] Reference(byte[] data,ref double[] previous){
        double[] a=new double[n],motion=new double[n],gradient=new double[(w-2)*(h-2)];
        for(int i=0;i<n;i++){
            if(layout==2){int pos=i*stride;double r=ReadCode(data,stride>0?pos+red:2*n+i),g=ReadCode(data,stride>0?pos+green:i),b=ReadCode(data,stride>0?pos+blue:n+i);double v=table[0]*(r-table[3])/(table[4]-table[3])+table[1]*(g-table[3])/(table[4]-table[3])+table[2]*(b-table[3])/(table[4]-table[3]);a[i]=Transfer(Math.Min(1,Math.Max(0,v)));}
            else a[i]=sampleBytes==0?BitConverter.ToDouble(data,8*i):table[ReadCode(data,i)];motion[i]=previous==null?0:a[i]-previous[i];
        }
        int[] sx={-1,0,1,-2,0,2,-1,0,1},sy={-1,-2,-1,0,0,0,1,2,1};
        for(int y=1;y<h-1;y++)for(int x=1;x<w-1;x++){double gx=0,gy=0;for(int k=0;k<9;k++){double v=a[(y+k/3-1)*w+x+k%3-1];gx+=v*sx[k];gy+=v*sy[k];}gradient[(y-1)*(w-2)+x-1]=Math.Sqrt(gx*gx+gy*gy);}
        previous=a;return new[]{Std(gradient)*255,Std(motion)*255};
    }
    double Transfer(double v){
        if(table[5]==0)return v;double luminance;
        if(table[5]==3){double linear=v<=.5?v*v/3:Math.Exp((v-table[12])/table[10])-table[11];luminance=(table[6]-table[7])*Math.Pow(linear,table[8])+table[7];}
        else if(table[5]==2){double linear=v<=.04045?v/12.92:Math.Pow((v+.055)/1.055,table[8]);luminance=(table[6]-table[7])*linear+table[7];}
        else luminance=(table[6]-table[7])*Math.Pow(v,table[8])+table[7];
        double y=Math.Pow(luminance/10000,table[13]);return Math.Pow((table[15]+table[16]*y)/(1+table[17]*y),table[14]);
    }
    double SelfTest(){
        int oldW=w,oldH=h;double maxError=0;var valid=new List<int>();for(int code=0;code<(layout==2?1<<depth:sampleBytes==0?256:table.Length);code++)if(layout==2?code>=table[3]&&code<=table[4]:sampleBytes==0||!double.IsNaN(table[code])&&!double.IsInfinity(table[code]))valid.Add(code);if(valid.Count==0)throw new InputException("Invalid SITI lookup table");
        foreach(int width in new[]{9,67}){w=width;h=7;n=w*h;double[] previous=null;
            for(int frame=0;frame<6;frame++){
                byte[] data=new byte[n*(sampleBytes==0?8:sampleBytes*(layout==2?(stride>0?stride:alpha>=0?4:3):alpha>=0?2:1))];
                for(int i=0;i<n;i++){
                    int codeIndex=frame==0?0:frame==1?valid.Count-1:(i*37+(i/w)*53+frame*29)%valid.Count,code=valid[codeIndex];
                    if(sampleBytes==0)System.Buffer.BlockCopy(BitConverter.GetBytes((double)code/255),0,data,8*i,8);
                    else if(layout==2){int pos=i*stride;WriteCode(data,stride>0?pos+red:2*n+i,code);WriteCode(data,stride>0?pos+green:i,valid[(codeIndex+frame*17)%valid.Count]);WriteCode(data,stride>0?pos+blue:n+i,valid[(codeIndex+frame*31)%valid.Count]);if(alpha>=0)WriteCode(data,stride>0?pos+alpha:3*n+i,(1<<depth)-1);}
                    else{WriteCode(data,i,code);if(alpha>=0)WriteCode(data,n+i,(1<<depth)-1);}
                }
                double[] actual=Measure(data,frame==0,alpha>=0?(layout==2?(stride>0?alpha:3*n):n):-1),expected=Reference(data,ref previous);
                for(int j=0;j<2;j++){double error=Math.Abs(actual[j]-expected[j]);maxError=Math.Max(maxError,error);if(double.IsNaN(actual[j])||double.IsInfinity(actual[j])||error>1e-8+1e-10*Math.Abs(expected[j]))throw new Exception("P.910 GPU fp64 self-test mismatch");}
            }
        }
        w=oldW;h=oldH;n=w*h;return maxError;
    }
    void ReleaseBuffers(){foreach(IntPtr b in new[]{raw,curr,prev,values,partial,stats,invalid,lut})if(b!=IntPtr.Zero)clReleaseMemObject(b);raw=curr=prev=values=partial=stats=invalid=lut=IntPtr.Zero;planeCapacity=rawCapacity=lutCapacity=0;}
    public void Dispose(){
        ReleaseBuffers();
        foreach(IntPtr k in new[]{convert,metrics,reduce,finish})if(k!=IntPtr.Zero)clReleaseKernel(k);
        if(program!=IntPtr.Zero)clReleaseProgram(program);if(queue!=IntPtr.Zero)clReleaseCommandQueue(queue);if(context!=IntPtr.Zero)clReleaseContext(context);
        raw=curr=prev=values=partial=stats=invalid=lut=convert=metrics=reduce=finish=program=queue=context=IntPtr.Zero;
    }
    sealed class InputException:Exception{public InputException(string message):base(message){}}
    static bool ReadFrame(Stream input,byte[] data){int offset=0;while(offset<data.Length){int read=input.Read(data,offset,data.Length-offset);if(read==0){if(offset!=0)throw new InputException("Truncated P.910 raw input");return false;}offset+=read;}return true;}
    static string Escape(string s){return s.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r"," ").Replace("\n"," ");}
    int ReadCode(byte[] data,int i){int word=sampleBytes==1?data[i]:little==1?data[2*i]|data[2*i+1]<<8:data[2*i+1]|data[2*i]<<8;return word>>shift;}
    void WriteCode(byte[] data,int i,int code){int word=code<<shift;if(sampleBytes==1)data[i]=(byte)word;else{data[2*i+(little==1?0:1)]=(byte)word;data[2*i+(little==1?1:0)]=(byte)(word>>8);}}
    static HashSet<int> Starts(string text){var starts=new HashSet<int>();int last=-1;foreach(string value in text.Split(',')){int start;if(!int.TryParse(value,out start)||start<0||start>=MaxFrames||start<=last||last==-1&&start!=0||starts.Count>=2048)throw new InputException("Invalid SITI scene starts");starts.Add(start);last=start;}return starts;}
    string InfoJson(string prefix,double error){return prefix+"\"device\":\""+Escape(Name)+"\",\"driver\":\""+Escape(Driver)+"\",\"backend\":\"OpenCL 1.2 fp64\",\"metrics\":\"PQ-Sobel-TI-fp64\",\"selfTestMaxError\":"+error.ToString("R")+"}";}
    static string Header(Stream input){var bytes=new List<byte>();for(;;){int b=input.ReadByte();if(b==-1){if(bytes.Count!=0)throw new InputException("Truncated SITI request");return null;}if(b==10)return Encoding.UTF8.GetString(bytes.ToArray());if(bytes.Count>=65536)throw new InputException("SITI request too large");bytes.Add((byte)b);}}
    static int Serve(){
        CultureInfo.CurrentCulture=CultureInfo.InvariantCulture;Stream input=Console.OpenStandardInput();
        using(var gpu=new SitiOpenCl(9,7,0,8,0,1,504,-1,new double[1])){
            double selfTest=gpu.SelfTest();Console.WriteLine(gpu.InfoJson("{\"event\":\"ready\",\"protocol\":1,",selfTest));
            string line;while((line=Header(input))!=null){
                string[] p=line.Split('\t');if(p.Length==1&&p[0]=="Q")return 0;int id=p.Length>1?int.Parse(p[1]):-1;
                try{
                    if(p.Length==2&&p[0]=="P"){Console.WriteLine(gpu.InfoJson("{\"id\":"+id+",\"event\":\"probe\",",selfTest));continue;}
                    if(p.Length!=18||p[0]!="M")throw new InputException("Invalid SITI session request");
                    int width=int.Parse(p[2]),height=int.Parse(p[3]),count=int.Parse(p[4]),entries=int.Parse(p[17]);var starts=Starts(p[5]);
                    if(count<1||count>MaxFrames||entries<1||entries>65536)throw new InputException("Invalid SITI frame or table count");foreach(int start in starts)if(start>=count)throw new InputException("SITI scene start exceeds frame count");
                    byte[] header=new byte[entries*8];if(!ReadFrame(input,header))throw new InputException("Missing SITI input parameters");double[] table=new double[entries];System.Buffer.BlockCopy(header,0,table,0,header.Length);
                    bool reused=gpu.Configure(width,height,int.Parse(p[6]),int.Parse(p[7]),int.Parse(p[8]),int.Parse(p[9]),int.Parse(p[10]),int.Parse(p[11]),int.Parse(p[12]),int.Parse(p[13]),int.Parse(p[14]),int.Parse(p[15]),int.Parse(p[16]),table);
                    selfTest=gpu.SelfTest();Console.WriteLine(gpu.InfoJson("{\"id\":"+id+",\"event\":\"configured\",\"buffersReused\":"+(reused?"true":"false")+",",selfTest));
                    byte[] data=new byte[gpu.frameBytes];double reading=0,processing=0;var watch=new Stopwatch();
                    for(int frame=0;frame<count;frame++){
                        watch.Restart();if(!ReadFrame(input,data))throw new InputException("Truncated P.910 raw input");reading+=watch.Elapsed.TotalSeconds;
                        bool first=starts.Contains(frame);watch.Restart();double[] value=gpu.Measure(data,first);processing+=watch.Elapsed.TotalSeconds;
                        Console.WriteLine("{\"id\":"+id+",\"frame\":"+frame+",\"si\":"+value[0].ToString("R")+",\"ti\":"+(first?"null":value[1].ToString("R"))+"}");
                    }
                    Console.WriteLine("{\"id\":"+id+",\"event\":\"done\",\"frames\":"+count+",\"gpuUploadComputeReadSeconds\":"+processing.ToString("R")+",\"inputWaitSeconds\":"+reading.ToString("R")+"}");
                }catch(Exception e){Console.WriteLine("{\"id\":"+id+",\"event\":\"error\",\"phase\":\""+(e is InputException?"input":"gpu")+"\",\"message\":\""+Escape(e.Message)+"\"}");return 1;}
            }return 0;
        }
    }
    public static int Main(string[] args){
        try{Console.OutputEncoding=new UTF8Encoding(false);if(args.Length!=1||args[0]!="serve")throw new InputException("Invalid SITI bridge arguments");return Serve();}
        catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}
    }
}
}
