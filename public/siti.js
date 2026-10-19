import {MAX_ANALYSIS_FRAMES,validateSitiDimensions} from './analysis-limits.js';
// Fixed siti-tools 0.6.0 PQ calculation; native layouts and RGB are declared adapters.
// VQEG mathematical functions are ported under MIT; see licenses/VQEG-siti-tools.txt.
export const SITI_STANDARD_PROFILE='P910-2023-PQ-v1';
export const SITI_COMPAT_PROFILE='VQEG-siti-tools-0.6.0-PQ-v1';
// Historical profiles identify saved values only; new calculations use version 8.
export const SITI_PROFILE='VQEG-siti-c537e337-PQ';
export const SITI_HLG_PROFILE='P910-HLG-BT2100-2-PQ-v1';
export const SITI_REFERENCE=Object.freeze({project:'VQEG/siti-tools',commit:'c537e33793266187aad87c859fd62a9de9033854',sourceSha256:'84557e030e302fa14e28a1cd1227f3320986050c4cf5f5f4d590215971329873'});
// Pinned test/test.py: pytest.approx(actual, rel=0.005, abs=0.01) == reference.
export const SITI_NUMERIC_TOLERANCE=Object.freeze({absoluteTolerance:.01,relativeTolerance:.005,toleranceRule:'max',relativeTo:'actual',toleranceSource:'siti-tools 0.6.0 test/test.py (c537e33793266187aad87c859fd62a9de9033854); upstream regression criterion, not an ITU guarantee'});
export function sitiValuesClose(actual,reference){return Number.isFinite(actual)&&Number.isFinite(reference)&&Math.abs(actual-reference)<=Math.max(SITI_NUMERIC_TOLERANCE.absoluteTolerance,SITI_NUMERIC_TOLERANCE.relativeTolerance*Math.abs(actual));}
export const SITI_MATRICES=Object.freeze({bt601:[.299,.587,.114],bt709:[.2126,.7152,.0722],bt2020:[.2627,.678,.0593]});
const HLG_A=.17883277,HLG_B=.02372241,HLG_C=1.00429347;
const SDR_WHITE=300,SDR_BLACK=.01,GAMMA=2.4;
const SDR_ROOT=SDR_WHITE**(1/GAMMA)-SDR_BLACK**(1/GAMMA);
const SDR_GAIN=SDR_ROOT**GAMMA,SDR_LIFT=SDR_BLACK**(1/GAMMA)/SDR_ROOT;
const SITI_INTERPRETATIONS=Object.freeze({range:'native integer nominal endpoints; 7.8.1.2 extended from 8-bit',sdr:'BT.1886 Annex 1 reference EOTF; B.2 Appendix 1 locator interpreted',pq:'already in target PQ domain; no repeated encoding',output:'7.8.1.5 b is the input integer bit depth'});
function version7Display(input){
  return input.domain==='pq'?null:input.domain==='hlg'?{...input.hlg}:input.domain==='srgb'?{whiteCdM2:80,blackCdM2:.2,gamma:GAMMA,model:'inverse sRGB reference display'}:{whiteCdM2:SDR_WHITE,blackCdM2:SDR_BLACK,gamma:GAMMA,gain:SDR_GAIN,blackLift:SDR_LIFT,model:'BT.1886 Annex 1 reference EOTF'};
}
function version7Hlg({whiteCdM2:white,blackCdM2:black}){
  // Table 5 note 5f; footnote 2 extends gamma outside 400–2000 cd/m².
  const gamma=white>=400&&white<=2000?1.2+.42*Math.log10(white/1000):1.2*1.111**Math.log2(white/1000);
  return {whiteCdM2:white,blackCdM2:black,gamma,beta:Math.sqrt(3*(black/white)**(1/gamma))};
}
function hlgDisplay({whiteCdM2:white,blackCdM2:black}){
  return {whiteCdM2:white,blackCdM2:black,gamma:white<=1000?1.2:1.2+.42*Math.log10(white/1000)};
}
function sitiDisplay(input){return input.domain==='pq'?null:input.domain==='hlg'?{...input.hlg}:{whiteCdM2:300,blackCdM2:.1,gamma:2.4,model:input.domain==='srgb'?'siti-tools inverse sRGB and affine display':'siti-tools BT.1886 and affine display'};}

export function validateSitiSettings(settings,{historical=false}={}){
  if(settings===undefined)return;
  if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(k=>!['range','transfer','interlaced','matrix','hlg'].includes(k)))throw Error('SI/TI 参数无效；旧版自定义计算口径已停用，请重新选择输入设置');
  if(![undefined,'auto','tv','pc'].includes(settings.range)||![undefined,'auto','sdr','srgb','pq','hlg'].includes(settings.transfer)||![undefined,'reject','bwdif'].includes(settings.interlaced)||![undefined,'auto',...Object.keys(SITI_MATRICES)].includes(settings.matrix))throw Error('SI/TI 范围、传递函数、矩阵或隔行处理无效');
  const h=settings.hlg;
  if(h!==undefined&&(!h||typeof h!=='object'||Array.isArray(h)||Object.keys(h).some(k=>!['whiteCdM2','blackCdM2'].includes(k))||!Number.isFinite(h.whiteCdM2)||h.whiteCdM2<=0||h.whiteCdM2>10000||!Number.isFinite(h.blackCdM2)||h.blackCdM2<0||h.blackCdM2>=h.whiteCdM2||![undefined,'auto','hlg'].includes(settings.transfer)))throw Error('SI/TI HLG 显示峰值或黑位无效');
}
export function sitiRgbMatrix(stream,choice){
  if(choice&&choice!=='auto')return {name:choice,source:'user-confirmed'};
  const a={bt709:'bt709',bt470bg:'bt601',smpte170m:'bt601',bt2020nc:'bt2020'}[stream.color_space],b={bt709:'bt709',bt470bg:'bt601',smpte170m:'bt601',bt2020:'bt2020'}[stream.color_primaries];
  if(stream.color_space&&!['gbr','unknown','unspecified','bt709','bt470bg','smpte170m','bt2020nc'].includes(stream.color_space)||stream.color_primaries&&!['unknown','unspecified','bt709','bt470bg','smpte170m','bt2020'].includes(stream.color_primaries)||a&&b&&a!==b)return null;
  return a?{name:a,source:'stream-matrix'}:b?{name:b,source:'stream-primaries'}:null;
}
export function sitiInput(stream,settings,options){
  validateSitiSettings(settings,options);
  const format=sitiFormat(stream.pix_fmt);
  if(!format||format.float)throw Error('SI/TI 不支持该像素布局或浮点亮度语义；缺少参考依据，不生成估计值');
  const range=settings?.range&&settings.range!=='auto'?settings.range:stream.color_range;
  const tagged={bt709:'sdr',smpte170m:'sdr',smpte240m:'sdr','bt2020-10':'sdr','bt2020-12':'sdr','iec61966-2-1':'srgb',smpte2084:'pq','arib-std-b67':'hlg'}[stream.color_transfer];
  const domain=settings?.transfer&&settings.transfer!=='auto'?settings.transfer:tagged;
  const matrix=format.family==='rgb'?sitiRgbMatrix(stream,settings?.matrix):null,deinterlace=settings?.interlaced==='bwdif';
  if(!['tv','pc'].includes(range)||!domain)throw Error('SI/TI 需要明确的亮度范围和传递函数；请核实文件声明或确认输入设置');
  if(format.family==='rgb'&&!matrix)throw Error('SI/TI RGB 需要一致且受支持的亮度矩阵；请核实文件声明或确认矩阵');
  if(!['progressive','unknown',undefined].includes(stream.field_order)&&!deinterlace)throw Error('SI/TI 隔行输入需要明确选择去隔行处理');
  return {format,depth:format.depth,range,domain,matrix,deinterlace,hlg:domain==='hlg'?hlgDisplay(settings?.hlg??{whiteCdM2:1000,blackCdM2:.01}):null,settings:settings?structuredClone(settings):null,
    source:{pixelFormat:stream.pix_fmt,range:stream.color_range??null,transfer:stream.color_transfer??null,fieldOrder:stream.field_order??null,matrix:stream.color_space??null,primaries:stream.color_primaries??null}};
}
export function sitiConfiguration(input){
  return {configurationVersion:8,profile:SITI_COMPAT_PROFILE,standard:'ITU-T P.910 (10/2023)',reference:{...SITI_REFERENCE,version:'0.6.0'},referenceAgreement:'Fixed siti-tools 0.6.0 normalization, display/PQ, Sobel/TI and 255 scale; adapters recorded separately',input:structuredClone(input),inputDomain:input.domain,inputBitDepth:input.depth,inputRange:input.range,domain:'PQ',display:sitiDisplay(input),outputMultiplier:255,firstTi:null,preprocessing:input.deinterlace?'bwdif=mode=send_frame:parity=auto:deint=interlaced':'native decoded samples',lumaDerivation:input.matrix?{...input.matrix,coefficients:[...SITI_MATRICES[input.matrix.name]]}:null,inputAdapter:{layout:input.format.layout,extendedBitDepth:![8,10,12].includes(input.depth),rgbLuma:!!input.matrix}};
}
function version7Configuration(input){
  return {configurationVersion:7,profile:SITI_STANDARD_PROFILE,standard:'ITU-T P.910 (10/2023)',reference:SITI_REFERENCE,referenceAgreement:'VQEG Sobel/TI kernels; independently specified display models and input-bit-depth output',interpretations:{...SITI_INTERPRETATIONS},input:structuredClone(input),inputDomain:input.domain,inputBitDepth:input.depth,inputRange:input.range,domain:'PQ',
    display:version7Display(input),
    outputMultiplier:2**input.depth-1,firstTi:null,preprocessing:input.deinterlace?'bwdif=mode=send_frame:parity=auto:deint=interlaced':'native decoded samples',
    lumaDerivation:input.matrix?{...input.matrix,coefficients:[...SITI_MATRICES[input.matrix.name]]}:null};
}
export function validateSitiConfiguration(execution,stream){
  const c=execution?.configuration;
  // Historical reports retain their original values and method, without running old algorithms.
  if(![SITI_PROFILE,SITI_HLG_PROFILE,SITI_STANDARD_PROFILE,SITI_COMPAT_PROFILE].some(p=>execution?.method===p||c?.profile===p)&&![5,6,7,8].includes(c?.configurationVersion))return;
  if(![5,6,7,8].includes(c?.configurationVersion))throw Error('SI/TI 计算配置版本无效');
  const input=sitiInput(stream,c?.input?.settings??undefined,{historical:true});
  if(c.configurationVersion!==8&&input.hlg)input.hlg=version7Hlg(input.hlg);
  if(c.configurationVersion===7&&input.hlg?.beta>=1)throw Error('SI/TI HLG 黑位抬升超出历史模型有效范围');
  const expected=c.configurationVersion===8?sitiConfiguration(input):version7Configuration(input);
  if([5,6].includes(c?.configurationVersion)){
    if(c.configurationVersion===6&&expected.inputDomain!=='hlg')throw Error('SI/TI 历史计算配置版本无效');
    expected.configurationVersion=c.configurationVersion;expected.profile=c.configurationVersion===6?SITI_HLG_PROFILE:SITI_PROFILE;
    expected.referenceAgreement=c.configurationVersion===6?'BT.2100-2 Table 5 HLG EOTF; VQEG PQ metrics; integer storage and RGB luma adapters':'VQEG PQ pipeline; integer storage and RGB luma adapters';
    expected.display=expected.inputDomain==='pq'?null:expected.inputDomain==='hlg'?{...expected.input.hlg}:{whiteCdM2:300,blackCdM2:.1,gamma:2.4};
    expected.outputMultiplier=255;delete expected.interpretations;
  }
  // Validate old HLG declarations without re-running or relabelling old values.
  if(c?.configurationVersion===5&&c?.profile===SITI_PROFILE&&expected.inputDomain==='hlg'){
    const {whiteCdM2:white,blackCdM2:black}=expected.input.hlg;
    expected.configurationVersion=5;expected.profile=SITI_PROFILE;expected.referenceAgreement='VQEG PQ pipeline; integer storage and RGB luma adapters';
    expected.input.hlg={whiteCdM2:white,blackCdM2:black};expected.display={...expected.input.hlg,gamma:white<=1000?1.2:1.2+.42*Math.log10(white/1000)};
  }
  const same=(a,b)=>b!==null&&typeof b==='object'?a!==null&&typeof a==='object'&&Object.keys(a).length===Object.keys(b).length&&Object.entries(b).every(([k,v])=>same(a[k],v)):a===b;
  if(execution.method!==expected.profile||!same(c,expected))throw Error('SI/TI 计算配置与标准处理流程、参考或输入不一致');
}
export function sitiPreprocessedValue(v,input){
  if(input.domain==='pq')return v;
  let luminance;
  if(input.domain==='hlg'){
    const {whiteCdM2:white,blackCdM2:black,gamma}=input.hlg;
    // Preserve the pinned upstream high branch, including its discontinuity.
    const linear=v<=.5?v*v/3:Math.exp((v-HLG_C)/HLG_A)-HLG_B;
    luminance=(white-black)*linear**gamma+black;
  }else{
    const linear=input.domain==='srgb'?(v<=.04045?v/12.92:((v+.055)/1.055)**2.4):v**2.4;
    luminance=(300-.1)*linear+.1;
  }
  const y=(luminance/10000)**(2610/16384);
  return ((3424/4096+(2413/128)*y)/(1+(2392/128)*y))**(2523/32);
}
export function createSitiLut(input){
  const max=2**input.depth-1,factor=2**(input.depth-8),lo=input.range==='tv'?16*factor:0,hi=input.range==='tv'?235*factor:max;
  return Float64Array.from({length:max+1},(_,code)=>code<lo||code>hi?NaN:sitiPreprocessedValue((code-lo)/(hi-lo),input));
}
// Sample offsets are shared by the CPU reader and GPU request; no colour conversion or quantization.
export function sitiFrameLayout(input,w,h){
  const f=input.format,n=w*h,bytes=sitiRawBytes(f,w,h),max=2**input.depth-1,factor=2**(input.depth-8),lo=input.range==='tv'?16*factor:0,hi=input.range==='tv'?235*factor:max;
  const stride=f.layout==='rgb-packed'?f.order.length:0;
  return {bytes,max,lo,hi,stride,red:stride?f.order.indexOf('r'):2*n,green:stride?f.order.indexOf('g'):0,blue:stride?f.order.indexOf('b'):n,alpha:stride?f.order.indexOf('a'):f.layout==='gbr-planar'?3*n:bytes/(f.storage/8)-n};
}
export function sitiGpuParameters(input,w,h){
  const layout=sitiFrameLayout(input,w,h),display=sitiDisplay(input);
  return Float64Array.from([...(input.matrix?SITI_MATRICES[input.matrix.name]:[0,0,0]),layout.lo,layout.hi,{pq:0,sdr:1,srgb:2,hlg:3}[input.domain],display?.whiteCdM2??0,display?.blackCdM2??0,display?.gamma??0,input.hlg?.beta??0,HLG_A,HLG_B,HLG_C,2610/16384,2523/32,3424/4096,2413/128,2392/128,display?.gain??0,display?.blackLift??0]);
}
export function createSitiReader(input,w,h){
  const f=input.format,n=w*h,{bytes,max,lo,hi,stride,red,green,blue,alpha}=sitiFrameLayout(input,w,h);
  const weights=input.matrix?SITI_MATRICES[input.matrix.name]:null;
  const table=f.family==='luma'?createSitiLut(input):null,shift=f.shift,padding=2**shift-1,little=f.endian==='le';
  return {bytes,read(raw,out){
    if(raw.length!==bytes||out.length!==n)throw Error('SI/TI 原始帧尺寸不一致');
    const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    const component=f.storage===8?i=>raw[i]:i=>{const word=view.getUint16(i*2,little),code=word>>>shift;if(word&padding||code>max)throw Error('SI/TI 填充位非零或样本超出位深');return code};
    for(let i=0;i<n;i++){
      const base=i*stride;
      if(f.alpha&&component(stride?base+alpha:alpha+i)!==max)throw Error('SI/TI 半透明输入缺少参考合成流程；仅支持完全不透明的 Alpha');
      let value;
      if(weights){
        const r=component(stride?base+red:red+i),g=component(stride?base+green:green+i),b=component(stride?base+blue:blue+i);
        if(r<lo||r>hi||g<lo||g>hi||b<lo||b>hi)throw Error('SI/TI RGB 分量超出声明范围；不裁剪或改判范围');
        const v=weights[0]*(r-lo)/(hi-lo)+weights[1]*(g-lo)/(hi-lo)+weights[2]*(b-lo)/(hi-lo);
        value=sitiPreprocessedValue(Math.min(1,Math.max(0,v)),input); // Convex weights: endpoint floating-point roundoff only.
      }else{const code=component(i);value=table[code];if(!Number.isFinite(value))throw Error(`SI/TI 亮度码值 ${code} 超出声明范围；不裁剪或改判范围`)}
      if(!Number.isFinite(value))throw Error('SI/TI 预处理结果无效');out[i]=value;
    }
  }};
}
function populationStd(values){
  let sum=0,correction=0;
  for(const value of values){const y=value-correction,t=sum+y;correction=(t-sum)-y;sum=t}
  const mean=sum/values.length;sum=0;correction=0;
  for(const value of values){const d=value-mean,y=d*d-correction,t=sum+y;correction=(t-sum)-y;sum=t}
  return Math.sqrt(sum/values.length);
}
export function createSitiCalculator(w,h,input){
  validateSitiDimensions(w,h);
  const reader=createSitiReader(input,w,h),n=w*h,multiplier=255;let current,previous,gradient,motion,frame=0;
  return {...reader,measure(raw,first=false,previousRaw=null){
    if(!current){current=new Float64Array(n);previous=new Float64Array(n);gradient=new Float64Array((w-2)*(h-2));motion=new Float64Array(n)}
    reader.read(raw,current);const temporal=(frame>0||previousRaw!==null)&&!first;
    if(temporal&&previousRaw!==null)reader.read(previousRaw,previous);
    if(temporal)for(let i=0;i<n;i++)motion[i]=current[i]-previous[i];
    let j=0;
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=y*w+x,tl=current[i-w-1],tr=current[i-w+1],bl=current[i+w-1],br=current[i+w+1];
      gradient[j++]=Math.hypot(-tl+tr-2*current[i-1]+2*current[i+1]-bl+br,-tl-2*current[i-w]-tr+bl+2*current[i+w]+br);
    }
    const point={frame:frame++,si:populationStd(gradient)*multiplier,ti:temporal?populationStd(motion)*multiplier:null};[previous,current]=[current,previous];return point;
  }};
}

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

export function distribution(values){const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?{min:a[0],mean:a.reduce((s,x)=>s+x,0)/a.length,p05:a[Math.floor((a.length-1)*.05)],p95:a[Math.floor((a.length-1)*.95)],max:a.at(-1),count:a.length}:null}

// Display-frame indices are zero based in saved data; the UI presents them from 1.
// Undefined means cuts have not been confirmed. [0] explicitly confirms one scene.
export function validateSitiSceneStarts(starts,count=null){
  if(starts===undefined)return;
  if(!Array.isArray(starts)||!starts.length||starts.length>2048||starts[0]!==0||starts.some((x,i)=>!Number.isSafeInteger(x)||x<0||x>=MAX_ANALYSIS_FRAMES||i>0&&x<=starts[i-1]||count!==null&&x>=count))throw Error('SI/TI 场景起始帧须从第 1 帧开始、严格递增且位于视频内（最多 2048 个场景）');
}

export function sitiSceneSummary(points,starts){
  validateSitiSceneStarts(starts,points.length);
  const scenes=starts?.map((start,index)=>{
    const end=starts[index+1]??points.length,part=points.slice(start,end);
    return {index,startFrame:start,endFrame:end-1,frameCount:part.length,startTime:part[0].t,lastTime:part.at(-1).t,si:distribution(part.map(p=>p.si)),ti:distribution(part.slice(1).map(p=>p.ti))};
  })??[];
  return {sceneAnalysis:{version:1,mode:starts?'confirmed':'unconfirmed',starts:starts??null},scenes,
    si:scenes.length>1?null:scenes[0]?.si??distribution(points.map(p=>p.si)),ti:scenes.length>1?null:scenes.length===1?scenes[0].ti:distribution(points.slice(1).map(p=>p.ti))};
}

export function validateSitiSceneResult(content,frames){
  const fail=()=>{throw Error('SI/TI 场景、逐帧值或统计与报告不一致')};
  const {sceneAnalysis:a,points}=content;
  if(a?.version!==1||!['confirmed','unconfirmed'].includes(a.mode)||!Array.isArray(points)||!points.length||points.length!==frames.length)fail();
  if(a.mode==='unconfirmed'&&a.starts!==null)fail();
  const starts=a.mode==='confirmed'?a.starts:undefined;
  validateSitiSceneStarts(starts,points.length);
  if(a.mode==='confirmed'&&starts===undefined)fail();
  validateSitiPoints(points,frames,{sceneStarts:starts??[0]});
  const expected=sitiSceneSummary(points,starts);
  const sameStats=(actual,wanted)=>wanted===null?actual===null:actual&&Object.keys(wanted).every(k=>actual[k]===wanted[k]);
  if(!sameStats(content.si,expected.si)||!sameStats(content.ti,expected.ti)||!Array.isArray(content.scenes)||content.scenes.length!==expected.scenes.length)fail();
  for(const [i,s] of expected.scenes.entries())for(const [k,v] of Object.entries(s)){
    const actual=content.scenes[i]?.[k];
    if(k==='si'||k==='ti'){if(!sameStats(actual,v))fail()}else if(actual!==v)fail();
  }
}

// These checks apply equally to CPU, GPU and recovered SI/TI results.
export function sitiTimestamp(pts,timeBase){
  const base=/^(\d+)\/(\d+)$/.exec(timeBase??'');
  const ticks=/^-?\d+$/.test(String(pts))?Number(pts):NaN;
  const numerator=base?Number(base[1]):NaN,denominator=base?Number(base[2]):NaN;
  if(!Number.isSafeInteger(ticks)||!Number.isSafeInteger(numerator)||numerator<=0||!Number.isSafeInteger(denominator)||denominator<=0)throw Error('SI/TI 整数 PTS 或时间基无效');
  const t=ticks*(numerator/denominator);
  if(!Number.isFinite(t))throw Error('SI/TI 帧时间戳无效');
  return t;
}

export function validateSitiPoints(points,frames=null,{sceneStarts=[]}={}){
  if(!Array.isArray(points)||!points.length||points.length>MAX_ANALYSIS_FRAMES)throw Error('SI/TI 结果帧数无效');
  if(frames!==null&&(!Array.isArray(frames)||points.length!==frames.length))throw Error('SI/TI 结果帧数与预扫描不一致');
  const starts=new Set(sceneStarts);
  for(let i=0;i<points.length;i++){
    const p=points[i];
    if(!p||p.frame!==i)throw Error(`SI/TI 第 ${i+1} 帧序号无效`);
    if(!Number.isFinite(p.t))throw Error(`SI/TI 第 ${i+1} 帧时间戳无效`);
    const noFirstTi=i===0||starts.has(i);
    if(!Number.isFinite(p.si)||p.si<0||!noFirstTi&&(!Number.isFinite(p.ti)||p.ti<0))throw Error(`SI/TI 第 ${i+1} 帧指标无效`);
    if(noFirstTi&&p.ti!==null)throw Error('P.910 场景首帧没有 TI 值');
    if(frames!==null){
      const expected=frames[i]?.t;
      if(!Number.isFinite(expected))throw Error(`SI/TI 预扫描第 ${i+1} 帧时间戳无效`);
      // FFprobe prints seconds to six decimal places. Account only for that
      // half-microsecond rounding and floating-point arithmetic, not frame drift.
      const rounding=0.0000005+4*Number.EPSILON*Math.max(1,Math.abs(p.t),Math.abs(expected));
      if(Math.abs(p.t-expected)>rounding)throw Error(`SI/TI 第 ${i+1} 帧时间戳与预扫描不一致`);
    }
  }
}
export function validateSitiAttempts(execution,count,{completed=true}={}){
  const attempts=execution?.attempts;if(attempts===undefined)return;
  const fail=()=>{throw Error('SI/TI 执行尝试、设备或耗时记录无效');};
  if(!Array.isArray(attempts)||!attempts.length||attempts.length>3)fail();
  for(const [i,a] of attempts.entries()){
    if(!a||!['cpu','gpu'].includes(a.device)||!Number.isInteger(a.workers)||a.workers<1||a.workers>8||!['passed','failed','cancelled'].includes(a.outcome)||!Number.isSafeInteger(a.framesComputed)||a.framesComputed<0||a.framesComputed>count||!Number.isFinite(a.elapsedSeconds)||a.elapsedSeconds<0)fail();
    if(i<attempts.length-1&&a.outcome!=='failed'||a.outcome!=='passed'&&(typeof a.reason!=='string'||!['input','decode','validation','cpu','gpu','gpu-initialization','cancelled'].includes(a.phase)))fail();
    for(const key of ['gpuReadySeconds','configurationSeconds','timeToFirstPointSeconds','timeToFirstDecodedFrameSeconds'])if(a[key]!==undefined&&(!Number.isFinite(a[key])||a[key]<0||a[key]>a.elapsedSeconds+1e-6))fail();
  }
  const last=attempts.at(-1);
  if(completed&&(last.outcome!=='passed'||last.framesComputed!==count||last.device!==execution.device||last.workers!==execution.workers)||!completed&&last.outcome==='passed')fail();
}
