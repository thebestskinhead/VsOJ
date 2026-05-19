import * as cheerio from 'cheerio';
import { Contest, ProblemBrief, ProblemDetail, Pagination, StatusRecord, STATUS_CLASS_MAP, ProblemStatus } from '../types';

/** HTML 解析器 — 比赛/题目/状态 */

type CheerioAPI = ReturnType<typeof cheerio.load>;

function loadHtml(html: string): CheerioAPI {
  return cheerio.load(html);
}

/** 解析比赛列表 (contest.php) */
export function parseContestList(html: string): { rows: Contest[]; pagination: Pagination } {
  const $ = loadHtml(html);
  const rows: Contest[] = [];

  $('tbody tr').each((_i: number, tr: cheerio.Element) => {
    const tds = $(tr).find('td');
    if (tds.length >= 5) {
      const id = $(tds[0]).text().trim();
      const a = $(tds[1]).find('a');
      const name = a.length ? a.text().trim() : $(tds[1]).text().trim();
      const status = $(tds[2]).text().trim();
      const priv = $(tds[3]).text().trim();
      const creator = $(tds[4]).text().trim();
      rows.push({ cid: id, title: name, status, private: priv, creator });
    }
  });

  const pagination: Pagination = { current: 1, total: 1, pages: [], first: null, last: null };
  const nav = $('nav.center ul.pagination');
  if (nav.length) {
    nav.find('li').each((_i: number, li: cheerio.Element) => {
      const a = $(li).find('a');
      if (!a.length) { return; }
      const href = a.attr('href') || '';
      const text = a.text().trim();
      const m = href.match(/page=(\d+)/);
      const pageNum = m ? parseInt(m[1], 10) : null;

      if ($(li).hasClass('active') && pageNum) {
        pagination.current = pageNum;
      }
      if (text === '<<' || text === '&lt;&lt;') {
        pagination.first = pageNum || 1;
      } else if (text === '>>' || text === '&gt;&gt;') {
        pagination.last = pageNum;
        if (pageNum) { pagination.total = pageNum; }
      } else if (pageNum && !isNaN(pageNum)) {
        pagination.pages.push({ page: pageNum, active: $(li).hasClass('active') });
        if (!pagination.total || pageNum > pagination.total) {
          pagination.total = pageNum;
        }
      }
    });
    if (!pagination.current && pagination.pages.length) {
      pagination.current = pagination.pages[0].page;
    }
  }

  return { rows, pagination };
}

/** 解析题目列表 (contest.php?cid=xxx) */
export function parseProblemList(html: string): { title: string; problems: ProblemBrief[] } {
  const $ = loadHtml(html);
  const title = $('h3').first().text().trim();
  const problems: ProblemBrief[] = [];

  $('table#problemset tbody tr').each((index: number, tr: cheerio.Element) => {
    const cells = $(tr).find('td');
    if (cells.length < 6) { return; }

    const problemId = $(cells[1]).text().trim();
    const titleLink = $(cells[2]).find('a');
    const probTitle = titleLink.length ? titleLink.text().trim() : $(cells[2]).text().trim();
    const href = titleLink.length ? titleLink.attr('href') || '#' : '#';
    const accepted = $(cells[4]).text().trim();
    const submissions = $(cells[5]).text().trim();
    const statusHtml = $(cells[0]).html() || '';

    // 三种状态：accepted=正确(green), wrong=提交过但未AC(red), pending=未提交
    let status: ProblemStatus = 'pending';
    if (statusHtml.includes('green')) {
      status = 'accepted';
    } else if (statusHtml.includes('red')) {
      status = 'wrong';
    }

    let currentPid = String(index);
    if (href !== '#') {
      const m = href.match(/pid=(\d+)/);
      if (m) { currentPid = m[1]; }
    }

    problems.push({
      pid: currentPid,
      title: probTitle || problemId,
      cid: '',
      status,
      acceptedCount: accepted,
      submissionCount: submissions,
    });
  });

  return { title, problems };
}

/** 解析题目详情 (problem.php) */
export function parseProblemDetail(html: string): ProblemDetail | null {
  const $ = loadHtml(html);

  // 标题
  const title = $('h3').first().text().trim() || $('title').text().trim();

  // 根据 panel-heading h4 查找对应的 panel-body
  function getPanelBody(headingText: string): cheerio.Cheerio | null {
    const panels = $('.panel.panel-default, .panel');
    for (let i = 0; i < panels.length; i++) {
      const heading = $(panels[i]).find('.panel-heading h4');
      if (heading.length && heading.text().trim() === headingText) {
        return $(panels[i]).find('.panel-body');
      }
    }
    return null;
  }

  function getPanelHtml(headingText: string): string {
    const body = getPanelBody(headingText);
    return body ? body.html() || '' : '';
  }

  const description = getPanelHtml('题目描述');
  const inputDesc = getPanelHtml('输入');
  const outputDesc = getPanelHtml('输出');

  // 样例输入/输出（严格保留空格和换行）
  function getRawText(selector: string): string {
    const el = $(selector);
    if (!el.length) { return ''; }
    return getNodeRawText($, el.get(0)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  const sampleInput = getRawText('#sampleinput');
  const sampleOutput = getRawText('#sampleoutput');

  // 提取 cid 和 pid
  const cidMatch = html.match(/cid[=:](\d+)/);
  const pidMatch = html.match(/pid[=:](\d+)/);

  return {
    cid: cidMatch ? cidMatch[1] : '',
    pid: pidMatch ? pidMatch[1] : '',
    title,
    description,
    inputDesc,
    outputDesc,
    sampleInput,
    sampleOutput,
  };
}

/** 递归提取纯文本（处理 BR 标签） */
function getNodeRawText($: CheerioAPI, node: cheerio.Element): string {
  if (node.type === 'text') {
    return node.data || '';
  }
  if (node.type !== 'tag') {
    return '';
  }
  const tagName = node.tagName.toLowerCase();
  if (tagName === 'br') {
    return '\n';
  }
  let s = '';
  $(node).contents().each((_i: number, child: cheerio.Element) => {
    s += getNodeRawText($, child);
  });
  return s;
}

/** 解析提交状态 (status.php) */
export function parseStatusTable(html: string): StatusRecord[] {
  const $ = loadHtml(html);
  const table = $('table#result-tab');
  if (!table.length) { return []; }

  const rows: StatusRecord[] = [];
  table.find('tbody tr').each((_i: number, tr: cheerio.Element) => {
    const cells = $(tr).find('td');
    if (cells.length < 6) { return; }

    const submitId = parseInt($(cells[0]).text().trim(), 10) || 0;
    const userCell = $(cells[1]);
    const userLink = userCell.find('a');
    const userId = userLink.length ? userLink.text().trim() : userCell.text().trim();
    const userHref = userLink.attr('href') || '';

    const probCell = $(cells[2]);
    const probLink = probCell.find('a');
    const probName = probLink.length ? probLink.text().trim() : probCell.text().trim();
    const probHref = probLink.attr('href') || '';

    // 从 probHref 提取数字 pid 并转为字母编号
    const pidMatch = probHref.match(/pid=(\d+)/);
    const numericPid = pidMatch ? parseInt(pidMatch[1], 10) : -1;
    const problemId = numericPid >= 0 ? numToLetter(numericPid) : (probName.substring(0, 4) || '?');

    const resultCell = $(cells[3]);
    const hiddenSpan = resultCell.find('span[result]');
    const resultCode = parseInt(hiddenSpan.attr('result') || '0', 10);
    const resultLink = resultCell.find('a');
    const resultHref = resultLink.attr('href') || '';
    const resultText = resultCell.text().trim();

    const memCell = $(cells[4]);
    const memory = parseInt((memCell.find('div').text() || memCell.text()).trim(), 10) || 0;

    const timeCell = $(cells[5]);
    const time = parseInt((timeCell.find('div').text() || timeCell.text()).trim(), 10) || 0;

    const langCell = $(cells[6]);
    const langLinks = langCell.find('a');
    let language = '';
    let sourceHref = '';
    if (langLinks.length > 0) {
      language = $(langLinks[0]).text().trim();
      sourceHref = $(langLinks[0]).attr('href') || '';
    }

    const codeLen = $(cells[7]).text().trim() || '';
    const submitTime = $(cells[8]).text().trim() || '';

    const statusInfo = STATUS_CLASS_MAP[resultCode] || { name: resultText, class: 'status-wait', short: '???' };

    rows.push({
      submitId,
      userId,
      userHref,
      probName,
      probHref,
      problemId,
      resultCode,
      resultName: statusInfo.name,
      resultClass: statusInfo.class,
      resultHref,
      memory,
      time,
      language,
      sourceHref,
      codeLen,
      submitTime,
    });
  });

  return rows;
}

/** 解析 CSRF Token */
export function parseCsrfToken(html: string): string {
  const $ = loadHtml(html);
  return $('input[name="csrf"]').attr('value') || '';
}

/** 解析学号 (modifypage.php) */
export function parseStudentId(html: string): string | null {
  const $ = loadHtml(html);
  const labels = $('label');
  for (let i = 0; i < labels.length; i++) {
    const text = $(labels[i]).text().trim();
    if (text.includes('用户名') || text.includes('学号')) {
      const nextLabel = $(labels[i + 1]);
      if (nextLabel.length) {
        const id = nextLabel.text().trim();
        if (/^\d{6,}$/.test(id)) { return id; }
      }
    }
    if (/^\d{6,}$/.test(text)) { return text; }
  }
  return null;
}

/** 数字 PID 转字母编号：0→A, 1→B, ..., 25→Z, 26→AA, ... */
function numToLetter(n: number): string {
  if (n < 0) { return '?'; }
  let s = '';
  let num = n;
  do {
    s = String.fromCharCode(65 + (num % 26)) + s;
    num = Math.floor(num / 26) - 1;
  } while (num >= 0);
  return s;
}
