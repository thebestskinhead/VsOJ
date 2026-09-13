// 题面图片本地化（media/localize.ts）— 依赖注入，无需 vscode 桩
// 运行：node test/localize.test.js
const { makeChecker } = require('./helpers/stub');
const L = require('../out/media/localize.js');

const { check, ok, done } = makeChecker();

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const URL_A = '/JudgeOnline/upload/image/20170611/a.png';
const URL_B = '/upload/image/x/b.jpg';

function makeDeps(opts = {}) {
  const local = new Map(Object.entries(opts.local || {}));
  const calls = { read: 0, write: 0, fetch: 0 };
  const deps = {
    readLocal: async (url) => { calls.read += 1; return local.get(url); },
    writeLocal: async (url, buf) => { calls.write += 1; local.set(url, buf); },
    fetchRemote: async (url) => {
      calls.fetch += 1;
      if (opts.fetchFails) { throw new Error('连接超时'); }
      return PNG;
    },
    isOffline: () => !!opts.offline,
    baseUrl: () => 'http://acm.hnust.edu.cn',
  };
  return { deps, calls, local };
}

const htmlWith = (...urls) => urls.map(u => `<img src="${u}" alt="" />`).join('\n');

(async () => {
  console.log('[1] collectImageUrls');
  check('无图片', L.collectImageUrls('<p>hello</p>'), []);
  check('单个相对路径', L.collectImageUrls(htmlWith(URL_A)), [URL_A]);
  check('去重且保持顺序', L.collectImageUrls(htmlWith(URL_B, URL_A, URL_B)), [URL_B, URL_A]);
  check('忽略绝对 URL（页脚二维码不受影响）',
    L.collectImageUrls('<img src="http://other.site/x.png" /><img src="https://y/z.png" />'), []);
  check('忽略 data URI', L.collectImageUrls('<img src="data:image/png;base64,AAA" />'), []);
  check('单引号写法也能识别', L.collectImageUrls(`<img src='${URL_A}' />`), [URL_A]);
  check('mimeOf 推断', L.mimeOf(URL_A), 'image/png');
  check('mimeOf 未知扩展名回退 png', L.mimeOf('/a/b.xyz'), 'image/png');
  check('mimeOf 忽略查询串', L.mimeOf('/a/b.jpg?v=2'), 'image/jpeg');

  console.log('\n[2] 无图片时零开销');
  {
    const { deps, calls } = makeDeps();
    const r = await L.localizeImages('<p>没有图</p>', deps);
    check('html 原样', r.html, '<p>没有图</p>');
    check('total=0', r.total, 0);
    check('未读本地', calls.read, 0);
  }

  console.log('\n[3] 本地命中 → 零网络');
  {
    const { deps, calls } = makeDeps({ local: { [URL_A]: PNG } });
    const r = await L.localizeImages(htmlWith(URL_A), deps);
    check('inlined=1', r.inlined, 1);
    check('未联网', calls.fetch, 0);
    check('未重复落盘', calls.write, 0);
    check('已内联为 data URI', r.html.includes(`src="data:image/png;base64,${PNG.toString('base64')}"`), true);
  }

  console.log('\n[4] 未缓存 + 在线 → 抓取并落盘');
  {
    const { deps, calls, local } = makeDeps();
    const r = await L.localizeImages(htmlWith(URL_A), deps);
    check('联网一次', calls.fetch, 1);
    check('落盘一次', calls.write, 1);
    check('本地已存', local.has(URL_A), true);
    check('inlined=1', r.inlined, 1);
    check('remote=0', r.remote, 0);
  }

  console.log('\n[5] 未缓存 + 离线 → 保留绝对 URL，绝不联网');
  {
    const { deps, calls } = makeDeps({ offline: true });
    const r = await L.localizeImages(htmlWith(URL_A), deps);
    check('零联网', calls.fetch, 0);
    check('零落盘', calls.write, 0);
    check('remote=1', r.remote, 1);
    check('替换为绝对 URL',
      r.html.includes(`src="http://acm.hnust.edu.cn${URL_A}"`), true);
  }

  console.log('\n[6] 离线但本地有 → 仍能内联');
  {
    const { deps, calls } = makeDeps({ offline: true, local: { [URL_A]: PNG } });
    const r = await L.localizeImages(htmlWith(URL_A), deps);
    check('零联网', calls.fetch, 0);
    check('已内联', r.inlined, 1);
  }

  console.log('\n[7] 抓取失败（在线）→ 保留绝对 URL');
  {
    const { deps, calls } = makeDeps({ fetchFails: true });
    const r = await L.localizeImages(htmlWith(URL_A), deps);
    check('尝试过联网', calls.fetch, 1);
    check('未落盘', calls.write, 0);
    check('remote=1', r.remote, 1);
  }

  console.log('\n[8] 多图混合 + 同 URL 重复出现');
  {
    const { deps, calls } = makeDeps({ local: { [URL_B]: PNG } });
    const r = await L.localizeImages(htmlWith(URL_A, URL_B, URL_A), deps);
    check('去重后 total=2', r.total, 2);
    check('inlined=2（URL_A 新抓 + URL_B 本地命中）', r.inlined, 2);
    check('URL_A 只抓一次', calls.fetch, 1);
    check('只落盘一次（URL_B 命中本地，无需写）', calls.write, 1);
    // .png 与 .jpg 的 MIME 不同，data URI 前缀也不同
    const pngHits = r.html.split('data:image/png;base64,').length - 1;
    const jpgHits = r.html.split('data:image/jpeg;base64,').length - 1;
    check('重复出现的 PNG 两处都被替换', pngHits, 2);
    check('JPG 一处被替换', jpgHits, 1);
  }

  console.log('\n[9] 不误伤非 src 属性与其它 URL');
  {
    const { deps } = makeDeps({ local: { [URL_A]: PNG } });
    const html = `<a href="${URL_A}">链接</a><img src="${URL_A}" />`;
    const r = await L.localizeImages(html, deps);
    check('a href 保持原样', r.html.includes(`href="${URL_A}"`), true);
    check('img src 已内联', r.html.includes('src="data:image/png;base64,'), true);
  }

  process.exit(done() ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
