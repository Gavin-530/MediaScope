export const recordedSeconds = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function timingSummary(timings) {
  const known = timings.filter(t => recordedSeconds(t?.computeSeconds));
  return {
    totalComputeSeconds: known.length ? known.reduce((sum, t) => sum + t.computeSeconds, 0) : null,
    recordedResults: known.length,
    missingResults: timings.length - known.length,
    scope: '各结果计算耗时累计，不含排队、报告保存、传输及浏览器渲染；并行阶段耗时不相加',
  };
}

export function formatElapsedSeconds(seconds) {
  if (!recordedSeconds(seconds)) return '未记录';
  if (seconds < 60) return `${seconds.toFixed(2)} 秒`;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600), minutes = Math.floor(whole % 3600 / 60);
  return `${hours ? hours + ' 小时 ' : ''}${minutes} 分 ${whole % 60} 秒`;
}
