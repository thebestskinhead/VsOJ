import * as vscode from 'vscode';
import { hex_md5 } from './crypto';

/** 全局状态管理封装 — 基于 ExtensionContext.globalState 和 secrets */

const KEYS = {
  FAVORITES: 'oj_favorites',
  CURRENT_CID: 'oj_current_cid',
  CURRENT_PID: 'oj_current_pid',
  STUDENT_ID: 'oj_student_id',
  COOKIE_SESSION: 'oj_phpsessid',
  LOGGED_IN: 'oj_logged_in',
  ACCOUNT_USERNAME: 'oj_account_username',
};

export class StateManager {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /** 收藏的比赛 ID 列表 */
  getFavorites(): string[] {
    return this.context.globalState.get<string[]>(KEYS.FAVORITES, []);
  }

  async setFavorites(ids: string[]): Promise<void> {
    await this.context.globalState.update(KEYS.FAVORITES, ids);
  }

  async addFavorite(cid: string): Promise<void> {
    const favs = this.getFavorites();
    if (!favs.includes(cid)) {
      favs.push(cid);
      await this.setFavorites(favs);
    }
  }

  async removeFavorite(cid: string): Promise<void> {
    const favs = this.getFavorites().filter(id => id !== cid);
    await this.setFavorites(favs);
  }

  async toggleFavorite(cid: string): Promise<boolean> {
    const isFav = this.isFavorite(cid);
    if (isFav) {
      await this.removeFavorite(cid);
    } else {
      await this.addFavorite(cid);
    }
    return !isFav;
  }

  isFavorite(cid: string): boolean {
    return this.getFavorites().includes(cid);
  }

  /** 当前比赛 ID */
  getCurrentCid(): string | undefined {
    return this.context.globalState.get<string>(KEYS.CURRENT_CID);
  }

  async setCurrentCid(cid: string | undefined): Promise<void> {
    await this.context.globalState.update(KEYS.CURRENT_CID, cid);
  }

  /** 当前题目 ID */
  getCurrentPid(): string | undefined {
    return this.context.globalState.get<string>(KEYS.CURRENT_PID);
  }

  async setCurrentPid(pid: string | undefined): Promise<void> {
    await this.context.globalState.update(KEYS.CURRENT_PID, pid);
  }

  /** 学号 */
  getStudentId(): string | undefined {
    return this.context.globalState.get<string>(KEYS.STUDENT_ID);
  }

  async setStudentId(id: string | undefined): Promise<void> {
    await this.context.globalState.update(KEYS.STUDENT_ID, id);
  }

  /** Cookie/Session 安全存储 */
  async getSessionCookie(): Promise<string | undefined> {
    return this.context.secrets.get(KEYS.COOKIE_SESSION);
  }

  async setSessionCookie(cookie: string): Promise<void> {
    await this.context.secrets.store(KEYS.COOKIE_SESSION, cookie);
  }

  async clearSessionCookie(): Promise<void> {
    await this.context.secrets.delete(KEYS.COOKIE_SESSION);
  }

  /** 登录状态 */
  isLoggedIn(): boolean {
    return this.context.globalState.get<boolean>(KEYS.LOGGED_IN, false);
  }

  async setLoggedIn(value: boolean): Promise<void> {
    await this.context.globalState.update(KEYS.LOGGED_IN, value);
    await vscode.commands.executeCommand('setContext', 'oj.loggedIn', value);
  }

  /** 存储的账号 — 明文存储 username，secret 存储密码哈希 */
  async getAccountUsername(): Promise<string | undefined> {
    return this.context.globalState.get<string>(KEYS.ACCOUNT_USERNAME);
  }

  async setAccountUsername(username: string): Promise<void> {
    await this.context.globalState.update(KEYS.ACCOUNT_USERNAME, username);
  }

  async getAccountPasswordHash(): Promise<string | undefined> {
    return this.context.secrets.get('oj_account_pwd_hash');
  }

  async setAccountPasswordHash(hash: string): Promise<void> {
    await this.context.secrets.store('oj_account_pwd_hash', hash);
  }

  async saveAccount(username: string, plainPassword: string): Promise<void> {
    await this.setAccountUsername(username);
    await this.setAccountPasswordHash(hex_md5(plainPassword));
  }

  hasAccount(): boolean {
    return !!this.context.globalState.get<string>(KEYS.ACCOUNT_USERNAME);
  }
}
