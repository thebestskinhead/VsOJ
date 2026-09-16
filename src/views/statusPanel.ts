import * as vscode from 'vscode';
import { SubmitService, StatusAjaxRow } from '../api/submit';
import { StateManager } from '../utils/state';
import { StatusRecord } from '../types';
import { getStatusPollInterval } from '../utils/config';
import {
  isPending, resultNameOf, MAX_POLL_MS, MAX_POLL_INTERVAL_MS,
} from '../webview/statusWebview';

/**
 * 状态面板 — OutputChannel，纯文本框线表格，刷新时替换。
 *
 * 自动刷新与结果页取同一套策略（站点 `auto_refresh.js` 的等价物）：只盯**一条**
 * 还没判完的提交去查 `status-ajax.php`，拿到结果后重绘整屏再扫下一条；间隔从
 * `oj.statusPollInterval` 起步、逐次翻倍封顶 8 秒，单条超过 `MAX_POLL_MS` 就放弃。
 * 与结果页的唯一差别在显示：OutputChannel 只能整屏替换，改不了单格。
 */

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export class StatusPanel {
  private channel: vscode.OutputChannel;
  private submitService: SubmitService;
  private state: StateManager;
  private autoRefreshEnabled: boolean = false;
  private smartStop: boolean = false;
  private filterPid: string = '';
  /** 当前这一屏的记录（已按 filterPid 过滤） */
  private records: StatusRecord[] = [];
  private src: { fromCache?: boolean; offlineNoCache?: boolean } = {};
  /** 轮询代次：每次重开 / 停止都 +1，让在途的旧循环自己退出 */
  private pollGen: number = 0;
  /** 超时放弃的提交，不再重复轮询 */
  private givenUp = new Set<number>();
  /** 正在盯的提交（表头提示用） */
  private watching: number | undefined;

  constructor(submitService: SubmitService, state: StateManager) {
    this.submitService = submitService;
    this.state = state;
    this.channel = vscode.window.createOutputChannel('OJ 提交状态');
  }

  /** 单次查看（命令触发）— 不做任何过滤，显示全部 */
  async show(): Promise<void> {
    this.filterPid = '';
    this.channel.show(true);
    await this.loadAndRender();
  }

  async refresh(): Promise<void> {
    this.givenUp.clear();
    await this.loadAndRender();
  }

  /** 手动切换——持续刷新，不自动停，显示全部 */
  toggleAutoRefresh(): void {
    if (this.autoRefreshEnabled) { this.stopAutoRefresh(); }
    else { this.smartStop = false; this.filterPid = ''; this.startAutoRefresh(); }
  }

  /**
   * 提交通道——只显示当前题目，开始刷新，最新结果出来后自动停
   * @param pidLetter 当前题目的编号字母（A/B/C…），用于过滤状态记录
   */
  startSubmitAutoRefresh(pidLetter: string): void {
    this.filterPid = pidLetter;
    this.smartStop = true;
    this.channel.show(true);
    this.startAutoRefresh();
  }

  private startAutoRefresh(): void {
    this.autoRefreshEnabled = true;
    this.givenUp.clear();
    void this.runLoop(++this.pollGen);
  }

  /**
   * 一轮 = 拉整张状态表 → 逐个盯还没判完的提交 → 都出结果后（持续模式）等下再来一轮。
   */
  private async runLoop(gen: number): Promise<void> {
    const base = Math.max(100, getStatusPollInterval());
    while (this.autoRefreshEnabled && gen === this.pollGen) {
      const ok = await this.loadAndRender();
      if (!ok) { this.stopAutoRefresh(); return; }
      if (!this.autoRefreshEnabled || gen !== this.pollGen) { return; }

      await this.pollPending(gen);
      if (!this.autoRefreshEnabled || gen !== this.pollGen) { return; }

      if (this.smartStop) {
        const latest = this.records[0];
        const done = !!latest && !isPending(latest.resultCode);
        this.stopAutoRefresh();
        if (done) { vscode.window.showInformationMessage('[OJ] 判题结果已出，停止刷新'); }
        return;
      }
      // 持续模式：没有待判定的也继续盯着（用户可能刚又提交了一发）
      await sleep(base);
    }
  }

  /** 逐个盯住还没判完的提交，直到没有了（或都到了放弃线）为止 */
  private async pollPending(gen: number): Promise<void> {
    const base = Math.max(100, getStatusPollInterval());
    for (;;) {
      if (!this.autoRefreshEnabled || gen !== this.pollGen) { return; }
      // 提交通道只关心自己刚交的那条，不去等历史遗留的待判定
      const row = this.smartStop ? this.latestPending() : this.nextPending();
      if (!row) { this.watching = undefined; this.render(); return; }
      this.watching = row.submitId;
      this.render();

      let wait = base;
      let resolved = false;
      const startedAt = Date.now();
      while (this.autoRefreshEnabled && gen === this.pollGen && Date.now() - startedAt < MAX_POLL_MS) {
        await sleep(wait);
        if (!this.autoRefreshEnabled || gen !== this.pollGen) { return; }
        try {
          const r = await this.submitService.fetchStatusAjax(row.submitId);
          this.applyAjax(row.submitId, r);
          this.render();
          if (!isPending(r.resultCode)) { resolved = true; break; }
        } catch {
          // 网络抖动：保持同一节奏继续重试，不打断整条队列
        }
        wait = Math.min(wait * 2, MAX_POLL_INTERVAL_MS);
      }
      if (!this.autoRefreshEnabled || gen !== this.pollGen) { return; }
      if (!resolved) { this.givenUp.add(row.submitId); }
      if (this.smartStop) { this.watching = undefined; return; }
    }
  }

  /** 自下而上取第一条还没判完的提交（顺序照搬站点 `auto_refresh()`） */
  private nextPending(): StatusRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (isPending(r.resultCode) && !this.givenUp.has(r.submitId)) { return r; }
    }
    return undefined;
  }

  /** 最新一条（列表新的在前）还没判完的提交 */
  private latestPending(): StatusRecord | undefined {
    const r = this.records[0];
    return r && isPending(r.resultCode) && !this.givenUp.has(r.submitId) ? r : undefined;
  }

  private async loadAndRender(): Promise<boolean> {
    try {
      const cid = this.state.getCurrentCid();
      if (!cid) { this.records = []; this.replace('  未进入比赛\n'); return false; }
      const userId = this.state.getStudentId() || '';
      // 本面板的每一条路径都是「用户要看最新的」——单次查看、手动刷新、自动刷新循环，
      // 因此一律绕过缓存新鲜度直取站点，否则刷新循环会在 TTL 内反复渲染同一份快照
      const res = await this.submitService.queryStatus(userId, cid, { force: true });
      this.records = this.filterPid
        ? res.records.filter(r => r.problemId === this.filterPid)
        : res.records;
      this.src = { fromCache: res.fromCache, offlineNoCache: res.offlineNoCache };
      this.render();
      return true;
    } catch (e: any) {
      this.replace(`  加载失败: ${e.message}\n`);
      return false;
    }
  }

  /** 一条轮询结果 → 更新记录（下一次 `render()` 会带上） */
  private applyAjax(submitId: number, r: StatusAjaxRow): void {
    const rec = this.records.find(x => x.submitId === submitId);
    if (rec) {
      rec.resultCode = r.resultCode;
      rec.resultName = resultNameOf(r.resultCode);
      rec.memory = r.memory;
      rec.time = r.time;
    }
  }

  private replace(content: string): void {
    this.channel.clear();
    this.channel.append(content);
  }

  private resultLabel(code: number, name: string): string {
    const shorts: Record<number, string> = {
      4: ' AC ', 6: ' WA ', 11: ' CE ', 7: ' TLE', 10: ' RE ',
      5: ' PE ', 8: ' MLE', 9: ' OLE', 0: 'WAIT', 1: 'REJ ', 2: 'COMP', 3: 'RUN ',
    };
    return shorts[code] || name.substring(0, 4).padEnd(4);
  }

  private render(): void {
    const records = this.records;
    const cid = this.state.getCurrentCid() || '-';
    const userId = this.state.getStudentId() || '-';
    const now = new Date().toLocaleString();
    const hintParts: string[] = [];
    if (this.filterPid) hintParts.push(`题目:${this.filterPid}`);
    if (this.autoRefreshEnabled) {
      hintParts.push(this.watching ? `自动刷新中 · 提交 ${this.watching}` : '自动刷新中');
      if (this.smartStop) hintParts.push('出结果自停');
    }
    // 本面板的每次拉取都是「用户要看最新的」，一律直取站点（见 loadAndRender 的 force）；
    // 于是只有「网络失败降级到旧缓存」与「离线且无缓存」两种情形需要把来源说出来
    if (this.src.offlineNoCache) hintParts.push('离线模式 · 无本地缓存');
    else if (this.src.fromCache) hintParts.push('离线缓存');
    const autoHint = hintParts.length ? ` [${hintParts.join(' | ')}]` : '';

    let ac = 0, wa = 0, ce = 0, tle = 0, re = 0;
    for (const d of records) {
      if (d.resultCode === 4) ac++;
      else if (d.resultCode === 6) wa++;
      else if (d.resultCode === 11) ce++;
      else if (d.resultCode === 7) tle++;
      else if (d.resultCode === 10) re++;
    }

    const W = [6, 12, 6, 6, 8, 8, 8, 6, 18];
    const totalW = W.reduce((a: number, b: number) => a + b, 0) + W.length + 1;
    const l = '─'.repeat(totalW);

    const pad = (s: string, w: number, a: 'L' | 'C' | 'R' = 'C'): string => {
      let t = s.length > w ? s.substring(0, w - 1) + '…' : s;
      if (a === 'L') return t.padEnd(w);
      if (a === 'R') return t.padStart(w);
      const pl = Math.floor((w - t.length) / 2);
      return ' '.repeat(Math.max(0, pl)) + t.padEnd(w - Math.max(0, pl));
    };

    const sep  = `┌${l}┐`;
    const div  = `├${l}┤`;
    const bot  = `└${l}┘`;
    const gap  = `│${' '.repeat(totalW)}│`;

    const hdrs = ['编号', '用户', '题目', '结果', '内存', '耗时', '语言', '长度', '时间'];
    const hdrRow = `│ ${hdrs.map((h, i) => pad(h, W[i])).join(' │ ')} │`;

    const title = `╔═ OJ 提交状态 — cid:${cid}  user:${userId}  ${now}${autoHint} ═`;

    let out = `\n${title}\n\n`;
    out += `  总计:${String(records.length).padStart(4)}  AC:${String(ac).padStart(3)}  WA:${String(wa).padStart(3)}  CE:${String(ce).padStart(3)}  TLE:${String(tle).padStart(3)}  RE:${String(re).padStart(3)}\n\n`;

    if (records.length === 0) {
      out += `  （暂无提交记录）\n\n`;
      this.replace(out);
      return;
    }

    out += sep + '\n' + hdrRow + '\n' + div + '\n';

    for (let i = 0; i < records.length; i++) {
      const d = records[i];
      const cols = [
        pad(String(d.submitId), W[0]),
        pad(d.userId, W[1], 'L'),
        pad(d.problemId, W[2]),
        pad(this.resultLabel(d.resultCode, d.resultName), W[3]),
        pad(d.memory > 0 ? `${d.memory}KB` : '-', W[4]),
        pad(d.time > 0 ? `${d.time}ms` : '-', W[5]),
        pad(d.language, W[6]),
        pad(d.codeLen, W[7]),
        pad(d.submitTime, W[8], 'L'),
      ].join(' │ ');
      out += `│ ${cols} │\n`;
      if (i < records.length - 1) out += gap + '\n';
    }

    out += bot + '\n\n';

    if (this.givenUp.size) {
      out += `  已停止等待：${[...this.givenUp].join(', ')}（超过 ${Math.round(MAX_POLL_MS / 60000)} 分钟仍未出结果）\n\n`;
    }

    this.replace(out);
  }

  private stopAutoRefresh(): void {
    this.autoRefreshEnabled = false;
    this.pollGen += 1;
    this.watching = undefined;
    this.render();
  }

  isAutoRefreshEnabled(): boolean { return this.autoRefreshEnabled; }

  /**
   * 停下自动刷新，但**保留 OutputChannel**。
   *
   * 退出比赛时用它而不是 `dispose()`：`dispose()` 会把 channel 一起释放掉，
   * 之后再 `oj.refreshStatus` 往一个已释放的 channel 写就会抛错
   * —— 输出面板一旦被释放，只有重载窗口才能恢复。
   */
  pause(): void {
    this.stopAutoRefresh();
  }

  dispose(): void {
    this.autoRefreshEnabled = false;
    this.pollGen += 1;
    this.channel.dispose();
  }
}
