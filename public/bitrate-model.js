// Exact packet accounting on an absolute PTS grid. Numerators are in ms * denominator.
const integer = v => /^-?\d+$/.test(String(v)) ? BigInt(v) : null;
const floor = (n, d) => n >= 0n ? n / d : -((-n + d - 1n) / d);
export function createBitrateAccumulator(timeBase, windowMs) {
  if (![100, 1000].includes(windowMs)) throw Error('码率窗口必须为 100 ms 或 1 秒');
  const match = /^(\d+)\/(\d+)$/.exec(timeBase ?? '');
  const a = match ? BigInt(match[1]) : 0n, d = match ? BigInt(match[2]) : 0n;
  const map = new Map(); let start = null, end = null, missing = 0, unknownDuration = 0, invalid = 0;
  return {
    add(p) {
      const bytes = integer(p.size), pts = integer(p.pts), duration = integer(p.duration);
      if (bytes === null || bytes < 0n) { invalid++; return; }
      if (pts === null) { missing++; return; }
      if (!a || !d) return;
      const t = pts * a * 1000n;
      if (start === null || t < start) start = t;
      if (duration === null || duration <= 0n) unknownDuration++;
      else { const e = t + duration * a * 1000n; if (end === null || e > end) end = e; }
      const key = floor(t, d * BigInt(windowMs)).toString();
      map.set(key, (map.get(key) ?? 0n) + bytes);
    },
    finish() {
      const reasons = [];
      if (!a || !d) reasons.push('轨道时间基准无效');
      if (missing) reasons.push(`${missing} 个包缺少 PTS，无法保证区间数据完整`);
      if (unknownDuration) reasons.push(`${unknownDuration} 个包持续时间未知或非正，无法确认完整统计范围`);
      if (invalid) reasons.push(`${invalid} 个包大小无效`);
      if (start === null || end === null || end <= start) reasons.push('无法确定有效包时间跨度');
      const result = {version: 1, windowMs, grid: 'absolute-pts', scope: 'demuxed-packet-payload', boundary: '[start,end)', status: reasons.length ? 'unavailable' : 'ok', reasons, denominator: d.toString(), bins: []};
      if (reasons.length) return result;
      const first = floor(start, d * BigInt(windowMs)), last = floor(end - 1n, d * BigInt(windowMs));
      if (last - first >= 1000000n) return {...result, status: 'unavailable', reasons: ['时间跨度超过曲线区间数量上限']};
      for (let i = first; i <= last; i++) {
        const lo = i * d * BigInt(windowMs), hi = lo + d * BigInt(windowMs);
        result.bins.push({index: i.toString(), startNumerator: (lo < start ? start : lo).toString(), endNumerator: (hi > end ? end : hi).toString(), bytes: (map.get(i.toString()) ?? 0n).toString()});
      }
      return result;
    }
  };
}
export function bitrateView(curve, windowMs = curve.windowMs) {
  if (![100, 1000].includes(windowMs) || windowMs < curve.windowMs) throw Error('无法从粗窗口恢复细窗口');
  if (curve.status !== 'ok') return [];
  const d = BigInt(curve.denominator), grouped = new Map();
  for (const bin of curve.bins) {
    const start = BigInt(bin.startNumerator), end = BigInt(bin.endNumerator);
    const key = floor(start, d * BigInt(windowMs)).toString(), prior = grouped.get(key);
    if (prior) { prior.bytes += BigInt(bin.bytes); prior.end = end; }
    else grouped.set(key, {start, end, bytes: BigInt(bin.bytes)});
  }
  return [...grouped.values()].map(b => ({start: Number(b.start) / Number(d) / 1000, end: Number(b.end) / Number(d) / 1000, mbps: Number(b.bytes * 8n * d) / Number(b.end - b.start) / 1000, bytes: b.bytes.toString()}));
}
export function validateBitrateCurve(c) {
  if (!c || c.version !== 1 || ![100,1000].includes(c.windowMs) || c.grid !== 'absolute-pts' || c.scope !== 'demuxed-packet-payload' || c.boundary !== '[start,end)' || !['ok','unavailable'].includes(c.status) || !Array.isArray(c.reasons) || c.reasons.some(r => typeof r !== 'string') || !Array.isArray(c.bins) || c.bins.length > 1000000) throw Error('码率曲线格式错误');
  const d = integer(c.denominator);
  if (d === null || d < 0n || (c.status === 'ok' && (d === 0n || !c.bins.length || c.reasons.length))) throw Error('码率曲线时间基准错误');
  if (c.status === 'unavailable' && (c.bins.length || !c.reasons.length)) throw Error('码率曲线状态错误');
  let previous = null;
  for (const b of c.bins) {
    const start = integer(b.startNumerator), end = integer(b.endNumerator), bytes = integer(b.bytes), index = integer(b.index);
    if (start === null || end === null || bytes === null || index === null || bytes < 0n || end <= start || floor(start,d*BigInt(c.windowMs)) !== index || end > (index+1n)*d*BigInt(c.windowMs) || (previous && (start !== previous.end || index !== previous.index+1n))) throw Error('码率曲线区间错误');
    previous = {end,index};
  }
}
