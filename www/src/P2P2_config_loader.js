// ===== 配置加载器（核心架构入口）=====
// 玩法与运行参数全部放在 config/*.json，本文件在游戏启动第一步把它们
// fetch 进 window 全局（GAME_CONFIG / UNITS / SKILLS / BULLETS / ...）。
//
// 使用方式：
//   1. index.html 在任何 src 逻辑之前引入本文件；
//   2. main.js init() 第一行：await loadGameConfig()，失败即弹窗，不进入游戏。
//
// 扩展规则（用户只需改配置，不动 src 逻辑）：
//   - 加"单位/角色模板"   → 改 config/units.json（hero 是默认勇者模板）
//   - 加"技能"           → 改 config/skills.json（cd/bullet/count/spread/ring/speedMul/charge/priority/condition/fxImage）
//   - 加"子弹"           → 改 config/bullets.json（speed/radius/damage/life/pierce/onHit/onWall/friendly/shape/length/color/image）
//   - 加"装备/铭文/宝石"  → 改 config/equipment.json + config/mods.json
//   - 加"模块/条目"      → 改 config/modules.json（模块定义 + maxSlots 上限 + source 来源库/pool 候选）
//   - 加"玩家档案"       → 改 config/profiles.json（单位底座 + 基础属性覆写 + 挂载模块与条目）
//   - 调"全局手感"       → 改 config/runtime.json
//   - 调"AI 难度"       → 改 config/ai.json（5 档数组）
//   - 单位/技能入场特效图片（如火焰/冰霜粒子图）→ 图片放 assets/，
//     在 skills.json 的 fxImage 字段或 bullets.json/units.json 的 image 字段填文件名即可。

// 全局配置表：window 键名 -> config 文件名
const CONFIG_FILES = {
  GAME_CONFIG: 'runtime',
  BASE_STATS: 'base_stats',
  UNITS: 'units',
  SKILLS: 'skills',
  BULLETS: 'bullets',
  EQUIPMENT: 'equipment',
  MODS: 'mods',
  SKILLBAR: 'skillbar',
  TRIGGERS: 'triggers',
  BUFFS: 'buffs',
  BOT_LEVELS: 'ai',
  CHALLENGE: 'challenge',
  MODULE_DEFS: 'modules',
  PROFILES: 'profiles',
};

// 无 HTTP 服务（直接双击 index.html）时的兜底：尝试同步加载同名 js 变体已废弃，
// 纯静态部署必须走本地 HTTP（python -m http.server 8000 等），否则浏览器禁 fetch。

// 普通对象判定（深同步用；数组/标量走替换）
function _cfgIsPlainObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// 深同步：把磁盘新值**原地**写回既有全局对象，保持引用不变（已持有该全局引用的模块无需改动）。
// 规则：对象递归就地写（源里没有的键删除，保证「删除条目」也能反映）；数组/标量整块替换。
function _cfgDeepSync(target, source) {
  if (Array.isArray(target) && Array.isArray(source)) {
    target.length = 0;
    source.forEach(v => target.push(v));
    return target;
  }
  if (!_cfgIsPlainObj(target) || !_cfgIsPlainObj(source)) return source;
  Object.keys(target).forEach(k => { if (!(k in source)) delete target[k]; });
  Object.keys(source).forEach(k => {
    const sv = source[k], tv = target[k];
    if ((_cfgIsPlainObj(tv) && _cfgIsPlainObj(sv)) || (Array.isArray(tv) && Array.isArray(sv))) target[k] = _cfgDeepSync(tv, sv);
    else target[k] = sv;
  });
  return target;
}

// 纯读盘：按 CONFIG_FILES 取回 config/*.json，返回 { 全局名: 数据 }，不触碰 window。
// keys 可选，只取指定全局（如 ['SKILLS']）；缺省取全部。
// 构建版（build_deploy.py）在 index.html 注入 window.__CFG_VERSION（整站 hash）时用它做缓存失效；
// 本地直读没有版本号则退化为时间戳，避免本地 http 服务的启发式缓存返回旧 JSON。
async function fetchGameConfig(base = 'config/', keys = null) {
  const fresh = {};
  const names = (Array.isArray(keys) && keys.length) ? keys.filter(k => k in CONFIG_FILES) : Object.keys(CONFIG_FILES);
  const jobs = names.map(async (globalName) => {
    const fileName = CONFIG_FILES[globalName];
    const ver = (window.__CFG_VERSION || '').replace(/[^0-9a-z]/gi, '') || ('t' + Date.now());
    const url = base + fileName + '.json?v=' + ver;
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error('配置加载失败: ' + url + ' (HTTP ' + resp.status + ')，请通过 HTTP 服务访问（如 python -m http.server）');
    fresh[globalName] = await resp.json();
  });
  await Promise.all(jobs);
  return fresh;
}

// 启动加载：把磁盘配置写入 window 全局（首次建立全局）
async function loadGameConfig(base = 'config/') {
  const fresh = await fetchGameConfig(base);
  Object.keys(fresh).forEach(k => { window[k] = fresh[k]; });
  return fresh;
}

// 运行时重载：重新读盘并把最新值原地同步进既有 window 全局（引用不变）。
// keys 可选，只刷新指定全局（如 ['SKILLS', 'MODULE_DEFS']）；缺省刷新全部。
async function reloadGameConfig(base = 'config/', keys = null) {
  const fresh = await fetchGameConfig(base, keys);
  Object.keys(fresh).forEach(k => {
    const cur = window[k];
    window[k] = (_cfgIsPlainObj(cur) || Array.isArray(cur)) ? _cfgDeepSync(cur, fresh[k]) : fresh[k];
  });
  return fresh;
}

// 配置界面专用：确保全局是磁盘最新（同一时刻的并发调用合并为一次请求）；
// 读盘失败时沿用当前内存配置并告警，不阻塞界面渲染。
let _cfgReloading = null, _cfgPendingKeys = null;   // _cfgPendingKeys：在途请求覆盖的全局名，null = 全量
// 在途请求是否已覆盖本次所需（在途为全量可覆盖一切；本次要全量而在途只有子集则不能）
function _cfgCovers(pending, need) {
  if (pending === null) return true;
  if (need === null) return false;
  return need.every(k => pending.indexOf(k) >= 0);
}
function ensureFreshCfg(base = 'config/', keys = null) {
  const need = (Array.isArray(keys) && keys.length) ? keys.slice() : null;
  if (_cfgReloading) {
    if (_cfgCovers(_cfgPendingKeys, need)) return _cfgReloading;          // 复用在途结果
    return _cfgReloading.catch(() => null).then(() => ensureFreshCfg(base, need));   // 覆盖不到：等在途结束后补一次
  }
  _cfgPendingKeys = need;
  _cfgReloading = reloadGameConfig(base, need)
    .catch(err => { console.warn('[config] 重载失败，沿用当前内存配置：', (err && err.message) || err); return null; })
    .then(r => { _cfgReloading = null; _cfgPendingKeys = null; return r; });
  return _cfgReloading;
}
