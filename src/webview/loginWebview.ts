import * as vscode from 'vscode';
import { AuthService } from '../api/auth';
import { StateManager } from '../utils/state';

/** 登录 Webview — 复用 login.js 登录弹窗逻辑 */

export class LoginWebview {
  private panel: vscode.WebviewPanel | undefined;
  private auth: AuthService;
  private state: StateManager;
  private onLoginSuccess: () => void;

  constructor(auth: AuthService, state: StateManager, onLoginSuccess: () => void) {
    this.auth = auth;
    this.state = state;
    this.onLoginSuccess = onLoginSuccess;
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ojLogin',
      'OJ 登录',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => { this.panel = undefined; });

    // 处理来自 webview 的消息
    this.panel.webview.onDidReceiveMessage(async (message: any) => {
      switch (message.command) {
        case 'login':
          await this.handleLogin(message.username, message.password, message.vcode, message.remember);
          break;
        case 'quickLogin':
          await this.handleQuickLogin(message.vcode);
          break;
        case 'refreshVcode':
          await this.loadVcode();
          break;
        case 'loadAccount':
          await this.loadAccount();
          break;
        case 'openAccountSettings':
          vscode.commands.executeCommand('oj.accountSettings');
          break;
      }
    });

    // 首个 /vcode.php 请求即建立会话 PHPSESSID，无需单独 initSession
    await this.loadVcode();
    await this.loadAccount();
  }

  private async loadAccount(): Promise<void> {
    const username = await this.state.getAccountUsername();
    if (this.panel && username) {
      this.panel.webview.postMessage({
        command: 'accountLoaded',
        username,
        hasAccount: true,
      });
    }
  }

  private async loadVcode(): Promise<void> {
    try {
      const vcodeBase64 = await this.auth.fetchVcodeImage();
      const csrfToken = await this.auth.fetchCsrfToken();
      if (this.panel) {
        this.panel.webview.postMessage({
          command: 'vcodeLoaded',
          vcodeBase64,
          csrfToken,
        });
      }
    } catch (e: any) {
      if (this.panel) {
        this.panel.webview.postMessage({
          command: 'error',
          message: `验证码加载失败: ${e.message}`,
        });
      }
    }
  }

  private async handleLogin(username: string, password: string, vcode: string, remember?: boolean): Promise<void> {
    try {
      const success = await this.auth.login(username, password, vcode);
      this.postResult(success);
      if (success) {
        // 记住我：登录成功时保存账号密码哈希
        if (remember) {
          await this.state.saveAccount(username, password);
        }
        setTimeout(() => { this.panel?.dispose(); this.onLoginSuccess(); }, 800);
      } else {
        await this.loadVcode();
      }
    } catch (e: any) {
      this.panel?.webview.postMessage({ command: 'loginFail', message: e.message });
      await this.loadVcode();
    }
  }

  private async handleQuickLogin(vcode: string): Promise<void> {
    try {
      const username = await this.state.getAccountUsername();
      const pwdHash = await this.state.getAccountPasswordHash();
      if (!username || !pwdHash) {
        this.panel?.webview.postMessage({ command: 'loginFail', message: '未设置账号，请先保存账号密码' });
        return;
      }
      const success = await this.auth.quickLogin(username, pwdHash, vcode);
      this.postResult(success);
      if (success) {
        setTimeout(() => { this.panel?.dispose(); this.onLoginSuccess(); }, 800);
      } else {
        await this.loadVcode();
      }
    } catch (e: any) {
      this.panel?.webview.postMessage({ command: 'loginFail', message: e.message });
      await this.loadVcode();
    }
  }

  private postResult(success: boolean): void {
    this.panel?.webview.postMessage({
      command: success ? 'loginSuccess' : 'loginFail',
      message: success ? '登录成功' : '登录失败，请检查验证码',
    });
  }

  getHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#e8f5e9,#c8e6c9)}
  .box{background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.15);width:380px;max-width:90vw;padding:32px}
  h2{text-align:center;color:#2e7d32;margin-bottom:20px;font-size:20px}
  .fg{margin-bottom:14px}
  .fg label{display:block;margin-bottom:4px;color:#555;font-size:13px;font-weight:500}
  .fg input{width:100%;padding:10px 12px;border:1px solid #c8e6c9;border-radius:6px;font-size:14px;outline:none;transition:border-color .2s}
  .fg input:focus{border-color:#4CAF50}
  .vcode-wrap{display:flex;gap:10px;align-items:center}
  .vcode-wrap input{flex:1}
  .vcode-wrap img{height:40px;border-radius:4px;cursor:pointer;border:1px solid #c8e6c9}
  .btns{display:flex;gap:8px;margin-top:4px}
  button{flex:1;padding:12px 0;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:500;transition:background .2s}
  .btn-login{background:#4CAF50;color:#fff}.btn-login:hover{background:#43a047}
  .btn-quick{background:#fff;color:#4CAF50;border:2px solid #4CAF50}.btn-quick:hover{background:#e8f5e9}
  button:disabled{opacity:.6;cursor:not-allowed}
  .msg{margin-top:10px;font-size:13px;text-align:center;min-height:18px}
  .msg-err{color:#c62828}.msg-ok{color:#2e7d32}
  .quick-hint{text-align:center;margin-bottom:12px;font-size:12px;color:#888;display:none}
  .quick-hint.show{display:block}
  .quick-hint strong{color:#2e7d32}
  .divider{display:flex;align-items:center;margin:12px 0;gap:10px}
  .divider::before,.divider::after{content:'';flex:1;border-bottom:1px solid #e0e0e0}
  .divider span{color:#aaa;font-size:11px}
  .remember-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;font-size:12px;color:#888}
  .remember-row label{display:flex;align-items:center;gap:6px;cursor:pointer;color:#666}
  .remember-row input[type=checkbox]{accent-color:#4CAF50;width:14px;height:14px}
  .manage-link{color:#4CAF50;cursor:pointer;text-decoration:underline}
  .manage-link:hover{color:#2e7d32}
</style></head>
<body>
<div class="box">
  <h2>OJ 用户登录</h2>
  <div class="quick-hint" id="quickHint">快捷用户: <strong id="quickUser"></strong></div>
  <form id="loginForm">
    <div class="fg"><label for="username">用户名 / 学号</label><input type="text" id="username" placeholder="请输入用户名" required></div>
    <div class="fg"><label for="password">密码</label><input type="password" id="password" placeholder="请输入密码" required></div>
    <div class="fg"><label>验证码</label>
      <div class="vcode-wrap">
        <input type="text" id="vcode" placeholder="验证码" required maxlength="4" autocomplete="off">
        <img id="vcodeImg" src="" alt="验证码" title="点击刷新" onclick="refreshVcode()">
      </div>
    </div>
    <div class="remember-row">
      <label><input type="checkbox" id="rememberMe"> 记住我（登录成功后保存账号）</label>
      <span class="manage-link" onclick="openAccountSettings()">管理快捷登录</span>
    </div>
    <div class="btns">
      <button type="submit" class="btn-login" id="submitBtn">登 录</button>
      <button type="button" class="btn-quick" id="quickBtn" style="display:none" onclick="quickLogin()">⚡ 快捷登录</button>
    </div>
  </form>
  <div id="message" class="msg"></div>
</div>
<script>
  const v=acquireVsCodeApi();
  const $=id=>document.getElementById(id);
  function show(m,e){const el=$('message');el.textContent=m;el.className='msg '+(e?'msg-err':'msg-ok')}
  function refreshVcode(){v.postMessage({command:'refreshVcode'})}
  function setBtns(on){$('submitBtn').disabled=!on;$('quickBtn').disabled=!on}

  $('loginForm').addEventListener('submit',e=>{
    e.preventDefault();setBtns(false);show('',false);
    v.postMessage({command:'login',username:$('username').value.trim(),password:$('password').value,vcode:$('vcode').value.trim(),remember:$('rememberMe').checked});
  });

  function quickLogin(){
    const vc=$('vcode').value.trim();
    if(!vc){show('请输入验证码',true);return}
    setBtns(false);show('',false);
    v.postMessage({command:'quickLogin',vcode:vc});
  }

  function openAccountSettings(){
    v.postMessage({command:'openAccountSettings'});
  }

  window.addEventListener('message',e=>{
    const d=e.data;
    switch(d.command){
      case 'vcodeLoaded':
        $('vcodeImg').src=d.vcodeBase64;setBtns(true);break;
      case 'accountLoaded':
        $('username').value=d.username;$('password').value='********';
        $('quickUser').textContent=d.username;$('quickHint').classList.add('show');
        $('quickBtn').style.display='';break;
      case 'loginSuccess':show(d.message,false);break;
      case 'loginFail':show(d.message,true);setBtns(true);break;
      case 'error':show(d.message,true);break;
    }
  });

  v.postMessage({command:'loadAccount'});
</script>
</body></html>`;
  }

  updateHtml(): void {
    if (this.panel) { this.panel.webview.html = this.getHtml(); }
  }
}
