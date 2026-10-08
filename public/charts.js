import {quantityNumber} from './units.js';
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
    initial,
    series = [],
    connect = true,
    markers = true,
    intervals = false,
    stems = false,
    xEnd,
    height,
  } = {},
) {
  if (!data.length) {
    host.textContent = "暂无可绘制的数据";
    return null;
  }
  host.innerHTML =
    '<div class="plot-controls"><button data-op="in" class="secondary">＋ 放大</button><button data-op="out" class="secondary">－ 缩小</button><button data-op="left" class="secondary">←</button><button data-op="right" class="secondary">→</button><button data-op="reset" class="secondary">全览</button><label>起点 <input data-field="from" type="number" step="any"></label><label>终点 <input data-field="to" type="number" step="any"></label><button data-op="apply" class="secondary">定位</button><label>纵轴范围<select data-field="scale"><option value="full">固定全数据范围</option><option value="visible">随可见区间缩放</option></select></label></div><div class="plot-axis-y"></div><canvas aria-label="可缩放分析曲线"></canvas><div class="chart-label" aria-live="polite"></div>';
  const canvas = host.querySelector("canvas"),
    label = host.querySelector(".chart-label"),
    from = host.querySelector("[data-field=from]"),
    to = host.querySelector("[data-field=to]");
  canvas.classList.toggle("frames-canvas", frames);
  if (height) canvas.style.height = height + "px";
  host.querySelector(".plot-axis-y").textContent = "纵轴：" + unit;
  canvas.setAttribute("aria-label", "横轴：" + axis + "；纵轴：" + unit);
  const scale = host.querySelector("[data-field=scale]");
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
    drag = null;
  const fullExtent = extent(data, frames || stems);
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
  const draw = () => {
    w = canvas.clientWidth;
    const h = height ?? (frames ? 180 : 230),
      dpr = devicePixelRatio || 1;
    canvas.width = Math.max(1, w * dpr);
    canvas.height = h * dpr;
    const c = canvas.getContext("2d");
    c.scale(dpr, dpr);
    c.font = "11px Segoe UI";
    const visible = intervals ? visibleIntervals(data, a, b) : visiblePoints(data, a, b, frames),
      finite = visible.filter((p) => Number.isFinite(p[1]));
    const [lo, hi] =
      scale.value === "visible" ? extent(visible, frames || stems) : fullExtent;
    const base = h - 50,
      top = 12,
      px = (x) => left + ((x - a) / (b - a)) * (w - left - right),
      py = (y) => base - ((y - lo) / (hi - lo)) * (base - top);
    const digits = Math.min(
      6,
      Math.max(1, Math.ceil(-Math.log10((hi - lo) / 4)) + 1),
    );
    c.fillStyle = "#98a7ba";
    c.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = top + ((base - top) * i) / 4;
      c.strokeStyle = "rgba(128, 128, 128, 0.25)";
      c.beginPath();
      c.moveTo(left, y);
      c.lineTo(w - right, y);
      c.stroke();
      c.textAlign = "right";
      c.fillText(n(hi - ((hi - lo) * i) / 4, digits), left - 8, y + 3);
      c.textAlign = "left";
    }
    if (frames) {
      const bw = Math.max(1, (w - left - right) / (b - a));
      for (const p of finite) {
        const f = p[2],
          x = px(p[0]);
        c.fillStyle = colorFor(
          f.special === "NON_IDR" ? f.type : f.special || f.type,
        );
        c.fillRect(
          x,
          py(p[1]),
          Math.max(1, bw - 1),
          Math.max(2, base - py(p[1])),
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
        c.beginPath();c.moveTo(x, base);c.lineTo(x, py(point[1]));c.stroke();
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
  canvas.ondblclick = () => setRange(minimum, maximum);
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
            setRange(Number(from.value), Number(to.value));
            break;
          case "reset":
            setRange(minimum, maximum);
        }
      }),
  );
  scale.onchange = draw;
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
