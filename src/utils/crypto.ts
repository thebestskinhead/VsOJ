/** MD5 工具函数 — 从火猴 core.js 提取 */

let hexcase = 0;

export function hex_md5(a: string): string {
  return rstr2hex(rstr_md5(str2rstr_utf8(a)));
}

function rstr_md5(a: string): string {
  return binl2rstr(binl_md5(rstr2binl(a), a.length * 8));
}

function rstr2hex(c: string): string {
  const f = hexcase ? '0123456789ABCDEF' : '0123456789abcdef';
  let b = '';
  for (let d = 0; d < c.length; d++) {
    const a = c.charCodeAt(d);
    b += f.charAt((a >>> 4) & 15) + f.charAt(a & 15);
  }
  return b;
}

function str2rstr_utf8(c: string): string {
  let b = '';
  let d = -1;
  while (++d < c.length) {
    let a = c.charCodeAt(d);
    const e = d + 1 < c.length ? c.charCodeAt(d + 1) : 0;
    if (55296 <= a && a <= 56319 && 56320 <= e && e <= 57343) {
      a = 65536 + ((a & 1023) << 10) + (e & 1023);
      d++;
    }
    if (a <= 127) {
      b += String.fromCharCode(a);
    } else if (a <= 2047) {
      b += String.fromCharCode(192 | ((a >>> 6) & 31), 128 | (a & 63));
    } else if (a <= 65535) {
      b += String.fromCharCode(224 | ((a >>> 12) & 15), 128 | ((a >>> 6) & 63), 128 | (a & 63));
    } else if (a <= 2097151) {
      b += String.fromCharCode(240 | ((a >>> 18) & 7), 128 | ((a >>> 12) & 63), 128 | ((a >>> 6) & 63), 128 | (a & 63));
    }
  }
  return b;
}

function rstr2binl(b: string): number[] {
  const a: number[] = Array(b.length >> 2);
  for (let c = 0; c < a.length; c++) { a[c] = 0; }
  for (let c = 0; c < b.length * 8; c += 8) {
    a[c >> 5] |= (b.charCodeAt(c / 8) & 255) << (c % 32);
  }
  return a;
}

function binl2rstr(b: number[]): string {
  let a = '';
  for (let c = 0; c < b.length * 32; c += 8) {
    a += String.fromCharCode((b[c >> 5] >>> (c % 32)) & 255);
  }
  return a;
}

function binl_md5(p: number[], k: number): number[] {
  p[k >> 5] |= 128 << ((k) % 32);
  p[(((k + 64) >>> 9) << 4) + 14] = k;
  let o = 1732584193;
  let n = -271733879;
  let m = -1732584194;
  let l = 271733878;
  for (let g = 0; g < p.length; g += 16) {
    const j = o;
    const h = n;
    const f = m;
    const e = l;
    o = md5_ff(o, n, m, l, p[g + 0], 7, -680876936);
    l = md5_ff(l, o, n, m, p[g + 1], 12, -389564586);
    m = md5_ff(m, l, o, n, p[g + 2], 17, 606105819);
    n = md5_ff(n, m, l, o, p[g + 3], 22, -1044525330);
    o = md5_ff(o, n, m, l, p[g + 4], 7, -176418897);
    l = md5_ff(l, o, n, m, p[g + 5], 12, 1200080426);
    m = md5_ff(m, l, o, n, p[g + 6], 17, -1473231341);
    n = md5_ff(n, m, l, o, p[g + 7], 22, -45705983);
    o = md5_ff(o, n, m, l, p[g + 8], 7, 1770035416);
    l = md5_ff(l, o, n, m, p[g + 9], 12, -1958414417);
    m = md5_ff(m, l, o, n, p[g + 10], 17, -42063);
    n = md5_ff(n, m, l, o, p[g + 11], 22, -1990404162);
    o = md5_ff(o, n, m, l, p[g + 12], 7, 1804603682);
    l = md5_ff(l, o, n, m, p[g + 13], 12, -40341101);
    m = md5_ff(m, l, o, n, p[g + 14], 17, -1502002290);
    n = md5_ff(n, m, l, o, p[g + 15], 22, 1236535329);
    o = md5_gg(o, n, m, l, p[g + 1], 5, -165796510);
    l = md5_gg(l, o, n, m, p[g + 6], 9, -1069501632);
    m = md5_gg(m, l, o, n, p[g + 11], 14, 643717713);
    n = md5_gg(n, m, l, o, p[g + 0], 20, -373897302);
    o = md5_gg(o, n, m, l, p[g + 5], 5, -701558691);
    l = md5_gg(l, o, n, m, p[g + 10], 9, 38016083);
    m = md5_gg(m, l, o, n, p[g + 15], 14, -660478335);
    n = md5_gg(n, m, l, o, p[g + 4], 20, -405537848);
    o = md5_gg(o, n, m, l, p[g + 9], 5, 568446438);
    l = md5_gg(l, o, n, m, p[g + 14], 9, -1019803690);
    m = md5_gg(m, l, o, n, p[g + 3], 14, -187363961);
    n = md5_gg(n, m, l, o, p[g + 8], 20, 1163531501);
    o = md5_gg(o, n, m, l, p[g + 13], 5, -1444681467);
    l = md5_gg(l, o, n, m, p[g + 2], 9, -51403784);
    m = md5_gg(m, l, o, n, p[g + 7], 14, 1735328473);
    n = md5_gg(n, m, l, o, p[g + 12], 20, -1926607734);
    o = md5_hh(o, n, m, l, p[g + 5], 4, -378558);
    l = md5_hh(l, o, n, m, p[g + 8], 11, -2022574463);
    m = md5_hh(m, l, o, n, p[g + 11], 16, 1839030562);
    n = md5_hh(n, m, l, o, p[g + 14], 23, -35309556);
    o = md5_hh(o, n, m, l, p[g + 1], 4, -1530992060);
    l = md5_hh(l, o, n, m, p[g + 4], 11, 1272893353);
    m = md5_hh(m, l, o, n, p[g + 7], 16, -155497632);
    n = md5_hh(n, m, l, o, p[g + 10], 23, -1094730640);
    o = md5_hh(o, n, m, l, p[g + 13], 4, 681279174);
    l = md5_hh(l, o, n, m, p[g + 0], 11, -358537222);
    m = md5_hh(m, l, o, n, p[g + 3], 16, -722521979);
    n = md5_hh(n, m, l, o, p[g + 6], 23, 76029189);
    o = md5_hh(o, n, m, l, p[g + 9], 4, -640364487);
    l = md5_hh(l, o, n, m, p[g + 12], 11, -421815835);
    m = md5_hh(m, l, o, n, p[g + 15], 16, 530742520);
    n = md5_hh(n, m, l, o, p[g + 2], 23, -995338651);
    o = md5_ii(o, n, m, l, p[g + 0], 6, -198630844);
    l = md5_ii(l, o, n, m, p[g + 7], 10, 1126891415);
    m = md5_ii(m, l, o, n, p[g + 14], 15, -1416354905);
    n = md5_ii(n, m, l, o, p[g + 5], 21, -57434055);
    o = md5_ii(o, n, m, l, p[g + 12], 6, 1700485571);
    l = md5_ii(l, o, n, m, p[g + 3], 10, -1894986606);
    m = md5_ii(m, l, o, n, p[g + 10], 15, -1051523);
    n = md5_ii(n, m, l, o, p[g + 1], 21, -2054922799);
    o = md5_ii(o, n, m, l, p[g + 8], 6, 1873313359);
    l = md5_ii(l, o, n, m, p[g + 15], 10, -30611744);
    m = md5_ii(m, l, o, n, p[g + 6], 15, -1560198380);
    n = md5_ii(n, m, l, o, p[g + 13], 21, 1309151649);
    o = md5_ii(o, n, m, l, p[g + 4], 6, -145523070);
    l = md5_ii(l, o, n, m, p[g + 11], 10, -1120210379);
    m = md5_ii(m, l, o, n, p[g + 2], 15, 718787259);
    n = md5_ii(n, m, l, o, p[g + 9], 21, -343485551);
    o = safe_add(o, j);
    n = safe_add(n, h);
    m = safe_add(m, f);
    l = safe_add(l, e);
  }
  return [o, n, m, l];
}

function md5_cmn(h: number, e: number, d: number, c: number, g: number, f: number): number {
  return safe_add(bit_rol(safe_add(safe_add(e, h), safe_add(c, f)), g), d);
}

function md5_ff(g: number, f: number, k: number, j: number, e: number, i: number, h: number): number {
  return md5_cmn((f & k) | ((~f) & j), g, f, e, i, h);
}

function md5_gg(g: number, f: number, k: number, j: number, e: number, i: number, h: number): number {
  return md5_cmn((f & j) | (k & (~j)), g, f, e, i, h);
}

function md5_hh(g: number, f: number, k: number, j: number, e: number, i: number, h: number): number {
  return md5_cmn(f ^ k ^ j, g, f, e, i, h);
}

function md5_ii(g: number, f: number, k: number, j: number, e: number, i: number, h: number): number {
  return md5_cmn(k ^ (f | (~j)), g, f, e, i, h);
}

function safe_add(a: number, d: number): number {
  const c = (a & 65535) + (d & 65535);
  const b = (a >> 16) + (d >> 16) + (c >> 16);
  return (b << 16) | (c & 65535);
}

function bit_rol(a: number, b: number): number {
  return (a << b) | (a >>> (32 - b));
}
