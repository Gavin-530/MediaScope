// Layout of the decoded rawvideo payload (no colour conversion or quantization).
export const SITI_MATRICES=Object.freeze({bt601:[.299,.587,.114],bt709:[.2126,.7152,.0722],bt2020:[.2627,.678,.0593]});
export function sitiFormat(name){
  let m;
  if((m=/^(yuv(?:a|j)?)(420|422|444|440|411|410)p(?:(9|10|12|14|16)(?:(msb)?(le|be)))?$/.exec(name??''))){
    const subs={420:[2,2],422:[2,1],444:[1,1],440:[1,2],411:[4,1],410:[4,4]}[m[2]],depth=Number(m[3]??8);
    return {family:'luma',depth,storage:depth===8?8:16,endian:m[5]??'le',layout:'yuv-planar',subsample:subs,alpha:m[1]==='yuva',shift:m[4]?16-depth:0};
  }
  if((m=/^gray(?:(9|10|12|14|16)(le|be)|f(32)(le|be))?$/.exec(name??'')))return {family:'luma',depth:m[3]?null:Number(m[1]??8),storage:m[3]?32:m[1]?16:8,endian:m[2]??m[4]??'le',layout:'gray',float:!!m[3],alpha:false,shift:0};
  if((m=/^gbr(a)?p(?:(9|10|12|14|16)(?:(msb)?(le|be))|f(32)(le|be))?$/.exec(name??'')))return {family:'rgb',depth:m[5]?null:Number(m[2]??8),storage:m[5]?32:m[2]?16:8,endian:m[4]??m[6]??'le',layout:'gbr-planar',float:!!m[5],alpha:!!m[1],shift:m[3]?16-Number(m[2]):0};
  if(['rgb24','bgr24','rgb0','bgr0','0rgb','0bgr','rgba','bgra','argb','abgr'].includes(name))return {family:'rgb',depth:8,storage:8,endian:'le',layout:'rgb-packed',order:name.replace('24',''),alpha:name.includes('a'),shift:0};
  if((m=/^(rgb|bgr)48(le|be)$/.exec(name??'')))return {family:'rgb',depth:16,storage:16,endian:m[2],layout:'rgb-packed',order:m[1],alpha:false,shift:0};
  if((m=/^(rgba|bgra)64(le|be)$/.exec(name??'')))return {family:'rgb',depth:16,storage:16,endian:m[2],layout:'rgb-packed',order:m[1],alpha:true,shift:0};
  if(['nv12','nv21','nv16','nv24','nv42'].includes(name))return {family:'luma',depth:8,storage:8,endian:'le',layout:'yuv-semi',subsample:name==='nv16'?[2,1]:['nv24','nv42'].includes(name)?[1,1]:[2,2],alpha:false,shift:0};
  if((m=/^p([024])(10|12|16)(le|be)$/.exec(name??'')))return {family:'luma',depth:Number(m[2]),storage:16,endian:m[3],layout:'yuv-semi',subsample:m[1]==='0'?[2,2]:m[1]==='2'?[2,1]:[1,1],alpha:false,shift:16-Number(m[2])};
  return null;
}
export function sitiRawBytes(format,w,h){
  const pixels=w*h,sample=format.storage/8;
  if(format.layout==='gray')return pixels*sample;
  if(format.layout==='gbr-planar')return pixels*(format.alpha?4:3)*sample;
  if(format.layout==='rgb-packed')return pixels*format.order.length*sample;
  return (pixels+2*Math.ceil(w/format.subsample[0])*Math.ceil(h/format.subsample[1])+(format.alpha?pixels:0))*sample;
}
export function sitiRgbMatrix(stream,choice){
  if(choice&&choice!=='auto')return {name:choice,source:'user-confirmed'};
  const spaces={bt709:'bt709',bt470bg:'bt601',smpte170m:'bt601',bt2020nc:'bt2020'},primaries={bt709:'bt709',bt470bg:'bt601',smpte170m:'bt601',bt2020:'bt2020'};
  const space=stream.color_space,p=stream.color_primaries,a=spaces[space],b=primaries[p];
  if(space&&!['gbr','unknown','unspecified'].includes(space)&&!a)return null;
  if(a&&b&&a!==b)return null;
  if(p&&!['unknown','unspecified'].includes(p)&&!b)return null;
  return a?{name:a,source:'stream-matrix'}:b?{name:b,source:'stream-primaries'}:null;
}

// Convert normalized nonlinear input luma into the declared calculation domain.
// This also accepts fractional luma derived from RGB; never round it to a LUT index.
export function sitiPreprocessedValue(v,{domain,hlg}){
  if(domain==='pq')return v;
  let luminance;
  if(domain==='hlg'){
    const {whiteCdM2,blackCdM2,gamma}=hlg,beta=Math.sqrt(3*(blackCdM2/whiteCdM2)**(1/gamma));
    const signal=Math.max(0,(1-beta)*v+beta),a=.17883277,b=1-4*a,c=.5-a*Math.log(4*a);
    const linear=signal<=.5?signal*signal/3:(Math.exp((signal-c)/a)+b)/12;
    luminance=whiteCdM2*linear**gamma;
  }else{
    const black=.01**(1/2.4),gain=300**(1/2.4)-black;
    luminance=Math.max(gain*v+black,0)**2.4;
  }
  const y=(luminance/10000)**(2610/16384);
  return ((3424/4096+(2413/128)*y)/(1+(2392/128)*y))**(2523/32);
}
export function sitiScaleValue(v,input){
  if(input.range!=='tv')return v;
  if(input.scale==='reference-255'){
    const divisor=2**input.depth-1,factor=2**(input.depth-8);
    return (v-16*factor/divisor)/(219*factor/divisor);
  }
  return (v-16/255)/(235/255-16/255);
}
// Exact native components, shared by independent physical-light configurations.
export function createSitiRawSamples(input,w,h){
  const f=input.format,n=w*h,bytes=sitiRawBytes(f,w,h),sample=f.storage/8;
  return {bytes,read(raw){
    if(raw.length!==bytes)throw Error('SI/TI 原始帧尺寸不一致');
    const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    const component=index=>{
      const offset=index*sample;
      const value=f.float?view.getFloat32(offset,f.endian==='le'):f.storage===8?raw[offset]:view.getUint16(offset,f.endian==='le')/2**f.shift;
      if(!Number.isFinite(value)||!f.float&&(!Number.isInteger(value)||value<0||value>2**f.depth-1))throw Error('SI/TI 样本非有限、填充位非零或超出有效位深');
      return f.float?value:value/(2**f.depth-1);
    };
    return {component,rgb:i=>f.layout==='gbr-planar'?[component(2*n+i),component(i),component(n+i)]:['r','g','b'].map(c=>component(i*f.order.length+f.order.indexOf(c))),
      alpha:i=>!f.alpha?1:f.layout==='rgb-packed'?component(i*f.order.length+f.order.indexOf('a')):component((f.layout==='gbr-planar'?3*n:bytes/sample-n)+i)};
  }};
}
export function createSitiRawReader(input,w,h){
  const f=input.format,n=w*h,bytes=sitiRawBytes(f,w,h),max=2**input.depth-1,factor=2**(input.depth-8);
  const lower=input.range==='tv'?16*factor/max:0,upper=input.range==='tv'?235*factor/max:1;
  const lo=f.float?Math.fround(lower):lower,hi=f.float?Math.fround(upper):upper;
  const weights=input.matrix?SITI_MATRICES[input.matrix.name]:null;
  return {bytes,read(raw,out){
    if(raw.length!==bytes||out.length!==n)throw Error('SI/TI 原始帧尺寸不一致');
    const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength),sample=f.storage/8;
    const component=index=>{
      const offset=index*sample;
      const value=f.float?view.getFloat32(offset,f.endian==='le'):f.storage===8?raw[offset]:view.getUint16(offset,f.endian==='le')/(2**f.shift);
      if(!Number.isFinite(value)||!f.float&&(!Number.isInteger(value)||value<0||value>2**f.depth-1))throw Error('SI/TI 样本非有限、填充位非零或超出有效位深');
      return f.float?value:value/(2**f.depth-1);
    };
    for(let i=0;i<n;i++){
      let v;
      if(f.alpha){
        const alpha=f.layout==='rgb-packed'?component(i*f.order.length+f.order.indexOf('a')):component((f.layout==='gbr-planar'?3*n:bytes/sample-n)+i);
        if(alpha!==1)throw Error('SI/TI 透明素材需要明确背景和预乘解释；本配置仅接受完全不透明的透明通道');
      }
      if(f.family==='rgb'){
        const values=f.layout==='gbr-planar'?[component(2*n+i),component(i),component(n+i)]:['r','g','b'].map(c=>component(i*f.order.length+f.order.indexOf(c)));
        if(values.some(x=>x<lo||x>hi))throw Error('SI/TI RGB 分量超出已声明合法范围；不裁剪负值或超白');
        v=weights[0]*values[0]+weights[1]*values[1]+weights[2]*values[2];
      }else{v=component(i);if(v<lo||v>hi)throw Error('SI/TI 亮度样本超出已声明合法范围；不裁剪负值或超白')}
      // A convex matrix can differ from an endpoint by one floating-point ULP.
      if(v<lo&&lo-v<=Number.EPSILON)v=lo;if(v>hi&&v-hi<=Number.EPSILON)v=hi;
      out[i]=sitiPreprocessedValue(sitiScaleValue(v,input),input);
      if(!Number.isFinite(out[i]))throw Error('SI/TI 预处理产生非有限数值');
    }
  }};
}
