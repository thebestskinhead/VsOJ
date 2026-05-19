import * as vscode from 'vscode';
import { AuthService } from '../api/auth';
import { SubmitService } from '../api/submit';
import { StateManager } from '../utils/state';
import { LANGUAGE_NAME } from '../types';

/** 提交代码 Webview — 完全参照 loginWebview 模式 */
export class SubmitWebview {
  private panel: vscode.WebviewPanel | undefined;
  private auth: AuthService;
  private submitService: SubmitService;
  private state: StateManager;
  private cid: string;
  private pid: string;
  private source: string;
  private defaultLang: number;
  private onSubmitSuccess?: () => void;

  constructor(
    auth: AuthService,
    submitService: SubmitService,
    state: StateManager,
    cid: string,
    pid: string,
    source: string,
    defaultLang: number,
    onSubmitSuccess?: () => void,
  ) {
    this.auth = auth;
    this.submitService = submitService;
    this.state = state;
    this.cid = cid;
    this.pid = pid;
    this.source = source;
    this.defaultLang = defaultLang;
    this.onSubmitSuccess = onSubmitSuccess;
  }

  async show(): Promise<void> {
    this.panel = vscode.window.createWebviewPanel(
      'ojSubmit',
      'OJ 提交代码',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => { this.panel = undefined; });

    this.panel.webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg.command) {
        case 'submit':
          await this.handleSubmit(msg.language, msg.vcode);
          break;
        case 'refreshVcode':
          await this.loadVcode();
          break;
      }
    });

    // 首个 /vcode.php 请求即建立会话，后续由 updateHtml 渲染页面
    await this.loadVcode();
  }

  private async loadVcode(): Promise<void> {
    try {
      const base64 = await this.auth.fetchVcodeImage();
      this.panel?.webview.postMessage({ command: 'vcodeLoaded', vcodeBase64: base64 });
    } catch (e: any) {
      this.panel?.webview.postMessage({ command: 'error', message: `验证码加载失败: ${e.message}` });
    }
  }

  /** 渲染 HTML（show 之后调用） */
  updateHtml(): void {
    if (this.panel) {
      this.panel.webview.html = this.getHtml();
    }
  }

  private async handleSubmit(language: number, vcode: string): Promise<void> {
    if (!vcode) {
      this.panel?.webview.postMessage({ command: 'error', message: '请输入验证码' });
      return;
    }
    try {
      const result = await this.submitService.submit(this.cid, this.pid, language, this.source, vcode);
      if (result.success) {
        this.panel?.webview.postMessage({ command: 'success', message: '提交成功' });
        vscode.window.showInformationMessage('[OJ] 提交成功');
        this.onSubmitSuccess?.();
        setTimeout(() => this.panel?.dispose(), 600);
      } else {
        this.panel?.webview.postMessage({ command: 'error', message: result.message });
        await this.loadVcode();
      }
    } catch (e: any) {
      this.panel?.webview.postMessage({ command: 'error', message: e.message });
      await this.loadVcode();
    }
  }

  private getHtml(): string {
    const sourceLen = this.source.length;
    const sourcePreview = this.source.substring(0, 200).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langOptions = Object.entries(LANGUAGE_NAME)
      .map(([k, v]) => `<option value="${k}" ${Number(k) === this.defaultLang ? 'selected' : ''}>${v}</option>`)
      .join('');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#e8f5e9,#c8e6c9)}
  .box{background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.15);width:420px;max-width:90vw;padding:32px}
  h2{text-align:center;color:#2e7d32;margin-bottom:6px;font-size:20px}
  .info{text-align:center;font-size:12px;color:#888;margin-bottom:16px}
  .info strong{color:#2e7d32}
  .src-preview{background:#f5f5f5;border:1px solid #e0e0e0;border-radius:6px;padding:10px;font-size:11px;color:#555;font-family:Consolas,monospace;max-height:80px;overflow:hidden;margin-bottom:16px}
  .fg{margin-bottom:14px}
  .fg label{display:block;margin-bottom:4px;color:#555;font-size:13px;font-weight:500}
  .fg select,.fg input{width:100%;padding:10px 12px;border:1px solid #c8e6c9;border-radius:6px;font-size:14px;outline:none;transition:border-color .2s}
  .fg select:focus,.fg input:focus{border-color:#4CAF50}
  .vcode-wrap{display:flex;gap:10px;align-items:center}
  .vcode-wrap input{flex:1}
  .vcode-wrap img{height:40px;border-radius:4px;cursor:pointer;border:1px solid #c8e6c9}
  button{width:100%;padding:12px;border:none;border-radius:6px;font-size:15px;cursor:pointer;font-weight:500;transition:background .2s}
  .btn-submit{background:#4CAF50;color:#fff}.btn-submit:hover{background:#43a047}
  button:disabled{opacity:.6;cursor:not-allowed}
  .msg{margin-top:10px;font-size:13px;text-align:center;min-height:18px}
  .msg-err{color:#c62828}.msg-ok{color:#2e7d32}
</style></head>
<body>
<div class="box">
  <h2>提交代码</h2>
  <div class="info">比赛 <strong>CID:${this.cid}</strong> ｜ 题目 <strong>PID:${this.pid}</strong> ｜ 代码 <strong>${sourceLen} 字节</strong></div>
  <div class="src-preview">${sourcePreview}${sourceLen > 200 ? '…' : ''}</div>
  <form id="form">
    <div class="fg"><label>编程语言</label>
      <select id="language">${langOptions}</select>
    </div>
    <div class="fg"><label>提交验证码</label>
      <div class="vcode-wrap">
        <input type="text" id="vcode" placeholder="验证码" required maxlength="4" autocomplete="off">
        <img id="vcodeImg" src="" alt="验证码" title="点击刷新" onclick="refreshVcode()">
      </div>
    </div>
    <button type="submit" class="btn-submit" id="submitBtn">🚀 提交代码</button>
  </form>
  <div id="message" class="msg"></div>
</div>
<script>
  const v=acquireVsCodeApi();
  const $=id=>document.getElementById(id);
  function show(m,e){const el=$('message');el.textContent=m;el.className='msg '+(e?'msg-err':'msg-ok')}
  function refreshVcode(){v.postMessage({command:'refreshVcode'})}

  const form = $('form');
  if (form) {
    form.addEventListener('submit',e=>{
      e.preventDefault();
      $('submitBtn').disabled=true;$('submitBtn').textContent='提交中…';show('',false);
      v.postMessage({command:'submit',language:Number($('language').value),vcode:$('vcode').value.trim()});
    });
  }

  window.addEventListener('message',e=>{
    const d=e.data;
    switch(d.command){
      case 'vcodeLoaded':$('vcodeImg').src=d.vcodeBase64;break;
      case 'success':show(d.message,false);setTimeout(()=>$('submitBtn').textContent='✅ 已提交',300);break;
      case 'error':show(d.message,true);$('submitBtn').disabled=false;$('submitBtn').textContent='🚀 提交代码';break;
    }
  });

  // 兜底：页面加载后主动请求验证码，防止 postMessage 丢失
  v.postMessage({command:'refreshVcode'});
</script>
</body></html>`;
  }
}
