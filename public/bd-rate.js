// PCHIP (Fritsch–Butland slopes), integrated exactly in quality / ln(rate).
// Method and conventions: docs/bd-rate.md. No extrapolation or point removal.
export const bdRateMethod = "PCHIP / ln(rate) / common quality interval";

function curve(points, name) {
  if (!Array.isArray(points) || points.length < 2)
    throw Error(`${name}至少需要 2 个码率—质量采样点；请测量多个质量档位（CRF、QP 或目标码率）。`);
  if (points.some(p => !Number.isFinite(p.quality) || !Number.isFinite(p.rate) || p.rate <= 0))
    throw Error(`${name}包含缺失、无限质量或非正码率；不自动删除采样点。`);
  const sorted = points.map(p => ({...p})).sort((a, b) => a.quality - b.quality);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].quality === sorted[i - 1].quality)
      throw Error(`${name}存在重复质量值，无法建立单值曲线。`);
    if (sorted[i].rate <= sorted[i - 1].rate)
      throw Error(`${name}的码率未随质量严格递增；请检查采样或增加 CRF 覆盖范围。`);
  }
  return sorted;
}

function integral(points, lower, upper) {
  // Normalize quality to the integration interval to avoid subtracting large powers.
  const span = upper - lower,
    x = points.map(p => (p.quality - lower) / span),
    y = points.map(p => Math.log(p.rate)),
    h = x.slice(1).map((v, i) => v - x[i]),
    d = h.map((v, i) => (y[i + 1] - y[i]) / v),
    end = (h0, h1, d0, d1) => {
      const m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
      if (Math.sign(m) !== Math.sign(d0)) return 0;
      return Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > 3 * Math.abs(d0) ? 3 * d0 : m;
    },
    n = x.length;
  // Two-point PCHIP is a line; average it over the normalized interval [0, 1].
  if (n === 2) return y[0] + d[0] * (0.5 - x[0]);
  const slopes = [end(h[0], h[1], d[0], d[1])];
  for (let i = 1; i < n - 1; i++) {
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    slopes.push((w1 + w2) / (w1 / d[i - 1] + w2 / d[i]));
  }
  slopes.push(end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]));
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = Math.max(0, x[i]), b = Math.min(1, x[i + 1]);
    if (b <= a) continue;
    const c2 = (3 * d[i] - 2 * slopes[i] - slopes[i + 1]) / h[i],
      c3 = (slopes[i] + slopes[i + 1] - 2 * d[i]) / h[i] ** 2,
      primitive = t => y[i] * t + slopes[i] * t ** 2 / 2 + c2 * t ** 3 / 3 + c3 * t ** 4 / 4;
    total += primitive(b - x[i]) - primitive(a - x[i]);
  }
  // x spans [0, 1], so this is also the average log-rate over the quality interval.
  return total;
}

export function bdRate(anchorPoints, testPoints) {
  try {
    const anchor = curve(anchorPoints, "基准组"), test = curve(testPoints, "对比组"),
      lower = Math.max(anchor[0].quality, test[0].quality),
      upper = Math.min(anchor.at(-1).quality, test.at(-1).quality);
    if (upper <= lower) throw Error("两组没有正宽度的共同质量区间，不能计算 BD-rate。");
    const percent = Math.expm1(integral(test, lower, upper) - integral(anchor, lower, upper)) * 100;
    if (!Number.isFinite(percent)) throw Error("计算结果超出数值范围。");
    const pointCounts = [anchor.length, test.length];
    return {ok: true, percent, method: bdRateMethod, qualityRange: [lower, upper],
      pointCounts,
      warnings: pointCounts.some(n => n < 4)
        ? [`采样稀疏：基准组 ${anchor.length} 点，对比组 ${test.length} 点；结果仅供粗略比较，建议每组 4–6 个采样点。`]
        : [],
      coverage: [anchor, test].map(p => (upper - lower) / (p.at(-1).quality - p[0].quality))};
  } catch (error) {
    return {ok: false, reason: error.message, method: bdRateMethod};
  }
}
