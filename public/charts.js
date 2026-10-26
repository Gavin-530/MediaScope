import {quantityNumber} from './units.js';
// View preferences live only as long as this report's chart host. Each metric
// keeps its own range; locked bounds use base units so prefix changes are safe.
const yViews = new WeakMap();
const palette = {
  I: "#80e1c4",
  P: "#76a9ed",
  B: "#ad94e7",
  IDR: "#80e1c4",
  KEY: "#80e1c4",
  CRA: "#edbe75",
  BLA: "#edbe75",
  SHOW_EXISTING: "#ed94bb",
  INTER: "#76a9ed",
  INTRA_ONLY: "#9ae5ce",
  SWITCH: "#edbe75",
};
export const colorFor = (k) =>
  Object.entries(palette).find(([p]) => String(k).startsWith(p))?.[1] ||
  "#8795a8";
const n = (x, d = 3) =>
  Number.isFinite(x)
    ? quantityNumber(x, d)
    : "∞";
function indexAt(data, x) {
  let a = 0,
    b = data.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (data[m][0] < x) a = m + 1;
    else b = m;
  }
  return a;
}
export function finiteSegments(points) {
  const segments = [];
  let current = [];
  for (const p of points) {
    if (Number.isFinite(p[1])) current.push(p);
    else if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  return segments;
}
export function extent(points, frames = false) {
  let lo = Infinity,
    hi = -Infinity;
  for (const p of points)
    if (Number.isFinite(p[1])) {
      lo = Math.min(lo, p[1]);
      hi = Math.max(hi, p[1]);
    }
  if (lo === Infinity) return [0, 1];
  if (frames) lo = 0;
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else {
      lo -= Math.abs(lo) * 0.05;
      hi += Math.abs(hi) * 0.05;
    }
  }
  return [lo, hi];
}
// Nonnegative counts use whole-number steps and an upper bound covering every value.
export function countTicks(maximum, minimum = 0) {
  const stop = maximum > minimum ? maximum : minimum + 1,
    target = Math.max(1, Math.ceil((stop - minimum) / 5)),
    power = 10 ** Math.floor(Math.log10(target)),
    step = [1, 2, 5, 10].find(value => value * power >= target) * power,
    first = Math.ceil(minimum / step), last = Math.ceil(stop / step);
  return Array.from({length: last - first + 1}, (_, i) => (first + i) * step);
}
export function validYRange(lo, hi) {
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo && Number.isFinite(hi - lo);
}
export function visiblePoints(data, a, b, frames = false) {
  let lo = 0,
    hi = data.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (data[m][0] <= b) lo = m + 1;
    else hi = m;
  }
  return data.slice(indexAt(data, a), lo).filter((p) => !frames || p[0] < b);
}

// Interval measurements apply to [start,end), including a bin whose start is
// outside the viewport. They must not be linearly interpolated between starts.
export function visibleIntervals(data, a, b) {
  const first = Math.max(0, indexAt(data, a) - 1);
  return data.slice(first, indexAt(data, b)).filter(p => p[2].end > a);
}

// Shared bounded viewport. Aggregation preserves extrema; it never recomputes measurement windows.
export function plot(
  host,
  data,
  {
    unit = "",
    axis = "时间 s",
    frames = false,
    describe,
    onPick,
    onReset,
    xControl,
    yControl,
    emptyMessage = "暂无可绘制的数据",
    initial,
    series = [],
    connect = true,
    markers = true,
    intervals = false,
    stems = false,
    integerY = false,
    yKey = unit,
    yFactor = 1,
    xEnd,
    height,
  } = {},
) {
  const focusedControl = document.activeElement,
    xMode = host.querySelector('[data-field="x-scale"]')?.value || 'full';
  const placeAxisControls = () => {
    for (const [selector, control] of [['.plot-range', xControl], ['.plot-y-controls', yControl]]) {
      if (!control) continue;
      const group = host.querySelector(selector);
      group.insertBefore(control, group.lastElementChild);
      if (control.contains(focusedControl)) focusedControl.focus({preventScroll: true});
    }
  };
  if (!data.length) {
    host.textContent = emptyMessage;
    if (xControl || yControl) {
      const toolbar = document.createElement('div');
      toolbar.className = 'plot-controls';
      toolbar.innerHTML = '<div class="plot-range"></div><div class="plot-y-controls"></div>';
      host.prepend(toolbar); placeAxisControls();
    }
    return null;
  }
  if (!(yFactor > 0) || !Number.isFinite(yFactor)) throw Error('Invalid chart unit factor');
  let views = yViews.get(host);
  if (!views) { views = new Map(); yViews.set(host, views); }
  if (!views.has(yKey)) views.set(yKey, {mode: 'full', range: null});
  const yView = views.get(yKey);
  host.innerHTML =
    '<div class="plot-controls"><div class="plot-actions"><button data-op="in" class="secondary">＋ 放大</button><button data-op="out" class="secondary">－ 缩小</button><button data-op="left" class="secondary" title="向左平移">←</button><button data-op="right" class="secondary" title="向右平移">→</button><button data-op="reset" class="secondary" title="恢复横轴全览，保留纵轴设置">全览</button></div>' +
    '<div class="plot-range"><label>X 轴<select data-field="x-scale" title="自动：收起起止输入，切回时恢复全览；自定义：显示当前起止范围，可修改并应用。"><option value="full">自动</option><option value="manual">自定义</option></select></label><div class="plot-x-bounds hidden"><label>起点 <input data-field="from" aria-label="X 起点" type="number" step="any"></label><label>终点 <input data-field="to" aria-label="X 终点" type="number" step="any"></label><button data-op="apply" class="secondary">应用</button></div></div>' +
    '<div class="plot-y-controls"><label>Y 轴<select data-field="scale" title="自动：全部曲线的范围；随 X 缩放：当前横轴区间的范围；锁定：固定当前范围，可修改上下限。"><option value="full">自动</option><option value="visible">随 X 缩放</option><option value="manual">锁定</option></select></label><div class="plot-y-bounds hidden"><label>下限 <input data-field="y-min" aria-label="Y 下限" type="number" step="any"></label><label>上限 <input data-field="y-max" aria-label="Y 上限" type="number" step="any"></label><button data-op="apply-y" class="secondary">应用</button></div></div></div>' +
    '<div class="plot-y-status" role="status"></div><div class="plot-axis-y"></div><canvas aria-label="可缩放分析曲线"></canvas><div class="chart-label" aria-live="polite"></div>';
  placeAxisControls();
  const canvas = host.querySelector("canvas"),
    label = host.querySelector(".chart-label"),
    from = host.querySelector("[data-field=from]"),
    to = host.querySelector("[data-field=to]");
  const xScale = host.querySelector('[data-field="x-scale"]'),
    xBounds = host.querySelector('.plot-x-bounds');
  xScale.value = xMode;
  if (height) canvas.style.height = height + "px";
  host.querySelector(".plot-axis-y").textContent = "纵轴：" + unit;
  canvas.setAttribute("aria-label", "横轴：" + axis + "；纵轴：" + unit);
  const scale = host.querySelector("[data-field=scale]");
  const yMin = host.querySelector('[data-field="y-min"]'),
    yMax = host.querySelector('[data-field="y-max"]'),
    yBounds = host.querySelector('.plot-y-bounds'),
    yStatus = host.querySelector('.plot-y-status');
  scale.value = yView.mode;
  if (series.length) {
    const legend = document.createElement("div");
    legend.className = "plot-legend";
    for (const s of series) {
      const item = document.createElement("span");
      item.textContent = (s.dash?.length ? "┄ " : "━ ") + s.name;
      item.style.color = s.color;
      legend.append(item);
    }
    canvas.before(legend);
  }
  const minimum = data[0][0],
    last = Number.isFinite(xEnd) && xEnd > data.at(-1)[0] ? xEnd : intervals ? data.at(-1)[2].end : data.at(-1)[0] + (frames ? 1 : 0),
    maximum = last > minimum ? last : minimum + 1,
    minSpan = frames ? 1 : stems ? Math.min(1e-6, (maximum - minimum) / 10) : Math.min(1, (maximum - minimum) / 10);
  let a = minimum,
    b = maximum,
    w = 0,
    drag = null,
    currentY = null;
  const fullExtent = extent(data, frames || stems || integerY);
  const left = 76,
    right = 25;
  const xValue = (x) =>
    a + ((x - left) / Math.max(1, w - left - right)) * (b - a);
  const setRange = (lo, hi) => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
    const span = Math.min(maximum - minimum, Math.max(minSpan, hi - lo));
    a = Math.max(minimum, Math.min(maximum - span, lo));
    b = a + span;
    from.value = +a.toFixed(6);
    to.value = +b.toFixed(6);
    draw();
  };
  const resetRange = () => { onReset?.(); setRange(minimum, maximum); };
  const lockY = (lo, hi) => {
    const baseRange = [lo * yFactor, hi * yFactor];
    if (!validYRange(lo, hi) || !validYRange(...baseRange)) {
      yStatus.textContent = '纵轴范围未应用：请输入有限的上下限，且上限必须大于下限。';
      yMin.setAttribute('aria-invalid', 'true'); yMax.setAttribute('aria-invalid', 'true');
      return;
    }
    yMin.removeAttribute('aria-invalid'); yMax.removeAttribute('aria-invalid');
    yView.mode = scale.value = 'manual'; yView.range = baseRange;
    draw();
  };
  const draw = () => {
    xBounds.classList.toggle('hidden', xScale.value !== 'manual');
    w = canvas.clientWidth;
    const h = canvas.clientHeight,
      dpr = devicePixelRatio || 1;
    canvas.width = Math.max(1, w * dpr);
    canvas.height = h * dpr;
    const c = canvas.getContext("2d");
    c.scale(dpr, dpr);
    c.font = "11px Segoe UI";
    const visible = intervals ? visibleIntervals(data, a, b) : visiblePoints(data, a, b, frames),
      finite = visible.filter((p) => Number.isFinite(p[1]));
    const manual = yView.mode === 'manual';
    yBounds.classList.toggle('hidden', !manual);
    let [lo, hi] = manual ? yView.range.map(value => value / yFactor) :
      yView.mode === 'visible' ? extent(visible, frames || stems || integerY) : fullExtent;
    let yTicks = integerY ? countTicks(hi, manual ? lo : 0) : Array.from({length: 5}, (_, i) => hi - ((hi - lo) * i) / 4);
    if (integerY && !manual) { lo = 0; hi = yTicks.at(-1); }
    if (manual && integerY) yTicks = yTicks.filter(value => value >= lo && value <= hi);
    currentY = [lo, hi];
    if (document.activeElement !== yMin && document.activeElement !== yMax) {
      yMin.value = String(lo); yMax.value = String(hi);
    }
    const below = finite.filter(p => p[1] < lo).length, above = finite.filter(p => p[1] > hi).length;
    yStatus.textContent = manual && lo !== 0 ? 'Y 轴下限非零。' : '';
    if (below || above) yStatus.textContent += ` 当前区间超出 Y 轴：上方 ${above} 项、下方 ${below} 项（仅裁剪显示）。`;
    const base = h - 50,
      top = 12,
      px = (x) => left + ((x - a) / (b - a)) * (w - left - right),
      py = (y) => base - ((y - lo) / (hi - lo)) * (base - top),
      zero = py(0);
    const digits = Math.min(
      manual ? 15 : 6,
      Math.max(1, Math.ceil(-Math.log10((hi - lo) / 4)) + 1),
    );
    c.fillStyle = "#98a7ba";
    c.lineWidth = 1;
    for (const value of yTicks) {
      const y = py(value);
      c.strokeStyle = "rgba(128, 128, 128, 0.25)";
      c.beginPath();
      c.moveTo(left, y);
      c.lineTo(w - right, y);
      c.stroke();
      c.textAlign = "right";
      c.fillText(n(value, integerY ? 0 : digits), left - 8, y + 3);
      c.textAlign = "left";
    }
    c.save();
    c.beginPath();c.rect(left, top, Math.max(0, w - left - right), base - top);c.clip();
    if (frames) {
      const bw = Math.max(1, (w - left - right) / (b - a));
      for (const p of finite) {
        const f = p[2],
          x = px(p[0]), y = py(p[1]);
        c.fillStyle = colorFor(
          f.special === "NON_IDR" ? f.type : f.special || f.type,
        );
        c.fillRect(
          x,
          Math.min(y, zero),
          Math.max(1, bw - 1),
          Math.abs(zero - y),
        );
        if (f.key) {
          c.fillStyle = "#f5f1ce";
          c.fillRect(x, top, Math.max(1, bw - 1), 4);
        }
        if (bw > 18) {
          c.fillStyle = "#e7edf5";
          c.fillText(f.type ?? "?", x + 2, base + 13);
        }
      }
    } else if (stems) {
      // A packet/frame remains a discrete observation. Dense columns show the
      // largest observation, never a sum or an interpolated rate.
      const columns = new Map();
      for (const point of finite) {
        const x = Math.floor(px(point[0])), prior = columns.get(x);
        if (!prior || point[1] > prior.point[1]) columns.set(x, {point, key: prior?.key || point[2]?.key});
        else prior.key ||= point[2]?.key;
      }
      c.lineWidth = 1;
      for (const [x, {point, key}] of columns) {
        const f = point[2];
        c.strokeStyle = f?.type || f?.special ? colorFor(f.special === 'NON_IDR' ? f.type : f.special || f.type) : '#10b981';
        c.beginPath();c.moveTo(x, zero);c.lineTo(x, py(point[1]));c.stroke();
        if (key) { c.fillStyle = '#f5f1ce';c.fillRect(x, top, 2, 4); }
      }
    } else {
      for (const group of series.length ? series : [{ color: "#10b981" }]) {
        const points = series.length
          ? visible.filter((p) => p[3] === group.id)
          : visible;
        c.strokeStyle = group.color;
        c.fillStyle = group.color;
        c.lineWidth = 2;
        c.setLineDash(group.dash || []);
        if (intervals) {
          c.beginPath();
          let previous = null;
          for (const p of points) {
            if (!Number.isFinite(p[1])) { previous = null; continue; }
            const x = px(Math.max(a, p[0])), end = px(Math.min(b, p[2].end));
            if (previous && previous[2].end === p[0]) c.lineTo(x, py(p[1]));
            else c.moveTo(x, py(p[1]));
            c.lineTo(end, py(p[1]));
            previous = p;
          }
          c.stroke();
          continue;
        }
        for (const segment of finiteSegments(points)) {
          // Dense traces retain each pixel column's extrema; gaps stay separate.
          const buckets = new Map();
          for (const p of segment) {
            const x = Math.floor(px(p[0])),
              bucket = buckets.get(x) || {
                lo: p[1],
                hi: p[1],
                first: p[1],
                last: p[1],
              };
            bucket.last = p[1];
            bucket.lo = Math.min(bucket.lo, p[1]);
            bucket.hi = Math.max(bucket.hi, p[1]);
            buckets.set(x, bucket);
          }
          if (connect) {
            c.beginPath();
            for (const [x, p] of buckets) {
              c.moveTo(x, py(p.lo));
              c.lineTo(x, py(p.hi) + 1);
            }
            c.stroke();
            c.beginPath();
            let first = true;
            for (const [x, p] of buckets) {
              if (first) c.moveTo(x, py(p.first));
              else c.lineTo(x, py(p.first));
              c.lineTo(x, py(p.last));
              first = false;
            }
            c.stroke();
          }
          if ((markers && series.length) || !connect || segment.length === 1) {
            for (const p of segment) {
              c.beginPath();
              c.arc(px(p[0]), py(p[1]), 3, 0, Math.PI * 2);
              c.fill();
            }
          }
        }
      }
      c.setLineDash([]);
    }
    c.restore();
    c.fillStyle = "#98a7ba";
    c.lineWidth = 1;
    const ticks = Math.max(1, Math.min(4, Math.floor((w - left - right) / 90))),
      xd = Math.min(
        6,
        Math.max(0, Math.ceil(-Math.log10((b - a) / ticks)) + 1),
      );
    for (let i = 0; i <= ticks; i++) {
      const x = left + ((w - left - right) * i) / ticks;
      c.strokeStyle = "rgba(128, 128, 128, 0.25)";
      c.beginPath();
      c.moveTo(x, top);
      c.lineTo(x, base + 4);
      c.stroke();
      c.textAlign = "center";
      c.fillText(n(a + ((b - a) * i) / ticks, xd), x, base + 18);
    }
    c.textAlign = "center";
    c.fillText("横轴：" + axis, left + (w - left - right) / 2, h - 7);
    c.textAlign = "left";
    if (!finite.length) c.fillText("当前区间为无限值或无数据", 70, 80);
    if (drag) {
      c.fillStyle = "#80e1c433";
      c.fillRect(
        Math.min(drag.start, drag.end),
        top,
        Math.abs(drag.end - drag.start),
        base - top,
      );
    }
  };
  const hover = (e) => {
    const x = xValue(e.offsetX);
    let idx = Math.min(
      data.length - 1,
      indexAt(data, frames ? Math.floor(x) : x),
    );
    if (intervals && idx > 0 && data[idx][0] > x) idx--;
    if (
      !frames && !intervals &&
      idx > 0 &&
      Math.abs(data[idx - 1][0] - x) < Math.abs(data[idx][0] - x)
    )
      idx--;
    const p = data[idx],
      atX = series.length ? visiblePoints(data, p[0], p[0]) : [p];
    label.textContent =
      axis +
      " " +
      n(p[0], 6) +
      " · " +
      (atX.length ? atX : [p])
        .map((point) =>
          describe
            ? describe(point)
            : `${unit} ${point[1] === null ? "缺失 / ∞" : n(point[1], 6)}`,
        )
        .join(" | ");
    return p;
  };
  canvas.onpointerdown = (e) => {
    if (e.button !== 0) return;
    drag = { start: e.offsetX, end: e.offsetX };
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    hover(e);
    if (drag) {
      drag.end = Math.max(left, Math.min(w - right, e.offsetX));
      draw();
    }
  };
  canvas.onpointerup = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (Math.abs(d.end - d.start) > 8)
      setRange(
        xValue(Math.min(d.start, d.end)),
        xValue(Math.max(d.start, d.end)),
      );
    else {
      onPick?.(hover(e));
      draw();
    }
  };
  canvas.onpointercancel = () => {
    drag = null;
    draw();
  };
  canvas.ondblclick = resetRange;
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const center = xValue(e.offsetX),
        factor = e.deltaY > 0 ? 1.4 : 0.7;
      setRange(center - (center - a) * factor, center + (b - center) * factor);
    },
    { passive: false },
  );
  host.querySelectorAll("[data-op]").forEach(
    (button) =>
      (button.onclick = () => {
        const span = b - a,
          mid = (a + b) / 2;
        switch (button.dataset.op) {
          case "in":
            setRange(mid - span / 4, mid + span / 4);
            break;
          case "out":
            setRange(mid - span, mid + span);
            break;
          case "left":
            setRange(a - span * 0.7, b - span * 0.7);
            break;
          case "right":
            setRange(a + span * 0.7, b + span * 0.7);
            break;
          case "apply":
            setRange(from.valueAsNumber, to.valueAsNumber);
            break;
          case "reset":
            resetRange();
            break;
          case 'apply-y':
            lockY(yMin.valueAsNumber, yMax.valueAsNumber);
            break;
        }
      }),
  );
  xScale.onchange = () => {
    if (xScale.value === 'full') resetRange();
    else {
      from.value = +a.toFixed(6); to.value = +b.toFixed(6);
      draw();
    }
  };
  scale.onchange = () => {
    if (scale.value === 'manual') lockY(...currentY);
    else {
      yMin.removeAttribute('aria-invalid'); yMax.removeAttribute('aria-invalid');
      yView.mode = scale.value; draw();
    }
  };
  const ro = new ResizeObserver(() => {
    if (canvas.isConnected) draw();
    else ro.disconnect();
  });
  ro.observe(canvas);
  setRange(...(initial || [minimum, maximum]));
  label.textContent = frames ? "点击帧查看证据。" : "";
  return { setRange, dispose: () => ro.disconnect() };
}

export function gopOverview(host, gops, total, onSelect) {
  host.innerHTML =
    '<canvas class="gop-canvas" aria-label="GOP 全片概览"></canvas><div class="chart-label"></div>';
  const canvas = host.querySelector("canvas"),
    label = host.querySelector(".chart-label");
  let selected = 0;
  const draw = () => {
    const w = canvas.clientWidth,
      d = devicePixelRatio || 1;
    canvas.width = w * d;
    canvas.height = 58 * d;
    const c = canvas.getContext("2d");
    c.scale(d, d);
    c.font = "11px Segoe UI";
    for (const g of gops) {
      const x = (g.start / total) * w,
        width = (g.count / total) * w;
      c.fillStyle = colorFor(g.label);
      c.globalAlpha = g.index === selected ? 1 : 0.45;
      c.fillRect(x, 6, Math.max(1, width - 1), 35);
      if (width > 65) {
        c.globalAlpha = 1;
        c.fillStyle = "#10251e";
        c.fillText(`#${g.index} ${g.label}`, x + 5, 27);
      }
    }
    c.globalAlpha = 1;
  };
  const pick = (x) =>
    gops.find((g) => ((g.end + 1) / total) * canvas.clientWidth >= x) ||
    gops.at(-1);
  canvas.onmousemove = (e) => {
    const g = pick(e.offsetX);
    label.textContent = `GOP #${g.index} · ${g.label} · 帧 ${g.start}–${g.end} · ${g.count} 帧`;
  };
  canvas.onclick = (e) => {
    selected = pick(e.offsetX).index;
    draw();
    onSelect(selected);
  };
  const ro = new ResizeObserver(() => {
    if (canvas.isConnected) draw();
    else ro.disconnect();
  });
  ro.observe(canvas);
  draw();
  return {
    select: (i) => {
      selected = i;
      draw();
    },
    dispose: () => ro.disconnect(),
  };
}
