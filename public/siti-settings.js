import {sitiFormat,sitiRgbMatrix,SITI_MATRICES} from './siti-formats.js';
import {physicalEncoding,validateSitiPhysicalSettings,sitiPhysicalFields} from './siti-physical.js';
export const SITI_EXTENDED_PROFILE='P910-2023-luma-text-v2';
export const SITI_PQ_PROFILE='P910-2023-PQ-preserved-v1';
export const SITI_HLG_PROFILE='P910-2023-HLG-display-v1';
export const SITI_HLG_DISPLAY=Object.freeze({whiteCdM2:1000,blackCdM2:.01,gamma:1.2});
export function sitiInterpretationIssues(depth,range,domain,deinterlace=false){
  return [...(depth>8&&range==='tv'?['7.8.1.2 使用原文 8-bit 比例，高位深合法黑白码值不会严格映射为 0 和 1。']:[]),
    ...(depth>8?['7.8.1.5 按输入位深乘数输出，与原文“同一尺度比较”的文字存在矛盾；禁止直接跨位深比较。']:[]),
    ...(domain==='sdr'?['B.2 指向 BT.1886 Appendix 1；本配置选择其讨论的 Annex 1 参考方程。']:[]),
    ...(domain==='pq'?['7.8.1.3/4 的 PQ 恒等分支与物理亮度串联有歧义；本配置采用明确选择的 PQ 保留解释。']:[]),
    ...(domain==='hlg'?['HLG 采用已记录的显示模型假设，并将原生亮度视为非彩色信号应用 EOTF。']:[]),
    ...(deinterlace?['BWDIF 每帧输出一帧属于用户选择的前处理；P.910 没有指定唯一隔行方法。']:[])];
}

export function sitiPixelDepth(format){return sitiFormat(format)?.depth??null}
export function validateSitiSettings(settings){
  if(settings===undefined)return;
  if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(k=>!['range','transfer','interlaced','hlg','pqInterpretation','scale','matrix','floatDepth','floatEncoding','linearDisplay','alpha'].includes(k)))throw Error('SI/TI 输入解释参数无效');
  if(![undefined,'auto','tv','pc'].includes(settings.range)||![undefined,'auto','sdr','pq','hlg'].includes(settings.transfer)||![undefined,'reject','bwdif'].includes(settings.interlaced)||![undefined,'preserve-pq'].includes(settings.pqInterpretation))throw Error('SI/TI 输入范围、传递函数或隔行处理无效');
  if(![undefined,'literal','reference-255'].includes(settings.scale)||![undefined,'auto',...Object.keys(SITI_MATRICES)].includes(settings.matrix)||![undefined,8,9,10,12,14,16].includes(settings.floatDepth)||![undefined,'normalized-nonlinear','normalized-linear','absolute-cdm2'].includes(settings.floatEncoding))throw Error('SI/TI 范围/尺度配置、RGB 矩阵或浮点输入解释无效');
  validateSitiPhysicalSettings(settings);
  if(settings.hlg!==undefined){
    const h=settings.hlg;
    if(!h||typeof h!=='object'||Array.isArray(h)||Object.keys(h).some(k=>!['whiteCdM2','blackCdM2','gamma'].includes(k))||
      !Number.isFinite(h.whiteCdM2)||h.whiteCdM2<=0||h.whiteCdM2>10000||!Number.isFinite(h.blackCdM2)||h.blackCdM2<0||h.blackCdM2>=h.whiteCdM2||!Number.isFinite(h.gamma)||h.gamma<1||h.gamma>3||Math.sqrt(3*(h.blackCdM2/h.whiteCdM2)**(1/h.gamma))>=1)throw Error('SI/TI HLG 显示峰值、黑位或系统 gamma 无效');
  }
}
export function sitiP910Input(stream,settings){
  validateSitiSettings(settings);
  const format=sitiFormat(stream.pix_fmt);
  if(!format)return null;
  const depth=format.float?settings?.floatDepth:format.depth;
  if(physicalEncoding(settings?.floatEncoding)||settings?.alpha){
    const physical=physicalEncoding(settings?.floatEncoding),domain=physical?(settings.floatEncoding==='normalized-linear'?'linear':'absolute'):settings?.transfer&&settings.transfer!=='auto'?settings.transfer:['bt709','smpte170m','smpte240m','bt2020-10','bt2020-12'].includes(stream.color_transfer)?'sdr':stream.color_transfer==='smpte2084'?'pq':stream.color_transfer==='arib-std-b67'?'hlg':null;
    const range=settings?.range&&settings.range!=='auto'?settings.range:stream.color_range,matrix=format.family==='rgb'?sitiRgbMatrix(stream,settings?.matrix):null;
    if(!depth||physical&&(!format.float||settings.range!=='pc'||settings.transfer&&!['auto'].includes(settings.transfer)||settings.hlg||settings.pqInterpretation||domain==='linear'&&!settings.linearDisplay)||format.float&&!settings.floatEncoding||settings.alpha&&(!format.alpha||format.family!=='rgb'||settings.pqInterpretation)||!domain||!['pc','tv'].includes(range)||format.family==='rgb'&&!matrix||!['unknown','progressive',undefined].includes(stream.field_order)&&settings?.interlaced!=='bwdif')return null;
    return {version:4,depth,range,domain,profile:settings.alpha?'P910-2023-linear-alpha-v1':domain==='linear'?'P910-2023-linear-light-float-v1':'P910-2023-absolute-light-float-v1',format,matrix,scale:settings.scale??'literal',
      hlg:domain==='hlg'?{...(settings.hlg??SITI_HLG_DISPLAY)}:null,hlgParameterSource:domain==='hlg'?(settings.hlg?'user-supplied':'project-confirmed-display-assumption'):null,
      linearDisplay:domain==='linear'?structuredClone(settings.linearDisplay):null,alphaComposition:settings.alpha?structuredClone(settings.alpha):null,
      floatAssumption:format.float?{encoding:settings.floatEncoding,equivalentBitDepth:depth,source:'user-confirmed'}:null,
      deinterlace:settings.interlaced==='bwdif',settings:structuredClone(settings),source:{pixelFormat:stream.pix_fmt,range:stream.color_range??null,transfer:stream.color_transfer??null,fieldOrder:stream.field_order??null},
      sourceColor:{matrix:stream.color_space??null,primaries:stream.color_primaries??null},interpretation:{range:settings.range&&settings.range!=='auto'?'user-confirmed':'stream-metadata',transfer:physical?'user-confirmed-physical-light':settings.transfer&&settings.transfer!=='auto'?'user-confirmed':'stream-metadata'}};
  }
  if(!depth||format.float&&settings?.floatEncoding!=='normalized-nonlinear')return null;
  const range=settings?.range&&settings.range!=='auto'?settings.range:stream.color_range;
  const sourceDomain=['bt709','smpte170m','smpte240m','bt2020-10','bt2020-12'].includes(stream.color_transfer)?'sdr':stream.color_transfer==='smpte2084'?'pq':stream.color_transfer==='arib-std-b67'?'hlg':null;
  const domain=settings?.transfer&&settings.transfer!=='auto'?settings.transfer:sourceDomain;
  const interlaced=!['unknown','progressive',undefined].includes(stream.field_order);
  if(!['tv','pc'].includes(range)||!domain||interlaced&&settings?.interlaced!=='bwdif'||domain==='pq'&&settings?.pqInterpretation!=='preserve-pq')return null;
  const matrix=format.family==='rgb'?sitiRgbMatrix(stream,settings?.matrix):null;
  if(format.family==='rgb'&&!matrix)return null;
  const scale=settings?.scale??'literal';
  const version3=scale!=='literal'||!/^(?:yuv(?:420|422|444|440|411|410)p|gray)(?:(9|10|12|14|16)le)?$/.test(stream.pix_fmt);
  const historical=domain==='sdr'&&stream.color_transfer==='bt709'&&[8,10].includes(depth)&&/^yuv(420|422)p(10le)?$/.test(stream.pix_fmt)&&!settings;
  return {depth,range,domain,profile:version3?(scale==='reference-255'?'P910-2023-reference-255-v1':format.float?'P910-2023-float-text-v1':format.family==='rgb'?'P910-2023-rgb-text-v1':'P910-2023-native-storage-text-v1'):historical?'P910-2023-SDR-BT1886-text-v1':domain==='pq'?SITI_PQ_PROFILE:domain==='hlg'?SITI_HLG_PROFILE:SITI_EXTENDED_PROFILE,
    hlg:domain==='hlg'?{...(settings?.hlg??SITI_HLG_DISPLAY)}:null,hlgParameterSource:domain==='hlg'?(settings?.hlg?'user-supplied':'project-confirmed-display-assumption'):null,deinterlace:settings?.interlaced==='bwdif',settings:settings?structuredClone(settings):null,
    source:{pixelFormat:stream.pix_fmt,range:stream.color_range??null,transfer:stream.color_transfer??null,fieldOrder:stream.field_order??null},
    interpretation:{range:settings?.range&&settings.range!=='auto'?'user-confirmed':'stream-metadata',transfer:settings?.transfer&&settings.transfer!=='auto'?'user-confirmed':'stream-metadata'},
    ...(version3?{version:3,format,matrix,scale,floatAssumption:format.float?{encoding:'normalized-nonlinear',equivalentBitDepth:depth,source:'user-confirmed'}:null,sourceColor:{matrix:stream.color_space??null,primaries:stream.color_primaries??null}}:{})};
}

export function sitiInputIssues(input){
  if(input.version!==3)return sitiInterpretationIssues(input.depth,input.range,input.domain,input.deinterlace);
  const base=sitiInterpretationIssues(input.depth,input.range,input.domain,input.deinterlace);
  return [...(input.scale==='reference-255'?base.filter(x=>!x.startsWith('7.8.1.2')&&!x.startsWith('7.8.1.5')):base),
    ...(input.scale==='reference-255'?['独立范围/尺度参考配置采用原位深合法端点和固定乘数 255；不是 P.910（10/2023）原文公式或官方勘误，显示模型仍使用本项目已声明参数。']:[]),
    ...(input.matrix?['RGB 按已记录矩阵从非线性 R′G′B′ 导出分数亮度，双精度计算，不先量化到整数 Y；该输入解释不是 P.910 指定的唯一 RGB 转换方法。']:[]),
    ...(input.floatAssumption?['浮点按用户确认的 0–1 非线性归一化码值解释，等效位深属于计算假设，不能从 32-bit 浮点存储推断。']:[]),
    ...(input.format.alpha?['透明通道须逐样本为完全不透明；不猜测背景或预乘语义。']:[])];
}

export function sitiVersion3Fields(input){
  return {configurationVersion:3,inputDomain:input.domain,input:structuredClone(input),
    preprocessing:input.deinterlace?'bwdif=mode=send_frame:parity=auto:deint=interlaced':'native decoded samples; no colour conversion, quantization or resampling',
    normalizationDivisor:input.format.float?1:2**input.depth-1,
    limitedRangeScaling:input.scale==='reference-255'?'(x - (16 * 2**(b-8))/(2**b-1)) / ((219 * 2**(b-8))/(2**b-1))':'(x - 16/255) / (235/255 - 16/255)',
    outputMultiplier:input.scale==='reference-255'?255:2**input.depth-1,
    outputScaling:input.scale==='reference-255'?'independent range/scale reference interpretation; fixed multiplier 255':'P.910 7.8.1.5 literal equation, b = input or user-confirmed equivalent bit depth',
    interpretationIssues:sitiInputIssues(input),comparison:{crossBitDepth:input.scale==='reference-255'&&!input.floatAssumption,crossResolution:false,crossFrameRate:false},
    lumaDerivation:input.matrix?{matrix:input.matrix.name,coefficients:[...SITI_MATRICES[input.matrix.name]],source:input.matrix.source,precision:'float64; nonlinear weighted components; no integer quantization'}:null,
    inputRangePolicy:input.format.float?'reject non-finite, negative, super-white or samples outside float32-rounded legal normalized endpoints; no clipping':'reject component codes outside declared legal range or nonzero padding bits; no clipping',
    precision:'float64 native sample normalization and pre-processing, two-pass population variance; unrounded samples'};
}

export function validateSitiConfiguration(execution,stream,count){
  const c=execution.configuration;
  if(![2,3,4].includes(c?.configurationVersion))return;
  const input=sitiP910Input(stream,c.input?.settings??undefined),fail=()=>{throw Error('SI/TI 计算配置与输入解释不一致')};
  const same=(a,b)=>b!==null&&typeof b==='object'?a!==null&&typeof a==='object'&&Object.keys(a).length===Object.keys(b).length&&Object.entries(b).every(([k,v])=>same(a[k],v)):a===b;
  if(c.configurationVersion===3){
    if(!input||input.version!==3)fail();
    for(const [key,value] of Object.entries(sitiVersion3Fields(input)))if(!same(c[key],value))fail();
  }
  if(c.configurationVersion===4){
    if(!input||input.version!==4)fail();
    for(const [key,value] of Object.entries(sitiPhysicalFields(input)))if(!same(c[key],value))fail();
  }
  if(!input||!same(c.input,input)||execution.method!==input.profile||c.profile!==input.profile||c.standard!=='ITU-T P.910 (10/2023)'||c.standardDocumentSha256!=='f1cdfc13ccdea8f76ffd05759b937b60ee164911bd2051711e291dfdf010099c'||c.inputDomain!==input.domain||c.inputBitDepth!==input.depth||c.inputRange!==input.range||c.domain!=='PQ'||c.firstTi!==null||c.assessment!=='declared-interpretation')fail();
  if(c.configurationVersion===2&&(input.version>=3||c.normalizationDivisor!==2**input.depth-1||c.outputMultiplier!==2**input.depth-1||c.limitedRangeScaling!=='(x - 16/255) / (235/255 - 16/255)'||!same(c.interpretationIssues,sitiInterpretationIssues(input.depth,input.range,input.domain,input.deinterlace))||!same(c.comparison,{crossBitDepth:false,crossResolution:false,crossFrameRate:false})||c.preprocessing!==(input.deinterlace?'bwdif=mode=send_frame:parity=auto:deint=interlaced':'native luma; none')))fail();
  const expectedEotf=input.domain==='pq'?'PQ preserved after normalization and range scaling; BT.2100-2 EOTF / inverse EOTF identity':input.domain==='hlg'?'BT.2100-2 Table 5 HLG reference EOTF applied to achromatic luma':'ITU-R BT.1886 (03/2011) Annex 1 reference EOTF';
  if(c.configurationVersion!==4&&(c.eotf!==expectedEotf||c.pq!==(input.domain==='pq'?'already PQ; no second PQ encoding':'ITU-R BT.2100-2 (07/2018) Table 4 inverse EOTF')))fail();
  if(c.configurationVersion!==4&&(input.domain==='hlg'&&(c.whiteCdM2!==input.hlg.whiteCdM2||c.blackCdM2!==input.hlg.blackCdM2||c.gamma!==input.hlg.gamma)||input.domain==='pq'&&(c.whiteCdM2!==null||c.blackCdM2!==null||c.gamma!==null)||input.domain==='sdr'&&(c.whiteCdM2!==300||c.blackCdM2!==.01||c.gamma!==2.4)))fail();
  if(input.deinterlace){const e=c.preprocessingEvidence;if(!e||e.filter!==c.preprocessing||e.outputFrameCount!==count||e.width!==stream.width||e.height!==stream.height||!/^\d+\/[1-9]\d*$/.test(e.outputTimeBase)||e.outputFrameRate!==null&&!/^\d+\/[1-9]\d*$/.test(e.outputFrameRate)||e.outputAverageFps!==null&&(!Number.isFinite(e.outputAverageFps)||e.outputAverageFps<=0))fail()}
}
