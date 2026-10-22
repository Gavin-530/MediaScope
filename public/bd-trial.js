import {bdRate} from './bd-rate.js';
import {bdProfile, bdReference, validateBdMeasurement, sameBdValue} from './bd-reference.js';

export function referenceBdRate(selected, anchor, test, metric) {
  const fail = reason => ({ok:false,profile:bdProfile,reason});
  if (metric !== 'psnr') return fail('参考测量模式使用 PSNR-Y 帧均值；SSIM / VMAF 请显式选择探索模式。');
  if (selected.some(group => group.length < 4)) return fail('参考测量模式每组至少需要 4 个采样点（本软件的保守策略）；请增加 CRF，或显式选择探索模式。');
  try {
    const rows=selected.flat();
    for(const row of rows) {
      if(row.bdRateMeasurement?.status==='unavailable')throw Error(row.bdRateMeasurement.reason);
      validateBdMeasurement(row.bdRateMeasurement,row.alignment?.frames);
      const m=row.bdRateMeasurement,codecs={libx264:'h264',libx265:'hevc','libaom-av1':'av1'};
      if(row.alignment.pairing!=='strict'||row.normalization?.crossDepth||row.normalization?.metadataGaps?.length!==0||
        row.pixelFormat!==m.input.pixelFormat||row.bitDepth!==(m.input.pixelFormat==='yuv420p10le'?10:8)||
        codecs[row.encoder]!==m.rate.codec||typeof row.id!=='string'||!row.id.length||!Number.isFinite(row.crf)||
        !Array.isArray(row.settings)||row.settings.some(s=>typeof s!=='string'))
        throw Error('编码点身份、格式或比较域记录不一致。');
    }
    if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('编码点编号重复。');
    const first=rows[0].bdRateMeasurement;
    if (rows.some(row => {
      const m=row.bdRateMeasurement;
      return !sameBdValue(m.input,first.input) || m.referenceSha256!==first.referenceSha256 || m.frames!==first.frames ||
        m.rate.frameRate!==first.rate.frameRate || m.peak!==first.peak || m.zeroMse!==first.zeroMse;
    })) throw Error('各点必须具有同一参考像素、帧数、比较域和帧率。');
    for(const group of selected) {
      const a=group[0];
      if(group.some(row=>row.encoder!==a.encoder||row.bitDepth!==a.bitDepth||row.pixelFormat!==a.pixelFormat||!sameBdValue(row.settings,a.settings)))
        throw Error('同一曲线的编码器、位深、格式或固定设置不一致。');
    }
    const points=selected.map(group=>group.map(row=>({id:row.id,crf:row.crf,quality:row.bdRateMeasurement.components.y.mean,rate:row.bdRateMeasurement.rate.kbps})));
    const result=bdRate(...points);
    if(!result.ok)return {...result,profile:bdProfile};
    const warnings=[...result.warnings,'本结果按指定测量口径计算；CRF 片段实验不声明符合完整 JVET CTC。'];
    if(rows.some(row=>Object.values(row.bdRateMeasurement.components).some(c=>c.zeroFrames)))
      warnings.push('包含零误差帧，已按 HM/VTM 的 999.99 dB 约定计入帧均值；请审阅其影响。');
    if(result.coverage.some(v=>v<.5))warnings.push('共同区间不足至少一条曲线跨度的一半；这是软件提示阈值，需结合曲线解释。');
    return {...result,profile:bdProfile,metric,qualityDomain:'PSNR-Y 帧算术均值 / dB',reference:{...bdReference},
      rateDomain:'基本码流 / kbit/s；含码流头，排除封装',anchor,test,points:{anchor:points[0],test:points[1]},
      measurement:{input:first.input,frames:first.frames,frameRate:first.rate.frameRate,referenceSha256:first.referenceSha256,
        peak:first.peak,zeroMse:first.zeroMse},
      componentMeans:selected.map(group=>group.map(row=>({id:row.id,y:row.bdRateMeasurement.components.y.mean,u:row.bdRateMeasurement.components.u.mean,v:row.bdRateMeasurement.components.v.mean}))),
      conditions:{sampling:'CRF',fullCtc:false},warnings};
  } catch(e) {return fail('缺少或不一致的参考测量数据：'+e.message);}
}
