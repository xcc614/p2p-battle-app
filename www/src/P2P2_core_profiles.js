// ===== 玩家档案 / 模块装配（设计文档第八、十一章）=====
// 数据分工：
//   config/modules.json  -> MODULE_DEFS：模块定义（maxSlots 上限 / source 条目来源库 / allowDuplicate / groups 分组声明 / excludeGroups 排除）
//                          候选范围不用白名单：由来源库条目的 group 标签与本表 groups 实时对齐，未归属标签收进「未分组」区
//   config/profiles.json -> PROFILES   ：玩家档案（unitId 底座 + base 覆写 + modules[{moduleId, entries[]}]）
// 本文件只做三件事（数值合成仍全部交给 src/P2P2_core_combat.js，逻辑不重复实现）：
//   1. 档案校验 sanitize()：超上限截断 / 未知模块剔除 / 未知条目剔除 / 重复条目去重（房主汇总时调用）
//   2. 档案装配 applyTo()：base 覆写 + 把每个条目解析成"模块节点"挂到玩家身上（条目可带 add/condition/unlockSkills/mods）
//   3. 档案选择：byUnit() 按当前单位模板自动匹配（客户端未显式选择时用），current() 读本地显式选择
//
// 标识一律从配置推导（代码里不写死模块 id / 条目来源库 / 自动普攻技能 id / 缺省单位）：
//   moduleIdBySource(source) → 按模块用途反查模块 id；sourceOf(moduleId) → 模块的条目来源库；
//   autoSkillId()/autoSkillName() → skills.json 里 auto:true 的技能与其显示名；defaultUnitId() → 档案缺省底座单位。
//
// 条目写法（字符串或对象皆可）：
//   "ruby"                                   // 直接引用来源库条目
//   { id: "ruby", add: { critChance: 0.03 } }               // 条目级追加属性
//   { id: "sapphire", condition: { type: "hpBelow", value: 0.5 } }   // 特殊效果判定（不满足则不生效）
//   { id: "iron_sword", mods: { m1: "ruby" } }              // 子挂载（套娃，无限嵌套）

const Profiles = {
  // 本地显式选择的档案 id（配置面板里选；未选则按 unitId 自动匹配）
  KEY: 'p2p_battle_profile_v1',
  // 面板拖拽编辑出来的「自定义配置」档案（不写回 config/profiles.json，只存本机）
  CUSTOM_KEY: 'p2p_battle_profile_custom_v1',
  CUSTOM_ID: '__custom__',

  defs() {
    return (typeof MODULE_DEFS !== 'undefined' && MODULE_DEFS && typeof MODULE_DEFS === 'object') ? MODULE_DEFS : {};
  },
  all() {
    return (typeof PROFILES !== 'undefined' && PROFILES && typeof PROFILES === 'object') ? PROFILES : {};
  },
  // 模块 source -> 条目来源库（window 全局配置表）
  registry(source) {
    if (source === 'equipment') return (typeof EQUIPMENT !== 'undefined' && EQUIPMENT) || {};
    if (source === 'mods') return (typeof MODS !== 'undefined' && MODS) || {};
    if (source === 'skills') return (typeof SKILLS !== 'undefined' && SKILLS) || {};
    return null;   // custom：条目内联在模块定义的 entries 里
  },
  // 按模块用途（source 条目来源库）反查模块 id：代码不写死具体模块 id，改 modules.json 的模块 id 后依旧命中。
  // 找不到声明该用途的模块时退回 fallback 模块 id（仍不存在则退回同名模块 id）；配置缺字段返回 ''，不报错。
  moduleIdBySource(source, fallback) {
    const defs = this.defs();
    const keys = Object.keys(defs).filter(k => !k.startsWith('_') && defs[k] && typeof defs[k] === 'object');
    const hit = keys.find(k => defs[k].source === source);
    if (hit) return hit;
    if (fallback && defs[fallback]) return fallback;
    return defs[source] ? source : '';
  },
  // 模块的条目来源库：优先模块自身声明的 source；模块漏标 source 时按明确规则推断，
  // 不再默认按镶嵌表(mods)解析（避免模块漏标 source 时把内联条目错读成宝石/铭文）。
  // 规则顺序：① modules.json 顶层 _defaultSource 全局缺省声明 → ② 模块 id 与来源库同名 → ③ custom（只认内联 entries）
  sourceOf(moduleId) {
    const defs = this.defs();
    const md = defs[moduleId] || {};
    const own = (md.source === undefined || md.source === null) ? '' : String(md.source).trim();
    if (own) return own;
    const g = (defs._defaultSource === undefined || defs._defaultSource === null) ? '' : String(defs._defaultSource).trim();
    if (g) return g;
    if (this.registry(moduleId)) return moduleId;
    return 'custom';
  },
  // 自动普攻技能 id：按 config/skills.json 的 auto:true 标记动态判定（技能 id 改名 / 换自动普攻技能后依旧命中），
  // 无任何标记时退回 'auto_attack' 兜底（配置缺字段保持原默认行为，不报错）
  autoSkillId() {
    const sk = this.registry('skills') || {};
    const hit = Object.keys(sk).find(k => !k.startsWith('_') && sk[k] && typeof sk[k] === 'object' && sk[k].auto === true);
    return hit || 'auto_attack';
  },
  // 自动普攻显示名：取 skills.json 的技能 name（界面不再写死「普攻」），配置缺 name 时退回兜底文案
  autoSkillName() {
    const d = (this.registry('skills') || {})[this.autoSkillId()];
    return (d && d.name) || '普攻';
  },
  // 取模块内某个条目的原始定义（custom 取模块 entries；其余查来源库）
  // 只认「对象型」条目：来源库里的 _doc / _note / _bossDoc 等元信息字符串不是条目，一律返回 null
  // （候选池、档案校验、装配解析共用本方法，因此元信息不会被当成可装载条目）
  entryDef(moduleId, entryId) {
    const md = this.defs()[moduleId];
    if (!md || !entryId) return null;
    const src = this.sourceOf(moduleId);          // 来源库按配置解析（模块漏标 source 时不默认按镶嵌表解析）
    const raw = (src === 'custom')
      ? (md.entries || {})[entryId]
      : (this.registry(src) || {})[entryId];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return { ...raw };
  },
  // ---- 候选范围解析（全配置驱动：候选 = 来源库 × modules.json 的 groups 声明 + 条目 group 标签，不用白名单）----
  // 「未分组」哨兵：条目 group 标签为空 / 未知 / 不被任何模块声明时归到这里，面板底部「未分组」折叠区照常显示
  UNGROUPED: '__other',
  // 本模块显式排除的分组（modules.json 的 excludeGroups，如 skill 模块排除 Boss 技能的 enemy 组）
  excludeGroups(moduleId) {
    const md = this.defs()[moduleId] || {};
    const arr = Array.isArray(md.excludeGroups) ? md.excludeGroups : [];
    return arr.filter(g => g !== undefined && g !== null && String(g) !== '').map(String);
  },
  // 全配置里被任何模块 groups 声明的分组 id 集合（用于判断某条目的 group 标签是否「有主」）
  _declaredGroupIds() {
    const set = new Set();
    const defs = this.defs();
    Object.keys(defs).forEach(mid => {
      const md = defs[mid];
      if (!md || typeof md !== 'object') return;
      (Array.isArray(md.groups) ? md.groups : []).forEach(g => { if (g && g.id) set.add(String(g.id)); });
    });
    return set;
  },
  // 条目的分组归属键：命中本模块 groups 声明 → 该分组 id；否则 → UNGROUPED（未分组，仍进候选池）
  groupKeyOf(moduleId, entryId) {
    const g = this.groupOf(moduleId, entryId);
    const ids = this.groups(moduleId).map(x => x.id);
    return (ids.length && ids.indexOf(g) >= 0) ? g : this.UNGROUPED;
  },
  // 模块候选条目 id 列表（编辑器下拉 / 面板候选池）：完全按配置实时解析，不写死组名/条目清单
  //   · 条目 group 命中本模块某分组           → 归该分组候选
  //   · 条目 group 为空 / 未知 / 无模块声明     → 归「未分组」候选（UNGROUPED），照常显示可装载
  //   · 条目 group 属于别的模块（串库）         → 不进本模块候选池（仅来源库模块适用）
  //   · 条目 group 在本模块 excludeGroups 中    → 不进本模块候选池
  // 传 groupId 时只返回该分组候选；不传返回全部候选
  candidates(moduleId, groupId) {
    const md = this.defs()[moduleId];
    if (!md) return [];
    const src = this.sourceOf(moduleId);
    const all = (src === 'custom') ? Object.keys(md.entries || {}) : Object.keys(this.registry(src) || {});
    const declared = new Set(this.groups(moduleId).map(g => g.id));
    const ex = new Set(this.excludeGroups(moduleId));
    const foreign = this._declaredGroupIds();
    return all.filter(id => {
      if (String(id).startsWith('_')) return false;       // 元信息块（_doc / _note / _releases 等）不是可装载条目
      if (!this.entryDef(moduleId, id)) return false;
      const g = this.groupOf(moduleId, id);
      if (ex.has(g)) return false;                       // 本模块显式排除的分组（Boss 技能等）
      let key;
      if (g && declared.has(g)) key = g;                 // 归属本模块的分组
      else if (!g || !foreign.has(g)) key = this.UNGROUPED;  // 无标签 / 未知标签：未分组，不丢弃
      else if (src === 'custom') key = this.UNGROUPED; // 自定义模块不做串库排斥（inline 条目自洽）
      else key = '';                                     // 标签属于别的模块：不跨库进本池
      if (!key) return false;
      if (!groupId) return true;
      return (groupId === this.UNGROUPED) ? (key === this.UNGROUPED) : (key === groupId);
    });
  },
  // 「未分组」区当前可装载余量：模块总上限 − 已声明分组已占格数（未分组条目占用模块剩余格数）
  ungroupedRoom(moduleId, entries) {
    const md = this.defs()[moduleId] || {};
    const gs = this.groups(moduleId);
    const total = Math.max(0, Number(md.maxSlots) || 0) || this.slotCount(moduleId);
    if (!gs.length) return total;
    const used = (Array.isArray(entries) ? entries : []).filter(e => {
      const id = (typeof e === 'string') ? e : (e && e.id);
      return !!id && this.groupKeyOf(moduleId, id) !== this.UNGROUPED;
    }).length;
    return Math.max(0, total - used);
  },
  candidateName(moduleId, entryId) {
    const d = this.entryDef(moduleId, entryId);
    return (d && d.name) || entryId;
  },
  // ---- 分组 / 部位（modules.json 的 groups 声明；未声明则视作单池，分组相关接口返回空）----
  // 条目所属分组标签：优先 entry.group，兼容装备旧字段 entry.slot；无标签返回 ''
  groupOf(moduleId, entryId) {
    const d = this.entryDef(moduleId, entryId);
    if (!d) return '';
    return String(d.group || d.slot || '');
  },
  // 模块分组声明（顺序即面板展示顺序）
  groups(moduleId) {
    const md = this.defs()[moduleId];
    if (!md || !Array.isArray(md.groups)) return [];
    return md.groups.filter(g => g && g.id).map(g => ({
      id: String(g.id),
      name: g.name || String(g.id),
      maxSlots: Math.max(0, Number(g.maxSlots) || 0),
      // 组级 allowDuplicate 缺省继承模块级
      allowDuplicate: (g.allowDuplicate === undefined || g.allowDuplicate === null) ? !!md.allowDuplicate : !!g.allowDuplicate,
      notes: g.notes || '',
    }));
  },
  groupName(moduleId, groupId) {
    const g = this.groups(moduleId).find(x => x.id === groupId);
    return g ? g.name : (groupId || '');
  },
  // 分组槽位上限；未声明该分组返回 null（= 不按分组限制）
  groupMax(moduleId, groupId) {
    const g = this.groups(moduleId).find(x => x.id === groupId);
    return g ? g.maxSlots : null;
  },
  // 模块可配置总格数 = Σ 分组槽位上限；未声明分组时回退模块 maxSlots
  slotCount(moduleId) {
    const gs = this.groups(moduleId);
    if (!gs.length) return Math.max(0, Number((this.defs()[moduleId] || {}).maxSlots) || 0);
    return gs.reduce((n, g) => n + g.maxSlots, 0);
  },
  // 把条目列表铺进分组格子（配置面板右侧格子区用）：
  //   返回 [{ id, name, maxSlots, slots: [条目对象 | null] }]，同组条目按原顺序占格，空位为 null。
  //   分组标签未在 modules.json 声明的条目不会被丢弃，统一挂到末尾的「其他」伪分组，保证可见可编辑。
  grid(moduleId, entries) {
    const list = Array.isArray(entries) ? entries : [];
    const norm = list.map(e => (typeof e === 'string') ? { id: e } : { ...e });
    const gs = this.groups(moduleId);
    if (!gs.length) {
      // 未声明分组的模块（如 relic）：单池铺格，按模块上限补齐空位
      const cap = Math.max(this.slotCount(moduleId) || 0, norm.length);
      const slots = norm.slice(0, cap);
      while (slots.length < cap) slots.push(null);
      return [{ id: '', name: '', maxSlots: cap, slots }];
    }
    const buckets = {};
    norm.forEach(e => {
      const key = this.groupKeyOf(moduleId, e.id);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(e);
    });
    const out = gs.map(g => {
      const items = (buckets[g.id] || []).slice(0, g.maxSlots);
      const slots = items.slice();
      while (slots.length < g.maxSlots) slots.push(null);
      return { id: g.id, name: g.name, maxSlots: g.maxSlots, slots };
    });
    // 未归属任何已声明分组的条目：统一挂到末尾「未分组」区（id 固定 UNGROUPED），保证照常可见可编辑，不丢弃
    const others = buckets[this.UNGROUPED] || [];
    if (others.length) {
      out.push({ id: this.UNGROUPED, name: '未分组', maxSlots: others.length, slots: others, unknownGroup: true });
    }
    return out;
  },
  // 档案列表（数组，含 id）
  list() {
    const all = this.all();
    return Object.keys(all).filter(k => !k.startsWith('_') && all[k] && typeof all[k] === 'object')
      .map(id => ({ id, profile: all[id] }));
  },
  get(id) {
    const all = this.all();
    return (id && all[id] && typeof all[id] === 'object') ? all[id] : null;
  },
  // 按单位模板匹配档案（同模板多档案时取第一条）——客户端未显式选择时兜底
  byUnit(unitId) {
    if (!unitId) return null;
    const hit = this.list().find(x => !x.profile.unitId || x.profile.unitId === unitId);
    return hit ? { id: hit.id, profile: hit.profile } : null;
  },
  // 本地显式选择的档案 id（无 / 失效则返回空串，交由 byUnit 自动匹配）
  currentId() {
    try { return (localStorage.getItem(this.KEY) || '').trim(); } catch (e) { return ''; }
  },
  setCurrentId(id) {
    try {
      if (id) localStorage.setItem(this.KEY, id); else localStorage.removeItem(this.KEY);
    } catch (e) { /* 隐私模式下静默失败，仅本次会话生效 */ }
  },
  // ---- 本机「自定义配置」档案（配置面板拖拽结果，存 localStorage；不落 config 文件）----
  // 返回已校验的档案对象或 null
  custom() {
    try {
      const raw = localStorage.getItem(this.CUSTOM_KEY);
      if (!raw) return null;
      const res = this.sanitize(JSON.parse(raw));
      return res.profile;
    } catch (e) { return null; }
  },
  // 写入自定义配置（传 null / 空模块 = 删除，回退角色模板默认装配）
  setCustom(raw) {
    try {
      if (!raw) { localStorage.removeItem(this.CUSTOM_KEY); return null; }
      const res = this.sanitize(raw);
      if (!res.profile || !res.profile.modules.length) { localStorage.removeItem(this.CUSTOM_KEY); return null; }
      localStorage.setItem(this.CUSTOM_KEY, JSON.stringify(res.profile));
      return res.profile;
    } catch (e) { return null; }
  },
  // 解析某单位模板应使用的档案：显式选择优先（且需单位匹配），否则按 unitId 自动匹配
  // 返回 { id, profile } 或 null；Boss 单位不挂玩家档案
  resolveFor(unitId) {
    if (!unitId) return null;
    const u = (typeof UNITS !== 'undefined' && UNITS[unitId]) || null;
    if (u && u.isBoss) return null;
    const cur = this.currentId();
    // 面板自定义配置：unitId 为空视为不限单位（底座走角色模板），与角色档案同优先级
    if (cur === this.CUSTOM_ID) {
      const c = this.custom();
      if (c && (!c.unitId || c.unitId === unitId)) return { id: this.CUSTOM_ID, profile: c };
    }
    const pick = this.get(cur);
    if (pick && (!pick.unitId || pick.unitId === unitId)) return { id: cur, profile: pick };
    return this.byUnit(unitId);
  },
  // 档案摘要（面板 / 悬停提示用）：按模块给出 已挂载/总格数，声明分组的模块再附各分组占用
  describe(profile) {
    if (!profile) return '无档案';
    const defs = this.defs();
    const parts = [];
    (profile.modules || []).forEach(m => {
      const md = defs[m.moduleId] || {};
      const entries = m.entries || [];
      const max = this.slotCount(m.moduleId) || (Number(md.maxSlots) || 0);
      const gs = this.groups(m.moduleId);
      let sub = '';
      if (gs.length > 1) {
        const cnt = {};
        let un = 0;
        entries.forEach(e => {
          const eid = (typeof e === 'string') ? e : e.id;
          const key = this.groupKeyOf(m.moduleId, eid);
          if (key === this.UNGROUPED) un++;
          cnt[key] = (cnt[key] || 0) + 1;
        });
        sub = '（' + gs.map(g => g.name + (cnt[g.id] || 0) + '/' + g.maxSlots).join(' · ') + (un ? ' · 未分组' + un : '') + '）';
      }
      parts.push((md.name || m.moduleId) + ' ' + entries.length + '/' + max + sub);
    });
    return parts.length ? parts.join(' · ') : '未挂载模块';
  },

  // 条目级覆写合并：add 叠加、unlockSkills 追加、condition 覆盖、mods 子挂载沿用
  _mergeEntry(base, entry) {
    if (!base) return null;
    const def = { ...base };
    if (entry.name) def.name = entry.name;
    if (entry.add && typeof entry.add === 'object') {
      const add = { ...(base.add || {}) };
      for (const k in entry.add) {
        const n = Number(entry.add[k]);
        if (!isNaN(n)) add[k] = (add[k] || 0) + n;
      }
      def.add = add;
    }
    if (entry.condition) def.condition = entry.condition;
    if (Array.isArray(entry.unlockSkills) && entry.unlockSkills.length) {
      def.unlockSkills = [...(base.unlockSkills || []), ...entry.unlockSkills];
    }
    return def;
  },

  // 档案缺省底座单位：读配置声明，不再写死 'hero'。
  // 规则顺序：① config/profiles.json 顶层 _defaultUnitId（本档案表声明）→ ② config/units.json 中 default:true 的单位模板
  //          → ③ config/challenge.json 的 player（单机默认选角）→ ④ 首个可选非 Boss 单位模板 → ⑤ 兜底 'hero'
  // 任一层缺字段都自动落到下一层，全缺时保持原默认行为，不报错。
  defaultUnitId() {
    const p = this.all();
    const declared = (p && typeof p._defaultUnitId === 'string') ? p._defaultUnitId.trim() : '';
    if (declared && this._unitDef(declared)) return declared;
    const us = (typeof UNITS !== 'undefined' && UNITS && typeof UNITS === 'object') ? UNITS : null;
    if (us) {
      const flagged = Object.keys(us).find(k => !k.startsWith('_') && us[k] && typeof us[k] === 'object' && us[k].default === true && us[k].isBoss !== true);
      if (flagged) return flagged;
      const ch = (typeof window !== 'undefined' && window.CHALLENGE) || (typeof CHALLENGE !== 'undefined' ? CHALLENGE : null);
      const cp = (ch && typeof ch.player === 'string') ? ch.player.trim() : '';
      if (cp && this._unitDef(cp)) return cp;
      const first = Object.keys(us).find(k => !k.startsWith('_') && us[k] && typeof us[k] === 'object' && us[k].name && us[k].isBoss !== true && us[k].selectable !== false);
      if (first) return first;
    }
    return 'hero';
  },
  _unitDef(unitId) {
    const us = (typeof UNITS !== 'undefined' && UNITS && typeof UNITS === 'object') ? UNITS : null;
    return (us && us[unitId] && typeof us[unitId] === 'object') ? us[unitId] : null;
  },

  // 单位显示名：读 config/units.json 的 name（_ 开头的说明/元数据键不算单位）；取不到时退回单位 id，不写死任何单位名
  unitDisplayName(unitId) {
    const d = this._unitDef(unitId);
    const nm = (d && typeof d.name === 'string') ? d.name.trim() : '';
    if (nm) return nm;
    return (typeof unitId === 'string' && unitId) ? unitId : '';
  },

  // 档案缺省 Boss 单位：读配置声明，不再写死 'demon_lord'。
  // 规则顺序：① config/challenge.json 的 boss（单机默认 Boss 选角）→ ② config/units.json 中首个 isBoss 模板 → ③ 兜底 'demon_lord'
  // 任一层缺字段都自动落到下一层，全缺时保持原默认行为，不报错。
  defaultBossUnitId() {
    const ch = (typeof window !== 'undefined' && window.CHALLENGE) || (typeof CHALLENGE !== 'undefined' ? CHALLENGE : null);
    const cb = (ch && typeof ch.boss === 'string') ? ch.boss.trim() : '';
    if (cb && this._unitDef(cb)) return cb;
    const us = (typeof UNITS !== 'undefined' && UNITS && typeof UNITS === 'object') ? UNITS : null;
    if (us) {
      const first = Object.keys(us).find(k => !k.startsWith('_') && us[k] && typeof us[k] === 'object' && us[k].isBoss === true);
      if (first) return first;
    }
    return 'demon_lord';
  },

  // 档案校验（房主汇总 / 客户端本地装配前统一走这里）
  // 返回 { profile, issues }；profile 为 null 表示该档案不可用
  sanitize(raw) {
    const issues = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { profile: null, issues: ['档案为空或格式错误'] };
    const defs = this.defs();
    const out = {
      name: String(raw.name || '未命名档案'),
      // unitId 缺省（undefined/null）= 配置声明的缺省底座单位（profiles.json 的 _defaultUnitId /
      // units.json 的 default / challenge.json 的 player，见 defaultUnitId()），不再写死 'hero'；
      // 显式 '' 表示不限单位（面板自定义配置用）
      unitId: (raw.unitId === undefined || raw.unitId === null) ? this.defaultUnitId() : String(raw.unitId),
      base: {},
      modules: [],
      notes: raw.notes || '',
    };
    if (raw.base && typeof raw.base === 'object' && !Array.isArray(raw.base)) {
      Object.keys(raw.base).forEach(k => {
        const n = Number(raw.base[k]);
        if (!isNaN(n)) out.base[k] = n; else issues.push('基础属性 ' + k + ' 不是数字，已忽略');
      });
    }
    const modsIn = Array.isArray(raw.modules) ? raw.modules : [];
    modsIn.forEach(m => {
      const mid = m && m.moduleId;
      const md = defs[mid];
      if (!md) { issues.push('未知模块「' + mid + '」已剔除'); return; }
      const max = Math.max(0, Number(md.maxSlots) || 0);
      const seen = new Set();
      const entries = [];
      (Array.isArray(m.entries) ? m.entries : []).forEach(e => {
        const id = (typeof e === 'string') ? e : (e && e.id);
        if (!id) { issues.push('模块「' + mid + '」含无 id 条目，已跳过'); return; }
        if (!this.entryDef(mid, id)) { issues.push('模块「' + mid + '」的条目 ' + id + ' 不在来源库中，已剔除'); return; }
        // 模块 excludeGroups 声明的分组（如 skill 模块的 Boss 技能 enemy 组）不进玩家可装配范围
        if (this.excludeGroups(mid).indexOf(this.groupOf(mid, id)) >= 0) {
          issues.push('模块「' + mid + '」的条目 ' + id + ' 属被排除分组，已剔除');
          return;
        }
        if (!md.allowDuplicate && seen.has(id)) { issues.push('模块「' + mid + '」不允许重复，重复条目 ' + id + ' 已去重'); return; }
        seen.add(id);
        entries.push((typeof e === 'string') ? { id } : { ...e });
      });
      // 分组槽位上限截断（未声明 groups 的模块跳过，保持单池行为）
      const gcaps = {};
      this.groups(mid).forEach(g => { gcaps[g.id] = g.maxSlots; });
      if (Object.keys(gcaps).length) {
        const used = {};
        const kept = [];
        entries.forEach(e => {
          const gid = this.groupOf(mid, e.id);
          const cap = gcaps[gid];
          if (cap === undefined) { kept.push(e); return; }   // 分组标签未声明：不参与分组限制，交由模块上限兜底
          used[gid] = (used[gid] || 0) + 1;
          if (used[gid] > cap) {
            issues.push('模块「' + mid + '」分组「' + (this.groupName(mid, gid) || gid) + '」超槽位上限（' + cap + '），条目 ' + e.id + ' 已剔除');
            return;
          }
          kept.push(e);
        });
        entries.length = 0;
        kept.forEach(e => entries.push(e));
      }
      if (entries.length > max) {
        issues.push('模块「' + mid + '」超上限（' + entries.length + '/' + max + '），已截断');
        entries.length = max;
      }
      if (entries.length) out.modules.push({ moduleId: mid, entries });
    });
    return { profile: out, issues };
  },

  // 把档案装配到玩家实体（Player 构造末尾调用）：
  //   base        覆写单位模板基础属性（Combat.calcStats 优先读 player.baseOverride）
  //   equipment   档案接管装备（有档案时清空单位模板预配，避免双重叠加）
  //   profileModules  条目解析成模块节点，由 Combat 统一收集（add / unlockSkills / condition 全走同一引擎）
  applyTo(player, raw) {
    if (!player || !raw) return null;
    if (player.isBoss) return null;                 // Boss 不挂玩家档案（Boss 侧用 units.json + 阶段规则）
    const res = this.sanitize(raw);
    const p = res.profile;
    if (!p) return null;
    if (p.unitId && p.unitId !== player.unitId) {   // 档案底座与当前角色不符：不装配（避免把勇者档案套到游侠上）
      return null;
    }
    player.profile = p;
    player.profileIssues = res.issues;
    player.baseOverride = { ...(player.baseOverride || {}), ...(p.base || {}) };
    player.equipment = [];                          // 档案接管装备挂载
    player.profileModules = [];
    (p.modules || []).forEach(m => {
      const src = this.sourceOf(m.moduleId);   // 来源库按配置解析：漏标 source 时不再默认按镶嵌表(mods)解析
      (m.entries || []).forEach(entry => {
        let def = this._mergeEntry(this.entryDef(m.moduleId, entry.id), entry);
        if (!def) return;
        // 技能模块条目 = 直接把该技能解锁进候选池（skills.json 的技能表本身没有 unlockSkills 字段）：
        // 技能自带的 condition 只在释放时由 Combat.canUseSkill 判定，这里从节点收集层剔除，
        // 否则未满足条件的技能会连带从候选池消失，导致出战栏随条件闪烁。
        if (src === 'skills') {
          const skillDef = { ...def };
          delete skillDef.condition;
          def = { ...skillDef, unlockSkills: [...(def.unlockSkills || []), entry.id] };
        }
        const mods = (entry.mods && typeof entry.mods === 'object') ? entry.mods : null;
        player.profileModules.push({
          moduleId: m.moduleId,
          groupId: this.groupOf(m.moduleId, entry.id),
          source: src,
          def,
          // 子挂载的 registry 固定为 MODS（装备/铭文/宝石/追加的孔位都指向镶嵌表），与旧 equipment 树一致
          children: (typeof MODS !== 'undefined' && MODS) || {},
          mods,
        });
      });
    });
    return p;
  },
};
