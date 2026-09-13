/* ============================================================
 * landing.js — APP 内首页：局域网访问地址二维码 + 进入游戏
 *
 * 地址解析优先级（resolveBase）：
 *   ① ?lan=<host:port | url>      APP 原生侧打开 WebView 时可显式注入（最优先）
 *   ② window.__LAN_BASE__         APP 原生侧注入的全局变量
 *   ③ location.origin             ★同源：页面由 APP 内置服务托管时，
 *                                 扫码方浏览器里看到的 origin 就是真实局域网地址
 *   ④ /api/info · /lan-info.json  内置服务可选提供的探测接口（含真实局域网 IP）
 *   ⑤ location.origin 兜底        回环地址（127.0.0.1）时仅本机可用，给出提示
 *
 * 优雅降级：
 *   - file:// 打开：无 origin、fetch 不可用 → 二维码区显示占位说明，
 *     「进入游戏」置灰并说明原因，不抛错、不白屏。
 *   - 静态 http 打开：正常渲染二维码，仅「进入游戏」按候选路径探测可用入口。
 * ============================================================ */
(function () {
  'use strict';

  var DEFAULT_PORT = 8080;
  var GAME_ENTRY = 'index.html';           // 游戏菜单页文件名（来自 p2p-battle）
  // 「进入游戏」候选路径：覆盖两种部署形态
  //   A. 发布形态 www/landing/index.html → ../index.html
  //   B. 源码形态 p2p-battle-app/landing/index.html → ../www/index.html
  var GAME_CANDIDATES = ['../index.html', '../www/index.html', 'index.html', './index.html'];

  var $ = function (id) { return document.getElementById(id); };

  function isHttp() { return /^https?:$/i.test(location.protocol); }

  function isLoopback(host) {
    if (!host) return true;
    host = String(host).toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0';
  }

  function normalizeBase(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return '';
    s = s.replace(/\s+/g, '');
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s.replace(/\/+$/, '');
  }

  function queryParam(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function originBase() {
    if (!isHttp()) return '';
    if (location.origin) return normalizeBase(location.origin);
    return normalizeBase(location.protocol + '//' + location.host);
  }

  // 尝试从内置服务的探测接口取真实局域网地址（不存在时静默失败）
  function probeInfo(done) {
    if (!isHttp() || typeof fetch !== 'function') { done(''); return; }
    var urls = ['/api/info', '/lan-info.json'];
    var i = 0;
    (function next() {
      if (i >= urls.length) { done(''); return; }
      var u = urls[i++];
      var to = setTimeout(function () { next(); }, 1500);
      fetch(u, { cache: 'no-store' })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (j) {
          clearTimeout(to);
          var b = j && (j.httpBase || j.base || (j.ip ? ('http://' + j.ip + ':' + (j.port || DEFAULT_PORT)) : ''));
          if (b) { done(normalizeBase(b)); } else { next(); }
        })
        .catch(function () { clearTimeout(to); next(); });
    })();
  }

  function resolveBase(cb) {
    // ① 查询参数
    var q = normalizeBase(queryParam('lan'));
    if (q) { cb({ base: q, source: '参数注入', localOnly: isLoopback(parseHost(q)) }); return; }
    // ② 全局变量
    var g = normalizeBase(window.__LAN_BASE__);
    if (g) { cb({ base: g, source: '原生注入', localOnly: isLoopback(parseHost(g)) }); return; }
    // ③ 同源且非回环 → 直接采用
    var o = originBase();
    if (o && !isLoopback(location.hostname)) { cb({ base: o, source: '当前访问地址', localOnly: false }); return; }
    // ④ 探测接口
    probeInfo(function (b) {
      if (b) { cb({ base: b, source: '内置服务', localOnly: isLoopback(parseHost(b)) }); return; }
      // ⑤ 兜底
      if (o) { cb({ base: o, source: '本机地址', localOnly: true }); return; }
      cb({ base: '', source: '', localOnly: true });
    });
  }

  function parseHost(base) {
    try { return new URL(base).hostname; } catch (e) { return ''; }
  }

  function joinUrl(base, path) {
    return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
  }

  // ---- 二维码渲染 ----------------------------------------------------
  function renderQr(text) {
    var box = $('qrbox'), ph = $('qrph');
    try {
      if (typeof qrcode !== 'function') throw new Error('二维码库未加载');
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 12, alt: '局域网访问地址二维码' });
      var svg = box.querySelector('svg');
      if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); }
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(ph);
      ph.textContent = '二维码生成失败：' + (e && e.message ? e.message : e);
      return false;
    }
    return true;
  }

  function placeholder(msg) {
    var box = $('qrbox'), ph = $('qrph');
    box.innerHTML = '';
    box.appendChild(ph);
    ph.textContent = msg;
  }

  function warn(msg, isErr) {
    var w = $('warnBar');
    if (!msg) { w.hidden = true; w.textContent = ''; return; }
    w.hidden = false;
    w.className = 'warn' + (isErr ? ' err' : '');
    w.textContent = msg;
  }

  function status(msg) { $('status').textContent = msg || ''; }

  // ---- 「进入游戏」入口探测 ------------------------------------------
  function probeGame(done) {
    if (typeof fetch !== 'function') { done(''); return; }
    var i = 0;
    (function next() {
      if (i >= GAME_CANDIDATES.length) { done(''); return; }
      var u = GAME_CANDIDATES[i++];
      fetch(u, { method: 'HEAD', cache: 'no-store' })
        .then(function (r) { if (r && r.ok) { done(u); } else { next(); } })
        .catch(function () { next(); });
    })();
  }

  // ---- 主渲染 --------------------------------------------------------
  function paint(info) {
    var addrEl = $('addr'), enter = $('enterBtn');

    if (!info.base) {
      // 降级：无可用地址（典型为 file:// 直开）
      addrEl.textContent = '不可用（需通过 APP 或 http 访问）';
      placeholder('以文件方式打开（file://）时无法获取局域网地址，\n请通过 APP 内置服务或 http 地址访问本页。');
      $('qrnote').textContent = '请在手机 APP 内查看二维码';
      warn('当前以 file:// 方式直接打开：页面仅用于外观预览。局域网二维码、游戏资源加载均需要 HTTP 环境，请从 APP 进入或使用 http://<局域网IP>:' + DEFAULT_PORT + '/ 访问。', true);
      enter.disabled = true;
      enter.textContent = '需通过 HTTP 访问';
      status('运行环境：file:// （降级显示）');
      $('copyBtn').disabled = true;
      return;
    }

    addrEl.textContent = info.base;
    renderQr(joinUrl(info.base, GAME_ENTRY));

    if (info.localOnly) {
      warn('当前显示的是本机回环地址（127.0.0.1 / localhost），其他手机无法访问。请在下方「手动指定局域网地址」中填写本机热点网段 IP（例如 192.168.43.1:' + DEFAULT_PORT + '）。');
      $('qrnote').textContent = '该二维码仅本机可访问，需修正地址后再分享';
    } else {
      warn('');
      $('qrnote').textContent = '其他手机连到同一热点后扫码，用浏览器打开即可游玩';
    }

    probeGame(function (hit) {
      if (hit) {
        enter.disabled = false;
        enter.textContent = '进入游戏';
        enter.onclick = function () { location.href = hit; };
        status('运行环境：' + (isHttp() ? location.protocol + '//' + location.host : 'file://') + ' · 地址来源：' + info.source + ' · 游戏入口 ' + hit);
      } else {
        enter.disabled = true;
        enter.textContent = '未找到游戏入口';
        status('运行环境：' + (isHttp() ? location.protocol + '//' + location.host : 'file://') + ' · 地址来源：' + info.source);
        warn('未能在候选路径中找到游戏入口（' + GAME_CANDIDATES.join(' / ') + '）。若这是首次构建，请先执行 sync.ps1 生成 www 目录。');
      }
    });
  }

  // ---- 交互 ----------------------------------------------------------
  function bindCopy() {
    var btn = $('copyBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var t = $('addr').textContent || '';
      var done = function () { status('地址已复制'); setTimeout(function () { refreshStatusText(); }, 1600); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t).then(done, function () { fallbackCopy(t, done); });
        } else { fallbackCopy(t, done); }
      } catch (e) { fallbackCopy(t, done); }
    });
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { status('复制失败，请长按地址手动选择'); }
  }

  var lastInfo = null;
  function refreshStatusText() {
    if (!lastInfo || !lastInfo.base) return;
    $('status').textContent = '运行环境：' + (isHttp() ? location.protocol + '//' + location.host : 'file://') + ' · 地址来源：' + lastInfo.source;
  }

  function bindManual() {
    var apply = $('manualApply'), input = $('manualInput');
    if (!apply) return;
    apply.addEventListener('click', function () {
      var v = normalizeBase(input.value);
      if (!v) { status('请输入形如 192.168.43.1:8080 的地址'); return; }
      paint({ base: v, source: '手动指定', localOnly: isLoopback(parseHost(v)) });
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') apply.click(); });
  }

  function boot() {
    if (!isHttp()) {
      paint({ base: '', source: '', localOnly: true });
      return;
    }
    resolveBase(function (info) {
      lastInfo = info;
      paint(info);
      // 回环地址时预填手动输入框，便于快速修正
      var mi = $('manualInput');
      if (mi && !mi.value) mi.placeholder = (location.hostname || '192.168.43.1') + ':' + (location.port || DEFAULT_PORT);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindCopy(); bindManual(); boot(); });
  } else { bindCopy(); bindManual(); boot(); }
})();
