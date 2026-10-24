import {validateBitrateCurve} from './bitrate-model.js';
import {validateAudioPacketDistribution} from './distribution-model.js';
import {vmafModel,parseVmafLog,vmafConfiguration,vmafInputReason} from './vmaf.js';
import {parseMetricSummary} from './metric-summary.js';
import {validateSitiSceneResult,validateSitiConfiguration,validateSitiAttempts} from './siti.js';
import {MAX_ANALYSIS_FRAMES} from './analysis-limits.js';
import {validateBdMeasurement,sameBdResult} from './bd-reference.js';
import {trialBdRate} from './trial-model.js';
import {validateRepeatAnalysis} from './repeat-model.js';
// Validate the saved data without normalizing, rounding or discarding evidence.
export function parseReport(text) {
  let r;
  try {
    r = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw Error("JSON 无法解析，请选择完整导出的报告文件");
  }
  validateReport(r);
  return r;
}
export function validateReport(r) {
  const fail = (p) => {
    throw Error(`报告字段缺失或格式错误：${p}；无法完整还原预览`);
  };
  const obj = (v, p) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(p);
  };
  const arr = (v, p) => {
    if (!Array.isArray(v)) fail(p);
  };
  const index = (v, p) => {
    if (!Number.isSafeInteger(v) || v < 0) fail(p);
  };
  const objects = (v, p) => {
    arr(v, p);
    v.forEach((x, i) => obj(x, `${p}[${i}]`));
  };
  const file = (v, p) => {
    obj(v, p);
    if (typeof v.file !== "string") fail(p + ".file");
  };
  const metrics = (v, p, required, normalization) => {
    obj(v, p);
    for (const [k, m] of Object.entries(v)) {
      if (!["psnr", "ssim", "vmaf"].includes(k)) fail(p + "." + k);
      obj(m, p + "." + k);
      if (required || m.values !== undefined) {
        arr(m.values, p + "." + k + ".values");
        if (
          m.values.some(
            (x) =>
              x !== null &&
              x !== "Infinity" &&
              (typeof x !== "number" || !Number.isFinite(x)),
          )
        )
          fail(p + "." + k + ".values");
      }
      if (m.worst !== undefined) objects(m.worst, p + "." + k + ".worst");
      if(k!=='vmaf'&&m.officialSummary!==undefined){
        try {
          const summary=parseMetricSummary(k,m.officialSummary.raw);
          if(m.pooled!==summary.pooled||Object.keys(summary).some(key=>key!=='components'&&m.officialSummary[key]!==summary[key])||
            Object.keys(m.components).length!==Object.keys(summary.components).length||
            Object.keys(m.officialSummary.components).length!==Object.keys(summary.components).length||
            Object.entries(summary.components).some(([key,value])=>m.components[key]!==value||m.officialSummary.components[key]!==value))throw Error();
        }catch {fail(p+'.'+k+'.officialSummary / pooled / components')}
      }
      if(k==='vmaf'&&(m.configuration!==undefined||m.officialSummary!==undefined)) {
        try {
          const c=m.configuration,model=vmafModel(m.model),log=parseVmafLog(m.raw,m.values.length);
          const input={width:c.input.width,height:c.input.height,pix_fmt:c.input.pixelFormat,
            color_range:c.input.range,color_primaries:c.input.primaries,color_transfer:c.input.transfer,color_space:c.input.matrix,
            chroma_location:c.input.chromaLocation,field_order:c.input.fieldOrder};
          const expected=vmafConfiguration(input,model.version,log.libraryVersion,c.pairing,c.evaluation);
          const same=(actual,wanted)=>wanted&&typeof wanted==='object'?actual&&Object.entries(wanted).every(([k,v])=>same(actual[k],v)):actual===wanted;
          if(c.configurationVersion===2){
            if(!same(c,expected)||typeof c.evaluation?.interlaced!=='boolean'||
              c.evaluation.crossDepth!==(normalization?.crossDepth===true)||
              c.evaluation.metadataUncertain!==((normalization?.metadataGaps?.length??0)>0)||
              ['range','primaries','transfer','matrix','chromaLocation','fieldOrder'].some(k=>c.input[k]!==null&&typeof c.input[k]!=='string'))throw Error();
          }else if(c.configurationVersion!==undefined||!['strict','ordinal-confirmed'].includes(c.pairing)||
            !same(c,{implementation:expected.implementation,libraryVersion:expected.libraryVersion,model:expected.model,pool:expected.pool,nSubsample:expected.nSubsample,nThreads:expected.nThreads,clipping:expected.clipping,transform:expected.transform,preprocessing:'none',matchesDisplay:expected.matchesDisplay}))throw Error();
          if(!['strict','ordinal-confirmed','playback-sample'].includes(c.pairing)||
            !Number.isSafeInteger(c.input.width)||c.input.width<1||!Number.isSafeInteger(c.input.height)||c.input.height<1||
            vmafInputReason(input)||
            m.pooled!==log.summary.mean||m.min!==log.summary.min||
            m.values.some((v,i)=>v!==log.values[i])||
            Object.keys(log.summary).some(key=>m.officialSummary?.[key]!==log.summary[key]))throw Error();
        } catch {fail(p+'.vmaf.configuration / officialSummary / raw')}
      }
    }
  };
  obj(r, "报告");
  if (Object.hasOwn(r,'schema') || Object.hasOwn(r,'formatVersion'))
    throw Error('0.4 报告不使用嵌套格式版本');
  if (!r.producer || typeof r.producer.applicationVersion!=='string' || !r.producer.applicationVersion.length)
    fail('producer.applicationVersion');
  if(typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))fail('createdAt');
  if (!["inspect", "analyze", "compare", "trial"].includes(r.type))
    fail("type");
  if (r.warnings !== undefined) arr(r.warnings, "warnings");
  if (r.type === "inspect" || r.type === "analyze") {
    file(r, "报告");
    obj(r.raw, "raw");
    objects(r.raw.streams, "raw.streams");
    obj(r.raw.format, "raw.format");
    r.raw.streams.forEach((s) => index(s.index, "raw.streams.index"));
    if (r.frameSample !== undefined && r.frameSample !== null) {
      obj(r.frameSample, "frameSample");
      if (r.frameSample.frames !== undefined) objects(r.frameSample.frames, "frameSample.frames");
    }
    if (r.pixelFormats !== undefined) {
      obj(r.pixelFormats, "pixelFormats");
      if (!['ok','failed'].includes(r.pixelFormats.status)) fail('pixelFormats.status');
      if (r.pixelFormats.status === 'ok') {
        obj(r.pixelFormats.raw, 'pixelFormats.raw');
        objects(r.pixelFormats.raw.pixel_formats, 'pixelFormats.raw.pixel_formats');
      } else if (typeof r.pixelFormats.error !== 'string') fail('pixelFormats.error');
      objects(r.pixelFormats.commands, 'pixelFormats.commands');
    }
    if (r.frameSampleRead !== undefined) {
      obj(r.frameSampleRead, 'frameSampleRead');
      const read = r.frameSampleRead;
      if (!['ok','failed','not-applicable','not-requested'].includes(read.status)) fail('frameSampleRead.status');
      if (read.status === 'failed' && (typeof read.error !== 'string' || r.frameSample !== null)) fail('frameSampleRead.error');
      if (read.status === 'ok' && !r.frameSample) fail('frameSample');
      objects(read.tracks, 'frameSampleRead.tracks');
      objects(read.commands, 'frameSampleRead.commands');
      const videoIndices = r.raw.streams.filter(s => s.codec_type === 'video').map(s => s.index);
      if (read.status === 'not-requested') {
        if (!videoIndices.length || r.frameSample !== null || read.tracks.length || read.commands.length) fail('frameSampleRead.status');
      } else if (read.tracks.length !== videoIndices.length || new Set(read.tracks.map(t => t.index)).size !== read.tracks.length) fail('frameSampleRead.tracks');
      if (read.status === 'not-applicable' && (videoIndices.length || r.frameSample !== null)) fail('frameSampleRead.status');
      for (const track of read.tracks) {
        index(track.index, 'frameSampleRead.tracks.index');
        index(track.count, 'frameSampleRead.tracks.count');
        if (!['ok','empty','failed'].includes(track.status)) fail('frameSampleRead.tracks.status');
        const count = (r.frameSample?.frames ?? []).filter(f => f.stream_index === track.index).length;
        if (!videoIndices.includes(track.index) || track.count !== count) fail('frameSampleRead.tracks.count');
        const expectedStatus = read.status === 'failed' ? 'failed' : count ? 'ok' : 'empty';
        if (track.status !== expectedStatus) fail('frameSampleRead.tracks.status');
      }
    }
    if (r.metadata) {
      obj(r.metadata, "metadata");
      objects(r.metadata.items, "metadata.items");
      r.metadata.items.forEach((x) => arr(x.sources, "metadata.items.sources"));
    }
    if (r.analysisTargets !== undefined) {
      obj(r.analysisTargets, 'analysisTargets');
      const targets = r.analysisTargets;
      if(r.type!=='analyze'||Object.keys(targets).some(k=>!['frames','bitrate','complexity','repeat'].includes(k))||!['frames','bitrate','complexity'].every(k=>typeof targets[k]==='boolean')||targets.repeat!==undefined&&targets.repeat!==true||!Object.values(targets).some(Boolean))fail('analysisTargets');
      if(targets.repeat){validateRepeatAnalysis(r.repeatAnalysis,r.raw.streams.find(s=>s.index===r.stream));}
      else if(r.repeatAnalysis!==undefined)fail('analysisTargets / repeatAnalysis');
      const needsFrames=targets.frames||targets.complexity,needsPackets=targets.frames||targets.bitrate;
      if(needsFrames!==Array.isArray(r.frames)||!needsFrames&&r.summary!==undefined)fail('analysisTargets / frames / summary');
      if(targets.frames)obj(r.coding,'coding');
      else if(r.coding!==undefined)fail('analysisTargets / coding');
      if(targets.complexity)obj(r.content,'content');
      else if(r.content!==null&&r.content!==undefined)fail('analysisTargets / content');
      if(needsPackets!==Array.isArray(r.tracks)||!needsPackets&&r.packets!==undefined)fail('analysisTargets / tracks / packets');
      if(r.tracks){
        if(!targets.bitrate&&r.tracks.some(t=>t.bitrateCurve!==undefined||t.bins?.length))fail('analysisTargets.bitrate');
        if(targets.bitrate&&r.tracks.some(t=>['video','audio'].includes(t.type)&&!t.bitrateCurve))fail('analysisTargets / bitrateCurve');
      }
    }
    if(r.repeatAnalysis!==undefined&&!r.analysisTargets?.repeat)fail('repeatAnalysis / analysisTargets');
    if ((r.type === "analyze" && !r.analysisTargets) || r.frames !== undefined) {
      objects(r.frames, "frames");
      if(!r.frames.length||r.frames.length>MAX_ANALYSIS_FRAMES)fail('frames.length');
      const required=(value,keys,p)=>{for(const key of keys)if(!Object.hasOwn(value,key))fail(p+'.'+key);};
      const nullableNumber=value=>value===null||typeof value==='number'&&Number.isFinite(value);
      for(const f of r.frames){
        required(f,['pts','t','duration','bytes','type','key','interlaced'],'frames');
        if(!(f.pts===null||typeof f.pts==='string')||!['t','duration','bytes'].every(k=>nullableNumber(f[k]))||typeof f.type!=='string'||!f.type.length||typeof f.key!=='boolean'||typeof f.interlaced!=='boolean')fail('frames.values');
      }
      obj(r.summary, "summary");
      if(r.summary.count!==r.frames.length)fail('summary.count');
      if (r.content?.available) {
        try{validateSitiAttempts(r.content.execution,r.frames.length)}catch{fail('content.execution.attempts')}
        try{validateSitiConfiguration(r.content.execution,r.raw.streams.find(s=>s.index===r.stream))}catch{fail('content.execution.configuration')}
        objects(r.content.points, "content.points");
        if(r.content.sceneAnalysis!==undefined){try{validateSitiSceneResult(r.content,r.frames)}catch{fail('content.sceneAnalysis / SI/TI')}}
        else obj(r.content.si, "content.si");
      }
      else if(r.content?.attempts!==undefined){try{validateSitiAttempts(r.content,r.frames.length,{completed:false})}catch{fail('content.attempts')}}
      if (r.coding?.gops) {
        objects(r.coding.gops, "coding.gops");
        let next = 0;
        for (const [i, g] of r.coding.gops.entries()) {
          if (
            g.index !== i ||
            g.start !== next ||
            !Number.isInteger(g.end) ||
            g.end < g.start ||
            g.end >= r.frames.length ||
            g.count !== g.end - g.start + 1
          )
            fail("coding.gops");
          next = g.end + 1;
        }
        if (next !== r.frames.length) fail("coding.gops");
      }
      if(r.coding?.packets){
        objects(r.coding.packets,'coding.packets');
        const packets=r.coding.packets,events=r.coding.events??[];
        const reference=(v,length,p)=>{index(v,p);if(v>=length)fail(p);};
        for(const [i,p]of packets.entries()){
          if(p.index!==i)fail('coding.packets.index');
          required(p,['pts','bytes','nalTypes','eventIds','firstSlices','recovery'],'coding.packets');
          if(!(p.pts===null||typeof p.pts==='string')||!nullableNumber(p.bytes))fail('coding.packets.values');
          arr(p.nalTypes,'coding.packets.nalTypes');
          arr(p.eventIds,'coding.packets.eventIds');
          for(const id of p.eventIds)reference(id,events.length,'coding.packets.eventIds');
        }
        for(const f of r.frames){
          if(f.packetIndex!==undefined)reference(f.packetIndex,packets.length,'frames.packetIndex');
          if(f.eventId!==undefined)reference(f.eventId,events.length,'frames.eventId');
        }
        for(const e of events){
          reference(e.packet,packets.length,'coding.events.packet');
          if(e.displayIndex!==undefined)reference(e.displayIndex,r.frames.length,'coding.events.displayIndex');
          if(e.sourceEvent!==null&&e.sourceEvent!==undefined)reference(e.sourceEvent,events.length,'coding.events.sourceEvent');
          for(const id of e.referenceEvents??[])if(id!==null)reference(id,events.length,'coding.events.referenceEvents');
        }
      }
      if (r.coding?.codec === "av1") {
        obj(r.coding.counts, "coding.counts");
        for (const k of ["encoded", "hidden", "showExisting", "shown"])
          index(r.coding.counts[k], "coding.counts." + k);
        objects(r.coding.events, "coding.events");
        objects(r.coding.sequences,'coding.sequences');
        r.coding.events.forEach((e, i) => {
          if (e.id !== i) fail("coding.events.id");
          required(e,['packet','pts','kind','frameType','hidden','showExisting','showable','orderHint','temporalId','spatialId','refreshFlags','showSlot','sourceEvent','obuType','obuPayloadBytes','fields'],'coding.events');
          obj(e.fields,'coding.events.fields');
          if(typeof e.kind!=='string'||typeof e.hidden!=='boolean'||typeof e.showExisting!=='boolean')fail('coding.events.values');
        });
      }
    }
    if((r.type==='analyze'||r.frames!==undefined)&&(!r.analysisTargets||r.analysisTargets.frames||r.analysisTargets.bitrate)) {
      obj(r.packets, 'packets');
      objects(r.packets.bins, 'packets.bins');
      if(r.packets.bitrateCurve)validateBitrateCurve(r.packets.bitrateCurve);
    }
    if(r.tracks!==undefined){
      objects(r.tracks, 'tracks');
      r.tracks.forEach(x=>{
        index(x.index, 'tracks.index');
        objects(x.bins, 'tracks.bins');
        if(x.bitrateCurve)validateBitrateCurve(x.bitrateCurve);
        if(x.packetDistribution!==undefined){
          if(x.type!=='audio')fail('tracks.packetDistribution.type');
          validateAudioPacketDistribution(x.packetDistribution);
        }
      });
    }
  } else if (r.type === "compare") {
    file(r.reference, "reference");
    file(r.candidate, "candidate");
    obj(r.alignment, "alignment");
    metrics(r.metrics, "metrics", true, r.normalization);
    index(r.alignment.frames, "alignment.frames");
    for (const m of Object.values(r.metrics))
      if (m.values.length !== r.alignment.frames) fail("metrics.values.length");
    if (r.alignment.pairing === "playback-sample") {
      const a = r.alignment;
      if (a.gridSide !== undefined) {
        index(a.sampledFrames, "alignment.sampledFrames");
        index(a.estimatedRepeatedSamples, "alignment.estimatedRepeatedSamples");
        index(
          a.estimatedUnrepresentedSampledFrames,
          "alignment.estimatedUnrepresentedSampledFrames",
        );
        arr(
          a.estimatedSampledFrameIndices,
          "alignment.estimatedSampledFrameIndices",
        );
        if (
          a.estimatedSampledFrameIndices.length !== a.frames ||
          a.estimatedSampledFrameIndices.some(
            (x) => !Number.isSafeInteger(x) || x < 0 || x >= a.sampledFrames,
          )
        )
          fail("alignment.estimatedSampledFrameIndices");
        if (
          !["reference", "candidate"].includes(a.gridSide) ||
          a.sampledSide !==
            (a.gridSide === "reference" ? "candidate" : "reference") ||
          a.sampledFrames < 2 ||
          a.frames < 2 ||
          a.estimatedRepeatedSamples >= a.frames ||
          a.estimatedUnrepresentedSampledFrames >= a.sampledFrames ||
          typeof a.gridRate !== "string" ||
          !Number.isFinite(a.gridRateHz) ||
          a.gridRateHz <= 0 ||
          !Number.isFinite(a.maxGridErrorSeconds) ||
          a.maxGridErrorSeconds < 0 ||
          !Number.isFinite(a.cfrToleranceSeconds) ||
          a.cfrToleranceSeconds <= 0 ||
          !Number.isFinite(a.sampledEndSeconds) ||
          a.sampledEndSeconds < 0 ||
          typeof a.sampling !== "string"
        )
          fail("alignment");
      } else {
        index(a.sourceFrames, "alignment.sourceFrames");
        index(a.estimatedRepeatedSamples, "alignment.estimatedRepeatedSamples");
        index(
          a.estimatedUnrepresentedSourceFrames,
          "alignment.estimatedUnrepresentedSourceFrames",
        );
        arr(
          a.estimatedSourceFrameIndices,
          "alignment.estimatedSourceFrameIndices",
        );
        if (
          a.estimatedSourceFrameIndices.length !== a.frames ||
          a.estimatedSourceFrameIndices.some(
            (x) => !Number.isSafeInteger(x) || x < 0 || x >= a.sourceFrames,
          )
        )
          fail("alignment.estimatedSourceFrameIndices");
        if (
          a.sourceFrames < 2 ||
          a.frames < 2 ||
          a.estimatedRepeatedSamples >= a.frames ||
          a.estimatedUnrepresentedSourceFrames >= a.sourceFrames ||
          typeof a.candidateRate !== "string" ||
          !Number.isFinite(a.candidateRateHz) ||
          a.candidateRateHz <= 0 ||
          !Number.isFinite(a.maxCandidateGridErrorSeconds) ||
          a.maxCandidateGridErrorSeconds < 0 ||
          !Number.isFinite(a.cfrToleranceSeconds) ||
          a.cfrToleranceSeconds <= 0 ||
          !Number.isFinite(a.sourceEndSeconds) ||
          a.sourceEndSeconds < 0 ||
          typeof a.sampling !== "string"
        )
          fail("alignment");
      }
    } else if (r.alignment.pairing !== undefined) {
      if (
        !["strict", "ordinal-confirmed"].includes(r.alignment.pairing) ||
        !Number.isFinite(r.alignment.maxRelativeDifferenceSeconds) ||
        r.alignment.maxRelativeDifferenceSeconds < 0 ||
        !(
          r.alignment.firstTimestampMismatchFrame === null ||
          (Number.isSafeInteger(r.alignment.firstTimestampMismatchFrame) &&
            r.alignment.firstTimestampMismatchFrame >= 2 &&
            r.alignment.firstTimestampMismatchFrame <= r.alignment.frames)
        ) ||
        !(
          r.alignment.lastDurationDifferenceSeconds === null ||
          (Number.isFinite(r.alignment.lastDurationDifferenceSeconds) &&
            r.alignment.lastDurationDifferenceSeconds >= 0)
        )
      )
        fail("alignment");
    }
    if (r.normalization?.crossDepth)
      obj(r.normalization.sourceFormats, "normalization.sourceFormats");
    if (r.chromaAssumptions !== undefined) {
      objects(r.chromaAssumptions, "chromaAssumptions");
      for (const x of r.chromaAssumptions)
        if (
          !["reference", "candidate"].includes(x.side) ||
          !(x.declared === null || typeof x.declared === "string") ||
          ![
            "left",
            "center",
            "topleft",
            "top",
            "bottomleft",
            "bottom",
          ].includes(x.assumed) ||
          x.source !== "用户确认；未由文件或软件验证"
        )
          fail("chromaAssumptions");
    }
  } else {
    file(r.source, "source");
    obj(r.experiment, "experiment");
    arr(r.experiment.retainedFiles, "experiment.retainedFiles");
    objects(r.rows, "rows");
    if (!r.rows.length) fail("rows");
    r.rows.forEach((x) => metrics(x.metrics, "rows.metrics", false, x.normalization));
    for(const row of r.rows) if(row.bdRateMeasurement!==undefined) {
      const m=row.bdRateMeasurement;
      if(m?.status==='unavailable') {
        if(m.version!==1||typeof m.reason!=='string'||!m.reason.length)fail('rows.bdRateMeasurement.reason');
      } else {
        validateBdMeasurement(m,r.experiment.actualFrames);
        if(row.alignment?.pairing!=='strict'||row.alignment.frames!==m.frames||row.normalization?.crossDepth||
          row.pixelFormat!==m.input.pixelFormat||row.bitDepth!==(m.input.pixelFormat==='yuv420p10le'?10:8))fail('rows.bdRateMeasurement / row');
        const source=r.source.raw?.streams?.find(s=>s.index===r.stream),p=m.input,
          mapping={width:'width',height:'height',pixelFormat:'pix_fmt',range:'color_range',primaries:'color_primaries',transfer:'color_transfer',matrix:'color_space',chromaLocation:'chroma_location'};
        if(!source||r.experiment.depthMode!=='native'||Object.entries(mapping).some(([k,v])=>p[k]!==source[v])||
          m.rate.frameRate!==source.r_frame_rate||row.normalization?.metadataGaps?.length!==0||
          ({libx264:'h264',libx265:'hevc','libaom-av1':'av1'})[row.encoder]!==m.rate.codec)fail('rows.bdRateMeasurement / source');
        const [n,d]=m.rate.frameRate.split('/').map(Number),times=r.experiment.frameTimes,
          tick=r.experiment.preparation?.selection?.timeBase;
        if(!Array.isArray(times)||times.length!==m.frames||!Number.isFinite(tick)||tick<=0||
          m.rate.timestampToleranceSeconds!==Math.max(tick,1e-6)+1e-6||
          m.rate.maxTimestampErrorSeconds!==times.reduce((max,t,i)=>Math.max(max,Math.abs(t-i/(n/d))),0))fail('rows.bdRateMeasurement / experiment.frameTimes');
      }
    }
    if(r.bdRateComparisons!==undefined) {
      arr(r.bdRateComparisons,'bdRateComparisons');
      if(!r.bdRateComparisons.length||r.bdRateComparisons.length>64)fail('bdRateComparisons.length');
      for(const saved of r.bdRateComparisons) {
        if(!saved||!['reference','exploratory'].includes(saved.profile))fail('bdRateComparisons.profile');
        const result=trialBdRate(r.rows,saved.anchor,saved.test,saved.metric,saved.profile);
        if(!result.ok||!sameBdResult(saved.result,result))fail('bdRateComparisons.result / 复算不一致');
      }
    }
    if (r.experiment.actualFrames !== undefined) {
      index(r.experiment.actualFrames, "experiment.actualFrames");
      for (const row of r.rows)
        for (const m of Object.values(row.metrics))
          if (m.values && m.values.length !== r.experiment.actualFrames)
            fail("rows.metrics.values.length");
    }
    if (r.experiment.frameTimes !== undefined) {
      const times = r.experiment.frameTimes;
      arr(times, "experiment.frameTimes");
      if (
        times.length !== r.experiment.actualFrames ||
        times.some(
          (t, i) =>
            !Number.isFinite(t) || t < 0 || (i > 0 && t <= times[i - 1]),
        )
      )
        fail("experiment.frameTimes");
    }
    if (r.experiment.preparation?.baseline) {
      obj(r.experiment.preparation.baseline.psnr, "baseline.psnr");
      obj(r.experiment.preparation.baseline.ssim, "baseline.ssim");
    }
  }
  return r;
}
