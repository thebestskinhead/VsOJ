/** 比赛信息 */
export interface Contest {
  cid: string;
  title: string;
  status: string;
  private: string;
  creator: string;
  isFavorite?: boolean;
}

/** 题目状态 */
export type ProblemStatus = 'accepted' | 'wrong' | 'pending';

/** 题目概要 */
export interface ProblemBrief {
  pid: string;
  title: string;
  cid: string;
  /** 提交状态: accepted=已AC, wrong=提交过但未AC, pending=未提交 */
  status: ProblemStatus;
  acceptedCount?: string;
  submissionCount?: string;
}

/** 题目详情 */
export interface ProblemDetail {
  cid: string;
  pid: string;
  title: string;
  description: string;
  inputDesc: string;
  outputDesc: string;
  sampleInput: string;
  sampleOutput: string;
}

/** 提交结果 */
export interface SubmitResult {
  success: boolean;
  message: string;
  solutionId?: string;
}

/** 状态记录 */
export interface StatusRecord {
  submitId: number;
  userId: string;
  userHref: string;
  probName: string;
  probHref: string;
  /** 题目编号（字母 A/B/C/D...） */
  problemId: string;
  resultCode: number;
  resultName: string;
  resultClass: string;
  resultHref: string;
  memory: number;
  time: number;
  language: string;
  sourceHref: string;
  codeLen: string;
  submitTime: string;
}

/** 分页信息 */
export interface Pagination {
  current: number;
  total: number;
  pages: { page: number; active: boolean; }[];
  first: number | null;
  last: number | null;
}

/** 比赛列表响应 */
export interface ContestListResponse {
  rows: Contest[];
  pagination: Pagination;
}

/** 判题结果映射 */
export const JUDGE_RESULT: { [key: number]: string } = {
  0: '等待',
  1: '等待重判',
  2: '编译中',
  3: '运行并评判',
  4: '正确',
  5: '格式错误',
  6: '答案错误',
  7: '时间超限',
  8: '内存超限',
  9: '输出超限',
  10: '运行错误',
  11: '编译错误',
  12: '编译成功',
  13: '运行完成',
};

/** 评判颜色 */
export const JUDGE_COLOR: { [key: number]: string } = {
  0: 'label gray',
  1: 'label label-info',
  2: 'label label-warning',
  3: 'label label-warning',
  4: 'label label-success',
  5: 'label label-danger',
  6: 'label label-danger',
  7: 'label label-warning',
  8: 'label label-warning',
  9: 'label label-warning',
  10: 'label label-warning',
  11: 'label label-warning',
  12: 'label label-warning',
  13: 'label label-info',
};

/** 文件扩展名到语言编号的映射 */
export const LANGUAGE_EXT: { [ext: string]: number } = {
  '.c': 0, '.h': 0,
  '.cpp': 1, '.cc': 1, '.cxx': 1, '.c++': 1, '.hpp': 1,
  '.pas': 2, '.pp': 2,
  '.java': 3,
  '.rb': 4,
  '.sh': 5, '.bash': 5,
  '.py': 6, '.py3': 6,
  '.php': 7,
  '.pl': 8, '.pm': 8,
  '.cs': 9,
  '.m': 10, '.mm': 10,
  '.bas': 11, '.bi': 11,
  '.scm': 12, '.ss': 12,
  '.cl': 13,
  '.clp': 14, '.clpp': 14,
  '.lua': 15,
  '.js': 16, '.ts': 16,
  '.go': 17,
  '.sql': 18, '.sqlite': 18,
  '.f': 19, '.f90': 19, '.f95': 19, '.for': 19,
  '.m2': 20,
};

/** 语言编号到名称映射 (来源: OJ /submit.php) */
export const LANGUAGE_NAME: { [lang: number]: string } = {
  0: 'C',
  1: 'C++',
  2: 'Pascal',
  3: 'Java',
  4: 'Ruby',
  5: 'Bash',
  6: 'Python',
  7: 'PHP',
  8: 'Perl',
  9: 'C#',
  10: 'Obj-C',
  11: 'FreeBasic',
  12: 'Scheme',
  13: 'Clang',
  14: 'Clang++',
  15: 'Lua',
  16: 'JavaScript',
  17: 'Go',
  18: 'SQL(sqlite3)',
  19: 'Fortran',
  20: 'Matlab(Octave)',
};

/** 状态结果样式类映射 */
export const STATUS_CLASS_MAP: { [key: number]: { name: string; class: string; short: string } } = {
  0: { name: '等待', class: 'status-wait', short: 'WAIT' },
  1: { name: '等待重判', class: 'status-wait', short: 'REJ' },
  2: { name: '编译中', class: 'status-run', short: 'COMP' },
  3: { name: '运行并评判', class: 'status-run', short: 'RUN' },
  4: { name: '正确', class: 'status-ac', short: 'AC' },
  5: { name: '格式错误', class: 'status-pe', short: 'PE' },
  6: { name: '答案错误', class: 'status-wa', short: 'WA' },
  7: { name: '时间超限', class: 'status-tle', short: 'TLE' },
  8: { name: '内存超限', class: 'status-mle', short: 'MLE' },
  9: { name: '输出超限', class: 'status-ole', short: 'OLE' },
  10: { name: '运行错误', class: 'status-re', short: 'RE' },
  11: { name: '编译错误', class: 'status-ce', short: 'CE' },
  12: { name: '编译成功', class: 'status-run', short: 'OK' },
  13: { name: '运行完成', class: 'status-run', short: 'DONE' },
};
