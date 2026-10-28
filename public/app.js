import {bitrateView} from "./bitrate-model.js";
import {analysisNoticeGroups,unconfirmedSceneNote} from './analysis-notes.js';
import {timingSummary, formatElapsedSeconds, recordedSeconds} from "./timing.js";
import {audioPacketPoints, packetSeconds, frameTimePoints, frameTimeRange} from "./distribution-model.js";
import {formatBytes, formatBitrate, byteEvidence, byteLimit, quantityScale, quantityNumber, scalePlotData} from "./units.js";
import {parsePortable,makePortable,maxPortableBytes,portableFilename,reportFromPortable} from './portable.js';
import { plot, gopOverview } from "./charts.js";
import { basicInfoHTML, initBasicInfo } from "./basic-info.js";
import {vmafModels} from "./vmaf.js";
import {validateSitiSceneStarts,validateSitiSettings} from "./siti.js";
import {
  parseCrfs,
  trialBdRate,
  rowLabel,
  trialPlotData,
  trialFramePlotData,
  metricLabels,
  trialSortFields,
  sortTrialRows,
} from "./trial-model.js";
const modes = ["inspect", "compare", "trial"],
  reports = {},
  reportOwners = {},
  viewCharts = { inspect: [], compare: [], trial: [] };
let activeMode = "inspect",
  renderingMode = null,
  nav = null;
const modeOf = (r) => (r.type === "analyze" ? "inspect" : r.type);
const $ = (s) =>
    document.querySelector(
      /^#(result|result-title|summary|details|export)$/.test(s)
        ? "#" + (renderingMode || activeMode) + "-" + s.slice(1)
        : s,
    ),
  token = $("meta[name=token]").content,
  applicationVersion = $("meta[name=app-version]").content;
let current = null,
  environmentReady = false,
  desktopSession = false,
  report = null,
  infoPath = null,
  hasVideo = false,
  charts = [],
  importing = false;
const esc = (v) =>
  String(v ?? "未报告").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (v, d = 3) =>
  typeof v === "number"
    ? v.toLocaleString("zh-CN", { maximumFractionDigits: d })
    : (v ?? "未报告");
const unitCell = Symbol('unit-cell');
const quantityCell = (text, title) => ({[unitCell]: true, text, title, toString: () => text});
const size = v => quantityCell(formatBytes(v), byteEvidence(v));
const rate = mbps => quantityCell(formatBitrate(mbps == null ? null : mbps * 1e6), mbps == null ? '未报告' : `${mbps * 1e6} bit/s`);
const cellHTML = v => v?.[unitCell] ? `<span title="${esc(v.title)}">${esc(v.text)}</span>` : esc(v);
const clean = (v) => v.trim().replace(/^"|"$/g, "");
for(const id of ['#vmaf-model','#trial-vmaf-model'])
  $(id).innerHTML=Object.entries(vmafModels).map(([version,m])=>`<option value="${version}">${esc(version)} · ${esc(m.label)}</option>`).join('');
async function api(url, options = {}) {
  const r = await fetch("/api/" + url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-MediaScope-Token": token,
      },
    }),
    d = await r.json();
  if (!r.ok) throw Error(d.error || "请求失败");
  return url==='probe'||/^jobs\/[^/]+\/report$/.test(url)?reportFromPortable(d):d;
}
function showStartup(s) {
  const wasReady = environmentReady;
  environmentReady = !s.startup || s.startup.state === "ready";
  desktopSession = !!s.desktop;
  const status = $("#startup-status");
  status.textContent = s.startup?.message || "运行环境已就绪";
  status.classList.toggle("hidden", environmentReady);
  status.classList.toggle("error", s.startup?.state === "error");
  $("#environment").textContent = environmentReady ? s.versions.ffmpeg : status.textContent;
  for (const box of document.querySelectorAll("[name=metric]")) {
    box.disabled = !environmentReady || !s.metrics.includes(box.value);
    if (environmentReady && box.disabled) box.checked = false;
  }
  if (!wasReady && environmentReady && clean($("#file").value) && !infoPath) void readFileInfo();
}
window.addEventListener("beforeunload", (event) => {
  if (desktopSession && latestJobs.some((j) => ["queued", "running"].includes(j.status))) {
    event.preventDefault();
    event.returnValue = "任务尚未完成，退出将停止分析。";
  }
});
function progressValue(value) {
  return Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
    : null;
}
function elapsed(startedAt) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
  );
  if (!Number.isFinite(seconds)) return "";
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  return `已运行 ${h ? String(h).padStart(2, "0") + ":" : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function message(
  text,
  error = false,
  progress = null,
  startedAt = null,
  status = null,
) {
  $("#task").classList.remove("hidden");
  $("#task").classList.toggle("error", error);
  $("#task-label").textContent = error
    ? "任务未完成"
    : status === "cancelled"
      ? "任务已取消"
      : status === "done"
        ? "任务完成"
        : "分析任务";
  $("#task-message").textContent = text;
  $("#cancel").classList.toggle("hidden", !current);
  const details = $("#task-progress-details"),
    stage = $("#task-stage"),
    phase = $("#task-phase");
  details.classList.toggle("hidden", !progress);
  stage.classList.toggle("hidden", !progress?.stage);
  phase.classList.toggle(
    "hidden",
    !(progress?.phaseIndex != null && progress?.phaseCount),
  );
  if (!progress) {
    stage.textContent = "";
    phase.textContent = "";
    syncTaskBrief();
    return;
  }
  stage.textContent = progress.stage || "";
  phase.textContent =
    progress.phaseIndex != null && progress.phaseCount
      ? `阶段 ${progress.phaseIndex} / ${progress.phaseCount}`
      : "";
  const determinate =
      Number.isFinite(progress.completed) &&
      Number.isFinite(progress.total) &&
      progress.total >= 0,
    percent = determinate
      ? progress.total === 0
        ? 100
        : Math.max(
            0,
            Math.min(100, (progress.completed / progress.total) * 100),
          )
      : null;
  const count = progressValue(progress.completed),
    total = progressValue(progress.total);
  $("#task-count").textContent =
    count === null
      ? "正在处理"
      : total === null
        ? `已处理 ${count}${progress.unit ? " " + progress.unit : ""}`
        : `${count} / ${total}${progress.unit ? " " + progress.unit : ""}`;
  $("#task-percent").textContent =
    percent === null
      ? "总量待核验"
      : `${percent.toFixed(percent < 10 && percent % 1 ? 1 : 0)}%`;
  const track = $("#task-progress-track"),
    bar = $("#task-progress-bar"),
    islandBar = $("#island-progress-bar");
  track.classList.toggle("indeterminate", !determinate);
  if (!bar.style) bar.style = {};
  bar.style.width = determinate ? percent + "%" : "";
  if (islandBar) islandBar.style.width = determinate ? percent + "%" : "";
  track.ariaValueNow = determinate ? String(percent) : "";
  track.ariaValueMax = determinate ? "100" : "";
  const subtasks = Object.values(progress.subtasks || {});
  $("#task-subtasks").innerHTML = subtasks
    .map((item) => {
      const done = progressValue(item.completed),
        all = progressValue(item.total);
      return `<div class="task-subtask"><span>${esc(item.label || "并行任务")}</span><span>${done ?? "准备中"}${all !== null ? " / " + all : ""}${item.unit ? " " + esc(item.unit) : ""}</span></div>`;
    })
    .join("");
  $("#task-elapsed").textContent = startedAt ? elapsed(startedAt) : "";
  syncTaskBrief();
}
function busy(value) {
  updateAnalysisSubmission();
  for (const id of ["compare", "enqueue-compare", "trial", "enqueue-trial"])
    if ($("#" + id)) $("#" + id).disabled = !environmentReady;
  $("#import-report").disabled = value;
  $("#import-button").disabled = value;
}
let submitting = false,
  refreshing = false,
  autoOpen = null,
  queueView = "",
  historyView = "",
  resultView = "",
  latestJobs = [],
  importSequence = 0;
let importedResults = [],
  removedReportIds = new Set(),
  selectedResults = new Set(),
  selectedPlans = new Set(),
  downloadNames = new Map();
async function launch(data) {
  if (submitting) return;
  submitting = true;
  try {
    const j = await api("jobs", { method: "POST", body: JSON.stringify(data) });
    latestJobs.push({ id: j.id, status: "queued" });
    if (!data.enqueue) autoOpen = j.id;
    message(data.enqueue ? "已加入队列，参数已保存" : "任务已提交");
    await poll();
  } catch (e) {
    message(e.message, true);
  } finally {
    submitting = false;
  }
}
const fileName = (file) =>
  String(file || "未指定文件")
    .split(/[\\/]/)
    .pop();
function queueRow(j, position) {
  const names = {
      inspect: "读取信息",
      analyze: "文件分析",
      compare: "质量比较",
      trial: "片段实验",
    },
    states = {
      queued: "等待",
      running: "运行中",
      done: "完成",
      error: "失败",
      cancelled: "已取消",
    };
  const primary = fileName(j.file || j.reference),
    secondary = j.candidate ? " → " + fileName(j.candidate) : "";
  const pathText =
    (j.file || j.reference || "") + (j.candidate ? " → " + j.candidate : "");
  const action = ["done", "error"].includes(j.status) ? "retry" : j.status === "queued" ? "remove" : "cancel";
  const label = { retry: "重新排队", cancel: "取消", remove: "移除" }[action];
  const stage =
    j.status === "running" ? j.progress?.stage || j.message : j.message;
  return `<div class="queue-item">${j.status === "queued" ? `<input class="portable-check" type="checkbox" data-plan-select="${j.id}" aria-label="选择任务计划 ${esc(primary)}" ${selectedPlans.has(j.id) ? "checked" : ""}>` : ""}<div class="queue-item-main"><strong>${position ? position + ". " : ""}${esc(primary + secondary)}</strong><span class="queue-state">${esc(names[j.type])} · ${states[j.status]}</span><p class="queue-path" title="${esc(pathText)}">${esc(pathText)}</p><p class="queue-description">${esc(j.description || "")}${stage ? " · " + esc(stage) : ""}</p></div><div class="queue-actions"><button class="secondary" data-job="${j.id}" data-action="${j.status === 'done' ? 'report' : action}">${j.status === 'done' ? '查看报告' : label}</button>${j.status === 'done' ? `<button class="secondary" data-job="${j.id}" data-action="retry">重新排队</button>` : ''}${["done", "error"].includes(j.status) ? `<button class="secondary" data-job="${j.id}" data-action="remove">移除</button>` : ''}</div></div>`;
}
function resultItems() {
  return [
    ...latestJobs
      .filter((j) => j.status === "done")
      .map((j) => ({ id: j.id, job: j })),
    ...importedResults,
  ];
}
function syncReportSelection() {
  const owner = reportOwners[activeMode];
  document.querySelectorAll('[data-result-open], [data-job][data-action="report"]').forEach(button => {
    const selected = !!owner && (button.dataset.resultOpen || button.dataset.job) === owner;
    button.closest('.queue-item')?.classList.toggle('is-current-report', selected);
    const label = selected ? '正在查看' : '查看报告';
    if (button.textContent !== label) button.textContent = label;
    if (selected) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
  for (const mode of modes) {
    const r = reports[mode], context = document.querySelector('#' + mode + '-report-context');
    document.querySelector('#' + mode + '-result').dataset.reportOwner = reportOwners[mode] ?? '';
    const file = r?.file || r?.source?.file || r?.reference?.file;
    const other = r?.candidate?.file;
    const text = file ? `当前报告：${fileName(file)}${other ? ' → ' + fileName(other) : ''}` : '';
    if (context.textContent !== text) context.textContent = text;
    context.title = file ? file + (other ? ' → ' + other : '') : '';
  }
}
function renderResultList() {
  const items = resultItems(),
    available = new Set(items.map((x) => x.id));
  let viewRemoved = false;
  for (const mode of modes) {
    if (reportOwners[mode] && removedReportIds.has(reportOwners[mode])) {
      viewCharts[mode].forEach(chart => chart.dispose?.());
      viewCharts[mode] = [];
      delete reports[mode];
      delete reportOwners[mode];
      $("#" + mode + "-details").textContent = "";
      $("#" + mode + "-summary").textContent = "";
      delete $("#" + mode + "-result").dataset.reportOwner;
      viewRemoved = true;
    }
  }
  removedReportIds.clear();
  if (viewRemoved) switchMode(activeMode);
  for (const id of selectedResults)
    if (!available.has(id)) selectedResults.delete(id);
  $("#result-clear").disabled = !items.length;
  const summary = timingSummary(items.map(x => x.report?.timing || x.job?.timing));
  $("#result-timing-total").textContent = items.length ? `累计计算耗时：${formatElapsedSeconds(summary.totalComputeSeconds)} · ${summary.recordedResults} 项已记录${summary.missingResults ? `，${summary.missingResults} 项未记录` : ""}（不含排队、保存和页面渲染）` : "";
  const signature = JSON.stringify(items.map((x) => [x.id, x.job?.status, x.report?.timing || x.job?.timing]));
  if (signature === resultView) {syncReportSelection();return;}
  resultView = signature;
  $("#result-list").innerHTML =
    items
      .map((x) => {
        const r = x.report,
          j = x.job,
          type = r?.type || j?.type || "?",
          file =
            r?.file ||
            r?.source?.file ||
            r?.reference?.file ||
            j?.file ||
            j?.reference ||
            "未指定文件",
          other = r?.candidate?.file || j?.candidate;
        const label = fileName(file) + (other ? " → " + fileName(other) : "");
        const timing = r?.timing || j?.timing;
        const stages = Array.isArray(timing?.stages) ? timing.stages.filter(s => typeof s?.name === "string" && recordedSeconds(s.elapsedSeconds)) : [];
        const timingHTML = `<p class="result-timing">计算耗时：${formatElapsedSeconds(timing?.computeSeconds)}</p>${stages.length ? `<details class="result-timing-stages"><summary>各阶段耗时</summary>${table(["项目", "耗时", "执行方式"], stages.map(s => [s.name, formatElapsedSeconds(s.elapsedSeconds), s.concurrentGroup ? `并行 · ${s.concurrentGroup}` : "顺序"]))}${stages.some(s => s.concurrentGroup) ? '<p class="hint">同组并行阶段的耗时有重叠，不相加。</p>' : ""}</details>` : ""}`;
        return `<div class="queue-item"><input class="portable-check" type="checkbox" data-result-select="${esc(x.id)}" aria-label="选择结果 ${esc(label)}" ${selectedResults.has(x.id) ? "checked" : ""}><div class="queue-item-main"><strong>${esc(label)}</strong><span class="queue-state">${esc(type)} · ${r ? "已导入" : "已完成"}</span><p class="queue-path">${esc(file)}${other ? " → " + esc(other) : ""}</p>${timingHTML}</div><div class="queue-actions"><button class="secondary" data-result-open="${esc(x.id)}">查看报告</button><button class="secondary" data-result-remove="${esc(x.id)}">移除</button></div></div>`;
      })
      .join("") || '<p class="hint">暂无已完成结果。</p>';
  syncReportSelection();
}
$("#queue-list").onchange = (e) => {
  const id = e.target.dataset?.planSelect;
  if (id) {
    if (e.target.checked) selectedPlans.add(id);
    else selectedPlans.delete(id);
  }
};
$("#result-list").onchange = (e) => {
  const id = e.target.dataset?.resultSelect;
  if (id) {
    if (e.target.checked) selectedResults.add(id);
    else selectedResults.delete(id);
  }
};
$("#result-list").onclick = async (e) => {
  const remove = e.target.closest?.("[data-result-remove]");
  if (remove) {
    remove.disabled = true;
    try {
      const id = remove.dataset.resultRemove;
      if (importedResults.some(x => x.id === id)) importedResults = importedResults.filter(x => x.id !== id);
      else await api("jobs/" + id, { method: "DELETE" });
      removedReportIds.add(id);
      renderResultList();
      await poll();
    } catch (err) { message(err.message, true); remove.disabled = false; }
    return;
  }
  const id = e.target.closest?.("[data-result-open]")?.dataset.resultOpen;
  if (!id) return;
  try {
    const loaded = modes.find(mode => reportOwners[mode] === id && reports[mode]);
    if (loaded) {switchMode(loaded);return;}
    const item = resultItems().find((x) => x.id === id);
    if (!item) throw Error("结果已不可用");
    render(item.report || (await api("jobs/" + id + "/report")), true, id);
  } catch (err) {
    message(err.message, true);
  }
};
async function queueAction(event) {
  const button = event.target.closest("[data-job]");
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.action === "report") {
      const loaded = modes.find(mode => reportOwners[mode] === button.dataset.job && reports[mode]);
      if (loaded) switchMode(loaded);
      else render(await api("jobs/" + button.dataset.job + "/report"), true, button.dataset.job);
      button.disabled = false;
    }
    else if (button.dataset.action === "retry")
      await api("jobs/" + button.dataset.job + "/retry", {
        method: "POST",
        body: "{}",
      });
    else {
      await api("jobs/" + button.dataset.job, { method: "DELETE" });
      removedReportIds.add(button.dataset.job);
    }
    await poll();
  } catch (e) {
    message(e.message, true);
    button.disabled = false;
  }
}
$("#queue-list").onclick = queueAction;
$("#queue-history-list").onclick = queueAction;
for (const [id, scope] of [["queue-clear", "queued"], ["queue-history-clear", "history"], ["result-clear", "results"]]) {
  $("#" + id).onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const removedIds = latestJobs.filter(j => scope === "queued" ? j.status === "queued" : scope === "results" ? j.status === "done" : ["done", "error"].includes(j.status)).map(j => j.id);
      if (scope === "results") removedIds.push(...importedResults.map(x => x.id));
      await api("jobs/clear", { method: "POST", body: JSON.stringify({ scope }) });
      removedIds.forEach(id => removedReportIds.add(id));
      if (scope === "results") importedResults = [];
      renderResultList();
      await poll();
    } catch (e) { message(e.message, true); button.disabled = false; }
  };
}
async function poll() {
  if (refreshing) return;
  refreshing = true;
  try {
    const previous = current,
      s = await api("status"),
      running = s.jobs.find((j) => j.status === "running");
    showStartup(s);
    current = running?.id ?? null;
    latestJobs = s.jobs;
    const pending = s.jobs.filter((j) =>
        ["queued", "running"].includes(j.status),
      ),
      history = s.jobs.filter((j) => ["done", "error"].includes(j.status));
    const waitingIds = new Set(
      pending.filter((j) => j.status === "queued").map((j) => j.id),
    );
    for (const id of selectedPlans)
      if (!waitingIds.has(id)) selectedPlans.delete(id);
    $("#queue-count").textContent =
      (s.queueRunning ? "运行中" : "已暂停 / 待开始") +
      " · " +
      pending.filter((j) => j.status === "queued").length +
      " 项等待";
    $("#queue-start").disabled = !environmentReady || !s.jobs.some((j) => j.status === "queued");
    $("#queue-pause").disabled = !s.queueRunning;
    $("#queue-clear").disabled = !waitingIds.size;
    $("#queue-history-clear").disabled = !history.length;
    $("#queue-history-count").textContent = `已结束任务（${history.length}）`;
    const nextQueue = JSON.stringify(
      pending.map((j) => [j.id, j.status, j.progress?.stage]),
    );
    const nextHistory = JSON.stringify(history.map((j) => [j.id, j.status]));
    if (nextQueue !== queueView) {
      $("#queue-list").innerHTML =
        pending.map((j, i) => queueRow(j, i + 1)).join("") ||
        '<p class="hint">暂无待运行任务。设置文件后点击“加入队列”。</p>';
      queueView = nextQueue;
    }
    if (nextHistory !== historyView) {
      $("#queue-history-list").innerHTML = history
        .map((j) => queueRow(j))
        .join("");
      historyView = nextHistory;
    }
    renderResultList();
    const completed = s.jobs.find(
      (j) => j.id === autoOpen && !["queued", "running"].includes(j.status),
    );
    if (completed) {
      autoOpen = null;
      if (completed.status === "done")
        render(await api("jobs/" + completed.id + "/report"), false, completed.id);
      if (!running)
        message(
          completed.retentionMessage || completed.message,
          completed.status === "error",
          completed.progress,
          completed.startedAt,
          completed.status,
        );
    }
    const ended = s.jobs.find(
      (j) => j.id === previous && !["queued", "running"].includes(j.status),
    );
    if (autoOpen && !s.jobs.some(j => j.id === autoOpen)) autoOpen = null;
    if (previous && !running && !s.jobs.some(j => j.id === previous)) message("任务已取消并移除", false, null, null, "cancelled");
    if (ended && ended.status === "error")
      $("#queue-history").open = true;
    if (!running && ended)
      message(
        ended.message,
        ended.status === "error",
        ended.progress,
        ended.startedAt,
        ended.status,
      );
    if (running)
      message(
        running.progress?.detail || running.message,
        false,
        running.progress,
        running.startedAt,
        running.status,
      );
    $("#cancel").classList.toggle("hidden", !current);
    busy(!!current || importing);
  } catch (e) {
    message(e.message, true);
  } finally {
    refreshing = false;
  }
}
for (const action of ["start", "pause"])
  $("#queue-" + action).onclick = async () => {
    try {
      await api("queue", { method: "POST", body: JSON.stringify({ action }) });
      await poll();
    } catch (e) {
      message(e.message, true);
    }
  };
setInterval(poll, 1000);
$("#cancel").onclick = async () => {
  try {
    await api("jobs/" + current, { method: "DELETE" });
  } catch (e) {
    message(e.message, true);
  }
};
function switchMode(mode) {
  activeMode = mode;
  report = reports[mode] ?? null;
  charts = viewCharts[mode];
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("selected", t.dataset.mode === mode));
  for (const name of modes) {
    document
      .querySelector("#" + name + "-panel")
      .classList.toggle("hidden", name !== mode);
    document
      .querySelector("#" + name + "-result")
      .classList.toggle("hidden", name !== mode || !reports[name]);
  }
  syncReportSelection();
  updateNav();
}
document
  .querySelectorAll(".tab")
  .forEach((b) => (b.onclick = () => switchMode(b.dataset.mode)));
document.querySelectorAll(".file-picker").forEach(
  (button) =>
    (button.onclick = async () => {
      button.disabled = true;
      const label = button.textContent;
      button.textContent = "正在打开…";
      message(
        "正在打开 Windows 文件选择器；如果没有出现在前台，请查看任务栏。",
      );
      try {
        const result = await api("select-file", { method: "POST", body: "{}" });
        if (result.file) {
          const input = $("#" + button.dataset.target);
          input.value = result.file;
          input.dispatchEvent(new Event("input"));
          message("已选择文件：" + result.file);
          if (button.dataset.target === "file") void readFileInfo();
        } else message("已取消选择文件");
      } catch (e) {
        message(
          e.message === "Failed to fetch"
            ? "本机分析服务未运行，请重新启动 MediaScope"
            : e.message,
          true,
        );
      } finally {
        button.textContent = label;
        button.disabled = false;
      }
    }),
);
let fileInfoTimer, fileInfoController, fileInfoRevision = 0, fileInfoLoading = false;
function updateAnalysisSubmission() {
  const selected = ["frame-analysis", "bitrate-enabled", "complexity"].some(id => $("#" + id).checked);
  $("#enqueue-analyze").disabled = !environmentReady || !infoPath || !hasVideo || fileInfoLoading || !selected;
  $("#inspect").disabled = !environmentReady || fileInfoLoading;
  $("#analysis-selection-hint").textContent = selected
    ? "任务保存当前参数，加入后在下方开始队列。"
    : "请至少选择一个分析目标。";
}
$("#file").oninput = () => {
  clearTimeout(fileInfoTimer);
  ++fileInfoRevision;
  fileInfoController?.abort();
  fileInfoLoading = false;
  infoPath = null;
  hasVideo = false;
  $("#stream").disabled = true;
  $("#stream").innerHTML = '<option value="">选择文件后自动读取</option>';
  $("#file-status").textContent = clean($("#file").value) ? "等待读取文件信息…" : "尚未选择文件。";
  $("#file-status").classList.remove("error");
  $("#inspect").classList.add("hidden");
  updateAnalysisSubmission();
  if (clean($("#file").value)) fileInfoTimer = setTimeout(() => void readFileInfo(), 500);
};
$("#file").onchange = () => void readFileInfo();
$("#file").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); void readFileInfo(); } };
const syncSitiWorkers = () => {
  $("#bitrate-options").classList.toggle("hidden", !$("#bitrate-enabled").checked);
  $("#bitrate-window").disabled = !$("#bitrate-enabled").checked;
  $("#siti-settings").classList.toggle("hidden", !$("#complexity").checked);
  $("#siti-device").disabled = !$("#complexity").checked;
  $("#siti-workers").disabled = !$("#complexity").checked || $("#siti-device").value === "gpu";
  $("#siti-workers-label").classList.toggle("hidden", $("#siti-device").value === "gpu");
  $("#siti-gpu-recheck").disabled = !$("#complexity").checked;
  $("#siti-scenes").disabled = !$("#complexity").checked;
  $("#siti-scene-frames").disabled = !$("#complexity").checked || $("#siti-scenes").value !== "confirmed";
  $("#siti-scene-frames-label").classList.toggle("hidden", $("#siti-scenes").value !== "confirmed");
  $("#siti-scene-hint").textContent = $("#siti-scenes").value === "unconfirmed"
    ? "未确认场景边界，剪辑点可能影响 TI。"
    : $("#siti-scenes").value === "confirmed" ? "请填写全部已确认边界；各场景独立统计，不计算跨场景 TI。" : "场景首帧没有 TI，不纳入 TI 统计。";
  for(const id of ['siti-range','siti-transfer','siti-interlaced','siti-matrix'])$('#'+id).disabled=!$('#complexity').checked;
  const hlg=$('#siti-transfer').value==='hlg';$('#siti-hlg-model').classList.toggle('hidden',!hlg);
  for(const id of ['siti-hlg-white','siti-hlg-black'])$('#'+id).disabled=!$('#complexity').checked||!hlg;
  updateAnalysisSubmission();
};
$('#complexity').onchange=syncSitiWorkers;
$('#frame-analysis').onchange=syncSitiWorkers;
$('#bitrate-enabled').onchange=syncSitiWorkers;
$('#siti-scenes').onchange=syncSitiWorkers;
$('#siti-transfer').onchange=syncSitiWorkers;
function sitiSettingsInput(){
  if(!$('#complexity').checked)return {};
  const range=$('#siti-range').value,transfer=$('#siti-transfer').value,interlaced=$('#siti-interlaced').value,matrix=$('#siti-matrix').value;
  if(range==='auto'&&transfer==='auto'&&interlaced==='reject'&&matrix==='auto')return {};
  const settings={range,transfer,interlaced,matrix};
  if(transfer==='hlg'){
    const fields=['siti-hlg-white','siti-hlg-black'];if(fields.some(id=>!$('#'+id).value.trim()))throw Error('请填写 HLG 显示峰值和黑位');
    settings.hlg={whiteCdM2:Number($('#'+fields[0]).value),blackCdM2:Number($('#'+fields[1]).value)};
  }
  validateSitiSettings(settings);return {sitiSettings:settings};
}
function sitiSceneInput(){
  if(!$("#complexity").checked||$("#siti-scenes").value==='unconfirmed')return {};
  const text=$("#siti-scene-frames").value.trim();
  if($("#siti-scenes").value==='confirmed'&&!/^\d+(?:\s*[,，\s]\s*\d+)*$/.test(text))throw Error('请输入全部已确认的场景起始帧，例如 1, 101, 251');
  const starts=$("#siti-scenes").value==='single'?[0]:text.split(/[,，\s]+/).map(x=>Number(x)-1);
  validateSitiSceneStarts(starts);return {sitiSceneStarts:starts};
}
let sitiGpuCheck,sitiGpuRevision=0;
async function checkSitiGpu(force=false){
  syncSitiWorkers();const revision=++sitiGpuRevision,requested=$("#siti-device").value;
  if(force)sitiGpuCheck=null;
  $("#siti-device-status").textContent = "正在检查 GPU 并执行 SI/TI 数值自检…";
  try {
    const result = await (sitiGpuCheck ??= api("siti-gpu"));
    if(revision!==sitiGpuRevision)return;
    $("#siti-device-status").textContent = result.available
      ? `GPU 可用：${result.device} · 自检通过。${$("#siti-device").value === 'gpu' ? '软件解码，GPU 计算；执行失败时回退 CPU。' : '当前选择 CPU。'}`
      : `GPU 检查未通过：${result.reason}。可重新检查。`;
    if (!result.available) {
      sitiGpuCheck=null;
      if(requested==='gpu'&&$("#siti-device").value==='gpu')$("#siti-device").value = "cpu";
      syncSitiWorkers();
    }
  } catch (e) {
    if(revision!==sitiGpuRevision)return;
    sitiGpuCheck = null;
    $("#siti-device-status").textContent = `GPU 检查失败：${e.message}。运行时重新检查，失败回退 CPU。`;
  } finally {
    $("#siti-gpu-recheck").textContent = "重新检测 GPU";
  }
}
$("#siti-device").onchange=()=>{syncSitiWorkers();++sitiGpuRevision;if($("#siti-device").value==='gpu')void checkSitiGpu();else $("#siti-device-status").textContent="CPU 计算；并行上限会按可用资源自动调整。";};
$("#siti-gpu-recheck").onclick=()=>void checkSitiGpu(true);
function sitiAttemptsHTML(attempts){
  if(!Array.isArray(attempts)||!attempts.length)return '';
  const phases={input:'输入',decode:'解码',validation:'数据校验',cpu:'CPU 执行',gpu:'GPU 执行','gpu-initialization':'GPU 初始化',cancelled:'取消'};
  return `<details><summary>SI/TI 计算尝试与耗时</summary>${table(['设备','耗时','已测帧','结果','失败阶段','原因'],attempts.map(a=>[a.device.toUpperCase(),formatElapsedSeconds(a.elapsedSeconds),a.framesComputed,a.outcome==='passed'?'完成':a.outcome==='cancelled'?'取消':'失败',phases[a.phase]??'',a.reason??'']))}</details>`;
}
syncSitiWorkers();
async function readFileInfo(force = false) {
  clearTimeout(fileInfoTimer);
  const requested = clean($("#file").value);
  if (!requested || !environmentReady || !force && (fileInfoLoading || infoPath === requested)) return;
  fileInfoController?.abort();
  fileInfoController = new AbortController();
  const revision = ++fileInfoRevision;
  fileInfoLoading = true;
  $("#file-status").textContent = "正在读取基本信息和视频轨道…";
  $("#file-status").classList.remove("error");
  updateAnalysisSubmission();
  try {
    const result = await api("probe", {
      method: "POST",
      body: JSON.stringify({ file: requested }),
      signal: fileInfoController.signal,
    });
    if (revision !== fileInfoRevision) return;
    $("#file").value = result.file;
    render(result, false);
    $("#file-status").textContent = hasVideo ? "已读取基本信息，可选择视频轨道与分析目标。" : "已读取基本信息；该文件没有可分析的视频轨道。";
    $("#inspect").classList.add("hidden");
  } catch (e) {
    if (revision !== fileInfoRevision) return;
    infoPath = null;
    hasVideo = false;
    $("#stream").disabled = true;
    $("#file-status").textContent = e.message;
    $("#file-status").classList.add("error");
    $("#inspect").classList.remove("hidden");
  } finally {
    if (revision === fileInfoRevision) {
      fileInfoLoading = false;
      updateAnalysisSubmission();
    }
  }
}
$("#inspect").onclick = () => void readFileInfo(true);
$("#compare").onclick = (event) => {
  const input = {
    type: "compare",
    reference: clean($("#reference").value),
    candidate: clean($("#candidate").value),
    refStream: Number($("#refStream").value),
    candidateStream: Number($("#candidateStream").value),
    comparisonMode: $("#comparison-mode").value,
    timingMode: $("#timing-mode").value,
    metrics: [...document.querySelectorAll("[name=metric]:checked")].map(
      (x) => x.value,
    ),
    confirm: $("#confirm").checked,
  };
  if(input.metrics.includes('vmaf'))input.vmafModel=$('#vmaf-model').value;
  if (input.timingMode === "ordinal-confirmed") {
    if (!$("#timing-confirm").checked) {
      message(
        "请确认两路视频的每个显示帧按顺序一一对应，且没有丢帧、重复帧或重排。",
        true,
      );
      return;
    }
    input.timingConfirmed = true;
  }
  if (input.timingMode === "playback-sample") {
    if (!$("#playback-confirm").checked) {
      message(
        "请确认两路首帧对应同一播放时刻，并接受 CFR 一侧作为采样网格的实验性解释。",
        true,
      );
      return;
    }
    input.playbackConfirmed = true;
  }
  if ($("#chroma-confirm-mode").checked) {
    if (!$("#chroma-confirm").checked) {
      message("请先确认色度位置来自可信来源，并了解结果依赖此假设。", true);
      return;
    }
    input.chromaConfirmed = true;
    input.chromaAssumptions = {};
    for (const [side, id] of [
      ["reference", "#reference-chroma"],
      ["candidate", "#candidate-chroma"],
    ])
      if ($(id).value) input.chromaAssumptions[side] = $(id).value;
  }
  launch({ ...input, enqueue: event?.currentTarget?.id === "enqueue-compare" });
};
$("#enqueue-compare").onclick = $("#compare").onclick;
$("#enqueue-analyze").onclick = () => {
  try{launch({
    type: "analyze",
    enqueue: true,
    file: clean($("#file").value),
    stream:
      infoPath === clean($("#file").value) ? Number($("#stream").value) : null,
    complexity: $("#complexity").checked,
    frameAnalysis: $("#frame-analysis").checked,
    bitrate: $("#bitrate-enabled").checked,
    ...($("#bitrate-enabled").checked ? {bitrateWindowMs: Number($("#bitrate-window").value)} : {}),
    sitiWorkers: $("#siti-workers").value,
    sitiDevice: $("#siti-device").value,
    ...sitiSceneInput(),...sitiSettingsInput(),
  })}catch(e){message(e.message,true)}
};
$("#enqueue-trial").onclick = () => {
  try {
    launch({ ...trialInput(), enqueue: true });
  } catch (e) {
    message(e.message, true);
  }
};
$("#chroma-confirm-mode").onchange = () =>
  $("#chroma-assumption-controls").classList.toggle(
    "hidden",
    !$("#chroma-confirm-mode").checked,
  );
$("#timing-mode").onchange = () => {
  $("#timing-confirm-row").classList.toggle(
    "hidden",
    $("#timing-mode").value !== "ordinal-confirmed",
  );
  $("#playback-confirm-row").classList.toggle(
    "hidden",
    $("#timing-mode").value !== "playback-sample",
  );
};
function trialInput() {
  return {
    type: "trial",
    file: clean($("#trial-file").value),
    stream: Number($("#trial-stream").value),
    start: Number($("#trial-start").value),
    duration: Number($("#trial-duration").value),
    encoder: $("#trial-encoder").value,
    depthMode: $("#trial-depth").value,
    presets: [...document.querySelectorAll("[name=trial-preset]:checked")].map(
      (x) => x.value,
    ),
    cpuUsed: Number($("#trial-cpu").value),
    crfs: parseCrfs($("#trial-crfs").value),
    metrics: $("#trial-vmaf").checked
      ? ["psnr", "ssim", "vmaf"]
      : ["psnr", "ssim"],
    ...($("#trial-vmaf").checked ? {vmafModel:$('#trial-vmaf-model').value} : {}),
    keepFiles: $("#trial-keep").checked,
    ...($("#trial-keep").checked ? {exportDirectory: clean($("#trial-save-directory").value)} : {}),
  };
}
function updateTrialReportContext(saved = reports.trial) {
  const host = document.querySelector("#bd-report-context");
  if (!host || !saved) return;
  const rows = saved.rows.map(row => ({...row, preset: row.preset ?? saved.experiment.preset})),
    groups = [...new Set(rows.map(rowLabel))],
    sameValues = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
  let changed = false;
  if (clean($("#trial-file").value)) {
    try {
      const input = trialInput(),
        presets = input.encoder === 'libaom-av1' ? [`cpu-used=${input.cpuUsed}`] : input.presets;
      changed = input.file !== saved.source.file || input.stream !== saved.stream ||
        input.start !== saved.experiment.start || input.duration !== saved.experiment.duration ||
        input.encoder !== saved.experiment.encoder ||
        (saved.experiment.depthMode != null && input.depthMode !== saved.experiment.depthMode) ||
        !sameValues(presets, rows.map(row => row.preset)) || !sameValues(input.crfs, rows.map(row => row.crf));
    } catch { changed = true; }
  }
  host.innerHTML = `<p class="hint">当前报告：${groups.length} 条曲线，${rows.length} 个采样点。</p>` +
    (changed ? notices(['当前设置与报告不同。请重新运行实验，或打开对应已完成任务的报告。']) : '');
}
function trialControls() {
  const av1 = $("#trial-encoder").value === "libaom-av1",
    both = $("#trial-depth").value === "both";
  $("#trial-presets").classList.toggle("hidden", av1);
  $("#trial-cpu-label").classList.toggle("hidden", !av1);
  try {
    const input = trialInput(),
      p = av1 ? 1 : input.presets.length,
      points = input.crfs.length * p * (both ? 2 : 1);
    $("#trial-count").textContent =
      `${input.crfs.length} 个 CRF × ${p} 个预设 × ${both ? 2 : 1} 种位深 = ${points} 个编码点。${points > 64 ? "超过 64 点上限，请减少选项。" : p < 1 || p > 4 ? "请选择 1–4 个 preset。" : "顺序运行，耗时曲线仅代表本机本次实验。"}`;
  } catch (e) {
    $("#trial-count").textContent = e.message;
  }
  updateTrialReportContext();
}
for (const id of ["trial-file", "trial-stream", "trial-start", "trial-duration", "trial-encoder", "trial-depth", "trial-crfs", "trial-cpu"])
  $("#" + id).addEventListener("input", trialControls);
document
  .querySelectorAll("[name=trial-preset]")
  .forEach((x) => x.addEventListener("change", trialControls));
trialControls();
$("#trial").onclick = () => {
  try {
    launch(trialInput());
  } catch (e) {
    message(e.message, true);
  }
};
function downloadPortable(results, plans) {
  const json = JSON.stringify(makePortable({results,plans,applicationVersion}));
  if (new Blob([json]).size > maxPortableBytes)
    throw Error(`导出文件超过 ${byteLimit(maxPortableBytes)}；请勾选较少的结果，确保文件能够重新导入`);
  download(json, portableFilename(results,plans), "application/json");
}
for (const mode of modes)
  document.querySelector("#" + mode + "-export").onclick = () => {
    const saved = reports[mode];
    if (saved)
      try {
        downloadPortable(
          [{ entryId: "current-report", report: saved }],
          [],
        );
      } catch (e) {
        message(e.message, true);
      }
  };
function syncPortableControls() {
  const hasResults = $("#import-results").checked,
    hasPlans = $("#import-plans").checked;
  for (const id of ["#import-results-mode", "#import-results-mode-label"])
    $(id).classList.toggle("hidden", !hasResults);
  for (const id of [
    "#import-plan-mode",
    "#import-plan-mode-label",
    "#import-start-label",
  ])
    $(id).classList.toggle("hidden", !hasPlans);
}
$("#import-results").onchange = syncPortableControls;
$("#import-plans").onchange = syncPortableControls;
syncPortableControls();
async function portableExport() {
  const resultScope = $("#export-result-scope").value || "all",
    planScope = $("#export-plan-scope").value || "none",
    results = [],
    plans = [];
  if (resultScope === "current") {
    if (!report) throw Error("请先打开一份报告");
    results.push({ entryId: "current-report", report });
  } else if (resultScope !== "none") {
    const chosen = resultItems().filter(
      (item) => resultScope === "all" || selectedResults.has(item.id),
    );
    if (resultScope === "selected" && chosen.length !== selectedResults.size)
      throw Error("勾选的结果已变化，请重新确认导出范围");
    const ids = chosen.filter(item => !item.report).map(item => item.id);
    const hold = ids.length ? await api("local-data/export-hold", {method:"POST",body:JSON.stringify({ids})}) : null;
    try {
      for (const item of chosen)
        results.push({entryId:item.id,report:item.report || (await api("jobs/" + item.id + "/report"))});
    } finally {
      if (hold) await api("local-data/export-release", {method:"POST",body:JSON.stringify({key:hold.key})});
    }
  }
  if (planScope !== "none") {
    const saved = await api("plans"),
      chosen = saved.plans.filter(
        (item) => planScope === "all" || selectedPlans.has(item.entryId),
      );
    if (planScope === "selected" && chosen.length !== selectedPlans.size)
      throw Error("勾选的待运行任务已变化，请重新确认导出范围");
    plans.push(...chosen);
  }
  if (!results.length && !plans.length)
    throw Error("当前选择没有可导出的结果或计划");
  downloadPortable(results, plans);
}
$("#export-portable").onclick = async () => {
  const button = $("#export-portable");
  button.disabled = true;
  try {
    await portableExport();
  } catch (e) {
    message(e.message, true);
  } finally {
    button.disabled = false;
  }
};
$("#import-button").onclick = () => $("#import-report").click();
$("#import-report").onchange = async (e) => {
  const input = e.target,
    f = input.files[0];
  if (!f) return;
  if (current || importing) {
    input.value = "";
    return;
  }
  importing = true;
  busy(true);
  message("正在读取并校验 JSON…");
  try {
    if (f.size > maxPortableBytes)
      throw Error(`JSON 文件超过 ${byteLimit(maxPortableBytes)} 导入上限`);
    const useResults = $("#import-results").checked,
      usePlans = $("#import-plans").checked;
    if (!useResults && !usePlans) throw Error("请至少选择一项导入内容");
    const saved = await f.text();
    if (current) throw Error("分析任务正在运行，请在任务完成后导入");
    const data = parsePortable(saved),
      results = useResults ? data.results : [],
      plans = usePlans ? data.plans : [];
    if (!results.length && !plans.length)
      throw Error("文件中没有所选的可导入内容");
    if (results.length === 1 && !plans.length) {
      const shown = results[0].report,
        previous = reports[modeOf(shown)];
      try {
        render(shown);
      } catch (err) {
        if (previous) render(previous);
        else
          document
            .querySelector("#" + modeOf(shown) + "-result")
            .classList.add("hidden");
        throw Error("报告无法完整显示：" + err.message);
      }
    }
    if (plans.length)
      await api("plans/import", {
        method: "POST",
        body: JSON.stringify({
          plans,
          mode: $("#import-plan-mode").value || "append",
          start: !!$("#import-start").checked,
        }),
      });
    if (results.length) {
      const incoming = results.map((item) => ({
        id: `imported-${Date.now()}-${++importSequence}`,
        report: item.report,
      }));
      if (($("#import-results-mode").value || "append") === "replace") {
        for (const item of importedResults) {selectedResults.delete(item.id);removedReportIds.add(item.id);}
        importedResults = [];
      }
      importedResults.push(...incoming);
      if (results.length === 1 && !plans.length) reportOwners[modeOf(results[0].report)] = incoming[0].id;
      resultView = "";
      renderResultList();
    }
    if (results.length === 1 && !plans.length)
      switchMode(modeOf(results[0].report));
    await poll();
    message(
      `已导入 ${f.name}：${results.length} 份结果、${plans.length} 项计划。结果使用保存的原始数据，不重新计算。`,
    );
  } catch (err) {
    message(err.message, true);
  } finally {
    importing = false;
    busy(!!current);
    input.value = "";
  }
};


function download(text, name, type) {
  const count = type==='application/json'?0:downloadNames.get(name)||0;
  if(type!=='application/json')downloadNames.set(name, count + 1);
  const unique = count
    ? name.replace(/(\.[^.]+)$/, (extension) => `-${count + 1}${extension}`)
    : name;
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = unique;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function cardsHTML(items) {
  return items
    .map(
      ([k, v]) =>
        `<div class="card"><span>${esc(k)}</span><strong>${cellHTML(v)}</strong></div>`,
    )
    .join("");
}
function cards(items) {
  $("#summary").innerHTML = cardsHTML(items);
}
function section(title, html) {
  return `<section class="section"><h3>${esc(title)}</h3>${html}</section>`;
}
function makeSectionsCollapsible(root) {
  for (const panel of root.querySelectorAll('.section')) {
    const existing = panel.querySelector(':scope > .basic-info-body, :scope > .report-section-body');
    if (existing) {
      existing.classList.add('report-section-body');
      for (const node of [...panel.childNodes]) if (node!==existing) existing.append(node);
      continue;
    }
    const heading = panel.querySelector(':scope > h3');
    if (!heading) continue;
    const details = document.createElement('details'), summary = document.createElement('summary');
    details.className = 'report-section-body'; details.open = true;
    summary.append(heading); details.append(summary);
    for (const node of [...panel.childNodes]) {
      details.append(node);
    }
    panel.prepend(details);
  }
}
function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((v) => `<th>${esc(v)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${cellHTML(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function metricStrip(items) {
  return `<dl class="report-metrics">${items.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${cellHTML(value)}</dd></div>`).join('')}</dl>`;
}
function raw(data, title = "展开证据 / 原始数据") {
  return `<details><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(data, null, 2))}</pre></details>`;
}
function notices(items) {
  return (items || []).map((w) => `<p class="notice">${esc(w)}</p>`).join("");
}
function explanation(title, html) {
  return html ? `<details class="analysis-explanation"><summary>${esc(title)}</summary>${html}</details>` : '';
}
const hintNotes = items => items.map(text => `<p class="hint">${esc(text)}</p>`).join('');
function draw(id, data, options) {
  const host = $("#" + id);
  if (host) {
    const p = plot(host, data, options);
    if (p) charts.push(p);
    return p;
  }
}
function render(r, activate = true, owner = null) {
  const mode = modeOf(r);
  renderingMode = mode;
  charts = viewCharts[mode];
  charts.forEach((c) => c.dispose?.());
  charts = [];
  try {
    $("#result-title").textContent =
      r.type === "compare"
        ? "质量对比报告"
        : r.type === "trial"
          ? "片段率失真实验"
          : "媒体分析报告";
    if (r.type === "compare") renderComparison(r);
    else if (r.type === "trial") renderTrial(r);
    else renderMedia(r);
    makeSectionsCollapsible($("#details"));
    reports[mode] = r;
    reportOwners[mode] = owner;
    $("#" + mode + "-result").dataset.reportOwner = owner ?? "";
  } finally {
    viewCharts[mode] = charts;
    renderingMode = null;
    switchMode(activate ? mode : activeMode);
    busy(!!current || importing);
  }
}
function renderMedia(r) {
  const notes = analysisNoticeGroups(r);
  const frameEnabled = r.analysisTargets?.frames !== false,
    bitrateEnabled = r.analysisTargets?.bitrate !== false;
  const displayControl = (curve, id) => curve ? `<div class="bitrate-display-control"><label for="${id}">显示窗口</label><select id="${id}">${curve.windowMs === 100 ? '<option value="100">100 ms</option>' : ''}<option value="1000">1 秒</option></select></div>` : '';
  const streams = r.raw.streams,
    videos = streams.filter((s) => s.codec_type === "video");
  if (!clean($("#file").value) || clean($("#file").value) === r.file) {
    const selectedStream = infoPath === r.file ? $("#stream").value : null;
    infoPath = r.file;
    hasVideo = !!videos.length;
    $("#file").value = r.file;
    $("#stream").innerHTML = videos
      .map(
        (s) =>
          `<option value="${s.index}">${s.index} · ${esc(s.codec_name)} · ${s.width} × ${s.height}</option>`,
      )
      .join("");
    if (videos.some(s => String(s.index) === selectedStream)) $("#stream").value = selectedStream;
    else if (r.stream !== undefined) $("#stream").value = r.stream;
    if (!hasVideo) $("#stream").innerHTML = '<option value="">没有视频轨道</option>';
    $("#stream").disabled = !hasVideo;
    $("#file-status").textContent = hasVideo ? "已读取基本信息，可选择视频轨道与分析目标。" : "该文件没有可分析的视频轨道。";
    $("#file-status").classList.remove("error");
  }
  if (!$("#trial-file").value) {
    $("#trial-file").value = r.file;
    $("#trial-stream").value = r.stream ?? videos[0]?.index ?? 0;
  }
  cards([]);
  let html = basicInfoHTML(r, {readingNotes: notes.metadata});
  if (r.type === "analyze" || r.frames) {
    if (r.frames && frameEnabled) {
    const gops = r.coding?.gops || legacyGops(r.frames);
    html += section(
      "帧结构与 GOP",
      metricStrip([
        ['显示帧数',r.frames.length],['视频包数据量',size(r.packets.bytes)],
        ['GOP / 关键帧区间',gops.length],['非递增时间戳',r.summary.nonIncreasing],
      ]) + `<div id="gop-overview"></div><div class="pager"><button id="gop-prev" class="secondary">上一 GOP</button><label>GOP #<input id="gop-index" type="number" min="0" max="${gops.length - 1}" value="0"></label><button id="gop-next" class="secondary">下一 GOP</button><span id="gop-info"></span></div><div id="frame-plot"><label>坐标<select id="frame-axis" aria-label="帧大小图 X 轴坐标"><option value="time">呈现时间（s）</option><option value="frame">显示帧序号</option></select></label></div><p class="notice hidden" id="frame-axis-warning"></p><div id="frame-detail" class="frame-detail"></div>` +
      explanation('GOP 与帧大小的读取说明', '<p class="hint">显示顺序视图。I / P / B 是预测类型；IDR / CRA / BLA 是码流访问类型，二者不混用。GOP 以随机访问/关键帧区间呈现，不据此猜测开放或闭合。</p><p class="hint" id="frame-axis-note"></p>' + hintNotes(notes.frames)) +
      '<details><summary>逐帧列表 / CSV</summary><div class="pager"><button id="prev" class="secondary">上一页</button><span id="page"></span><button id="next" class="secondary">下一页</button><button id="csv" class="secondary">导出帧 CSV</button></div><div id="frames"></div></details>',
    );
    }
    if (r.content?.available) {
      const sceneNotes=notes.sitiWarnings.filter(text=>text===unconfirmedSceneNote);
      if(r.content.execution?.gpuFallbackReason){sitiGpuCheck=null;$("#siti-device-status").textContent='该任务 GPU 执行失败，实际使用 CPU；可重新检查 GPU。';}
      const e = r.content.execution,
        execution = e
          ? `<p class="hint">SI/TI 计算设备：${e.device === "gpu" ? `GPU · ${esc(e.gpuName)} · ${esc(e.backend)}；软件解码${e.preprocessingDevice==='gpu'?'；GPU 前处理与指标':''}；数值自检通过` : `CPU · ${e.mode === "frame-parallel" ? `${e.workers} 路帧级并行` : "串行"}；设置 ${e.setting === "auto" ? `自动（请求上限 ${e.requestedWorkers} 路）` : `上限 ${e.requestedWorkers} 路`}`}${e.gpuFallbackReason ? `；GPU 已回退 CPU：${esc(e.gpuFallbackReason)}` : ""}${e.fallbackReason ? `；已回退：${esc(e.fallbackReason)}` : ""}。</p>${sitiAttemptsHTML(e.attempts)}`
          : "";
      html += section(
        "SI/TI 内容复杂度",
        (sceneNotes.length?'<p class="hint" id="siti-scene-note">场景边界未确认，TI 可能含剪辑点影响。</p>':'') +
          notices(notes.sitiWarnings.filter(text=>text!==unconfirmedSceneNote)) + notices([e?.gpuFallbackReason ? `GPU 已回退 CPU：${e.gpuFallbackReason}` : null,e?.fallbackReason ? `执行方式已回退：${e.fallbackReason}` : null].filter(Boolean)) +
          (e?.configuration?`<p class="hint">计算口径：${e.configuration.configurationVersion===8?`siti-tools 0.6.0 · PQ 域 · 固定尺度 ${esc(e.configuration.outputMultiplier)}`:`历史计算口径，保留原值（版本 ${esc(e.configuration.configurationVersion)}）`}。</p>`:'') +
          (r.content.scenes?.length>1?table(
            ["场景", "显示帧（从 1 计）", "SI 均值", "SI P95", "SI 最大值", "TI 均值", "TI P95", "TI 最大值"],
            r.content.scenes.map(s=>[s.index+1,`${s.startFrame+1}–${s.endFrame+1}`,fmt(s.si.mean),fmt(s.si.p95),fmt(s.si.max),fmt(s.ti?.mean),fmt(s.ti?.p95),fmt(s.ti?.max)]),
          ):"") +
          [["SI", r.content.si], ["TI", r.content.ti]].map(([metric, stats]) => `<div class="siti-chart-heading"><h4>${metric}</h4>${r.content.scenes?.length > 1 ? "" : `<dl>${[["均值", stats?.mean], ["P95", stats?.p95], ["最大值", stats?.max]].map(([name, value]) => `<div><dt>${name}</dt><dd>${fmt(value)}</dd></div>`).join("")}</dl>`}</div><div id="${metric.toLowerCase()}"></div>`).join("") +
          explanation('计算方法与限制', execution +
            (e?.configuration?`<p class="hint">计算流程：${esc(e.configuration.profile)}。输入 ${esc(e.configuration.input?.source?.pixelFormat??'')} · ${esc(e.configuration.inputDomain??'SDR')} · ${e.configuration.inputBitDepth}-bit · ${e.configuration.inputRange==='tv'?'有限范围':'全范围'}。</p>`:'') +
            (e?.configuration?.display?`<p class="hint">参考显示模型：峰值 ${fmt(e.configuration.display.whiteCdM2)}、黑位 ${fmt(e.configuration.display.blackCdM2,4)} cd/m²；gamma ${fmt(e.configuration.display.gamma,6)}。</p>`:'') + hintNotes([...sceneNotes,...notes.siti])),
      );
    } else if (r.content) html += notices([r.content.reason])+sitiAttemptsHTML(r.content.attempts);
    if (r.coding?.codec === "av1")
      html += section(
        "AV1 编码帧 / 显示事件",
        `<p>新编码帧 ${r.coding.counts.encoded} · 隐藏帧 ${r.coding.counts.hidden} · SHOW_EXISTING ${r.coding.counts.showExisting} · 显示事件 ${r.coding.counts.shown}</p><p class="hint">按码流编码顺序列出所有帧头事件，包含 KEY / INTER / INTRA_ONLY / SWITCH、隐藏帧和 SHOW_EXISTING。H=隐藏、S=显示已有帧、V=新帧直接显示。点击色带查看结构字段、刷新掩码与参考槽。OBU 负载字节不一定等于完整图像大小。</p><div id="av1-plot"></div><label>编码事件 #<input id="av1-index" type="number" min="0" max="${r.coding.events.length - 1}" value="0"></label><div id="av1-detail"></div>${raw(r.coding.sequences, "AV1 序列头（去重）")}`,
      );
    const audio = (r.tracks || []).filter((t) => t.type === "audio");
    if (audio.length && frameEnabled) html += `<section class="section"><details class="report-section-body" id="audio-packets-optional"><summary><h3>音轨包大小时间分布</h3></summary>${audio.map(audioPacketHTML).join("")}</details></section>`;
    if (r.packets) {
    const bitrateWarnings = bitrateEnabled ? [r.packets, ...audio].flatMap(t => {
      const track = t === r.packets ? `视频 #${r.stream}` : `音轨 #${t.index}`;
      return [...(t.bitrateCurve?.status === 'unavailable' ? t.bitrateCurve.reasons.map(reason => `${track} 窗口码率不可计算：${reason}`) : []),
        ...(t.missing ? [`${track}：缺少时间戳 ${t.missing} 包。`] : [])];
    }) : [];
    let bitrateHTML = `<h4>${r.packets.bitrateCurve ? "视频包负载码率（PTS 归属）" : "视频码率 · 1 秒窗口（旧报告）"}</h4>${displayControl(r.packets.bitrateCurve, "bitrate-display")}${r.packets.bitrateCurve ? `<p class="hint">计算窗口 ${r.packets.bitrateCurve.windowMs} ms。</p>` : ""}<div id="bitrate"></div>`;
    if (audio.length)
      bitrateHTML += audio
          .map(
            (t) =>
              `<h4>音轨 #${t.index} · ${esc(t.codec)} · 窗口码率</h4>${displayControl(t.bitrateCurve, `audio-${t.index}-display`)}<div id="audio-${t.index}"></div>`,
          )
          .join("");
    html += section("音视频码率统计", table(["轨道", "全程平均（原有独立口径）"], [[`视频 #${r.stream}`, rate(r.packets.averageMbps)], ...audio.map(t => [`音轨 #${t.index} · ${t.codec}`, t.averageMbps == null ? "不可计算" : rate(t.averageMbps)])]) + notices(bitrateWarnings) + (bitrateEnabled ? `<details id="bitrate-optional"><summary>展开音视频窗口码率曲线</summary>${bitrateHTML}</details>` : '<p class="hint">本次未选择区间码率曲线。</p>') + explanation('码率统计说明', hintNotes(notes.bitrate) + (bitrateEnabled && r.packets.bitrateCurve ? '<p class="hint">整包按起始 PTS 归属，跨窗口包不拆分，首尾使用实际时长；恒定 PCM 也可能波动，短尾窗口偏差可能更大。曲线不代表采样码率或传输瞬时码率。放大不改变统计窗口。</p>' : '')));
    }
    if (r.tracks)
      html += section(
        "体积构成",
        table(
          ["轨道", "压缩包数据量", "占文件比例", "包数"],
          r.tracks
            .map((t) => [
              `#${t.index} ${t.type} / ${t.codec}`,
              size(t.bytes),
              `${fmt((t.bytes / r.size) * 100)}%`,
              t.count,
            ])
            .concat([["容器及未归属差额", size(r.overheadBytes), "—", "—"]]),
        ) +
          '<p class="hint">差额按文件大小减去所有轨道包大小计算；特殊容器的重复引用可能使其为负，不等同于精确 box 大小。PCM 多音轨的体积不能算作视频可压缩空间。</p>',
      );
    html += notices(notes.warnings);
  }
  $("#details").innerHTML = html;
  initBasicInfo($("#details"), r);
  if (r.type === "analyze" || r.frames) {
    if (r.frames && frameEnabled) {
      if (r.frames.length) initFrames(r);
      else $("#gop-overview").textContent = "报告中没有显示帧";
    }
    if (frameEnabled) initAudioPackets(r);
    const bitratePlots = new Map();
    for (const [id, t] of bitrateEnabled && r.packets ? [["bitrate", r.packets], ...(r.tracks || []).filter(t => t.type === "audio").map(t => ["audio-" + t.index, t])] : []) {
      const control = $("#" + (id === "bitrate" ? "bitrate-display" : id + "-display"));
      const drawBitrate = () => {
        const windowMs = Number(control?.value ?? 1000);
        const data = t.bitrateCurve ? bitrateView(t.bitrateCurve, windowMs).map(b => [b.start, b.mbps * 1e6, b]) : t.bins.map(b => [b.second, b.mbps * 1e6, {...b, start: b.second, end: b.second + 1}]);
        const scale = quantityScale(data.map(p => p[1]), 'bit/s');
        const previous = bitratePlots.get(id);
        previous?.dispose?.();
        if (previous) { const i = charts.indexOf(previous); if (i >= 0) charts.splice(i, 1); }
        bitratePlots.set(id, draw(id, scalePlotData(data, {y: scale}), {unit: scale.unit, yKey:'bitrate', yFactor:scale.divisor, intervals: true, describe: p => [
          {label:'测量区间（s）',value:`[${quantityNumber(p[2].start, 6)}, ${quantityNumber(p[2].end, 6)})`,width:27},
          {label:`包负载码率（${scale.unit}）`,value:p[1],bounds:'y',digits:3},
          ...(p[2].bytes == null ? [] : [{label:'包负载（B）',value:p[2].bytes,text:String(p[2].bytes),digits:0,width:20}]),
        ]}));
        if (t.bitrateCurve?.status === "unavailable") $("#" + id).textContent = "不可计算";
      };
      drawBitrate();
      if (control) control.onchange = drawBitrate;
    }
    if (r.content?.available) {
      draw(
        "si",
        r.content.points.map((p) => [p.t, p.si]),
        { unit: "SI" },
      );
      draw(
        "ti",
        r.content.points.map((p) => [p.t, p.ti]),
        { unit: "TI" },
      );
    }
  }
}
function legacyGops(frames) {
  const starts = frames
    .map((f, i) => (i === 0 || f.key ? i : null))
    .filter((x) => x !== null);
  return starts.map((start, i) => ({
    index: i,
    start,
    end: (starts[i + 1] ?? frames.length) - 1,
    count: (starts[i + 1] ?? frames.length) - start,
    label: frames[start].key ? "KEY_FLAG" : "前置片段",
  }));
}
function audioPacketHTML(track) {
  const d = track.packetDistribution, id = `audio-packets-${track.index}`;
  const title = `<h4>音轨 #${track.index} · ${esc(track.codec)}</h4>`;
  if (!d) return title + '<p class="hint">此旧报告未保存音轨逐包数据，无法从窗口码率还原；原有码率仍可展开查看。</p>';
  if (d.status !== 'ok') return title + `<p class="hint">${esc(d.reason)}</p>`;
  return title + `<p class="hint">${d.count.toLocaleString()} 个解复用包；按包起始 PTS 展示负载大小，不按持续时间摊分。包大小也受分包时长影响。单位按整条音轨选择；密集时同一像素列保留最大高度，放大或查看列表可逐包核对。</p><p class="hint" id="${id}-status"></p><div id="${id}"></div><div id="${id}-detail" class="frame-detail"></div><details><summary>音轨 #${track.index} 逐包列表 / CSV</summary><div class="pager"><button id="${id}-prev" class="secondary">上一页</button><span id="${id}-page"></span><button id="${id}-next" class="secondary">下一页</button><button id="${id}-csv" class="secondary">导出音轨包 CSV</button></div><div id="${id}-list"></div></details>`;
}
function initAudioPackets(r) {
  for (const track of (r.tracks || []).filter(t => t.type === 'audio' && t.packetDistribution?.status === 'ok')) {
    const d = track.packetDistribution, id = `audio-packets-${track.index}`, points = audioPacketPoints(d),
      scale = quantityScale(d.packets.map(row => row[3]));
    const seconds = ticks => packetSeconds(ticks, d.timeBase);
    const fields = (row, index) => [index, seconds(row[0]) == null ? '未报告' : `${quantityNumber(seconds(row[0]), 6)} s`, seconds(row[1]) == null ? '未报告' : `${quantityNumber(seconds(row[1]), 6)} s`, seconds(row[2]) > 0 ? `${quantityNumber(seconds(row[2]), 6)} s` : '未知或非正', size(row[3]), row[0] ?? '未报告', row[1] ?? '未报告', row[2] ?? '未报告'];
    const headers = ['包序号', '呈现时间', '解码时间', '持续时间', '包大小', '原始 PTS', '原始 DTS', '原始 duration'];
    const missing = d.count - points.length;
    $(`#${id}-status`).textContent = `时间基 ${d.timeBase ?? '未报告'}；${missing ? `${missing} 个包缺少有效 PTS 或时间基，仅在逐包列表中保留，不回退 DTS。` : '全部包都有可定位的呈现时间。'}`;
    draw(id, scalePlotData(points, {y: scale}), {unit: `包大小（${scale.unit}）`, axis: '呈现时间 s', stems: true,
      describe: p => [
        {label:'呈现时间（s）',value:p[0],bounds:'x'},
        {label:'包序号',value:p[2].index,digits:0,width:10},
        {label:`包大小（${scale.unit}）`,value:p[1],bounds:'y',digits:3,title:byteEvidence(p[2].row[3])},
      ],
      onPick: p => {$(`#${id}-detail`).innerHTML = table(headers, [fields(p[2].row, p[2].index)]);}
    });
    if (d.packets.length) $(`#${id}-detail`).innerHTML = table(headers, [fields(d.packets[0], 0)]);
    let page = 0;
    const drawPage = () => {
      $(`#${id}-page`).textContent = `${page + 1} / ${Math.max(1, Math.ceil(d.count / 100))}`;
      $(`#${id}-prev`).disabled = page === 0;
      $(`#${id}-next`).disabled = (page + 1) * 100 >= d.count;
      $(`#${id}-list`).innerHTML = table(headers, d.packets.slice(page * 100, page * 100 + 100).map((row, i) => fields(row, page * 100 + i)));
    };
    $(`#${id}-prev`).onclick = () => {page--;drawPage();};
    $(`#${id}-next`).onclick = () => {page++;drawPage();};
    $(`#${id}-csv`).onclick = () => download('packet,pts_tick,dts_tick,duration_tick,size_bytes,time_base,pts_s,dts_s,duration_s\n' + d.packets.map((row, i) => [i, ...row, d.timeBase, ...row.slice(0, 3).map(seconds)].join(',')).join('\n'), `audio-${track.index}-packets.csv`, 'text/csv');
    drawPage();
  }
}
function initFrames(r) {
  const gops = r.coding?.gops || legacyGops(r.frames),
    frameScale = quantityScale(r.frames.map(f => f.bytes)),
    fdata = r.frames.map((f, i) => [i, f.bytes == null ? null : f.bytes / frameScale.divisor, f, i]),
    tdata = frameTimePoints(r.frames).map(p => [p[0], p[1] == null ? null : p[1] / frameScale.divisor, p[2], p[3]]),
    timeBounds = frameTimeRange(r.frames),
    gopTimeBounds = gops.map(g => frameTimeRange(r.frames, g.start, g.end));
  const detail = (p) => {
    const f = p[2],
      packet = r.coding?.packets?.[f.packetIndex];
    $("#frame-detail").innerHTML =
      table(
        ["显示帧", "时间", "预测类型", "访问类型", "关键帧标记", "包体积"],
        [
          [
            p[3],
            `${fmt(f.t, 6)} s`,
            f.type,
            f.special ?? "旧版未解析",
            f.key ? "是" : "否",
            size(f.bytes),
          ],
        ],
      ) + raw(packet ?? f, "码流包 / 单帧证据");
  };
  let ribbon, selected = null;
  const axisPicker = $("#frame-axis");
  const drawFrames = () => {
    if (ribbon) {ribbon.dispose?.();const index = charts.indexOf(ribbon);if (index >= 0) charts.splice(index, 1);}
    const time = axisPicker.value === 'time', g = selected===null?null:gops[selected],
      range = time ? g ? frameTimeRange(r.frames,g.start,g.end) : timeBounds : g ? [g.start, g.end + 1] : [0, r.frames.length];
    $("#frame-axis-note").textContent = time ? `显示帧关联包大小；时间取解码器报告／推定的显示时间，不按帧率估算。每帧一根竖线，密集时同一像素列保留最大高度；包与帧不保证一一对应。${tdata.length < r.frames.length ? ` ${r.frames.length - tdata.length} 帧缺少有效时间，仅在帧序号视图中保留。` : ''}` : '沿用显示帧序号与解码器报告的关联包大小；不据此重复相加估算轨道体积。';
    const missingTime = time && tdata.length < r.frames.length;
    $('#frame-axis-warning').textContent = missingTime ? `${r.frames.length - tdata.length} 帧缺少有效时间，仅在帧序号视图中保留。` : '';
    $('#frame-axis-warning').classList.toggle('hidden', !missingTime);
    ribbon = draw("frame-plot", time ? tdata : fdata, {
      unit: `关联包大小（${frameScale.unit}）`, axis: time ? '呈现时间 s' : '显示帧', frames: !time, stems: time,
      xEnd: time ? timeBounds?.[1] : undefined, initial: range ?? undefined,
      xControl: axisPicker.closest('label'),
      onRangeChange: ({from,to,full}) => {
        selected=null;
        const visible = full ? null : gops.filter((g,i) => {
          const bounds = time ? gopTimeBounds[i] : [g.start,g.end+1];
          return bounds && bounds[0] < to && bounds[1] > from;
        }).map(g => g.index);
        syncScope(full?'全片':'自定义范围',visible);
      },
      onPick: detail,
      describe: p => [
        ...(time ? [
          {label:'呈现时间（s）',value:p[0],bounds:'x'},
          {label:'显示帧',value:p[3],digits:0,width:10},
        ] : [
          {label:'显示帧',value:p[3],digits:0,width:10},
          {label:'呈现时间（s）',value:p[2].t,text:String(fmt(p[2].t,6)),bounds:timeBounds??[]},
        ]),
        {label:'预测类型',value:p[2].type,width:10},
        {label:'访问类型',value:p[2].special ?? '未解析',width:18},
        {label:`关联包大小（${frameScale.unit}）`,value:p[1],bounds:'y',digits:3,title:byteEvidence(p[2].bytes),width:18},
      ],
    });
  };
  const overview = gopOverview($("#gop-overview"), gops, r.frames.length, (i) =>
    select(i),
  );
  charts.push(overview);
  const syncScope = (scope, visible = null) => {
    const g=selected===null?null:gops[selected];
    $("#gop-index").value = g?selected:'';
    $("#gop-index").placeholder = '—';
    $("#gop-info").textContent =
      g?`${g.label} · 帧 ${g.start}–${g.end} · ${g.count} 帧${g.boundary ? " · " + g.boundary : ""}`:`主图：${scope}`;
    $("#gop-prev").disabled = selected===null || selected === 0;
    $("#gop-next").disabled = !gops.length || selected === gops.length - 1;
    overview.select(selected,visible);
  };
  const select = (i) => {
    if(!gops.length)return;
    selected = Math.max(0, Math.min(gops.length - 1, Math.round(i) || 0));
    const g=gops[selected];
    syncScope();drawFrames();
    detail(fdata[g.start]);
  };
  $("#gop-prev").onclick = () => select(selected - 1);
  $("#gop-next").onclick = () => select(selected===null?0:selected + 1);
  $("#gop-index").onchange = (e) => {
    if(e.target.value!=='')return select(Number(e.target.value));
    selected=null;syncScope('全片');
    const range=axisPicker.value==='time'?timeBounds:[0,r.frames.length];
    if(range)ribbon?.setRange(...range);
  };
  syncScope('全片');detail(fdata[0]);
  drawFrames();
  axisPicker.onchange = () => {if(selected===null)syncScope('全片');drawFrames();};
  let page = 0;
  const drawPage = () => {
    $("#page").textContent =
      `${page + 1} / ${Math.ceil(r.frames.length / 100)}`;
    $("#prev").disabled = page === 0;
    $("#next").disabled = (page + 1) * 100 >= r.frames.length;
    $("#frames").innerHTML = table(
      ["帧", "时间 s", "预测类型", "码流访问类型", "关键帧", "包体积"],
      r.frames
        .slice(page * 100, page * 100 + 100)
        .map((f, i) => [
          page * 100 + i,
          f.t,
          f.type,
          f.special ?? "未解析",
          f.key ? "是" : "否",
          size(f.bytes),
        ]),
    );
  };
  $("#prev").onclick = () => {
    page--;
    drawPage();
  };
  $("#next").onclick = () => {
    page++;
    drawPage();
  };
  $("#csv").onclick = () =>
    download(
      "frame,time_s,prediction,access_type,key,packet_bytes,duration_s\n" +
        r.frames
          .map((f, i) =>
            [
              i,
              f.t,
              f.type,
              f.special ?? "",
              f.key ? 1 : 0,
              f.bytes,
              f.duration,
            ].join(","),
          )
          .join("\n"),
      "frames.csv",
      "text/csv",
    );
  drawPage();
  if (r.coding?.codec === "av1") {
    const events = r.coding.events,
      eventScale = quantityScale(events.map(e => e.obuPayloadBytes));
    const eventDetail = (p) => {
      const e = events[p[0]];
      $("#av1-index").value = e.id;
      $("#av1-detail").innerHTML =
        table(
          [
            "事件 / 编码包",
            "类型 / 可见性",
            "显示帧",
            "Order hint",
            "刷新掩码",
            "引用槽 → 编码事件",
          ],
          [
            [
              `${e.id} / ${e.packet}`,
              `${e.kind} / ${e.hidden ? "隐藏" : "显示"}`,
              e.displayIndex ?? "不直接输出",
              e.orderHint,
              e.refreshFlags == null
                ? "未报告"
                : "0x" + e.refreshFlags.toString(16),
              e.showExisting
                ? `显示槽 ${e.showSlot} → 事件 ${e.sourceEvent ?? "未知"}`
                : (e.referenceSlots || [])
                    .map((s, i) => `${s}→${e.referenceEvents?.[i] ?? "未知"}`)
                    .join(", "),
            ],
          ],
        ) + raw(e, "结构相关帧头字段与引用证据");
    };
    draw(
      "av1-plot",
      events.map((e) => [
        e.id,
        e.obuPayloadBytes == null ? null : e.obuPayloadBytes / eventScale.divisor,
        {
          type: e.hidden ? "H" : e.showExisting ? "S" : "V",
          special: e.kind,
          key: e.kind === "KEY",
        },
      ]),
      {
        unit: `OBU 负载体积（${eventScale.unit}）`,
        axis: "编码事件",
        frames: true,
        initial: [0, Math.min(60, Math.max(1, events.length))],
        onPick: eventDetail,
        describe: (p) => {
          const e = events[p[0]];
          return [
            {label:'编码事件',value:e.id,digits:0,width:10},
            {label:'包序号',value:e.packet,digits:0,width:10},
            {label:'访问类型',value:e.kind,width:20},
            {label:'显示状态',value:e.hidden ? '隐藏' : '显示',width:10},
            {label:'order_hint',value:e.orderHint ?? '未知',digits:0,width:14},
            {label:`OBU 负载（${eventScale.unit}）`,value:p[1],bounds:'y',digits:3,title:byteEvidence(e.obuPayloadBytes)},
          ];
        },
      },
    );
    if (events.length) eventDetail([0]);
    $("#av1-index").onchange = (e) =>
      eventDetail([
        Math.max(
          0,
          Math.min(events.length - 1, Math.round(Number(e.target.value)) || 0),
        ),
      ]);
  }
}
function renderComparison(r) {
  cards([
    ["参考文件", size(r.reference.size)],
    ["候选文件", size(r.candidate.size)],
    ["总文件体积比", `${fmt(r.sizeRatio * 100)}%`],
    [
      r.alignment.pairing === "playback-sample" ? "采样时刻" : "匹配显示帧",
      r.alignment.frames,
    ],
  ]);
  let html =
    `<p class="path">参考：${esc(r.reference.file)}<br>候选：${esc(r.candidate.file)}</p>` +
    notices([r.alignment.note]);
  if (r.alignment.pairing === "ordinal-confirmed")
    html += section(
      "帧序配对与时间轴差异",
      table(
        [
          "配对方式",
          "首次超过 0.1 ms 的帧",
          "最大相对时间差",
          "末帧持续时间差",
        ],
        [
          [
            "解码显示帧序号",
            r.alignment.firstTimestampMismatchFrame ?? "未超过",
            `${fmt(r.alignment.maxRelativeDifferenceSeconds * 1000, 3)} ms`,
            r.alignment.lastDurationDifferenceSeconds == null
              ? "未报告"
              : `${fmt(r.alignment.lastDurationDifferenceSeconds * 1000, 3)} ms`,
          ],
        ],
      ) +
        notices([
          "时间轴差异已记录；指标按对应帧计算，不代表两路播放时间完全一致。",
        ]),
    );
  if (r.alignment.pairing === "playback-sample") {
    const a = r.alignment,
      modern = !!a.gridSide;
    html += section(
      "VFR ↔ CFR 播放采样 · 实验性",
      table(
        [
          "CFR 网格所在视频 / 帧率",
          "采样视频帧 / 网格帧",
          "CFR 最大偏差 / 容差",
          "采样重复 / 未采样帧（估计）",
        ],
        [
          [
            `${modern ? (a.gridSide === "reference" ? "参考" : "候选") : "候选"} / ${modern ? a.gridRate : a.candidateRate} (${fmt(modern ? a.gridRateHz : a.candidateRateHz, 3)} fps)`,
            `${fmt(modern ? a.sampledFrames : a.sourceFrames)} / ${fmt(a.frames)}`,
            `${fmt((modern ? a.maxGridErrorSeconds : a.maxCandidateGridErrorSeconds) * 1000, 4)} / ${fmt(a.cfrToleranceSeconds * 1000, 4)} ms`,
            `${fmt(a.estimatedRepeatedSamples)} / ${fmt(modern ? a.estimatedUnrepresentedSampledFrames : a.estimatedUnrepresentedSourceFrames)}`,
          ],
        ],
      ) +
        notices([
          a.sampling,
          a.note,
          "两路首帧对应同一播放时刻由用户确认。指标只覆盖 CFR 网格的采样时刻；完整的估计帧索引映射保存在导出的 JSON 中。",
        ]),
    );
  }
  if (r.chromaAssumptions?.length)
    html += section(
      "用户确认的色度位置",
      table(
        ["视频", "文件报告值", "本次采用值", "证据性质"],
        r.chromaAssumptions.map((x) => [
          x.side === "reference" ? "参考" : "候选",
          x.declared ?? "未报告",
          x.assumed,
          x.source,
        ]),
      ) + notices(["该位置由用户指定，软件未验证其真实性；指标依赖此假设。"]),
    );
  if (r.profile)
    html += section(
      "比较域与格式",
      table(
        ["像素格式", "位深 / 采样", "信号", "原色 / 传递 / 矩阵 / 范围"],
        [
          [
            r.profile.pixelFormat,
            `${r.profile.bitDepth}-bit / ${r.profile.subsampling}`,
            r.profile.signal,
            `${r.profile.primaries} / ${r.profile.transfer} / ${r.profile.matrix} / ${r.profile.range}`,
          ],
        ],
      ) + notices([r.profile.domain]),
    );
  if (r.normalization?.crossDepth)
    html += section(
      "跨位深码值映射",
      table(
        ["参考原格式", "候选原格式", "比较格式", "映射 / PSNR 峰值"],
        [
          [
            r.normalization.sourceFormats.reference,
            r.normalization.sourceFormats.candidate,
            r.normalization.targetFormat,
            `${r.normalization.mapping} / ${r.normalization.psnrPeak}`,
          ],
        ],
      ) +
        notices([
          r.normalization.basis,
          r.normalization.verification?.passed
            ? "本机全码值映射校验通过（Y / Cb / Cr，0–255）"
            : "未报告映射验证",
        ]) +
        raw(r.normalization),
    );
  if (r.skippedMetrics)
    html += notices(
      Object.entries(r.skippedMetrics).map(
        ([k, v]) => `${k.toUpperCase()} 未计算：${v}`,
      ),
    );
  for (const [key, m] of Object.entries(r.metrics))
    if (m.components)
      html += section(
        `${key.toUpperCase()} 分量`,
        table(
          Object.keys(m.components).map(k=>({y:r.profile?.colorModel==='GRAY'?'Y 灰度':'Y 亮度',u:'U 色度',v:'V 色度',r:'R 红',g:'G 绿',b:'B 蓝',a:'A 透明度'})[k]??k.toUpperCase()),
          [Object.values(m.components).map(v=>fmt(v,m.officialSummary?6:5))],
        ),
      );
  if (r.videoSize)
    html += section(
      "仅视频数据量",
      table(
        ["参考视频包", "候选视频包", "候选 / 参考"],
        [
          [
            size(r.videoSize.reference),
            size(r.videoSize.candidate),
            `${fmt((r.videoSize.candidate / r.videoSize.reference) * 100)}%`,
          ],
        ],
      ) +
        '<p class="hint">此比例排除了音轨与容器体积，便于评价视频编码的实际节省。</p>',
    );
  for (const [key, m] of Object.entries(r.metrics))
    html += section(
      key.toUpperCase(),
      table(
        ["整体值", "P05", "最低帧", "统计方式"],
        [
          [
            fmt(m.pooled, key!=='vmaf'&&m.officialSummary?6:5),
            fmt(m.p05, 5),
            fmt(m.min, 5),
            key === "psnr"
              ? "MSE 域汇总 / dB"
              : key === "vmaf"
                ? m.model
                : "逐帧均值",
          ],
        ],
      ) +
        (key==='vmaf'?vmafDetails(m):'') +
        `<div id="metric-${key}"></div>` +
        (m.worst
          ? "<h4>最低质量的 1 秒区间（相对参考起点）</h4>" +
            table(
              ["起点 / 秒", "帧范围", "区间整体值", "最低帧值"],
              m.worst.map((w) => [
                w.start,
                `${w.first}–${w.last}`,
                fmt(w.value, 5),
                fmt(w.min, 5),
              ]),
            )
          : "") +
        '<p class="hint">最低区间用于定位复查，不自动判定画面不可接受。末尾区间可能不足 1 秒。</p>',
    );
  const alignmentEvidence = { ...r.alignment };
  delete alignmentEvidence.estimatedSourceFrameIndices;
  delete alignmentEvidence.estimatedSampledFrameIndices;
  html +=
    notices(r.warnings) +
    section(
      "复现记录",
      raw({
        tools: r.tools,
        commands: r.commands,
        alignment: alignmentEvidence,
      }),
    );
  $("#details").innerHTML = html;
  for (const [k, m] of Object.entries(r.metrics))
    draw(
      "metric-" + k,
      m.values.map((v, i) => [i, v === "Infinity" ? null : v]),
      { unit: metricLabels[k], axis: "显示帧序号（从 0 开始）" },
    );
}
function vmafDetails(m) {
  const c=m.configuration;
  return c?table(['官方模型','输入','汇总 / 采样','libvmaf 版本'],[[c.model.version,`${c.input.width}×${c.input.height} · ${c.input.pixelFormat} · ${c.input.range==='pc'?'Full':c.input.range==='tv'?'Limited':'范围未声明'}`,`${c.pool} / 每 ${c.nSubsample} 帧`,c.libraryVersion]])+
    notices([c.interpretation,'VMAF 评价亮度；不衡量色度损失。整体值采用 libvmaf 官方汇总；P05 和最低 1 秒区间是本软件的定位统计。'])+
    '<details><summary>VMAF 参数与输入记录</summary>'+raw(c)+'</details>':'';
}
function renderTrial(r) {
  cards([
    ["片段起点", `${r.experiment.start} s`],
    ["请求片段长度", `${r.experiment.duration} s`],
    ["实际显示帧", r.experiment.actualFrames],
    ["编码器", r.experiment.encoder],
  ]);
  const rows = r.rows.map((x) => ({
      ...x,
      preset: x.preset ?? r.experiment.preset,
    })),
    groups = [...new Set(rows.map(rowLabel))],
    metrics = ["psnr", "ssim", "vmaf"].filter((m) =>
      rows.some((x) => x.metrics[m]),
    );
  const byteScale = quantityScale(rows.map(x => x.videoBytes)),
    bitScale = quantityScale(rows.map(x => x.videoMbps == null ? null : x.videoMbps * 1e6), 'bit/s'),
    scales = {videoBytes: byteScale, videoMbps: {...bitScale, divisor: bitScale.divisor / 1e6}};
  let html =
    `<p class="path">${esc(r.source.file)}</p>` +
    notices([
      r.experiment.comparisonDomain ?? "原生位深参考",
      ...Object.values(r.skippedMetrics ?? {}),
    ]);
  if(rows[0]?.metrics.vmaf)html+=section('VMAF 模型与适用条件',vmafDetails(rows[0].metrics.vmaf));
  if (r.experiment.preparation?.baseline)
    html += section(
      "编码前的位深转换基准",
      notices([r.experiment.preparation.mapping]) +
        table(
          ["PSNR / dB", "SSIM", "含义"],
          [
            [
              fmt(r.experiment.preparation.baseline.psnr.pooled, r.experiment.preparation.baseline.psnr.officialSummary?6:5),
              fmt(r.experiment.preparation.baseline.ssim.pooled, 6),
              "两种无损输入在统一 10-bit 域的差异；尚未试编码，不与成片分数相减。",
            ],
          ],
        ),
    );
  html += section(
    "实验采样点",
    `<details id="trial-samples" ${rows.length <= 12 ? "open" : ""}><summary>查看 ${rows.length} 个实测点</summary><div class="sample-sort"><label>排序参数<select id="sample-sort-key">${Object.entries(
      trialSortFields,
    )
      .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
      .join(
        "",
      )}</select></label><label>顺序<select id="sample-sort-direction"><option value="asc">升序</option><option value="desc">降序</option></select></label></div><div id="trial-sample-table"></div></details>`,
  );
  html += section(
    "CRF 参数扫描 · 固定每条曲线的位深与 preset",
    '<div class="trial-chart-grid"><div><h4>① CRF 与质量：PSNR（越高越好）</h4><div id="trial-psnr"></div></div><div><h4>② CRF 与编码耗时（越低越快）</h4><div id="trial-time"></div></div><div><h4>③ CRF 与视频码率（数据开销）</h4><div id="trial-rate"></div></div><div><h4>④ CRF 与质量：SSIM（越高越好）</h4><div id="trial-ssim"></div></div></div><p class="hint">每个圆点是一个 CRF 实测结果，每条线固定一个位深 / preset；连线仅辅助读图，不是拟合或插值预测。横轴 CRF 是编码器参数，无量纲；同 CRF 不保证同质量或码率。耗时仅为本机单次测量，无误差条，不宜据微小差异排名。</p>',
  );
  html += section(
    "码率—质量与编码成本",
    `<div id="rd"><label>指标<select id="rd-axis" aria-label="码率质量图 X 轴指标"><option value="videoMbps">视频平均码率（${bitScale.unit}）</option><option value="videoBytes">视频包体积（${byteScale.unit}）</option><option value="encodeSeconds">编码耗时（s）</option><option value="encodeFps">编码速度（frame/s）</option></select></label><label>指标<select id="rd-metric" aria-label="码率质量图 Y 轴指标">${metrics.map((m) => `<option value="${m}">${esc(metricLabels[m])}</option>`).join("")}</select></label></div><p class="hint">码率—质量图：同等质量时越靠左越省码率，同等码率时越高越好；需比较同一参考片段及指标域。成本图仅显示散点：相同质量下比较编码时间或速度。体积与码率仅计视频包。PSNR 为 MSE 域汇总，SSIM / VMAF 为逐帧均值。</p>`,
  );
  html += section(
    "BD-rate · 同等质量下的平均码率差",
    `<div id="bd-report-context" aria-live="polite"></div><div class="two"><label>基准曲线<select id="bd-anchor">${groups.map((g, i) => `<option value="${i}">${esc(g)}</option>`).join("")}</select></label><label>对比曲线<select id="bd-test">${groups.map((g, i) => `<option value="${i}">${esc(g)}</option>`).join("")}</select></label></div><label>计算模式<select id="bd-profile"><option value="reference">参考测量 · PSNR-Y 帧均值 / PCHIP</option><option value="exploratory">探索比较 · 原报告指标</option></select></label><label>质量指标<select id="bd-metric">${Object.keys(metricLabels).map(m => `<option value="${m}">${esc(metricLabels[m])}${m === 'ssim' ? ' · dB' : ''}</option>`).join("")}</select></label><div id="bd-result" aria-live="polite"></div><div id="bd-plot"></div><p id="bd-plot-note" class="hint"></p><button id="bd-export" disabled>导出当前 BD-rate 与完整复算依据（JSON）</button><p class="hint">负值表示对比方案省码率，正值表示增加。结果仅代表共同质量区间。</p>`,
  );
  html += section(
    "逐帧质量叠加 · 固定位深与 preset，对比 CRF",
    `<div class="plot-controls"><label>固定对比组<select id="trial-group">${groups.map((g, i) => `<option value="${i}">${esc(g)}</option>`).join("")}</select></label></div><div id="trial-crf-select" class="checks"></div><p id="trial-frame-note" class="hint"></p><div id="trial-frames"><label>指标<select id="trial-frame-metric" aria-label="逐帧质量图 Y 轴指标">${metrics.map((m) => `<option value="${m}">${esc(metricLabels[m])}</option>`).join("")}</select></label></div>`,
  );
  html +=
    notices(r.warnings) +
    section(
      "实验文件与复现记录",
      `<p class="hint">${r.experiment.retainedFiles.length ? "已保留实验文件：" + esc(r.experiment.retainedFiles.join("；")) : "实验视频已自动清理；报告保留数据与运行参数。"}</p>` +
        raw({ experiment: r.experiment, tools: r.tools, commands: r.commands }),
    );
  $("#details").innerHTML = html;
  const labels = {
    ...metricLabels,
    videoBytes: `视频包体积（${byteScale.unit}）`,
    videoMbps: `视频平均码率（${bitScale.unit}）`,
    encodeSeconds: "编码耗时（s）↓",
    encodeFps: "编码速度（frame/s）↑",
    crf: "CRF（无量纲）",
  };
  let bdPlot;
  const updateBdRate = () => {
    const result = trialBdRate(rows, groups[Number($("#bd-anchor").value)],
      groups[Number($("#bd-test").value)], $("#bd-metric").value, $("#bd-profile").value);
    bdPlot?.dispose();$("#bd-plot").innerHTML="";$("#bd-plot-note").textContent="";
    if(result.ok && result.points) {
      const data=[...result.points.anchor.map(p=>[p.rate,p.quality,p,0]),...result.points.test.map(p=>[p.rate,p.quality,p,1])].sort((a,b)=>a[0]-b[0]);
      bdPlot=draw("bd-plot",data,{connect:true,axis:"基本码流码率（kbit/s）",unit:result.qualityDomain,
        series:[{id:0,name:result.anchor,color:"#80e1c4"},{id:1,name:result.test,color:"#76a9ed"}],
        describe:p=>[
          {label:'对比组',value:p[3]===0?result.anchor:result.test,width:24},
          {label:'CRF',value:p[2].crf,digits:0,width:8},
          {label:'基本码流码率（kbit/s）',value:p[0],bounds:'x',text:String(fmt(p[0],6)),width:24},
          {label:'PSNR-Y（dB）',value:p[1],bounds:'y',digits:8,text:String(fmt(p[1],8)),width:20},
        ]});
      $("#bd-plot-note").textContent="此图使用本次 BD-rate 的基本码流码率与 PSNR-Y 帧均值。采样点连线辅助审阅，计算采用 PCHIP 积分；请检查共同区间、曲线交叉与采样分布。";
    }
    $("#bd-export").disabled = !result.ok;
    $("#bd-result").innerHTML = result.ok
      ? table(["BD-rate（对比组相对基准组）", "共同质量区间", "区间覆盖：基准 / 对比", "采样点：基准 / 对比"], [[
          `${result.percent > 0 ? '+' : ''}${fmt(result.percent, 3)} %`,
          `${fmt(result.qualityRange[0], 6)} – ${fmt(result.qualityRange[1], 6)} · ${result.qualityDomain}`,
          result.coverage.map(v => fmt(v * 100, 1) + ' %').join(' / '),
          result.pointCounts.join(' / '),
        ]]) + notices(result.warnings) + (result.reference ? `<p class="hint">依据：<a href="${result.reference.url}" target="_blank" rel="noopener">ITU-T HSTP-VID-WPOM §7.2–7.4</a>；${esc(result.reference.numericalReference)}。${esc(result.rateDomain)}。</p>` + raw({measurement:result.measurement,components:result.componentMeans},"BD-rate 测量依据与 Y/U/V 均值") : notices(["探索模式使用原报告汇总指标，不声明符合参考 PSNR-Y 测量口径。"]))
      : notices(['BD-rate 不可计算：' + result.reason]);
  };
  $("#bd-test").value = groups.length > 1 ? '1' : '0';
  const savedBd = r.bdRateComparisons?.[0];
  if (savedBd) {
    $("#bd-profile").value = savedBd.profile;
    $("#bd-metric").value = savedBd.metric;
    $("#bd-anchor").value = String(groups.indexOf(savedBd.anchor));
    $("#bd-test").value = String(groups.indexOf(savedBd.test));
  }
  for (const id of ['#bd-anchor', '#bd-test', '#bd-metric', '#bd-profile']) $(id).onchange = updateBdRate;
  $("#bd-export").onclick = () => {
    try {
      const anchor=groups[Number($("#bd-anchor").value)], test=groups[Number($("#bd-test").value)],
        metric=$("#bd-metric").value, profile=$("#bd-profile").value,
        result=trialBdRate(rows,anchor,test,metric,profile);
      if (!result.ok) throw Error(result.reason);
      downloadPortable([{entryId:"bd-rate",report:{...r,bdRateComparisons:[{anchor,test,metric,profile,result}]}}],[]);
    } catch(e) {message(e.message,true);}
  };
  updateBdRate();
  const drawSamples = () => {
    $("#trial-sample-table").innerHTML = table(
      [
        "位深 / preset",
        "CRF",
        "视频包体积",
        "视频码率",
        "PSNR / dB",
        "SSIM / 无量纲",
        "VMAF / 模型分数",
        "编码耗时 s / 速度 frame/s",
      ],
      sortTrialRows(
        rows,
        $("#sample-sort-key").value,
        $("#sample-sort-direction").value,
      ).map((x) => [
        rowLabel(x),
        x.crf,
        size(x.videoBytes),
        rate(x.videoMbps),
        fmt(x.metrics.psnr?.pooled,x.metrics.psnr?.officialSummary?6:3),
        fmt(x.metrics.ssim?.pooled, 6),
        fmt(x.metrics.vmaf?.pooled),
        `${fmt(x.encodeSeconds)} / ${fmt(x.encodeFps)}`,
      ]),
    );
  };
  const seriesPlot = (id, x, y, controls = {}) => {
    const { data, series } = trialPlotData(rows, x, y);
    return draw(id, scalePlotData(data, {x: scales[x], y: scales[y]}), {
      ...controls,
      series,
      connect: !["encodeSeconds", "encodeFps"].includes(x),
      unit: labels[y],
      axis: labels[x],
      describe: (p) => [
        {label:'对比组',value:rowLabel(p[2]),width:24},
        {label:labels[x],value:p[0],bounds:'x',text:quantityNumber(p[0],6),width:20},
        ...(x==='crf'?[]:[{label:'CRF',value:p[2].crf,digits:0,width:8}]),
        {label:labels[y],value:p[2].metrics[y]?.pooled ?? p[1],bounds:'y',text:String(["psnr", "ssim", "vmaf"].includes(y) ? fmt(p[2].metrics[y]?.pooled,6) : quantityNumber(p[1],6)),width:20},
        ...(x==='videoBytes' || y==='videoBytes'?[]:[{label:'视频包体积',value:formatBytes(p[2].videoBytes),title:byteEvidence(p[2].videoBytes)}]),
        ...(x==='videoMbps' || y==='videoMbps'?[]:[{label:'视频包码率',value:String(rate(p[2].videoMbps))}]),
      ],
    });
  };
  seriesPlot("trial-psnr", "crf", "psnr");
  seriesPlot("trial-time", "crf", "encodeSeconds");
  seriesPlot("trial-rate", "crf", "videoMbps");
  seriesPlot("trial-ssim", "crf", "ssim");
  const rdAxis = $("#rd-axis"), rdMetric = $("#rd-metric"), frameMetric = $("#trial-frame-metric");
  let rd, framePlot;
  const update = () => {
    rd?.dispose();
    rd = seriesPlot("rd", rdAxis.value, rdMetric.value, {
      xControl: rdAxis.closest('label'), yControl: rdMetric.closest('label'),
    });
  };
  let selectedCrfs = [];
  const updateFrames = () => {
    framePlot?.dispose();
    const group = groups[Number($("#trial-group").value) || 0],
      metric = frameMetric.value || metrics[0];
    const result = trialFramePlotData(
      rows,
      metric,
      group,
      selectedCrfs,
      r.experiment.frameTimes,
    );
    $("#trial-frame-note").textContent =
      (result.timed
        ? "横轴：相对片段首帧的时间（s），使用保存的参考帧时间戳。"
        : "横轴：片段显示帧序号（从 0 开始）；报告未保存可用时间戳，不估算秒数。") +
      " 同一参考片段、位深与 preset；仅改变 CRF。悬停可并列读取各曲线；无限值和缺失值留空，不跨空缺连线。" +
      (result.missing.length
        ? " 未保存逐帧数据的 CRF：" + result.missing.join("、")
        : "");
    framePlot = draw("trial-frames", result.data, {
      yControl: frameMetric.closest('label'),
      emptyMessage: selectedCrfs.length ? "该报告未保存所选指标的逐帧数据。" : "请至少选择一个 CRF。",
      series: result.series,
      markers: false,
      height: 440,
      axis: result.timed
        ? "相对片段首帧时间（s）"
        : "片段显示帧序号（从 0 开始）",
      unit: labels[metric],
      describe: (p) => [
        ...(result.timed?[{label:'片段时间（s）',value:p[0],bounds:'x'}]:[]),
        {label:'显示帧',value:p[2].frame,digits:0,width:10},
        {label:'CRF',value:p[2].crf,digits:0,width:8},
        {label:labels[metric],value:p[2].value,bounds:'y',text:String(p[2].value==='Infinity'?'∞':p[2].value==null?'缺失':fmt(p[2].value,6)),width:20},
      ],
    });
  };
  const updateGroup = () => {
    selectedCrfs = rows
      .filter(
        (row) => rowLabel(row) === groups[Number($("#trial-group").value) || 0],
      )
      .map((row) => row.crf)
      .sort((a, b) => a - b);
    $("#trial-crf-select").innerHTML = selectedCrfs
      .map(
        (crf) =>
          '<label><input type="checkbox" name="plot-crf" value="' +
          crf +
          '" checked>CRF ' +
          crf +
          "</label>",
      )
      .join("");
    document.querySelectorAll("[name=plot-crf]").forEach(
      (box) =>
        (box.onchange = () => {
          selectedCrfs = [
            ...document.querySelectorAll("[name=plot-crf]:checked"),
          ].map((x) => Number(x.value));
          updateFrames();
        }),
    );
    updateFrames();
  };
  $("#sample-sort-key").onchange = drawSamples;
  $("#sample-sort-direction").onchange = drawSamples;
  $("#rd-axis").onchange = update;
  $("#rd-metric").onchange = update;
  $("#trial-group").onchange = updateGroup;
  $("#trial-frame-metric").onchange = updateFrames;
  drawSamples();
  update();
  updateGroup();
  updateTrialReportContext(r);
}
api("status")
  .then((s) => {
    showStartup(s);
    poll();
  })
  .catch((e) => message(e.message, true));

// 1. Dynamic Floating Nav
nav = document.createElement("aside");
nav.className = "floating-nav";
document.body.appendChild(nav);

function updateNav() {
  if (!nav) return;
  const items = document.createDocumentFragment();
  const visiblePanels = Array.from(
    document.querySelectorAll(
      ".panel:not(.hidden), #inspect-result:not(.hidden), #compare-result:not(.hidden), #trial-result:not(.hidden)",
    ),
  );

  let hasItems = false;
  visiblePanels.forEach((panel) => {
    const titleEls = panel.querySelectorAll("h2, h3");
    titleEls.forEach((titleEl, index) => {
      if (!titleEl.id) {
        titleEl.id = panel.id + "-heading-" + index;
      }
      const a = document.createElement("a");
      a.href = "#" + titleEl.id;
      a.className = "nav-dot";
      a.addEventListener('click',()=>{
        const details=titleEl.closest('.report-section-body');
        if (details) details.open=true;
      });
      const label = document.createElement("span");
      label.textContent = titleEl.textContent;
      a.appendChild(label);
      items.appendChild(a);
      hasItems = true;
    });
  });
  nav.replaceChildren(items);
  nav.style.display = hasItems ? "flex" : "none";
}

updateNav();

// switchMode runs after synchronous and asynchronous report rendering and import.

function syncTaskBrief() {
  const task = document.getElementById("task"),
    brief = document.getElementById("island-brief-text"),
    queueCount = document.getElementById("queue-count"),
    compactCount = document.getElementById("island-q-count");
  if (queueCount && compactCount)
    compactCount.textContent = queueCount.textContent || "0";
  if (!task || !brief) return;
  if (task.classList.contains("hidden")) {
    brief.textContent = "当前无任务";
    return;
  }
  const label = document.getElementById("task-label"),
    phase = document.getElementById("task-phase");
  brief.textContent = [
    label?.textContent,
    phase && !phase.classList.contains("hidden") ? phase.textContent : "",
  ].filter(Boolean).join(" ") || "运行中...";
}

// 2. 任务队列（通栏 / 紧凑悬浮视图）
const taskEl = document.getElementById("task");
if (taskEl) {
  taskEl.removeAttribute("onclick"); // Clean old attribute

  const header = document.createElement("div");
  header.className = "island-header";
  header.innerHTML = `
          <div class="island-brief">
            <div class="pulse-dot"></div>
            <span id="island-brief-text">当前无任务</span>
          </div>
          <div class="island-queue">排队: <span id="island-q-count">0</span></div>
          <div class="island-progress-track"><div id="island-progress-bar"></div></div>
        `;
  // Toggle expansion
  header.onclick = () => {
    if (taskEl.classList.contains("island")) {
      taskEl.classList.toggle("expanded");
    }
  };
  taskEl.insertBefore(header, taskEl.firstChild);

  const toggleBtn = document.getElementById("toggle-island");
  if (toggleBtn) {
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      if (taskEl.classList.contains("task-banner")) {
        taskEl.classList.remove("task-banner");
        taskEl.classList.add("island");
        toggleBtn.innerHTML =
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
        toggleBtn.title = "还原为顶部视图";
      } else {
        taskEl.classList.remove("island");
        taskEl.classList.remove("expanded");
        taskEl.classList.add("task-banner");
        toggleBtn.innerHTML =
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
        toggleBtn.title = "切换到紧凑视图";
      }
      taskEl.classList.remove('tucked');
      taskEl.style.removeProperty('left');
      taskEl.style.removeProperty('top');
      taskEl.style.removeProperty('right');
      taskEl.style.removeProperty('bottom');
      taskEl.style.removeProperty('position');
      taskEl.style.removeProperty('margin');
      taskEl.style.removeProperty('transition');
    };
  }

  let isDragging = false;
  let startX, startY, initialLeft, initialTop;
  let snapEnabled = true;
  let hasDragged = false;

  const snapBtn = document.getElementById("toggle-snap");
  if (snapBtn) {
    snapBtn.onclick = (e) => {
      e.stopPropagation();
      snapEnabled = !snapEnabled;
      snapBtn.classList.toggle("active", snapEnabled);
      if (snapEnabled && !isDragging) {
         snapToEdge();
      }
    };
  }

  function snapToEdge() {
    if (!snapEnabled) return;

    const rect = taskEl.getBoundingClientRect();
    const vWidth = document.documentElement.clientWidth;
    const vHeight = document.documentElement.clientHeight;
    const centerX = rect.left + rect.width / 2;

    let targetLeft;
    let targetTop = rect.top;
    const edgeMargin = 20; // Keep a small margin from the edge

    // Only snap left or right
    if (centerX < vWidth / 2) {
      targetLeft = edgeMargin;
    } else {
      targetLeft = vWidth - rect.width - edgeMargin;
    }

    // Keep vertical position within viewport
    targetTop = Math.max(edgeMargin, Math.min(targetTop, vHeight - rect.height - edgeMargin));

    taskEl.style.position = 'fixed';
    taskEl.style.setProperty('right', 'auto', 'important');
    taskEl.style.setProperty('bottom', 'auto', 'important');
    taskEl.style.margin = '0';
    taskEl.style.transition = 'left 0.3s ease, top 0.3s ease';
    
    // Slide to the target position
    taskEl.style.setProperty('left', targetLeft + 'px', 'important');
    taskEl.style.setProperty('top', targetTop + 'px', 'important');
    
    setTimeout(() => { taskEl.style.transition = ''; }, 300);
  }

  taskEl.onmousedown = (e) => {
    if (e.button !== 0) return;
    const target = e.target;
    if (target.closest('button') || target.closest('input') || target.closest('select')) return;

    startX = e.clientX;
    startY = e.clientY;
    isDragging = false;
    hasDragged = false;
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  function onMouseMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!isDragging) {
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        isDragging = true;
        hasDragged = true;
        const rect = taskEl.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        taskEl.style.position = 'fixed';
        taskEl.style.setProperty('left', initialLeft + 'px', 'important');
        taskEl.style.setProperty('top', initialTop + 'px', 'important');
        taskEl.style.setProperty('right', 'auto', 'important');
        taskEl.style.setProperty('bottom', 'auto', 'important');
        taskEl.style.margin = '0';
        taskEl.style.transition = 'none';
      } else {
        return;
      }
    }

    taskEl.style.setProperty('left', (initialLeft + dx) + 'px', 'important');
    taskEl.style.setProperty('top', (initialTop + dy) + 'px', 'important');
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    
    if (hasDragged && snapEnabled) {
      setTimeout(snapToEdge, 50);
    }
    isDragging = false;
    hasDragged = false;
  }

  syncTaskBrief();
  setInterval(syncTaskBrief, 300);
}

const themeToggleBtn = document.getElementById("theme-toggle");
if (themeToggleBtn) {
  const states = ["system", "light", "dark"];
  const icons = {
    system: document.getElementById("theme-icon-system"),
    light: document.getElementById("theme-icon-light"),
    dark: document.getElementById("theme-icon-dark")
  };
  
  let currentTheme = document.documentElement.getAttribute("data-theme") || "system";
  
  function applyTheme() {
    if (currentTheme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", currentTheme);
    }
    
    for (const [key, icon] of Object.entries(icons)) {
      if (icon) icon.style.display = key === currentTheme ? "block" : "none";
    }
  }
  
  applyTheme();
  
  themeToggleBtn.onclick = () => {
    const idx = states.indexOf(currentTheme);
    currentTheme = states[(idx + 1) % states.length];
    applyTheme();
    api("local-data/settings", {method:"POST",body:JSON.stringify({theme:currentTheme})}).catch(e=>message(e.message,true));
  };
}

$("#trial-keep").onchange = () => $("#trial-save-row").classList.toggle("hidden", !$("#trial-keep").checked);
$("#trial-save-picker").onclick = async () => {
  const button=$("#trial-save-picker");button.disabled=true;
  try {const value=await api("select-directory",{method:"POST",body:"{}"});if(value.directory)$("#trial-save-directory").value=value.directory}
  catch(e){message(e.message,true)}finally{button.disabled=false}
};
async function refreshLocalData(){
  const value=await api("local-data");
  $("#local-data-usage").textContent=`本次结果 ${value.count} 项；临时工作文件 ${formatBytes(value.workBytes)}；浏览器缓存 ${formatBytes(value.profileBytes)}。${value.warnings.join('；')}`;
  $("#local-data-usage").title=`临时工作文件 ${byteEvidence(value.workBytes)}；浏览器缓存 ${byteEvidence(value.profileBytes)}`;
}
$("#local-data-panel").ontoggle=()=>{if($("#local-data-panel").open)refreshLocalData().catch(e=>message(e.message,true))};
$("#local-data-refresh").onclick=()=>refreshLocalData().catch(e=>message(e.message,true));
for(const [id,category]of [["#local-data-clear","records"],["#local-cache-clear","cache"]])$(id).onclick=async()=>{
  if(category==='records'&&!confirm('清空本次结果？未导出的结果将无法恢复。'))return;
  const button=$(id);button.disabled=true;
  const ids=category==='records'?[...latestJobs.filter(job=>['done','error'].includes(job.status)).map(job=>job.id),...importedResults.map(item=>item.id)]:[];
  try{
    const value=await api("local-data/clean",{method:"POST",body:JSON.stringify({category})});
    if(category==='records'){ids.forEach(id=>removedReportIds.add(id));importedResults=[];renderResultList()}
    await poll();await refreshLocalData();message(value.message);
  }
  catch(e){message(e.message,true)}finally{button.disabled=false}
};
