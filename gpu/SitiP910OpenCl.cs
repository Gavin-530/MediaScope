using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace MediaScope {
// Executes the explicitly versioned SDR/PQ/HLG interpretations. No fast-math or float casts.
public sealed class SitiP910OpenCl : IDisposable {
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
    static IntPtr Device(){
        uint n;Check(clGetPlatformIDs(0,null,out n));IntPtr[] platforms=new IntPtr[n];Check(clGetPlatformIDs(n,platforms,out n));
        foreach(IntPtr p in platforms){uint count;int e=clGetDeviceIDs(p,4,0,null,out count);if(e==-1)continue;Check(e);IntPtr[] devices=new IntPtr[count];Check(clGetDeviceIDs(p,4,count,devices,out count));foreach(IntPtr d in devices)if(Info(d,0x1030).Contains("cl_khr_fp64"))return d;}
        throw new Exception("No OpenCL GPU with cl_khr_fp64 support");
    }
    const string Source=@"
#pragma OPENCL EXTENSION cl_khr_fp64 : enable
#pragma OPENCL FP_CONTRACT OFF
__kernel void convert(__global const uchar *raw,__global double *curr,__global const double *lut,__global int *invalid,int n,int depth,int rawMode) {
    int i=get_global_id(0);if(i>=n)return;
    int code=depth==8?raw[i]:((int)raw[2*i]|((int)raw[2*i+1]<<8));
    double value=code<(1<<depth)?lut[code]:NAN;
    if(rawMode>=1){ulong bits=0;for(int j=0;j<8;j++)bits|=((ulong)raw[8*i+j])<<(8*j);value=as_double(bits);}
    if(!isfinite(value)){atomic_or((volatile __global int*)invalid,1);value=0;}
    curr[i]=value;
}
__kernel void metrics(__global const double *curr,__global const double *prev,__global double *v,int w,int h,int first) {
    int i=get_global_id(0),n=w*h;if(i>=n)return;
    v[n+i]=first?0:curr[i]-prev[i];
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
    IntPtr context,queue,program,convert,metrics,reduce,finish,raw,curr,prev,values,partial,stats,lut,invalid;
    int w,h,n;readonly int depth,full,rawMode,referenceScale,multiplier;readonly string domain;readonly double white,black,gamma;readonly double[] table,result=new double[4];
    readonly int[] invalidFlag=new int[1];
    public readonly string Name,Driver;
    public SitiP910OpenCl(int width,int height,int bits,int range,double[] lookup,string calculationDomain,double lw,double lb,double systemGamma,int mode,int scale,int outputMultiplier){
        if(width<3||height<3||(long)width*height>33554432||!ValidDepth(bits)||(range!=0&&range!=1)||!ValidDomain(calculationDomain)||double.IsNaN(lw)||double.IsNaN(lb)||double.IsNaN(systemGamma)||lw<=0||lw>10000||lb<0||lb>=lw||systemGamma<1||systemGamma>3)throw new Exception("Invalid P.910 GPU format or display model");
        if((mode!=0&&mode!=1&&mode!=2)||(scale!=0&&scale!=1)||outputMultiplier!=(scale==1?255:(1<<bits)-1))throw new Exception("Invalid P.910 raw mode or scale");
        w=width;h=height;n=checked(w*h);depth=bits;full=range;table=lookup;domain=calculationDomain;white=lw;black=lb;gamma=systemGamma;rawMode=mode;referenceScale=scale;multiplier=outputMultiplier;ValidateTable();
        try{
            IntPtr device=Device();Name=Info(device,0x102B);Driver=Info(device,0x102D);int e;
            context=clCreateContext(IntPtr.Zero,1,new[]{device},IntPtr.Zero,IntPtr.Zero,out e);Check(e);queue=clCreateCommandQueue(context,device,0,out e);Check(e);
            program=clCreateProgramWithSource(context,1,new[]{Source},IntPtr.Zero,out e);Check(e);e=clBuildProgram(program,1,new[]{device},"-cl-std=CL1.2",IntPtr.Zero,IntPtr.Zero);
            if(e!=0){UIntPtr len;clGetProgramBuildInfo(program,device,0x1183,UIntPtr.Zero,null,out len);byte[] b=new byte[(int)len.ToUInt64()];clGetProgramBuildInfo(program,device,0x1183,len,b,out len);throw new Exception("OpenCL build: "+Encoding.UTF8.GetString(b));}
            convert=clCreateKernel(program,"convert",out e);Check(e);metrics=clCreateKernel(program,"metrics",out e);Check(e);reduce=clCreateKernel(program,"reduce_values",out e);Check(e);finish=clCreateKernel(program,"finish_stat",out e);Check(e);
            int capacity=Math.Max(n,469);raw=Buffer(capacity*(rawMode>=1?8:2));curr=Buffer(capacity*8);prev=Buffer(capacity*8);values=Buffer(capacity*16);partial=Buffer(((capacity+255)/256)*8);stats=Buffer(32);invalid=Buffer(4);lut=Buffer(table.Length*8);Write(lut,table,table.Length*8);
        }catch{Dispose();throw;}
    }
    void ValidateTable(){
        int max=(1<<depth)-1,factor=1<<(depth-8),lo=full==1?0:16*factor,hi=full==1?max:235*factor;
        if(table==null||table.Length!=max+1)throw new Exception("Invalid P.910 lookup table");
        double a=Math.Pow(Math.Pow(white,1/2.4)-Math.Pow(black,1/2.4),2.4),b=Math.Pow(black,1/2.4)/(Math.Pow(white,1/2.4)-Math.Pow(black,1/2.4));
        for(int code=0;code<=max;code++){
            if(code<lo||code>hi){if(!double.IsNaN(table[code]))throw new Exception("P.910 lookup range guard mismatch");continue;}
            double v=(double)code/max;if(full==0)v=referenceScale==1?(double)(code-lo)/(hi-lo):(v-16.0/255)/(235.0/255-16.0/255);
            double luminance=a*Math.Pow(Math.Max(v+b,0),2.4);
            if(domain=="hlg"){
                double beta=Math.Sqrt(3*Math.Pow(black/white,1/gamma));
                if(beta>=1)throw new Exception("Invalid HLG black level lift");
                double signal=Math.Max((1-beta)*v+beta,0),ha=.17883277,hb=1-4*ha,hc=.5-ha*Math.Log(4*ha);
                double linear=signal<=.5?signal*signal/3:(Math.Exp((signal-hc)/ha)+hb)/12;
                luminance=white*Math.Pow(linear,gamma);
            }
            double y=Math.Pow(luminance/10000,2610.0/16384);
            double expected=domain=="pq"?v:Math.Pow((3424.0/4096+(2413.0/128)*y)/(1+(2392.0/128)*y),2523.0/32);
            if(double.IsNaN(table[code])||double.IsInfinity(table[code])||Math.Abs(table[code]-expected)>1e-12)throw new Exception("P.910 lookup formula mismatch");
        }
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
    double[] Measure(byte[] data,bool first){
        if(data.Length!=n*(rawMode>=1?8:depth==8?1:2))throw new Exception("Incomplete P.910 raw frame");
        invalidFlag[0]=0;Write(invalid,invalidFlag,4);Write(raw,data,data.Length);
        Mem(convert,0,raw);Mem(convert,1,curr);Mem(convert,2,lut);Mem(convert,3,invalid);Int(convert,4,n);Int(convert,5,depth);Int(convert,6,rawMode);Launch(convert,n);
        Mem(metrics,0,curr);Mem(metrics,1,prev);Mem(metrics,2,values);Int(metrics,3,w);Int(metrics,4,h);Int(metrics,5,first?1:0);Launch(metrics,n);
        Statistics(0,(w-2)*(h-2),0);Statistics(n,n,1);Read(stats,result,32);Read(invalid,invalidFlag,4);
        if(invalidFlag[0]!=0)throw new Exception("P.910 SDR input code outside declared range; no clipping");
        IntPtr swap=prev;prev=curr;curr=swap;return new[]{result[2]*multiplier,result[3]*multiplier};
    }
    static double Std(double[] a){double sum=0,c=0;foreach(double v in a){double y=v-c,t=sum+y;c=(t-sum)-y;sum=t;}double mean=sum/a.Length;sum=0;c=0;foreach(double v in a){double d=v-mean,y=d*d-c,t=sum+y;c=(t-sum)-y;sum=t;}return Math.Sqrt(sum/a.Length);}
    double[] Reference(byte[] data,ref double[] previous){
        double[] a=new double[n],motion=new double[n],gradient=new double[(w-2)*(h-2)];
        for(int i=0;i<n;i++){int code=depth==8?data[i]:data[2*i]|data[2*i+1]<<8;a[i]=rawMode>=1?BitConverter.ToDouble(data,8*i):table[code];motion[i]=previous==null?0:a[i]-previous[i];}
        int[] sx={-1,0,1,-2,0,2,-1,0,1},sy={-1,-2,-1,0,0,0,1,2,1};
        for(int y=1;y<h-1;y++)for(int x=1;x<w-1;x++){double gx=0,gy=0;for(int k=0;k<9;k++){double v=a[(y+k/3-1)*w+x+k%3-1];gx+=v*sx[k];gy+=v*sy[k];}gradient[(y-1)*(w-2)+x-1]=Math.Sqrt(gx*gx+gy*gy);}
        previous=a;return new[]{Std(gradient)*multiplier,Std(motion)*multiplier};
    }
    double SelfTest(){
        int oldW=w,oldH=h;double maxError=0;int factor=1<<(depth-8),lo=full==1?0:16*factor,hi=full==1?(1<<depth)-1:235*factor;
        foreach(int width in new[]{9,67}){w=width;h=7;n=w*h;double[] previous=null;
            for(int frame=0;frame<6;frame++){
                byte[] data=new byte[n*(rawMode>=1?8:depth==8?1:2)];for(int i=0;i<n;i++){int code=frame==0?lo:frame==1?hi:lo+(i*37+(i/w)*53+frame*29)%(hi-lo+1);if(rawMode>=1)System.Buffer.BlockCopy(BitConverter.GetBytes(table[code]),0,data,8*i,8);else if(depth==8)data[i]=(byte)code;else{data[2*i]=(byte)code;data[2*i+1]=(byte)(code>>8);}}
                double[] actual=Measure(data,frame==0),expected=Reference(data,ref previous);
                for(int j=0;j<2;j++){double error=Math.Abs(actual[j]-expected[j]);maxError=Math.Max(maxError,error);if(double.IsNaN(actual[j])||double.IsInfinity(actual[j])||error>1e-8+1e-10*Math.Abs(expected[j]))throw new Exception("P.910 GPU fp64 self-test mismatch");}
            }
        }
        w=oldW;h=oldH;n=w*h;return maxError;
    }
    public void Dispose(){
        foreach(IntPtr b in new[]{raw,curr,prev,values,partial,stats,lut,invalid})if(b!=IntPtr.Zero)clReleaseMemObject(b);
        foreach(IntPtr k in new[]{convert,metrics,reduce,finish})if(k!=IntPtr.Zero)clReleaseKernel(k);
        if(program!=IntPtr.Zero)clReleaseProgram(program);if(queue!=IntPtr.Zero)clReleaseCommandQueue(queue);if(context!=IntPtr.Zero)clReleaseContext(context);
        raw=curr=prev=values=partial=stats=lut=invalid=convert=metrics=reduce=finish=program=queue=context=IntPtr.Zero;
    }
    static bool ReadFrame(Stream input,byte[] data){int offset=0;while(offset<data.Length){int read=input.Read(data,offset,data.Length-offset);if(read==0){if(offset!=0)throw new Exception("Truncated P.910 raw input");return false;}offset+=read;}return true;}
    static string Escape(string s){return s.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r"," ").Replace("\n"," ");}
    static bool ValidDepth(int bits){return bits==8||bits==9||bits==10||bits==12||bits==14||bits==16;}
    static bool ValidDomain(string value){return value=="sdr"||value=="pq"||value=="hlg";}
    public static void Run(int width,int height,int depth,int full,string sceneStarts,string domain,double white,double black,double gamma,string profile,int rawMode,int referenceScale,int outputMultiplier){
        bool physical=Array.IndexOf(new[]{"P910-2023-linear-light-float-v1","P910-2023-absolute-light-float-v1","P910-2023-linear-alpha-v1"},profile)>=0;
        bool extended=Array.IndexOf(new[]{"P910-2023-reference-255-v1","P910-2023-rgb-text-v1","P910-2023-float-text-v1","P910-2023-native-storage-text-v1"},profile)>=0;
        if(!ValidDepth(depth)||!ValidDomain(domain)||physical&&(rawMode!=2||domain!="pq")||extended&&(rawMode!=1||referenceScale!=(profile=="P910-2023-reference-255-v1"?1:0))||!extended&&!physical&&(rawMode!=0||referenceScale!=0||profile!=(domain=="pq"?"P910-2023-PQ-preserved-v1":domain=="hlg"?"P910-2023-HLG-display-v1":depth==8||depth==10?"P910-2023-SDR-BT1886-text-v1":"P910-2023-luma-text-v2")&&!(domain=="sdr"&&profile=="P910-2023-luma-text-v2")))throw new Exception("Invalid P.910 profile");CultureInfo.CurrentCulture=CultureInfo.InvariantCulture;
        var starts=new HashSet<int>();int last=-1;foreach(string value in sceneStarts.Split(',')){int start;if(!int.TryParse(value,out start)||start<0||start>=500000||start<=last||last==-1&&start!=0||starts.Count>=2048)throw new Exception("Invalid P.910 scene starts");starts.Add(start);last=start;}
        Stream input=Console.OpenStandardInput();double[] table=new double[1<<depth];
        if(physical){full=1;for(int code=0;code<table.Length;code++)table[code]=(double)code/(table.Length-1);}
        else{byte[] header=new byte[table.Length*8];if(!ReadFrame(input,header))throw new Exception("Missing P.910 lookup table");System.Buffer.BlockCopy(header,0,table,0,header.Length);}
        using(var gpu=new SitiP910OpenCl(width,height,depth,full,table,domain,white,black,gamma,rawMode,referenceScale,outputMultiplier)){
            double error=gpu.SelfTest();Console.WriteLine("{\"device\":\""+Escape(gpu.Name)+"\",\"driver\":\""+Escape(gpu.Driver)+"\",\"backend\":\"OpenCL 1.2 fp64\",\"method\":\""+Escape(profile)+"\",\"selfTestMaxError\":"+error.ToString("R")+"}");
            byte[] data=new byte[checked(width*height*(rawMode>=1?8:depth==8?1:2))];int frame=0;
            while(ReadFrame(input,data)){if(frame>=500000)throw new Exception("P.910 GPU frame limit exceeded");bool first=starts.Contains(frame);double[] values=gpu.Measure(data,first);Console.WriteLine("{\"frame\":"+frame+",\"si\":"+values[0].ToString("R")+",\"ti\":"+(first?"null":values[1].ToString("R"))+"}");frame++;}
            if(last>=frame)throw new Exception("P.910 scene start exceeds frame count");
        }
    }
}
}
