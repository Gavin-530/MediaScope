// Versioned measurement contract; used by the trial producer and JSON reader.
// ITU-T HSTP-VID-WPOM (2020, March 2025 repost), §§7.2–7.4.
export const bdProfile = 'itu-sdr-psnr-y-pchip-v1';
// Project accuracy budgets, not tolerances published by a standards organization.
export const bdTolerance = Object.freeze({psnrDb:1e-10,percent:1e-9,coverage:1e-12});
export const bdReference = Object.freeze({
  document: 'ITU-T HSTP-VID-WPOM (2020; March 2025 repost)',
  url: 'https://www.itu.int/dms_pub/itu-t/opb/tut/T-TUT-ASC-2020-HSTP1-PDF-E.pdf',
  sections: ['7.2', '7.3', '7.4'],
  numericalReference: 'JVET-O0003-v1 / bdrate; JVET-T2010-v2 / Module1',
  implementation: 'MediaScope PCHIP exact integral v1',
  zeroMse: 'HM/VTM: PSNR = 999.99 dB',
  projectTolerance:bdTolerance,
});
export function bdPsnr(sse, samples, peak) {
  return sse === 0 ? 999.99 : 10 * Math.log10(peak * peak * samples / sse);
}
export function bdMean(values) {
  // Compensated sum, deterministic on both production and import paths.
  let sum = 0, correction = 0;
  for (const value of values) {
    const next = value - correction, total = sum + next;
    correction = (total - sum) - next; sum = total;
  }
  return sum / values.length;
}
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = v => Number.isSafeInteger(v) && v > 0;
export function validateBdMeasurement(m, expectedFrames) {
  const fail = reason => { throw Error('BD-rate 测量记录无效：' + reason); };
  if (!m || m.status !== 'ok' || m.profile !== bdProfile || m.version !== 1) fail('配置版本');
  const p = m.input, depth = ['yuv420p','yuvj420p'].includes(p?.pixelFormat) ? 8 : p?.pixelFormat === 'yuv420p10le' ? 10 : null;
  if (!depth || !integer(p.width) || !integer(p.height) || p.width % 2 || p.height % 2 ||
      p.primaries !== 'bt709' || p.transfer !== 'bt709' || p.matrix !== 'bt709' ||
      !['tv','pc'].includes(p.range) || p.pixelFormat==='yuvj420p'&&p.range!=='pc' ||
      !['left','center','topleft','top','bottomleft','bottom'].includes(p.chromaLocation)) fail('SDR 420 比较域');
  const count = p.width * p.height, max = (2 ** depth - 1) ** 2;
  if (!Number.isSafeInteger(count * max) || m.peak !== 255 * 2 ** (depth - 8) || m.zeroMse !== bdReference.zeroMse ||
      m.pairing !== 'strict' || !integer(m.frames) || m.frames !== expectedFrames ||
      !hash(m.referenceSha256) || !hash(m.candidateSha256)) fail('峰值、帧数、配对或像素摘要');
  for (const key of ['y','u','v']) {
    const c = m.components?.[key], samples = key === 'y' ? count : count / 4;
    if (!c || c.samples !== samples || !Array.isArray(c.sse) || c.sse.length !== m.frames ||
        c.sse.some(s => !Number.isSafeInteger(s) || s < 0 || s > samples * max) ||
        !Number.isFinite(c.mean) || Math.abs(c.mean - bdMean(c.sse.map(s => bdPsnr(s, samples, m.peak)))) > bdTolerance.psnrDb ||
        c.zeroFrames !== c.sse.filter(s => s === 0).length) fail('分量 ' + key + ' / 整数 SSE / 均值');
  }
  const r = m.rate, rate = /^(\d+)\/(\d+)$/.exec(r?.frameRate ?? ''), fps = rate ? Number(rate[1]) / Number(rate[2]) : NaN;
  const formats = {h264:'Annex B', hevc:'Annex B', av1:'low-overhead OBU'};
  if (!r || !Number.isFinite(fps) || fps <= 0 || !Number(rate[2]) || !integer(r.bytes) || !hash(r.sha256) ||
      r.format !== formats[r.codec] || !r.format || r.frames !== m.frames || r.checksumPolicy !== 'reject-decoded-picture-hash' ||
      r.duration !== m.frames / fps || r.kbps !== r.bytes * 8 * fps / m.frames / 1000 ||
      !Number.isFinite(r.maxTimestampErrorSeconds) || r.maxTimestampErrorSeconds < 0 ||
      !Number.isFinite(r.timestampToleranceSeconds) || r.timestampToleranceSeconds <= 0 || r.timestampToleranceSeconds > .01 ||
      r.maxTimestampErrorSeconds > r.timestampToleranceSeconds) fail('基本码流字节或 CFR 码率');
  return m;
}

// Compare JSON values without depending on object key order; reject extra fields too.
export function sameBdValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b,k) && sameBdValue(a[k],b[k]));
}

export function sameBdResult(saved, calculated) {
  if(!saved || !calculated)return false;
  if(typeof saved.percent!=='number'||!Array.isArray(saved.qualityRange)||saved.qualityRange.length!==2||
    !Array.isArray(saved.coverage)||saved.coverage.length!==2)return false;
  const a={...saved},b={...calculated};
  for(const [key,tolerance] of [['percent',bdTolerance.percent],['qualityRange',bdTolerance.psnrDb],['coverage',bdTolerance.coverage]]) {
    const x=Array.isArray(a[key])?a[key]:[a[key]],y=Array.isArray(b[key])?b[key]:[b[key]];
    if(x.length!==y.length||x.some((v,i)=>!Number.isFinite(v)||!Number.isFinite(y[i])||Math.abs(v-y[i])>tolerance))return false;
    delete a[key];delete b[key];
  }
  return sameBdValue(a,b);
}
