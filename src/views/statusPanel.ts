import * as vscode from 'vscode';
import { SubmitService } from '../api/submit';
import { StateManager } from '../utils/state';
import { StatusRecord } from '../types';
import { getStatusRefreshInterval, getBaseUrl } from '../utils/config';
import { apiClient } from '../api/client';

/** 状态面板 — OutputChannel，纯文本框线表格，刷新时替换 */

export class StatusPanel {
  private channel: vscode.OutputChannel;
  private submitService: SubmitService;
  private state: StateManager;
  private refreshTimer: NodeJS.Timeout | undefined;
  private autoRefreshEnabled: boolean = false;
  private smartStop: boolean = false;
  private filterPid: string = '';

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

  async refresh(): Promise<void> { await this.loadAndRender(); }

  /** 手动切换——持续刷新，不自动停，显示全部 */
  toggleAutoRefresh(): void {
    if (this.autoRefreshEnabled) { this.stopAutoRefresh(); }
    else { this.smartStop = false; this.filterPid = ''; this.startAutoRefresh(); }
  }

  /**
   * 提交通道——只显示当前题目，开始刷新，最新结果出来后自动停
   * @param pid 当前题目 PID（数字），用于过滤状态记录
   */
  startSubmitAutoRefresh(pid: string): void {
    this.filterPid = pid;
    this.smartStop = true;
    this.channel.show(true);
    if (!this.autoRefreshEnabled) { this.startAutoRefresh(); }
    else { this.loadAndRender(); }
  }

  private async loadAndRender(): Promise<void> {
    try {
      const cid = this.state.getCurrentCid();
      if (!cid) { this.replace('  未进入比赛\n'); return; }
      const userId = this.state.getStudentId() || '';
      let records = await this.submitService.queryStatus(userId, cid);

      // 按题目过滤——只显示当前题目的提交
      if (this.filterPid) {
        records = records.filter(r => r.problemId === this.filterPid);
      }

      this.render(records);

      // 智能停止：最新提交已出最终结果 → 自动停
      if (this.autoRefreshEnabled && this.smartStop && records.length > 0) {
        const latest = records[0];
        if (latest.resultCode >= 4) {
          this.stopAutoRefresh();
          vscode.window.showInformationMessage('[OJ] 判题结果已出，停止刷新');
        }
      }
    } catch (e: any) {
      this.replace(`  加载失败: ${e.message}\n`);
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

  private render(records: StatusRecord[]): void {
    const cid = this.state.getCurrentCid() || '-';
    const userId = this.state.getStudentId() || '-';
    const now = new Date().toLocaleString();
    const intervalSec = Math.round(getStatusRefreshInterval() / 1000);
    const hintParts: string[] = [];
    if (this.filterPid) hintParts.push(`题目:${this.filterPid}`);
    if (this.autoRefreshEnabled && this.smartStop) hintParts.push('出结果自停');
    if (this.autoRefreshEnabled && !this.smartStop) hintParts.push(`刷新中 ${intervalSec}s`);
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
    this.replace(out);
  }

  private startAutoRefresh(): void {
    this.autoRefreshEnabled = true;
    const interval = getStatusRefreshInterval();
    this.refreshTimer = setInterval(() => this.loadAndRender(), interval);
    this.loadAndRender();
  }

  private stopAutoRefresh(): void {
    this.autoRefreshEnabled = false;
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = undefined; }
    this.loadAndRender();
  }

  isAutoRefreshEnabled(): boolean { return this.autoRefreshEnabled; }

  /** Webview 模式：打开 OJ 自带的 status 页面 */
  private statusWebviewPanel: vscode.WebviewPanel | undefined;

  async showWebview(): Promise<void> {
    if (this.statusWebviewPanel) {
      this.statusWebviewPanel.reveal(vscode.ViewColumn.Two);
      return;
    }

    this.statusWebviewPanel = vscode.window.createWebviewPanel(
      'ojStatus',
      'OJ 提交状态',
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.statusWebviewPanel.onDidDispose(() => { this.statusWebviewPanel = undefined; });

    // 代理拦截：webview 内链接/表单 → 扩展带 Cookie 请求 → 回传 HTML
    this.statusWebviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg.command === 'proxyNavigate' && this.statusWebviewPanel) {
        try {
          const baseUrl = getBaseUrl();
          let targetUrl = msg.url;
          // 补全相对路径
          if (targetUrl.startsWith('/')) targetUrl = baseUrl + targetUrl;
          else if (!targetUrl.startsWith('http')) targetUrl = `${baseUrl}/${targetUrl}`;

          const resp = await apiClient.get<string>(targetUrl, { responseType: 'text' });
          this.statusWebviewPanel.webview.html = this.injectProxyScript(resp.data, baseUrl);
        } catch (e: any) {
          this.statusWebviewPanel.webview.postMessage({ command: 'proxyError', message: e.message });
        }
      }
    });

    await this.loadStatusPage();
  }

  private async loadStatusPage(): Promise<void> {
    const cid = this.state.getCurrentCid();
    const userId = this.state.getStudentId() || '';
    const pid = this.state.getCurrentPid();
    const baseUrl = getBaseUrl();

    const params = new URLSearchParams();
    if (userId) params.set('user_id', userId);
    if (cid) params.set('cid', cid);
    if (pid) {
      // PID 数字 → 字母（0→A, 1→B, ...）
      const letter = String.fromCharCode(65 + parseInt(pid, 10));
      params.set('problemId', letter);
    }
    const query = params.toString();
    const url = query ? `${baseUrl}/status.php?${query}` : `${baseUrl}/status.php`;

    try {
      const response = await apiClient.get<string>(url, { responseType: 'text' });
      const html = this.injectProxyScript(response.data, baseUrl);
      if (this.statusWebviewPanel) {
        this.statusWebviewPanel.webview.html = html;
      }
    } catch (e: any) {
      if (this.statusWebviewPanel) {
        this.statusWebviewPanel.webview.html = `
          <html><body style="padding:20px;font-family:sans-serif;color:#c62828">
            <h3>加载状态页面失败</h3><p>${e.message}</p>
            <p>请确认 OJ 平台地址配置正确，且已登录。</p>
          </body></html>`;
      }
    }
  }

  /** 注入代理脚本：拦截所有链接和表单，通过扩展代理带 Cookie 请求 */
  private injectProxyScript(html: string, baseUrl: string): string {
    const proxyScript = `
<script>
(function(){
  const base='${baseUrl}'.replace(/\\/+$/,'');
  const vscode=acquireVsCodeApi();

  // 拦截所有 <a> 链接
  document.addEventListener('click',function(e){
    var a=e.target.closest('a');
    if(a&&a.href&&!a.href.startsWith('javascript')&&!a.target){
      e.preventDefault();
      var url=a.getAttribute('href')||a.href;
      if(url.startsWith(base)){url=url.substring(base.length)}
      else if(url.startsWith('/')){/* keep */}
      vscode.postMessage({command:'proxyNavigate',url:url});
    }
  },true);

  // 拦截所有 <form> 提交
  document.addEventListener('submit',function(e){
    var f=e.target.closest('form');
    if(f&&f.action){
      e.preventDefault();
      var url=f.action;
      var method=(f.method||'get').toLowerCase();
      var fd=new FormData(f);
      var params=new URLSearchParams();
      for(var pair of fd.entries()){params.append(pair[0],pair[1])}
      if(method==='get'){
        if(params.toString()){url+=((url.indexOf('?')>=0)?'&':'?')+params.toString()}
        vscode.postMessage({command:'proxyNavigate',url:url});
      }else{
        // POST 暂直接跳转 GET
        if(params.toString()){url+=((url.indexOf('?')>=0)?'&':'?')+params.toString()}
        vscode.postMessage({command:'proxyNavigate',url:url});
      }
    }
  },true);
})();
</script>`;

    return html.replace('</head>', `<base href="${baseUrl}/">\n${proxyScript}\n</head>`);
  }

  /** Webview 模式：提交通道仅打开 webview */
  startSubmitWebviewRefresh(): void {
    this.showWebview();
  }

  dispose(): void {
    this.stopAutoRefresh();
    this.statusWebviewPanel?.dispose();
    this.channel.dispose();
  }
}
