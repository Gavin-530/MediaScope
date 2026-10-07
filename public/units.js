// Presentation only. Reports and resource limits keep their original base units.
const prefixes = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'];
const number = value => {
  if (!['number', 'bigint', 'string'].includes(typeof value) ||
      typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function quantityScale(values, baseUnit = 'B') {
  let largest = 0;
  for (const value of values) {
    const n = number(value);
    if (n !== null) largest = Math.max(largest, Math.abs(n));
  }
  let index = 0;
  while (index < prefixes.length - 1 && largest >= 1000 ** (index + 1)) index++;
  // Avoid displaying a rounded 1000 kB at a prefix boundary.
  if (index < prefixes.length - 1 && Math.round(largest / 1000 ** index * 1000) / 1000 >= 1000) index++;
  return {divisor: 1000 ** index, unit: prefixes[index] + baseUnit};
}

export function quantityNumber(value, digits = 3) {
  const n = number(value);
  if (n === null) return '未报告';
  if (n !== 0 && Math.abs(n) < 10 ** -digits) return n.toExponential(digits);
  return n.toLocaleString('zh-CN', {maximumFractionDigits: digits});
}

export function formatQuantity(value, baseUnit, scale = quantityScale([value], baseUnit)) {
  const n = number(value);
  return n === null ? '未报告' : `${quantityNumber(n / scale.divisor)} ${scale.unit}`;
}
export const formatBytes = value => formatQuantity(value, 'B');
export const formatBitrate = value => formatQuantity(value, 'bit/s');

export function byteEvidence(value) {
  if (number(value) === null) return '未报告';
  // Preserve integer strings (including values above Number.MAX_SAFE_INTEGER).
  const text = String(value);
  return `${/^-?\d+$/.test(text) ? BigInt(text).toLocaleString('zh-CN') : text} B`;
}

export function scalePlotData(data, {x, y} = {}) {
  return data.map(point => {
    const result = [...point];
    for (const [index, scale] of [[0, x], [1, y]]) {
      if (!scale) continue;
      const value = number(point[index]);
      result[index] = value === null ? null : value / scale.divisor;
    }
    return result;
  });
}

export const byteLimit = formatBytes;
