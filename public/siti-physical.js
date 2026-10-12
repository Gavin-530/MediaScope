import {SITI_MATRICES,createSitiRawSamples} from './siti-formats.js';

export const SITI_PHYSICAL_PROFILES=['P910-2023-linear-light-float-v1','P910-2023-absolute-light-float-v1','P910-2023-linear-alpha-v1'];
export const physicalEncoding=encoding=>['normalized-linear','absolute-cdm2'].includes(encoding);
export function validateSitiPhysicalSettings(settings){
  if(settings.linearDisplay!==undefined){
    const d=settings.linearDisplay;
    if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['whiteCdM2','blackCdM2'].includes(k))||!Number.isFinite(d.whiteCdM2)||!Number.isFinite(d.blackCdM2)||d.whiteCdM2<=0||d.whiteCdM2>10000||d.blackCdM2<0||d.blackCdM2>=d.whiteCdM2||settings.floatEncoding!=='normalized-linear')throw Error('SI/TI 归一化线性光须指定有效黑位和峰值，不自动采用显示假设');
  }
  if(settings.alpha!==undefined){
    const a=settings.alpha;
    if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!['mode','backgroundCdM2'].includes(k))||!['straight','premultiplied-signal'].includes(a.mode)||!Array.isArray(a.backgroundCdM2)||a.backgroundCdM2.length!==3||a.backgroundCdM2.some(x=>!Number.isFinite(x)||x<0||x>10000))throw Error('SI/TI Alpha 须明确直通或存储信号域预乘，并输入三个 0–10000 cd/m² 的线性背景 RGB');
  }
}
export function sitiPhysicalFields(input){
  const {domain,linearDisplay,alphaComposition,scale}=input;
  const eotf=domain==='linear'?'user-confirmed normalized display-linear light: Lb + (Lw-Lb)*x':domain==='absolute'?'user-confirmed display-linear luminance in cd/m2; no EOTF':domain==='pq'?'ITU-R BT.2100-2 Table 4 PQ EOTF applied per RGB component':domain==='hlg'?'ITU-R BT.2100-2 Table 5 RGB HLG EOTF with luminance-dependent OOTF':'ITU-R BT.1886 (03/2011) Annex 1 reference EOTF applied per RGB component';
  return {configurationVersion:4,inputDomain:domain,input:structuredClone(input),
    preprocessing:input.deinterlace?'bwdif=mode=send_frame:parity=auto:deint=interlaced':'native decoded samples; no quantization or resampling',
    normalizationDivisor:input.format.float?1:2**input.depth-1,
    limitedRangeScaling:physicalEncoding(input.floatAssumption?.encoding)?'not applicable: physical float requires explicit pc range':'independent native legal endpoints to 0–1 before component EOTF; float32 endpoints rounded to storage precision',
    outputMultiplier:scale==='reference-255'?255:2**input.depth-1,
    outputScaling:scale==='reference-255'?'independent physical-light configuration; fixed multiplier 255':'independent physical-light configuration; input or user-confirmed equivalent-depth multiplier',
    eotf,eotfSelection:'user-confirmed physical-light input/compositing interpretation; independent of historical P.910 literal pre-processing',
    gamma:domain==='sdr'?2.4:domain==='hlg'?input.hlg.gamma:null,
    whiteCdM2:domain==='sdr'?300:domain==='hlg'?input.hlg.whiteCdM2:domain==='linear'?linearDisplay.whiteCdM2:null,
    blackCdM2:domain==='sdr'?.01:domain==='hlg'?input.hlg.blackCdM2:domain==='linear'?linearDisplay.blackCdM2:null,
    pq:'ITU-R BT.2100-2 (07/2018) Table 4 inverse EOTF',
    physicalLight:{units:'cd/m2',mapping:domain==='linear'?'Lb + (Lw-Lb)*x':domain==='absolute'?'native absolute display-light components':'per-component EOTF before linear-light composition and luma',source:'user-confirmed',acceptedLuminance:[0,10000]},
    alphaComposition:alphaComposition?{...structuredClone(alphaComposition),backgroundUnits:'linear cd/m2 in the source RGB primaries',backgroundAlpha:1,operation:'source-over in display-linear light; alpha*source + (1-alpha)*background',premultiplication:'if selected, undo association in normalized range-expanded source signal (or cd/m2) before EOTF; alpha=0 requires zero associated colour'}:null,
    lumaDerivation:input.matrix?{matrix:input.matrix.name,coefficients:[...SITI_MATRICES[input.matrix.name]],source:input.matrix.source,precision:'float64; display-linear weighted RGB before PQ; no integer quantization'}:null,
    comparison:{crossBitDepth:false,crossResolution:false,crossFrameRate:false},
    inputRangePolicy:'reject non-finite, negative, out-of-domain colour/alpha or invalid association; associated ceiling rounded to native storage precision, endpoint-only unassociation cap; no general clipping',
    precision:'float64 native samples, physical light and composition; two-pass population variance; unrounded samples',
    interpretationIssues:['独立物理亮度配置：显式输入解释或透明合成后生成 PQ 亮度，不代表 P.910 指定了唯一前处理。',
      ...(domain==='linear'?['归一化线性光按用户输入黑位/峰值仿射映射到显示亮度；不自动解释为场景光或应用 SDR/HLG EOTF。']:[]),
      ...(domain==='absolute'?['绝对亮度样本按用户声明的 cd/m² 显示光解释，接受 0–10000；不猜测单位、不再次执行 EOTF。']:[]),
      ...(alphaComposition?['Alpha 在线性显示光域合成到已记录的同色原色背景；预乘定义限定为输入信号域关联，不能自动猜测其他预乘约定。']:[]),
      ...(input.matrix?['RGB 在线性显示光域导出亮度，再编码为 PQ；与历史非线性加权后转换的配置不同。']:[]),
      ...(domain==='sdr'?['SDR 分量采用已声明的 BT.1886 Annex 1 模型；保留原有附录指向的解释边界。']:[]),
      ...(domain==='hlg'?['RGB HLG 使用亮度相关 OOTF；该完整 RGB 解释与历史非彩色标量亮度模型独立。']:[]),
      ...(input.floatAssumption?['浮点等效位深是输出尺度假设，不能从 float32 存储位数推断。']:[]),
      ...(scale!=='reference-255'?['输出采用输入或等效位深乘数，禁止直接跨位深比较。']:[]),
      ...(input.deinterlace?['BWDIF 属于用户选择的前处理；源格式须被滤镜原生支持。']:[])]};
}

const pq=l=>{const x=(l/10000)**(2610/16384);return ((3424/4096+(2413/128)*x)/(1+(2392/128)*x))**(2523/32)};
function displayLight(values,input,weights){
  if(input.domain==='absolute')return values;
  if(input.domain==='linear')return values.map(x=>input.linearDisplay.blackCdM2+(input.linearDisplay.whiteCdM2-input.linearDisplay.blackCdM2)*x);
  if(input.domain==='pq')return values.map(v=>{const p=v**(32/2523);return 10000*(Math.max(p-3424/4096,0)/(2413/128-(2392/128)*p))**(16384/2610)});
  if(input.domain==='sdr'){const black=.01**(1/2.4),gain=300**(1/2.4)-black;return values.map(v=>(gain*v+black)**2.4)}
  const {whiteCdM2,blackCdM2,gamma}=input.hlg,beta=Math.sqrt(3*(blackCdM2/whiteCdM2)**(1/gamma)),a=.17883277,b=1-4*a,c=.5-a*Math.log(4*a);
  const scene=values.map(v=>{const s=(1-beta)*v+beta;return s<=.5?s*s/3:(Math.exp((s-c)/a)+b)/12});
  const y=weights.reduce((sum,w,i)=>sum+w*scene[i],0),gain=whiteCdM2*y**(gamma-1);
  return scene.map(x=>gain*x);
}
export function createSitiPhysicalReader(input,w,h){
  const native=createSitiRawSamples(input,w,h),n=w*h,f=input.format,weights=input.matrix?SITI_MATRICES[input.matrix.name]:[1],absolute=input.domain==='absolute',physical=physicalEncoding(input.floatAssumption?.encoding);
  const max=2**input.depth-1,k=2**(input.depth-8),lower=!physical&&input.range==='tv'?16*k/max:0,upper=absolute?10000:!physical&&input.range==='tv'?235*k/max:1;
  const lo=f.float?Math.fround(lower):lower,hi=f.float?Math.fround(upper):upper,cap=absolute?10000:1;
  return {bytes:native.bytes,read(raw,out){
    if(out.length!==n)throw Error('SI/TI 物理亮度帧尺寸不一致');
    const samples=native.read(raw);
    for(let i=0;i<n;i++){
      const alpha=samples.alpha(i);
      if(alpha<0||alpha>1||!input.alphaComposition&&alpha!==1)throw Error('SI/TI Alpha 越界或透明内容缺少显式合成参数');
      let values=f.family==='rgb'?samples.rgb(i):[samples.component(i)];
      if(values.some(x=>x<lo||x>hi))throw Error('SI/TI 物理输入分量超出已声明范围；拒绝负值或越界亮度');
      if(!physical&&input.range==='tv')values=values.map(x=>(x-lo)/(hi-lo));
      if(input.alphaComposition?.mode==='premultiplied-signal'){
        const ceiling=physical?(f.float?Math.fround(alpha*cap):alpha*cap):(f.float?Math.fround(lo+alpha*(hi-lo)):Math.round((lo+alpha*(hi-lo))*max)/max)-lo;
        const bound=physical?ceiling:ceiling/(hi-lo);
        if(values.some(x=>x>bound+Number.EPSILON*cap)||alpha===0&&values.some(x=>x!==0))throw Error('SI/TI 预乘分量与 Alpha 不一致；零 Alpha 须有零关联颜色');
        values=alpha===0?values.map(()=>0):values.map(x=>Math.min(cap,x/alpha));
      }
      let light=displayLight(values,input,weights);
      if(input.alphaComposition)light=light.map((x,c)=>alpha*x+(1-alpha)*input.alphaComposition.backgroundCdM2[c]);
      const luminance=weights.reduce((sum,c,j)=>sum+c*light[j],0);
      if(!Number.isFinite(luminance)||luminance<0||luminance>10000+1e-8)throw Error('SI/TI 物理亮度超出 PQ 0–10000 cd/m² 域');
      out[i]=pq(Math.min(10000,luminance));
    }
  }};
}
