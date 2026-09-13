// 统一测试入口：按文件名顺序运行 test/*.test.js，任一失败则整体失败。
// 运行：npm test
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

// 清掉 shell 可能自带的代理，避免劫持 127.0.0.1 上的本地测试服务器
const env = { ...process.env };
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete env[k];
}
env.NO_PROXY = '*';
env.no_proxy = '*';

const failed = [];
for (const f of files) {
  console.log(`\n══════════════════ ${f} ══════════════════`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit', env });
  if (r.status !== 0) { failed.push(`${f} (exit ${r.status})`); }
}

console.log('\n══════════════════ 汇总 ══════════════════');
console.log(`共 ${files.length} 个套件，失败 ${failed.length} 个`);
if (failed.length) {
  for (const f of failed) { console.log(`  ❌ ${f}`); }
  process.exit(1);
}
console.log('✅ 全部套件通过');
