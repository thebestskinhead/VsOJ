import * as vscode from 'vscode';
import { StateManager } from '../utils/state';

/** 账号设置 Webview — 存储用户名和加密后的密码哈希 */

export class AccountWebview {
  private panel: vscode.WebviewPanel | undefined;
  private state: StateManager;

  constructor(state: StateManager) {
    this.state = state;
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ojAccountSettings',
      'OJ 账号设置',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => { this.panel = undefined; });

    this.panel.webview.onDidReceiveMessage(async (msg: { command: string; username?: string; password?: string }) => {
      switch (msg.command) {
        case 'save':
          await this.handleSave(msg.username || '', msg.password || '');
          break;
        case 'load':
          await this.postAccountInfo();
          break;
        case 'clear':
          await this.state.setAccountUsername('');
          await this.state.setAccountPasswordHash('');
          this.panel?.webview.postMessage({ command: 'saved', username: '', hasAccount: false });
          break;
      }
    });

    await this.postAccountInfo();
    this.panel.webview.html = this.getHtml();
  }

  private async postAccountInfo(): Promise<void> {
    const username = await this.state.getAccountUsername();
    this.panel?.webview.postMessage({
      command: 'saved',
      username: username || '',
      hasAccount: !!username,
    });
  }

  private async handleSave(username: string, password: string): Promise<void> {
    if (!username || !password) {
      this.panel?.webview.postMessage({ command: 'error', message: '用户名和密码不能为空' });
      return;
    }
    await this.state.saveAccount(username, password);
    this.panel?.webview.postMessage({
      command: 'saved',
      username,
      hasAccount: true,
    });
    vscode.window.showInformationMessage('[OJ] 账号已保存');
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(135deg,#e8f5e9,#c8e6c9);display:flex;align-items:center;justify-content:center;min-height:100vh}
  .box{background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.15);width:380px;max-width:90vw;padding:32px}
  h2{text-align:center;color:#2e7d32;margin-bottom:8px;font-size:20px}
  .hint{text-align:center;color:#888;font-size:12px;margin-bottom:20px}
  .fg{margin-bottom:14px}
  .fg label{display:block;margin-bottom:4px;color:#555;font-size:13px;font-weight:500}
  .fg input{width:100%;padding:10px 12px;border:1px solid #c8e6c9;border-radius:6px;font-size:14px;outline:none;transition:border-color .2s}
  .fg input:focus{border-color:#4CAF50}
  .info{background:#f1f8e9;border-radius:6px;padding:10px 12px;margin-bottom:16px;font-size:13px;color:#2e7d32}
  .info strong{color:#1b5e20}
  .btns{display:flex;gap:8px}
  button{flex:1;padding:12px;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:500;transition:background .2s}
  .btn-save{background:#4CAF50;color:#fff}.btn-save:hover{background:#43a047}
  .btn-clear{background:#fff;color:#c62828;border:1px solid #ef9a9a}.btn-clear:hover{background:#ffebee}
  .btn-save:disabled{background:#a5d6a7;cursor:not-allowed}
  .msg{margin-top:10px;font-size:13px;text-align:center;min-height:18px}
  .msg-err{color:#c62828}.msg-ok{color:#2e7d32}
</style></head>
<body>
<div class="box">
  <h2>OJ 账号设置</h2>
  <div class="hint">密码使用与登录相同的加密算法存储哈希值，不保存原始密码</div>
  <div id="infoBar" class="info" style="display:none">已设置账号: <strong id="infoUser"></strong></div>
  <form id="form">
    <div class="fg"><label for="uname">用户名 / 学号</label><input type="text" id="uname" placeholder="请输入用户名" required></div>
    <div class="fg"><label for="pwd">密码</label><input type="password" id="pwd" placeholder="请输入密码" required></div>
    <div class="btns">
      <button type="submit" class="btn-save" id="saveBtn">💾 保存</button>
      <button type="button" class="btn-clear" id="clearBtn">🗑 清除</button>
    </div>
  </form>
  <div id="message" class="msg"></div>
</div>
<script>
  const v = acquireVsCodeApi();
  const msg=id=>document.getElementById(id);
  function show(m,t,e){const el=msg('message');el.textContent=m;el.className='msg '+(e?'msg-err':'msg-ok')}

  msg('form').addEventListener('submit',e=>{
    e.preventDefault();
    const u=msg('uname').value.trim(),p=msg('pwd').value;
    if(!u||!p){show('用户名和密码不能为空',false,true);return}
    msg('saveBtn').disabled=true;msg('saveBtn').textContent='保存中…';
    v.postMessage({command:'save',username:u,password:p});
  });

  msg('clearBtn').addEventListener('click',()=>{v.postMessage({command:'clear'})});

  window.addEventListener('message',e=>{
    const d=e.data;
    switch(d.command){
      case 'saved':
        msg('uname').value=d.username||'';
        msg('pwd').value='';
        msg('infoBar').style.display=d.hasAccount?'block':'none';
        msg('infoUser').textContent=d.username||'';
        msg('saveBtn').disabled=false;msg('saveBtn').textContent='💾 保存';
        if(d.hasAccount)show('账号已保存',false,false);
        else show('账号已清除',false,false);
        break;
      case 'error':
        show(d.message,false,true);
        msg('saveBtn').disabled=false;msg('saveBtn').textContent='💾 保存';
        break;
    }
  });

  v.postMessage({command:'load'});
</script>
</body></html>`;
  }
}
