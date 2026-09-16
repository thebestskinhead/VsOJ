import * as vscode from 'vscode';
import { StatusRecord, STATUS_CLASS_MAP } from '../types';
import { StatusQueryResult, StatusAjaxRow } from '../api/submit';
import { LoginRequiredError } from '../session/access';
import { OfflineNoCacheError } from '../cache/store';
import { escapeHtml, numToLetter } from '../utils/format';

/**
 * 【提交结果】
 *
 * 取代早先「把站点 status.php 的 HTML 原样塞进 webview + 注入一段链接代理脚本」的做法：
 * 那种页面长得和编辑器里其他页面完全不同（站点自己的 Bootstrap 绿主题、
 * 顶部整条导航栏），而且**刷新只能整页重载**。
 *
 * 两条硬要求（用户明确提的）：
 *
 * 1. **样式与插件其他页面一致、固定亮色** —— 与题目页 / 本地测试结果页同一套配色约定
 *    （白底深字、绿红琥珀灰四种状态色、无 emoji、无蓝紫，并显式声明亮色配色方案）。
 * 2. **自动刷新提交状态，但不刷新页面** —— 照搬站点自己的做法
 *    （`template/bs3/auto_refresh.js`）：待判定的那一条去查 `status-ajax.php`，
 *    **只改表里那几格**；没出结果就按 80ms 起步、逐次翻倍继续问。
 *
 * 页面因此是本项目里**唯一开了脚本的页面**（`enableScripts: true`）：整页重载式的
 * 「刷新」做不到「就地更新」，而就地更新必须有人在客户端改 DOM。代价是注入数据
 * 一律先 `escapeHtml`（站点来的结果名、编译器原文都属不可信内容）。
 *
 * 结构上仍分两层：纯函数（模型 / 渲染 / 轮询队列）可单测，`StatusWebview` 只是薄壳。
 */

// ─────────────────────────────────────────────────────────────
// 结果语义（纯函数）
// ─────────────────────────────────────────────────────────────

/** 站点判定的「还没出结果」区间：0 等待 / 1 等待重判 / 2 编译中 / 3 运行并评判 */
export const STATUS_PENDING_MAX = 4;

export function isPending(code: number): boolean {
  return Number.isFinite(code) && code >= 0 && code < STATUS_PENDING_MAX;
}

/**
 * 结果标签的配色类别。
 *
 * 对齐站点 `judge_color`，但把 `label-info`（蓝）与 `gray` 一起归到 `wait` / `muted`
 * —— 亮色约定里不用蓝紫。
 */
export type StatusTone = 'pass' | 'fail' | 'warn' | 'wait' | 'muted';

export function toneOf(code: number): StatusTone {
  if (code === 4) { return 'pass'; }                 // 正确
  if (code === 5 || code === 6) { return 'fail'; }   // 格式错误 / 答案错误
  if (code >= 7 && code <= 11) { return 'warn'; }    // TLE / MLE / OLE / RE / CE
  if (isPending(code)) { return 'wait'; }            // 等待 / 编译中 / 运行并评判
  return 'muted';                                    // 编译成功 / 运行完成 / 未知
}

/** 详情页选型，与站点状态页「结果」列上的链接一致 */
export type DetailKind = 'ceinfo' | 'reinfo';

export function detailKindOf(code: number): DetailKind | null {
  if (code === 11) { return 'ceinfo'; }          // 编译错误 → 编译器原文
  if (code >= 4 && code <= 10) { return 'reinfo'; } // 已出结果 → 期望 / 你的输出对照
  return null;
}

export function resultNameOf(code: number): string {
  const info = STATUS_CLASS_MAP[code];
  return info ? info.name : `未知结果(${code})`;
}

// ─────────────────────────────────────────────────────────────
// 页面模型（纯函数）
// ─────────────────────────────────────────────────────────────

export interface StatusRowView {
  submitId: number;
  /** 题号字母（A/B/C…） */
  problemId: string;
  probName: string;
  resultCode: number;
  resultName: string;
  short: string;
  tone: StatusTone;
  memory: number;
  time: number;
  language: string;
  codeLen: string;
  submitTime: string;
  detail: DetailKind | null;
  /** 还没出结果 —— 会进轮询队列 */
  pending: boolean;
  /** 落在「只看本题」的范围内 */
  match: boolean;
}

export interface StatusSummary {
  total: number;
  ac: number;
  wa: number;
  ce: number;
  tle: number;
  re: number;
  pending: number;
}

export interface StatusPageModel {
  cid: string;
  userId: string;
  /** 当前题目字母；空串 = 不做「只看本题」过滤 */
  filterPid: string;
  fromCache: boolean;
  loadedAt: string;
  pollIntervalMs: number;
  records: StatusRowView[];
  summary: StatusSummary;
}

export interface BuildStatusContext {
  cid: string;
  userId: string;
  /** 当前题目字母（数字 pid 由调用方转换）；缺省不过滤 */
  filterPid?: string;
  fromCache?: boolean;
  loadedAt?: string;
  pollIntervalMs?: number;
}

export function summarize(rows: StatusRowView[]): StatusSummary {
  const s: StatusSummary = { total: rows.length, ac: 0, wa: 0, ce: 0, tle: 0, re: 0, pending: 0 };
  for (const r of rows) {
    if (r.pending) { s.pending += 1; }
    if (r.resultCode === 4) { s.ac += 1; }
    else if (r.resultCode === 6) { s.wa += 1; }
    else if (r.resultCode === 11) { s.ce += 1; }
    else if (r.resultCode === 7) { s.tle += 1; }
    else if (r.resultCode === 10) { s.re += 1; }
  }
  return s;
}

/** `StatusRecord[]`（解析层） → 页面行模型 */
export function toRowView(r: StatusRecord, filterPid: string): StatusRowView {
  return {
    submitId: r.submitId,
    problemId: r.problemId,
    probName: r.probName,
    resultCode: r.resultCode,
    resultName: resultNameOf(r.resultCode),
    short: (STATUS_CLASS_MAP[r.resultCode] || { short: '?' }).short,
    tone: toneOf(r.resultCode),
    memory: r.memory,
    time: r.time,
    language: r.language,
    codeLen: r.codeLen,
    submitTime: r.submitTime,
    detail: detailKindOf(r.resultCode),
    pending: isPending(r.resultCode),
    match: !filterPid || r.problemId === filterPid,
  };
}

export function buildStatusModel(records: StatusRecord[], ctx: BuildStatusContext): StatusPageModel {
  const filterPid = ctx.filterPid ?? '';
  const rows = records.map(r => toRowView(r, filterPid));
  return {
    cid: ctx.cid,
    userId: ctx.userId,
    filterPid,
    fromCache: !!ctx.fromCache,
    loadedAt: ctx.loadedAt ?? new Date().toLocaleString(),
    pollIntervalMs: ctx.pollIntervalMs ?? 800,
    records: rows,
    summary: summarize(rows),
  };
}

/**
 * 待轮询队列。
 *
 * **顺序照搬站点 `auto_refresh()`**：它在表格里自下而上扫，取第一条没出结果的。
 * 这里 `records` 是新的在前（与站点表格一致），所以也是自下而上收集。
 */
export function pendingQueue(m: Pick<StatusPageModel, 'records' | 'filterPid'>): StatusRowView[] {
  const scoped = m.filterPid ? m.records.filter(r => r.match) : m.records;
  const out: StatusRowView[] = [];
  for (let i = scoped.length - 1; i >= 0; i--) {
    if (scoped[i].pending) { out.push(scoped[i]); }
  }
  return out;
}

/** 队列里第一条还没被放弃的提交；都放弃完则 null */
export function nextPendingRow(
  m: Pick<StatusPageModel, 'records' | 'filterPid'>,
  givenUp: ReadonlySet<number> = new Set(),
): StatusRowView | null {
  for (const r of pendingQueue(m)) {
    if (!givenUp.has(r.submitId)) { return r; }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 单行渲染（列表首屏与轮询更新共用同一套文案）
// ─────────────────────────────────────────────────────────────

export interface RowUpdate {
  submitId: number;
  resultCode: number;
  pending: boolean;
  memory: number;
  time: number;
  /** 已经转义好的「结果」格 HTML */
  labelHtml: string;
  /** 鼠标悬停提示（判题机 / 判题中） */
  title: string;
}

/**
 * 一条提交的最新状态 → 页面要改的那几格。
 *
 * 首屏渲染与 `status-ajax` 轮询回来后的更新**都走这里**：两处各写一套文案，
 * 迟早会出现「刚打开写着『正确』、刷新一下变成『答案正确』」这种错位。
 */
export function rowUpdatePayload(submitId: number, r: Pick<StatusAjaxRow, 'resultCode' | 'memory' | 'time' | 'judger'>): RowUpdate {
  const code = r.resultCode;
  const pending = isPending(code);
  const tone = toneOf(code);
  const detail = detailKindOf(code);
  const spin = pending ? '<span class="spin"></span>' : '';
  const label = `<span class="label ${tone}">${escapeHtml(resultNameOf(code))}</span>${spin}`;
  // 已出结果且站点有详情页 → 结果标签可点
  const labelHtml = detail && !pending
    ? `<span class="link" data-act="detail" data-sid="${submitId}" data-code="${code}" title="查看判题详情">${label}</span>`
    : label;
  const title = [
    r.judger ? `判题机 ${r.judger}` : '',
    pending ? '判题中……' : '',
  ].filter(Boolean).join(' · ');
  return {
    submitId,
    resultCode: code,
    pending,
    memory: r.memory,
    time: r.time,
    labelHtml,
    title,
  };
}

// ─────────────────────────────────────────────────────────────
// 整页渲染（纯函数）
// ─────────────────────────────────────────────────────────────

function rowHtml(r: StatusRowView): string {
  const cell = rowUpdatePayload(r.submitId, {
    resultCode: r.resultCode, memory: r.memory, time: r.time, judger: '',
  }).labelHtml;
  const attrs = [
    `data-sid="${r.submitId}"`,
    `data-code="${r.resultCode}"`,
    `data-match="${r.match ? 1 : 0}"`,
    `data-pending="${r.pending ? 1 : 0}"`,
  ].join(' ');
  const cls = r.pending ? ' class="pending"' : '';
  // 题名与题号相同时（比赛里题名常常就是一个字母）不重复写在悬停提示里
  const title = r.probName && r.probName !== r.problemId ? ` title="${escapeHtml(r.probName)}"` : '';
  return `<tr${cls} ${attrs}${title}>`
    + `<td>${r.submitId}</td>`
    + `<td>${escapeHtml(r.problemId)}</td>`
    + `<td class="res">${cell}</td>`
    + `<td class="num mem">${r.memory > 0 ? r.memory : '-'}</td>`
    + `<td class="num time">${r.time > 0 ? r.time : '-'}</td>`
    + `<td>${escapeHtml(r.language)}</td>`
    + `<td class="num">${escapeHtml(r.codeLen)}</td>`
    + `<td>${escapeHtml(r.submitTime)}</td>`
    + `</tr>`;
}

/** 表体（整表刷新时单独替换这一块，不动页面其余部分） */
export function rowsHtml(m: StatusPageModel): string {
  if (!m.records.length) {
    return '<tr class="empty"><td colspan="8">（这个比赛里还没有你的提交记录）</td></tr>';
  }
  return m.records.map(rowHtml).join('\n');
}

export function numbersHtml(m: StatusPageModel): string {
  const s = m.summary;
  return [
    `<span class="kv"><b>${s.total}</b> 条提交</span>`,
    `<span class="kv pass"><b>${s.ac}</b> 正确</span>`,
    `<span class="kv fail"><b>${s.wa}</b> 答案错误</span>`,
    s.ce ? `<span class="kv warn"><b>${s.ce}</b> 编译错误</span>` : '',
    s.tle ? `<span class="kv warn"><b>${s.tle}</b> 时间超限</span>` : '',
    s.re ? `<span class="kv warn"><b>${s.re}</b> 运行错误</span>` : '',
    s.pending ? `<span class="kv wait"><b>${s.pending}</b> 判题中</span>` : '',
  ].filter(Boolean).join('');
}

/** 判题详情面板（`reinfo.php` / `ceinfo.php` 的 `<pre id='errtxt'>` 正文） */
export function detailHtml(page: string, code: number, text: string): string {
  const isCe = page === 'ceinfo.php';
  const head = isCe ? '编译输出（编译器原文）' : '判题详情（期望 / 你的输出）';
  const cls = isCe || toneOf(code) === 'fail' ? ' class="err"' : '';
  return `<div class="dhead"><b>${head}</b>`
    + `<button data-act="close-detail">收起</button></div>`
    + `<pre${cls}>${escapeHtml(text)}</pre>`;
}

/** 首屏的自动刷新徽章文案（后续由 `{command:'auto'}` 消息覆盖） */
export function autoBadge(m: StatusPageModel): { state: 'on' | 'off' | 'err'; text: string } {
  const n = pendingQueue(m).length;
  if (n > 0) { return { state: 'on', text: `自动刷新中 · ${n} 条待判定` }; }
  if (m.summary.pending > 0) { return { state: 'off', text: '待判定的提交不在当前范围内' }; }
  return { state: 'off', text: '没有待判定的提交' };
}

/**
 * 整页 HTML。
 *
 * 亮色固定：不引用任何编辑器主题变量、在 `<html>` 上显式声明亮色配色方案、
 * 白底深字；状态色只用绿 / 红 / 琥珀 / 灰，无 emoji、无蓝紫（与题目页 / 测试结果页同一约定）。
 */
export function buildStatusHtml(m: StatusPageModel, opts: { offlineNoCacheNotice?: boolean } = {}): string {
  const badge = autoBadge(m);
  const source = opts.offlineNoCacheNotice
    ? '<div class="notice">离线模式，且本地没有这个比赛的状态缓存 —— 下面是从网络也拿不到数据时的空表</div>'
    : m.fromCache
      ? '<div class="notice">网络不可用，下面展示的是本地缓存里的记录，可能已过期</div>'
      : '';
  const toggle = `<button id="toggleBtn" data-act="toggle"${m.filterPid ? '' : ' hidden'}>显示全部题目</button>`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<style>
  /* 固定亮色主题：不跟随 VS Code 配色（与题目页 / 本地测试结果页同一约定） */
  html { color-scheme: light; }
  body { margin: 0; padding: 18px 20px 40px; background: #fff; color: #333;
         font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px; line-height: 1.6; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  code, pre { font-family: Consolas, "Courier New", monospace; }
  .meta { color: #666; margin: 8px 0 4px; }
  .bar { margin: 12px 0 4px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .auto { display: inline-block; padding: 2px 10px; border-radius: 3px; font-size: 12px; }
  .auto.on { background: #e8f5e9; color: #2e7d32; border-left: 3px solid #43a047; }
  .auto.off { background: #f5f5f5; color: #555; border-left: 3px solid #9e9e9e; }
  .auto.err { background: #fff3e0; color: #b26a00; border-left: 3px solid #ef6c00; }
  button { font: inherit; padding: 3px 12px; background: #fafafa; color: #333;
           border: 1px solid #ddd; border-radius: 3px; cursor: pointer; }
  button:hover { background: #f0f0f0; }
  button[disabled] { opacity: .6; cursor: not-allowed; }
  .notice { margin: 10px 0; padding: 7px 12px; background: #fff8e1; color: #8d6e00;
            border-left: 4px solid #ffb300; border-radius: 3px; }
  .notice.err { background: #fdecea; color: #c62828; border-left-color: #e53935; }
  .notice:empty { display: none; }
  .numbers { margin: 10px 0 0; }
  .kv { display: inline-block; margin-right: 16px; color: #555; }
  .kv b { font-size: 15px; }
  .kv.pass b { color: #2e7d32; }
  .kv.fail b { color: #c62828; }
  .kv.warn b { color: #b26a00; }
  .kv.wait b { color: #666; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #eee; text-align: left; white-space: nowrap; }
  th { background: #fafafa; color: #555; font-weight: 600; border-bottom: 1px solid #e0e0e0; }
  td.num { text-align: right; }
  tbody tr:hover { background: #fafafa; }
  tbody tr.empty td { color: #999; text-align: center; padding: 22px 0; }
  .label { display: inline-block; padding: 1px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; }
  .label.pass { background: #e8f5e9; color: #2e7d32; }
  .label.fail { background: #fdecea; color: #c62828; }
  .label.warn { background: #fff3e0; color: #b26a00; }
  .label.wait { background: #f5f5f5; color: #666; }
  .label.muted { background: #f5f5f5; color: #888; }
  .link { cursor: pointer; border-bottom: 1px dashed #bbb; }
  .link:hover { border-bottom-color: #2e7d32; }
  .spin { display: inline-block; width: 9px; height: 9px; margin-left: 6px; vertical-align: -1px;
          border: 2px solid #ddd; border-top-color: #888; border-radius: 50%; animation: spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* 「只看本题」纯客户端过滤：只藏行，不重新请求 —— 切回来是瞬时的 */
  body.only-current tr[data-match="0"] { display: none; }
  /* 判题详情：占满一整行（8 列合并），内部再套一层带边框的盒子 */
  .detailrow > td { padding: 0 0 10px; border-bottom: none; white-space: normal; }
  .detailrow:hover > td { background: transparent; }
  .detail { padding: 10px 12px; background: #fafafa;
            border: 1px solid #e6e6e6; border-left: 4px solid #9e9e9e; border-radius: 4px; }
  .detail .dhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  pre { margin: 0; padding: 8px 10px; background: #f7f7f7; border: 1px solid #e6e6e6; border-radius: 3px;
        white-space: pre-wrap; word-break: break-all; max-height: 420px; overflow: auto; }
  pre.err { color: #c62828; }
</style></head>
<body${m.filterPid ? ' class="only-current"' : ''}>
  <h1>提交结果</h1>
  <div class="meta">
    比赛 <code>${escapeHtml(m.cid || '-')}</code> · 用户 <code>${escapeHtml(m.userId || '-')}</code>
    · 共 <b>${m.summary.total}</b> 条 · 更新于 <span id="at">${escapeHtml(m.loadedAt)}</span>
  </div>
  <div class="bar">
    <span id="auto" class="auto ${badge.state}">${escapeHtml(badge.text)}</span>
    <button id="refreshBtn" data-act="refresh">刷新列表</button>
    ${toggle}
  </div>
  <div id="notice" class="notice"></div>
  <div class="numbers" id="numbers">${numbersHtml(m)}</div>
  ${source}
  <table>
    <thead><tr>
      <th>提交编号</th><th>题目</th><th>结果</th><th class="num">内存(KB)</th>
      <th class="num">耗时(MS)</th><th>语言</th><th class="num">代码长度</th><th>提交时间</th>
    </tr></thead>
    <tbody id="tb">${rowsHtml(m)}</tbody>
  </table>
<script>
(function () {
  var vscode = acquireVsCodeApi();
  var $ = function (id) { return document.getElementById(id); };

  function setAuto(state, text) {
    var el = $('auto');
    if (!el) { return; }
    el.className = 'auto ' + state;
    el.textContent = text;
  }

  function notice(text, kind) {
    var el = $('notice');
    if (!el) { return; }
    el.className = kind === 'err' ? 'notice err' : 'notice';
    el.textContent = text || '';
  }

  function hideDetail() {
    var row = document.getElementById('detailRow');
    if (row && row.parentNode) { row.parentNode.removeChild(row); }
  }

  // 详情必须挂成表格的一整行（tr + td colspan=8）。
  // 早先这里往 tbody 里直接塞了个 div：DOM 不报错，但渲染时浏览器会给它套一层
  // 匿名 table-row/cell，宽度塌成第一列（提交编号）那么窄 —— 内容全挤在左边。
  function showDetail(d) {
    hideDetail();
    var tr = document.querySelector('tr[data-sid="' + d.submitId + '"]');
    if (!tr || !tr.parentNode) { return; }

    var row = document.createElement('tr');
    row.id = 'detailRow';
    row.className = 'detailrow';

    var td = document.createElement('td');
    td.colSpan = 8;

    var box = document.createElement('div');
    box.className = 'detail';
    box.innerHTML = d.html;

    td.appendChild(box);
    row.appendChild(td);
    tr.parentNode.insertBefore(row, tr.nextSibling);
    row.scrollIntoView({ block: 'nearest' });
  }

  function pendingVisible() {
    var only = document.body.classList.contains('only-current');
    var all = document.querySelectorAll('tr[data-pending="1"]');
    var n = 0;
    for (var i = 0; i < all.length; i++) {
      if (!only || all[i].getAttribute('data-match') === '1') { n++; }
    }
    return n;
  }

  function applyRow(d) {
    var tr = document.querySelector('tr[data-sid="' + d.submitId + '"]');
    if (!tr) { return; }
    tr.setAttribute('data-code', String(d.resultCode));
    tr.setAttribute('data-pending', d.pending ? '1' : '0');
    if (d.title) { tr.setAttribute('title', d.title); }
    var res = tr.querySelector('td.res');
    if (res) { res.innerHTML = d.labelHtml; }
    var mem = tr.querySelector('td.mem');
    if (mem) { mem.textContent = d.memory > 0 ? String(d.memory) : '-'; }
    var tim = tr.querySelector('td.time');
    if (tim) { tim.textContent = d.time > 0 ? String(d.time) : '-'; }
    if (!d.pending) { tr.classList.remove('pending'); }
    var left = pendingVisible();
    if (left === 0) { setAuto('off', '已全部出结果'); }
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) { return; }
    var act = el.getAttribute('data-act');

    if (act === 'refresh') {
      if (el.disabled) { return; }
      el.disabled = true;
      notice('正在重新拉取状态页…');
      vscode.postMessage({ command: 'refresh' });
      return;
    }
    if (act === 'toggle') {
      var only = !document.body.classList.contains('only-current');
      document.body.classList.toggle('only-current', only);
      el.textContent = only ? '显示全部题目' : '只看本题';
      // 详情是独立一行，跟着它的行一起收起，免得留下一条无主的详情
      hideDetail();
      notice('');
      vscode.postMessage({ command: 'filter', onlyCurrent: only });
      return;
    }
    if (act === 'detail') {
      notice('正在取判题详情…');
      vscode.postMessage({
        command: 'detail',
        submitId: Number(el.getAttribute('data-sid')),
        resultCode: Number(el.getAttribute('data-code')),
      });
      return;
    }
    if (act === 'close-detail') { hideDetail(); notice(''); return; }
  });

  function syncFilter(onlyCurrent, hasFilter) {
    var on = !!onlyCurrent && !!hasFilter;
    document.body.classList.toggle('only-current', on);
    var btn = $('toggleBtn');
    if (btn) {
      btn.hidden = !hasFilter;
      btn.textContent = on ? '显示全部题目' : '只看本题';
    }
  }

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.command === 'table') {
      $('tb').innerHTML = d.rowsHtml;
      $('numbers').innerHTML = d.numbersHtml;
      $('at').textContent = d.loadedAt;
      $('refreshBtn').disabled = false;
      syncFilter(d.onlyCurrent, d.hasFilter);
      hideDetail();
    } else if (d.command === 'row') {
      applyRow(d);
    } else if (d.command === 'auto') {
      setAuto(d.state, d.text);
    } else if (d.command === 'detail') {
      if (d.ok) { notice(''); showDetail(d); }
      else { notice('取详情失败：' + d.message, 'err'); }
    } else if (d.command === 'notice') {
      notice(d.text, d.kind);
    } else if (d.command === 'busy') {
      $('refreshBtn').disabled = !!d.on;
    }
  });

  // 告诉扩展「DOM 已就绪」—— 首屏之后才开始轮询，免得消息比 DOM 先到被丢掉
  vscode.postMessage({ command: 'ready' });
})();
</script>
</body></html>`;
}

/** 连状态表都拉不到时的兜底页（比一个空白面板强） */
export function buildStatusErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<style>
  html { color-scheme: light; }
  body { margin: 0; padding: 40px 24px; background: #fff; color: #333;
         font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px; line-height: 1.7; }
  h3 { color: #c62828; margin: 0 0 8px; }
  p { color: #666; margin: 4px 0; }
  code { font-family: Consolas, "Courier New", monospace; background: #f7f7f7; padding: 1px 5px; border-radius: 3px; }
</style></head>
<body>
  <h3>拉取提交状态失败</h3>
  <p>${escapeHtml(message)}</p>
  <p>确认已经进入比赛、处于登录状态，且 <code>oj.baseUrl</code> 指向的平台可以访问；然后重新执行「OJ: 刷新提交状态」。</p>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// 面板（薄壳）
// ─────────────────────────────────────────────────────────────
/** 单条提交的轮询上限：超过就不再死等这一条，免得页面永远停在「判题中」 */
export const MAX_POLL_MS = 10 * 60 * 1000;
/** 轮询间隔翻倍的上限 */
export const MAX_POLL_INTERVAL_MS = 8000;

export interface StatusWebviewDeps {
  /** 拉整张状态表（缓存优先 + 同步 TTL；`force` 时直取站点，网络失败降级到旧缓存） */
  loadRecords: (opts?: { force?: boolean }) => Promise<StatusQueryResult>;
  /** 查单条提交的最新判题结果（站点 `status-ajax.php`） */
  pollRow: (submitId: number) => Promise<StatusAjaxRow>;
  /** 取判题详情正文 */
  loadDetail: (submitId: number, resultCode: number) => Promise<{ page: string; text: string }>;
  /** 轮询起始间隔（毫秒） */
  pollIntervalMs: () => number;
  currentCid: () => string;
  currentUser: () => string;
  /** 当前题目编号（数字字符串）；用于默认「只看本题」 */
  currentPid: () => string;
  log?: (msg: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export class StatusWebview {
  private panel: vscode.WebviewPanel | undefined;
  private model: StatusPageModel | undefined;
  /** 「只看本题」开关 —— 页面上的按钮与轮询范围都读它 */
  private onlyCurrent = true;
  /** 轮询代次：刷新 / 关闭面板都会 +1，让在途的旧轮询自己退出 */
  private pollGen = 0;
  /** 超时放弃的提交，不再重复轮询 */
  private givenUp = new Set<number>();

  constructor(private deps: StatusWebviewDeps) {}

  get isOpen(): boolean { return !!this.panel; }

  /**
   * 登录态失效 / 站点切换时，把已打开的结果页收口为登录提示。
   *
   * 提交记录属于「登录态下才该看到」的内容：会话掉了、或换了站点，留在屏上的
   * 旧记录既可能不属于当前用户，也可能来自上一个站点。这里不再尝试重新拉取，
   * 直接渲染登录提示，并停掉轮询 —— 否则轮询会在登录提示上继续转，反复去问
   * 一个已经失效的会话。文案与登录被拦时的首屏兜底保持一致。
   */
  public applyAccessLoss(): void {
    if (!this.panel) { return; }
    this.pollGen += 1;
    this.model = undefined;
    this.panel.webview.html = buildStatusErrorHtml('需要登录后才能查看提交状态');
  }

  dispose(): void {
    this.pollGen += 1;
    this.panel?.dispose();
    this.panel = undefined;
    this.model = undefined;
  }

  /**
   * 打开结果页或重新拉取一次。
   *
   * @param opts.focus 是否把焦点抢到该页（提交成功后为 true，手动刷新状态时为 false）
   * @param opts.force 绕过缓存新鲜度直取站点（用户显式要求刷新时用）
   */
  async show(opts: { focus?: boolean; force?: boolean } = {}): Promise<void> {
    const created = this.ensurePanel(opts.focus ?? true);
    await this.reload({ full: created, force: opts.force });
  }

  /** 页面上的「刷新列表」按钮 —— 用户显式要求，绕过缓存 */
  private async onReloadRequest(): Promise<void> {
    await this.reload({ full: false, force: true });
  }

  private ensurePanel(focus: boolean): boolean {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two, !focus);
      return false;
    }
    const panel = vscode.window.createWebviewPanel(
      'ojStatus',
      'OJ 提交结果',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: !focus },
      // 本项目唯一开脚本的页面：就地更新 DOM 是「不刷新页面」的前提
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.onDidReceiveMessage((msg: any) => { void this.onMessage(msg); });
    panel.onDidDispose(() => {
      this.pollGen += 1;
      this.panel = undefined;
      this.model = undefined;
    });
    this.panel = panel;
    return true;
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.command) {
      case 'ready':
        // 页面脚本就绪 —— 首屏之后才开始轮询，避免消息比 DOM 先到被丢掉
        this.startPolling();
        break;
      case 'refresh':
        await this.onReloadRequest();
        break;
      case 'filter': {
        this.onlyCurrent = msg.onlyCurrent !== false;
        if (this.model) {
          this.model = { ...this.model, filterPid: this.pickFilterPid() };
          this.post({ command: 'auto', ...this.badgePayload() });
        }
        // 过滤范围变了 → 轮询队列跟着变，重开一轮
        this.startPolling();
        break;
      }
      case 'detail':
        await this.replyDetail(Number(msg.submitId), Number(msg.resultCode));
        break;
      default:
        break;
    }
  }

  private pickFilterPid(): string {
    if (!this.onlyCurrent) { return ''; }
    const pid = parseInt(this.deps.currentPid(), 10);
    return Number.isFinite(pid) && pid >= 0 ? numToLetter(pid) : '';
  }

  private async replyDetail(submitId: number, resultCode: number): Promise<void> {
    try {
      const { page, text } = await this.deps.loadDetail(submitId, resultCode);
      this.post({ command: 'detail', ok: true, submitId, html: detailHtml(page, resultCode, text) });
    } catch (e: any) {
      this.post({ command: 'detail', ok: false, submitId, message: e.message });
    }
  }

  private badgePayload(): { state: 'on' | 'off' | 'err'; text: string } {
    if (!this.model) { return { state: 'off', text: '没有待判定的提交' }; }
    const n = nextPendingRow(this.model, this.givenUp);
    if (n) { return { state: 'on', text: `自动刷新中 · 提交 ${n.submitId}` }; }
    if (pendingQueue(this.model).length) { return { state: 'err', text: '待判定的提交已停止自动刷新' }; }
    return { state: 'off', text: '没有待判定的提交' };
  }

  private async reload(opts: { full: boolean; force?: boolean }): Promise<void> {
    if (!this.panel) { return; }
    if (!opts.full) { this.post({ command: 'busy', on: true }); }

    let res: StatusQueryResult;
    try {
      res = await this.deps.loadRecords(opts.force ? { force: true } : undefined);
    } catch (e: any) {
      // 未登录：状态表不读缓存（那份记录可能已经不是这个人的），只讲清要登录
      if (e instanceof LoginRequiredError) {
        const message = '需要登录后才能查看提交状态';
        this.deps.log?.(`拉取提交状态失败：${message}`);
        if (!this.panel) { return; }
        if (opts.full) { this.panel.webview.html = buildStatusErrorHtml(message); return; }
        this.post({ command: 'busy', on: false });
        this.post({ command: 'notice', text: `拉取失败：${message}`, kind: 'err' });
        this.post({ command: 'auto', state: 'err', text: '拉取失败' });
        return;
      }
      // 离线且无缓存：与「返回空表 + 标志」时代等价 —— 渲染空表并附那条 notice，
      // 而不是把「离线读不到」显示成「暂无提交记录」
      if (e instanceof OfflineNoCacheError) {
        if (!this.panel) { return; }
        const model = buildStatusModel([], {
          cid: this.deps.currentCid(),
          userId: this.deps.currentUser(),
          filterPid: this.pickFilterPid(),
          fromCache: true,
          loadedAt: new Date().toLocaleString(),
          pollIntervalMs: this.deps.pollIntervalMs(),
        });
        this.model = model;
        this.panel.title = `提交结果 · ${model.filterPid ? `${model.cid}-${model.filterPid}` : model.cid}`;
        if (opts.full) {
          this.panel.webview.html = buildStatusHtml(model, { offlineNoCacheNotice: true });
        } else {
          this.post({ command: 'busy', on: false });
          this.post({
            command: 'table',
            rowsHtml: rowsHtml(model),
            numbersHtml: numbersHtml(model),
            loadedAt: model.loadedAt,
            onlyCurrent: this.onlyCurrent,
            hasFilter: !!model.filterPid,
          });
          this.post({ command: 'notice', text: '' });
          this.post({ command: 'auto', ...this.badgePayload() });
        }
        return;
      }
      const message = e.message;
      this.deps.log?.(`拉取提交状态失败：${message}`);
      if (!this.panel) { return; }
      if (opts.full) { this.panel.webview.html = buildStatusErrorHtml(message); return; }
      this.post({ command: 'busy', on: false });
      this.post({ command: 'notice', text: `拉取失败：${message}`, kind: 'err' });
      this.post({ command: 'auto', state: 'err', text: '拉取失败' });
      return;
    }
    if (!this.panel) { return; }

    // 每次重新拉取都把「只看本题」拉回默认（页面上那行筛选状态由 table 消息一起同步）
    this.givenUp.clear();
    this.onlyCurrent = true;
    const model = buildStatusModel(res.records, {
      cid: this.deps.currentCid(),
      userId: this.deps.currentUser(),
      filterPid: this.pickFilterPid(),
      fromCache: res.fromCache,
      loadedAt: new Date().toLocaleString(),
      pollIntervalMs: this.deps.pollIntervalMs(),
    });
    this.model = model;
    this.panel.title = `提交结果 · ${model.filterPid ? `${model.cid}-${model.filterPid}` : model.cid}`;

    if (opts.full) {
      // 首屏整页渲染（一次性），此后只有轮询消息，不再整页替换。
      // 轮询等页面脚本发来 `ready` 再开 —— 刚赋值 html 时 DOM 还没建起来，
      // 这时候 postMessage 会丢。
      this.panel.webview.html = buildStatusHtml(model);
    } else {
      this.post({
        command: 'table',
        rowsHtml: rowsHtml(model),
        numbersHtml: numbersHtml(model),
        loadedAt: model.loadedAt,
        onlyCurrent: this.onlyCurrent,
        hasFilter: !!model.filterPid,
      });
      this.post({ command: 'busy', on: false });
      this.post({ command: 'notice', text: '' });
      this.post({ command: 'auto', ...this.badgePayload() });
      this.startPolling();
    }
  }

  private startPolling(): void {
    const gen = ++this.pollGen;
    void this.runPoll(gen);
  }

  /**
   * 轮询循环 —— 站点 `auto_refresh()` 的等价物。
   *
   * 一次只盯**一条**待判定的提交（而不是并行问所有行），拿到结果后回到队首重扫；
   * 间隔逐次翻倍、封顶 `MAX_POLL_INTERVAL_MS`。这些都是站点自己的做法，
   * 照搬的理由很实际：并行轮询会把判题机问出脾气，而翻倍能让「判得慢」的提交少挨问。
   */
  private async runPoll(gen: number): Promise<void> {
    const base = Math.max(100, this.deps.pollIntervalMs());
    while (this.panel && gen === this.pollGen) {
      const m = this.model;
      if (!m) { return; }
      const row = nextPendingRow(m, this.givenUp);
      if (!row) {
        this.post({ command: 'auto', ...this.badgePayload() });
        return;
      }
      this.post({ command: 'auto', state: 'on', text: `自动刷新中 · 提交 ${row.submitId}` });

      let wait = base;
      let resolved = false;
      const startedAt = Date.now();
      while (this.panel && gen === this.pollGen && Date.now() - startedAt < MAX_POLL_MS) {
        await sleep(wait);
        if (!this.panel || gen !== this.pollGen) { return; }
        try {
          const r = await this.deps.pollRow(row.submitId);
          if (!this.panel || gen !== this.pollGen) { return; }
          this.applyAjax(row.submitId, r);
          if (!isPending(r.resultCode)) { resolved = true; break; }
        } catch (e: any) {
          // 会话失效：登录提示交给 onSessionLost 路径，停止轮询，不弹「继续重试」
          if (e instanceof LoginRequiredError) {
            this.pollGen += 1;
            return;
          }
          this.deps.log?.(`轮询提交 ${row.submitId} 失败：${e.message}`);
          this.post({ command: 'notice', text: `轮询失败（会继续重试）：${e.message}`, kind: 'err' });
        }
        wait = Math.min(wait * 2, MAX_POLL_INTERVAL_MS);
      }
      if (!this.panel || gen !== this.pollGen) { return; }
      if (!resolved) {
        this.givenUp.add(row.submitId);
        this.post({
          command: 'notice',
          text: `提交 ${row.submitId} 等了 ${Math.round(MAX_POLL_MS / 60000)} 分钟还没出结果，已停止自动刷新 —— 可以点「刷新列表」重来`,
          kind: '',
        });
        this.post({ command: 'auto', state: 'err', text: '已停止自动刷新' });
      }
      // 继续扫下一条（站点也是拿到结果后立刻重扫一遍）
    }
  }

  /** 一条轮询结果 → 更新模型 + 只发那几格给页面 */
  private applyAjax(submitId: number, r: StatusAjaxRow): void {
    const row = this.model?.records.find(x => x.submitId === submitId);
    if (row) {
      row.resultCode = r.resultCode;
      row.resultName = resultNameOf(r.resultCode);
      row.tone = toneOf(r.resultCode);
      row.pending = isPending(r.resultCode);
      row.detail = detailKindOf(r.resultCode);
      row.memory = r.memory;
      row.time = r.time;
    }
    this.post({ command: 'row', ...rowUpdatePayload(submitId, r) });
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel?.webview.postMessage(msg);
  }
}
