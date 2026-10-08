// Compact audio evidence: [PTS ticks, DTS ticks, duration ticks, payload bytes].
// Unknown fields stay null. This does not change any existing bitrate calculation.
const integer = value => /^-?\d+$/.test(String(value)) ? String(value) : null;
export function createAudioPacketDistribution(timeBase, limit = 500000) {
  let count = 0, packets = [], exceeded = false;
  return {
    add(packet) {
      count++;
      if (exceeded) return;
      if (count > limit) { exceeded = true; packets = []; return; }
      const bytes = integer(packet.size);
      packets.push([integer(packet.pts), integer(packet.dts), integer(packet.duration), bytes !== null && BigInt(bytes) >= 0n ? bytes : null]);
    },
    finish() {
      return {version: 1, scope: 'demuxed-packet-payload', timeBase: timeBase ?? null, count, status: exceeded ? 'unavailable' : 'ok', reason: exceeded ? `音轨包数超过 ${limit} 个，未保存逐包视图；汇总和码率统计仍保留` : null, packets};
    }
  };
}

export function validateAudioPacketDistribution(d) {
  if (!d || d.version !== 1 || d.scope !== 'demuxed-packet-payload' || !(d.timeBase === null || typeof d.timeBase === 'string') || !Number.isSafeInteger(d.count) || d.count < 0 || !['ok', 'unavailable'].includes(d.status) || !Array.isArray(d.packets) || d.packets.length > 500000) throw Error('音轨逐包数据格式错误');
  if (d.status === 'unavailable') {
    if (typeof d.reason !== 'string' || !d.reason || d.packets.length) throw Error('音轨逐包数据状态错误');
    return;
  }
  if (d.reason !== null || d.packets.length !== d.count) throw Error('音轨逐包数据数量错误');
  for (const row of d.packets) {
    if (!Array.isArray(row) || row.length !== 4 || row.some(v => v !== null && (typeof v !== 'string' || !/^-?\d+$/.test(v))) || row[3] !== null && BigInt(row[3]) < 0n) throw Error('音轨逐包字段错误');
  }
}

export function packetSeconds(ticks, timeBase) {
  const match = /^(\d+)\/(\d+)$/.exec(timeBase ?? '');
  if (ticks === null || !match || BigInt(match[1]) === 0n || BigInt(match[2]) === 0n) return null;
  const value = Number(ticks) * Number(match[1]) / Number(match[2]);
  return Number.isFinite(value) ? value : null;
}

export function audioPacketPoints(d) {
  if (d?.status !== 'ok') return [];
  return d.packets.flatMap((row, index) => {
    const time = packetSeconds(row[0], d.timeBase);
    return time === null ? [] : [[time, row[3] === null ? null : Number(row[3]), {index, row}]];
  }).sort((a, b) => a[0] - b[0] || a[2].index - b[2].index);
}

// Keep the original display-frame identity even when timestamps reorder or repeat.
export function frameTimePoints(frames) {
  return frames.flatMap((frame, index) => Number.isFinite(frame.t) ? [[frame.t, frame.bytes, frame, index]] : [])
    .sort((a, b) => a[0] - b[0] || a[3] - b[3]);
}

export function frameTimeRange(frames, start = 0, end = frames.length - 1) {
  let lo = Infinity, hi = -Infinity;
  for (let i = start; i <= end; i++) {
    const frame = frames[i];
    if (!Number.isFinite(frame?.t)) continue;
    lo = Math.min(lo, frame.t);
    hi = Math.max(hi, frame.t + (Number.isFinite(frame.duration) && frame.duration > 0 ? frame.duration : 0));
  }
  return Number.isFinite(lo) && hi > lo ? [lo, hi] : null;
}
