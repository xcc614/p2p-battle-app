// ===== 对局令牌编解码（固定格式参数提取 + 压缩拼接）=====
// 完整连接令牌为固定格式，包含三类关键参数：
//   服务器地址（IPv4 或域名，用于定位信令服务）
//   信令端口（WebSocket/HTTP）
//   房间码（信令服务内的房间标识）
// 传统做法直接把完整地址明文字符串丢出去；本模块改为把固定格式里的
// "会变的"关键参数（host 字节 / 端口 / 房间码）单独取出，按紧凑二进制
// 打包再转 base64url 压缩成短令牌（P2B 前缀），分享时只复制短令牌。
// 接收方拿到令牌后解压，把参数拼接还原出完整连接信息，即可直连房间。
//
// 二进制布局（V1）：
//   [ver 1B]=1
//   [type 1B] 0=IPv4, 1=域名
//   type0: [ip4 a.b.c.d 各 1B 共 4B] + [port 2B 大端]
//   type1: [hostLen 1B] + [host UTF-8 字节] + [port 2B 大端]
//   [roomLen 1B] + [room ascii] + [crc8 1B]（对全部前序字节校验）
// 传输使用 base64url（去 +/=），成品约 25 字符，适合聊天窗口复制。

const TokenCodec = (() => {
  const PREFIX = 'P2B';
  const V = 1;
  const CRC_TAB = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0x07 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc8(bytes) {
    let c = 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TAB[(c ^ bytes[i]) & 0xff];
    return c;
  }

  function toB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // encode({ host, port, room }) -> 'P2Bxxxx'；失败返回 ''
  function encode(opt) {
    try {
      const room = String((opt && opt.room) || '').slice(0, 16);
      if (!room) return '';
      const bytes = [V];
      const hostRaw = String((opt && opt.host) || '').trim();
      const port = Math.max(1, Math.min(65535, parseInt((opt && opt.port), 10) || 8080));
      const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostRaw);
      if (ipv4) {
        bytes.push(0);
        for (let i = 1; i <= 4; i++) bytes.push(parseInt(ipv4[i], 10) & 0xff);
        bytes.push((port >> 8) & 0xff, port & 0xff);
      } else {
        const hb = [];
        for (let i = 0; i < hostRaw.length; i++) hb.push(hostRaw.charCodeAt(i) & 0xff);
        if (!hb.length || hb.length > 120) return '';
        bytes.push(1, hb.length & 0xff);
        for (let i = 0; i < hb.length; i++) bytes.push(hb[i]);
        bytes.push((port >> 8) & 0xff, port & 0xff);
      }
      bytes.push(room.length & 0xff);   // [roomLen 1B]（decode 按 1B roomLen + room 读取，此前漏写导致 decode 恒失败）
      for (let i = 0; i < room.length; i++) bytes.push(room.charCodeAt(i) & 0xff);
      bytes.push(crc8(bytes));
      return PREFIX + toB64(bytes);
    } catch (e) {
      return '';
    }
  }

  // decode('P2Bxxxx') -> { host, port, room, httpBase, wsBase }；失败返回 null
  function decode(str) {
    try {
      if (!str || str.indexOf(PREFIX) !== 0) return null;
      const raw = fromB64(str.slice(PREFIX.length));
      if (!raw || raw.length < 9) return null;
      if (crc8(raw.subarray(0, raw.length - 1)) !== raw[raw.length - 1]) return null;
      if (raw[0] !== V) return null;
      let idx = 1;
      let host = '';
      let port = 8080;
      const type = raw[idx++];
      if (type === 0) {
        if (idx + 5 > raw.length) return null;
        host = raw[idx] + '.' + raw[idx + 1] + '.' + raw[idx + 2] + '.' + raw[idx + 3];
        idx += 4;
        port = (raw[idx] << 8) | raw[idx + 1];
        idx += 2;
      } else if (type === 1) {
        const hl = raw[idx++];
        if (idx + hl + 2 > raw.length) return null;
        for (let i = 0; i < hl; i++) host += String.fromCharCode(raw[idx + i]);
        idx += hl;
        port = (raw[idx] << 8) | raw[idx + 1];
        idx += 2;
      } else {
        return null;
      }
      const rl = raw[idx++];
      if (idx + rl + 1 > raw.length) return null;
      let room = '';
      for (let i = 0; i < rl; i++) room += String.fromCharCode(raw[idx + i]);
      return { host, port, room, httpBase: 'http://' + host + ':' + port, wsBase: 'ws://' + host + ':' + port };
    } catch (e) {
      return null;
    }
  }

  function isToken(str) {
    return typeof str === 'string' && str.indexOf(PREFIX) === 0 && str.length > PREFIX.length + 6;
  }

  // 输入框内容解析：完整令牌 / 纯房间码 / 无法识别
  function parseInput(str) {
    const s = String(str || '').trim();
    if (!s) return { kind: '' };
    if (isToken(s)) {
      const t = decode(s);
      if (t) return { kind: 'token', raw: s, room: t.room, join: t };
      return { kind: 'bad' };
    }
    if (s.length <= 16 && /^[A-Za-z0-9_-]+$/.test(s)) return { kind: 'room', raw: s, room: s };
    return { kind: 'bad' };
  }

  return { encode, decode, isToken, parseInput, crc8 };
})();

// ===== 手动贴码邀请/应答编解码（M2P 前缀，JSON 整体 base64url）=====
// 用于 0 服务器手动贴码建连（星形链接）：邀请码(offer)与应答码(answer)均包含
// 完整 WebRTC SDP + ICE candidates，复制粘贴即完成信令交换，无需信令服务器。
// 载荷较大（SDP 数 KB），适合聊天窗口/当面贴码；UTF-8 编码兼容中文昵称。
const ManualCodec = (() => {
  const PREFIX = 'M2P';
  const CHUNK = 0x8000;   // String.fromCharCode.apply 安全上限

  // 粘贴噪声清洗：空白/换行/零宽字符/首尾引号（聊天窗口复制长码常带入，导致解析失败）
  function sanitize(str) {
    return String(str == null ? '' : str).replace(/[\s\u200b-\u200f\ufeff"'`]/g, '');
  }

  // 校验位：正文（M2P+b64url）后附 '.' + 2 位十六进制 crc8
  // 作用：把“复制不完整/被截断”与“格式错误”区分开，给出可读失败原因
  const CRC_TAB = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0x07 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();
  function crcHex(s) {
    let c = 0;
    for (let i = 0; i < s.length; i++) c = CRC_TAB[(c ^ (s.charCodeAt(i) & 0xff)) & 0xff];
    return (c < 16 ? '0' : '') + c.toString(16);
  }

  function pack(obj) {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(obj));
      let bin = '';
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const body = PREFIX + b64;
      return body + '.' + crcHex(body);
    } catch (e) {
      return '';
    }
  }

  function unpack(str) {
    try {
      const s = sanitize(str);
      if (!s || s.indexOf(PREFIX) !== 0) return null;
      let body = s;
      const dot = s.lastIndexOf('.');
      if (dot > 0) {
        const tail = s.slice(dot + 1);
        if (/^[0-9a-f]{2}$/.test(tail)) {
          body = s.slice(0, dot);
          if (crcHex(body) !== tail) return null;   // 校验不符：内容被截断或改动
        }
      }
      const b64s = body.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
      // 修正填充：base64 长度已是 4 的倍数时不能再补 '===='（atob 会因多余 '=' 抛错，
      // 表现为“邀请码/应答码明明复制完整却解析失败”）
      const pad = b64s.length % 4;
      const b64 = pad ? b64s + '==='.slice(0, 4 - pad) : b64s;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const obj = JSON.parse(new TextDecoder().decode(bytes));
      return obj && typeof obj === 'object' ? obj : null;
    } catch (e) {
      return null;
    }
  }

  // 失败原因诊断：供 UI 给出明确提示（复制不完整 / 前缀不对 / 混入其它文字）
  function diagnose(str) {
    const raw = String(str == null ? '' : str);
    if (!raw.trim()) return 'empty';
    const s = sanitize(raw);
    const i = s.indexOf(PREFIX);
    if (i < 0) return 'no-prefix';
    if (i > 0) return 'has-junk';
    const dot = s.lastIndexOf('.');
    if (dot > 0 && /^[0-9a-f]{2}$/.test(s.slice(dot + 1)) && crcHex(s.slice(0, dot)) !== s.slice(dot + 1)) {
      return 'truncated';
    }
    return 'broken';
  }

  function isManual(str) {
    return typeof str === 'string' && str.indexOf(PREFIX) === 0 && str.length > PREFIX.length + 12;
  }

  return { pack, unpack, isManual, diagnose, sanitize };
})();
