using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;

namespace MediaScope {
// OpenCL 1.2, GPU devices only. fp64 is required for stable population statistics.
public sealed class SitiOpenCl : IDisposable {
    const string Dll = "OpenCL.dll";
    [DllImport(Dll)] static extern int clGetPlatformIDs(uint n, [Out] IntPtr[] p, out uint count);
    [DllImport(Dll)] static extern int clGetDeviceIDs(IntPtr p, ulong type, uint n, [Out] IntPtr[] devices, out uint count);
    [DllImport(Dll)] static extern int clGetDeviceInfo(IntPtr d, uint key, UIntPtr size, [Out] byte[] value, out UIntPtr actual);
    [DllImport(Dll)] static extern IntPtr clCreateContext(IntPtr props, uint n, IntPtr[] d, IntPtr cb, IntPtr data, out int error);
    [DllImport(Dll)] static extern IntPtr clCreateCommandQueue(IntPtr c, IntPtr d, ulong props, out int error);
    [DllImport(Dll)] static extern IntPtr clCreateProgramWithSource(IntPtr c, uint n, string[] source, IntPtr lengths, out int error);
    [DllImport(Dll)] static extern int clBuildProgram(IntPtr p, uint n, IntPtr[] devices, string options, IntPtr cb, IntPtr data);
    [DllImport(Dll)] static extern int clGetProgramBuildInfo(IntPtr p, IntPtr d, uint key, UIntPtr size, [Out] byte[] value, out UIntPtr actual);
    [DllImport(Dll)] static extern IntPtr clCreateKernel(IntPtr p, string name, out int error);
    [DllImport(Dll)] static extern IntPtr clCreateBuffer(IntPtr c, ulong flags, UIntPtr size, IntPtr data, out int error);
    [DllImport(Dll)] static extern int clSetKernelArg(IntPtr k, uint i, UIntPtr size, ref IntPtr value);
    [DllImport(Dll, EntryPoint="clSetKernelArg")] static extern int ArgInt(IntPtr k, uint i, UIntPtr size, ref int value);
    [DllImport(Dll)] static extern int clEnqueueNDRangeKernel(IntPtr q, IntPtr k, uint dim, IntPtr offset, UIntPtr[] global, UIntPtr[] local, uint n, IntPtr wait, IntPtr ev);
    [DllImport(Dll)] static extern int clEnqueueWriteBuffer(IntPtr q, IntPtr b, uint blocking, UIntPtr offset, UIntPtr size, IntPtr data, uint n, IntPtr wait, IntPtr ev);
    [DllImport(Dll)] static extern int clEnqueueReadBuffer(IntPtr q, IntPtr b, uint blocking, UIntPtr offset, UIntPtr size, IntPtr data, uint n, IntPtr wait, IntPtr ev);
    [DllImport(Dll)] static extern int clReleaseMemObject(IntPtr p);
    [DllImport(Dll)] static extern int clReleaseKernel(IntPtr p);
    [DllImport(Dll)] static extern int clReleaseProgram(IntPtr p);
    [DllImport(Dll)] static extern int clReleaseCommandQueue(IntPtr p);
    [DllImport(Dll)] static extern int clReleaseContext(IntPtr p);
    static void Check(int e) { if(e!=0) throw new Exception("OpenCL error "+e); }
    static string Info(IntPtr d, uint key) {
        UIntPtr len; Check(clGetDeviceInfo(d,key,UIntPtr.Zero,null,out len));
        byte[] b=new byte[(int)len.ToUInt64()]; Check(clGetDeviceInfo(d,key,len,b,out len));
        return Encoding.UTF8.GetString(b).TrimEnd('\0');
    }
    static IntPtr Device() {
        uint n; Check(clGetPlatformIDs(0,null,out n)); IntPtr[] platforms=new IntPtr[n]; Check(clGetPlatformIDs(n,platforms,out n));
        foreach(IntPtr p in platforms) {
            uint count; int e=clGetDeviceIDs(p,4,0,null,out count); if(e==-1) continue; Check(e);
            IntPtr[] devices=new IntPtr[count]; Check(clGetDeviceIDs(p,4,count,devices,out count));
            foreach(IntPtr d in devices) if(Info(d,0x1030).Contains("cl_khr_fp64")) return d;
        }
        throw new Exception("No OpenCL GPU with cl_khr_fp64 support");
    }
    const string Source=@"
#pragma OPENCL EXTENSION cl_khr_fp64 : enable
#pragma OPENCL FP_CONTRACT OFF
__kernel void normalize(__global const uchar *raw, __global ushort *curr, int n, int depth, int full) {
    int i=get_global_id(0); if(i>=n)return;
    int y=depth==8?raw[i]:((int)raw[2*i]|((int)raw[2*i+1]<<8));
    int factor=depth==8?1:4;
    curr[i]=full?y:((256*factor-1)*clamp(y-16*factor,0,219*factor)/(219*factor));
}
__kernel void metrics(__global const ushort *curr, __global const ushort *prev, __global float *v, int w, int h, int first) {
    int i=get_global_id(0),n=w*h; if(i>=n)return;
    v[n+i]=first?0:((int)curr[i]-(int)prev[i]);
    int x=i%w,y=i/w;
    if(x>0 && x<w-1 && y>0 && y<h-1) {
        int a=curr[i-w-1],b=curr[i-w],c=curr[i-w+1];
        int d=curr[i-1],f=curr[i+1];
        int g=curr[i+w-1],j=curr[i+w],k=curr[i+w+1];
        double gx=a-c+2*d-2*f+g-k,gy=a+2*b+c-g-2*j-k;
        v[(y-1)*(w-2)+x-1]=(float)sqrt(gx*gx+gy*gy);
    }
}
__kernel void reduce_values(__global const float *v, int offset, int n, __global const double *stats, int channel, int variance, __global double *out) {
    int i=get_global_id(0),l=get_local_id(0);
    __local double sums[256];
    double value=0;
    if(i<n) { float f=v[offset+i]; if(variance) { float delta=(float)((double)f-stats[channel]); value=(double)(delta*delta); } else value=(double)f; }
    sums[l]=value; barrier(CLK_LOCAL_MEM_FENCE);
    for(int step=128;step>0;step>>=1) { if(l<step)sums[l]+=sums[l+step]; barrier(CLK_LOCAL_MEM_FENCE); }
    if(l==0)out[get_group_id(0)]=sums[0];
}
__kernel void finish_stat(__global const double *partial, int groups, int count, __global double *stats, int channel, int variance) {
    if(get_global_id(0)!=0)return;
    double total=0; for(int i=0;i<groups;i++)total+=partial[i];
    stats[channel+(variance?2:0)]=variance?(double)((float)sqrt(total/count)):total/count;
}";
    IntPtr context,queue,program,normalize,metrics,reduce,finish,raw,curr,prev,values,partial,stats;
    int w,h,depth,full,n; readonly double[] result=new double[4];
    public readonly string Name,Driver;
    public SitiOpenCl(int width,int height,int bits,int range) {
        if(width<3||height<3||(long)width*height>33554432||(bits!=8&&bits!=10)||(range!=0&&range!=1))throw new Exception("Invalid GPU frame format");
        w=width;h=height;depth=bits;full=range;n=checked(w*h);
        try {
            IntPtr device=Device();Name=Info(device,0x102B);Driver=Info(device,0x102D);
            int e;context=clCreateContext(IntPtr.Zero,1,new[]{device},IntPtr.Zero,IntPtr.Zero,out e);Check(e);
            queue=clCreateCommandQueue(context,device,0,out e);Check(e);
            program=clCreateProgramWithSource(context,1,new[]{Source},IntPtr.Zero,out e);Check(e);
            e=clBuildProgram(program,1,new[]{device},"-cl-std=CL1.2",IntPtr.Zero,IntPtr.Zero);
            if(e!=0) { UIntPtr len;clGetProgramBuildInfo(program,device,0x1183,UIntPtr.Zero,null,out len);byte[] b=new byte[(int)len.ToUInt64()];clGetProgramBuildInfo(program,device,0x1183,len,b,out len);throw new Exception("OpenCL build: "+Encoding.UTF8.GetString(b)); }
            normalize=clCreateKernel(program,"normalize",out e);Check(e);metrics=clCreateKernel(program,"metrics",out e);Check(e);reduce=clCreateKernel(program,"reduce_values",out e);Check(e);
            finish=clCreateKernel(program,"finish_stat",out e);Check(e);
            int capacity=Math.Max(n,469);
            raw=Buffer(capacity*2);curr=Buffer(capacity*2);prev=Buffer(capacity*2);values=Buffer(capacity*8);partial=Buffer(((capacity+255)/256)*8);stats=Buffer(32);
        } catch { Dispose();throw; }
    }
    IntPtr Buffer(int bytes) {int e;IntPtr b=clCreateBuffer(context,1,(UIntPtr)bytes,IntPtr.Zero,out e);Check(e);return b;}
    static void Mem(IntPtr k,uint i,IntPtr b){Check(clSetKernelArg(k,i,(UIntPtr)IntPtr.Size,ref b));}
    static void Int(IntPtr k,uint i,int v){Check(ArgInt(k,i,(UIntPtr)4,ref v));}
    void Launch(IntPtr k,int count){Check(clEnqueueNDRangeKernel(queue,k,1,IntPtr.Zero,new[]{(UIntPtr)(((count+255)/256)*256)},new[]{(UIntPtr)256},0,IntPtr.Zero,IntPtr.Zero));}
    void Statistics(int offset,int count,int channel) {
        for(int variance=0;variance<2;variance++) {
            Mem(reduce,0,values);Int(reduce,1,offset);Int(reduce,2,count);Mem(reduce,3,stats);Int(reduce,4,channel);Int(reduce,5,variance);Mem(reduce,6,partial);Launch(reduce,count);
            Mem(finish,0,partial);Int(finish,1,(count+255)/256);Int(finish,2,count);Mem(finish,3,stats);Int(finish,4,channel);Int(finish,5,variance);
            Check(clEnqueueNDRangeKernel(queue,finish,1,IntPtr.Zero,new[]{(UIntPtr)1},new[]{(UIntPtr)1},0,IntPtr.Zero,IntPtr.Zero));
        }
    }
    public float[] Measure(byte[] data,bool first) {
        if(data.Length!=n*(depth==8?1:2))throw new Exception("Incomplete GPU frame");
        GCHandle handle=GCHandle.Alloc(data,GCHandleType.Pinned);
        try{Check(clEnqueueWriteBuffer(queue,raw,1,UIntPtr.Zero,(UIntPtr)data.Length,handle.AddrOfPinnedObject(),0,IntPtr.Zero,IntPtr.Zero));}finally{handle.Free();}
        Mem(normalize,0,raw);Mem(normalize,1,curr);Int(normalize,2,n);Int(normalize,3,depth);Int(normalize,4,full);Launch(normalize,n);
        Mem(metrics,0,curr);Mem(metrics,1,prev);Mem(metrics,2,values);Int(metrics,3,w);Int(metrics,4,h);Int(metrics,5,first?1:0);Launch(metrics,n);
        Statistics(0,(w-2)*(h-2),0);Statistics(n,n,1);
        handle=GCHandle.Alloc(result,GCHandleType.Pinned);
        try{Check(clEnqueueReadBuffer(queue,stats,1,UIntPtr.Zero,(UIntPtr)32,handle.AddrOfPinnedObject(),0,IntPtr.Zero,IntPtr.Zero));}finally{handle.Free();}
        IntPtr swap=prev;prev=curr;curr=swap;
        return new[]{(float)result[2],(float)result[3]};
    }
    public void Dispose() {
        foreach(IntPtr b in new[]{raw,curr,prev,values,partial,stats})if(b!=IntPtr.Zero)clReleaseMemObject(b);
        foreach(IntPtr k in new[]{normalize,metrics,reduce,finish})if(k!=IntPtr.Zero)clReleaseKernel(k);
        if(program!=IntPtr.Zero)clReleaseProgram(program);if(queue!=IntPtr.Zero)clReleaseCommandQueue(queue);if(context!=IntPtr.Zero)clReleaseContext(context);
        raw=curr=prev=values=partial=stats=normalize=metrics=reduce=finish=program=queue=context=IntPtr.Zero;
    }
    static float StdReference(float[] a) {
        double mean=0,total=0;foreach(float v in a)mean+=v;mean/=a.Length;
        foreach(float v in a){float delta=(float)(v-mean);total+=(double)(delta*delta);}return (float)Math.Sqrt(total/a.Length);
    }
    // Independent scalar reference, including exact integer range mapping and legal-range clipping.
    static float[] Reference(byte[] raw,ref int[] previous,int w,int h,int depth,int full) {
        int[] a=new int[w*h];float[] motion=new float[a.Length],gradient=new float[(w-2)*(h-2)];int factor=depth==8?1:4;
        for(int i=0;i<a.Length;i++) {int y=depth==8?raw[i]:(raw[2*i]|(raw[2*i+1]<<8));a[i]=full==1?y:((256*factor-1)*Math.Min(Math.Max(y-16*factor,0),219*factor)/(219*factor));motion[i]=previous==null?0:a[i]-previous[i];}
        int[] sx={1,0,-1,2,0,-2,1,0,-1},sy={1,2,1,0,0,0,-1,-2,-1};
        for(int y=1;y<h-1;y++)for(int x=1;x<w-1;x++){double gx=0,gy=0;for(int k=0;k<9;k++){int v=a[(y+k/3-1)*w+x+k%3-1];gx+=v*sx[k];gy+=v*sy[k];}gradient[(y-1)*(w-2)+x-1]=(float)Math.Sqrt(gx*gx+gy*gy);}
        previous=a;return new[]{StdReference(gradient),StdReference(motion)};
    }
    string SelfTest() {
        int oldW=w,oldH=h,oldDepth=depth,oldFull=full;double maxError=0;var gpu=this;
        foreach(int width in new[]{9,67})foreach(int bits in new[]{8,10})foreach(int range in new[]{0,1}) {
            w=width;h=7;n=width*7;depth=bits;full=range;
            int[] prev=null;var random=new Random(910+bits+range);
            for(int frame=0;frame<6;frame++) {
                byte[] data=new byte[width*7*(bits==8?1:2)];
                for(int i=0;i<width*7;i++){int y=frame==0?0:frame==1?((1<<bits)-1):random.Next(1<<bits);if(bits==8)data[i]=(byte)y;else{data[2*i]=(byte)y;data[2*i+1]=(byte)(y>>8);}}
                float[] actual=gpu.Measure(data,frame==0),expected=Reference(data,ref prev,width,7,bits,range);
                for(int j=0;j<2;j++){double error=Math.Abs(actual[j]-expected[j]);maxError=Math.Max(error,maxError);if(double.IsNaN(actual[j])||double.IsInfinity(actual[j])||error>0.0005+0.000002*Math.Abs(expected[j]))throw new Exception("GPU self-test mismatch");}
            }
        }
        w=oldW;h=oldH;n=w*h;depth=oldDepth;full=oldFull;
        return maxError.ToString("R",CultureInfo.InvariantCulture);
    }
    static string Escape(string s){return s.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r"," ").Replace("\n"," ");}
    public static void Run(string mode,int width,int height,int depth,int full) {
        CultureInfo.CurrentCulture=CultureInfo.InvariantCulture;
        using(var gpu=new SitiOpenCl(width,height,depth,full)) {
            string error=gpu.SelfTest();
            Console.WriteLine("{\"device\":\""+Escape(gpu.Name)+"\",\"driver\":\""+Escape(gpu.Driver)+"\",\"backend\":\"OpenCL 1.2 fp64\",\"selfTestMaxError\":"+error+"}");
            if(mode=="probe")return;
            Stream input=Console.OpenStandardInput();byte[] data=new byte[checked(width*height*(depth==8?1:2))];int frame=0;
            for(;;){int offset=0;while(offset<data.Length){int read=input.Read(data,offset,data.Length-offset);if(read==0){if(offset!=0)throw new Exception("Truncated raw frame");return;}offset+=read;}
                if(frame>=500000)throw new Exception("GPU frame limit exceeded");
                float[] values=gpu.Measure(data,frame==0);Console.WriteLine("{\"frame\":"+(frame++)+",\"si\":"+values[0].ToString("F2")+",\"ti\":"+values[1].ToString("F2")+"}");
            }
        }
    }
}
}
