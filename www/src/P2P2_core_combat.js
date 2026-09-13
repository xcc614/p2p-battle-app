// ===== 战斗模块（逻辑核心，src 层）=====
// 职责：
//   1. 合成最终数值（BASE_STATS 基础属性 <- UNITS 模板 base 覆写 <- 装备树叠加）
//   2. 伤害公式（含暴击、护甲）
//   3. 可用技能判断（模板技能 + 装备解锁 + 触发解锁）
//   4. 出战技能选择（候选技能池按 SKILLBAR.loadout 选 N 个）
//   5. 技能可用判定（冷却 + 条件判断）
//   6. 子弹上限控制
//   7. 战斗统计（击杀数、造成伤害）
// 纯配置（config/*.json）+ 纯函数，world.js 只调用本模块接口，不硬编码伤害逻辑。
//
// 条件判断：所有模块节点可带 condition（见 src/P2P2_core_conditions.js），
// 不满足条件的节点整棵子树不生效；技能带 condition 则未满足前不可释放。

// 技能栏配置读取（config/skillbar.json → window.SKILLBAR）：
// 技能栏格数 capacity / 出战技能数 loadout 一律读配置，代码里不再写死；
// 仅在配置缺字段时退回原默认值（capacity 8 / loadout 4），改配置即改槽位数。
const SKILLBAR_DEFAULT_CAPACITY = 8;    // 原写死的兜底值：技能栏格数（与 config/modules.json 技能模块 maxSlots=8 对齐）
const SKILLBAR_DEFAULT_LOADOUT = 4;     // 原写死的兜底值：出战技能数
function _skillbarCfg() {
  return (typeof SKILLBAR !== 'undefined' && SKILLBAR) || (typeof window !== 'undefined' && window.SKILLBAR) || {};
}
function skillbarCapacity() {
  const cap = Math.floor(Number(_skillbarCfg().capacity)) || 0;
  return cap > 0 ? cap : SKILLBAR_DEFAULT_CAPACITY;
}
function skillbarLoadout() {
  const n = Math.floor(Number(_skillbarCfg().loadout)) || 0;
  return n > 0 ? n : SKILLBAR_DEFAULT_LOADOUT;
}

const Combat = {
  // ---- 模块树解析 ----
  // 引用可以是字符串 id，或 { id, mods } 对象（mods 为子模块树）
  _resolve(ref, registry) {
    if (typeof ref === 'string') return { def: registry[ref] || null, mods: null };
    if (ref && typeof ref === 'object') {
      return { def: (ref.id && registry[ref.id]) || null, mods: ref.mods || null };
    }
    return { def: null, mods: null };
  },

  // 由玩家状态构造条件上下文（供所有模块 condition 使用）
  // 除血量/击杀/时间外，带上受击数、命中数、连击数（触发器与模块条件共用同一套计数）
  _buildCtx(player) {
    const stats = player.statsTotal || {};
    const st = player.stats || {};
    // 血量比一律以「条件重算前的基线上限」为分母（_statsBaseNoCond），
    // 避免条件型模块自身抬高上限（如 relic_blood +200）后把血量比拉低、造成条件反复翻转。
    const maxHp = (player._statsBaseNoCond && player._statsBaseNoCond.hp) || stats.hp || 0;
    // 血量未初始化（构造期 calcStats）时按满血处理，避免条件型模块在开局被误判为「半血以下」而生效
    const hp = (typeof player.hp === 'number' && player.hp >= 0) ? player.hp : maxHp;
    return {
      hpRatio: maxHp ? hp / maxHp : 1,
      kills: st.kills || 0,
      deaths: st.deaths || 0,
      hits: st.hits || 0,
      hitTaken: st.hitTaken || 0,
      combo: st.combo || 0,
      time: player.worldTime || 0,
      skills: player.skillPool || [],
    };
  },

  // ---- 条件型模块的重算触发（方案 C）----
  // 条件上下文签名：血量分档（0.5% 粒度）+ 计数（击杀/死亡/命中/受击/连击）+ 对局整秒。
  // 语义：签名不变 => 条件判定结果不变 => 合成数值不必重算（Player.tickConditionalStats 据此短路）。
  // 各端输入同一套（血量 / 计数 / 世界时间）=> 同一签名 => 重算结果一致。
  statsKey(player) {
    const ctx = this._buildCtx(player);
    const ratio = (ctx.hpRatio !== undefined) ? ctx.hpRatio : 1;
    const pct = Math.max(0, Math.round(ratio * 200));      // 0.5% 粒度，够精确又不抖动
    return [pct, ctx.kills || 0, ctx.deaths || 0, ctx.hits || 0, ctx.hitTaken || 0,
            ctx.combo || 0, Math.floor(ctx.time || 0)].join('|');
  },

  // ---- 攻击属性接线（方案 A）----
  // 伤害 = 弹型基础 damage（bullets.json）× 释放方式倍率（castMul，子弹内部） × 攻击者运行时 damageMul（本函数）
  // 攻击者 damageMul 来自 calcStats 合成（单位 base + 装备/宝石/铭文/追加/档案模块条目），
  // 与 buff 增伤（world.applyDamage 内 BuffSystem.effects().damageMul）分属两个乘区，不重复计算。
  attackDamage(attackerStats, baseDmg) {
    const st = attackerStats || {};
    const mul = (typeof st.damageMul === 'number' && isFinite(st.damageMul) && st.damageMul > 0)
      ? st.damageMul : 1;
    return Math.max(1, Math.round((baseDmg || 0) * mul));
  },

  // 暴击掷骰（攻击者合成属性 critChance / critMul）：rng 由调用方注入。
  // 子弹端传入「子弹id + 目标id」派生的确定性 rng，保证各端对同一次命中判定一致。
  rollCrit(stats, dmg, rng = Math.random) {
    const st = stats || {};
    let out = Math.max(1, Math.round(dmg || 0));
    let crit = false;
    const cc = st.critChance || 0;
    if (cc > 0 && rng() < cc) {
      out = Math.max(1, Math.round(out * (st.critMul || 1.5)));
      crit = true;
    }
    return { dmg: out, crit };
  },

  // 递归收集模块树：collector = { add: {...}, unlockSkills: [...] }
  // 装备/铭文/宝石/追加统一"模块节点"结构，支持无限层级子模块（mods 递归）
  // 节点带 condition 且不满足时，整棵子树（含该节点 add/技能）不生效
  _collectMod(def, mods, collector, registry, ctx) {
    if (!def) return;
    if (def.condition && !Conditions.check(def.condition, ctx)) return;
    if (def.add) {
      for (const k in def.add) collector.add[k] = (collector.add[k] || 0) + def.add[k];
    }
    if (Array.isArray(def.unlockSkills)) {
      def.unlockSkills.forEach(s => collector.unlockSkills.push(s));
    }
    if (mods) {
      for (const mid in mods) {
        const { def: subDef, mods: subMods } = this._resolve(mods[mid], registry);
        this._collectMod(subDef, subMods, collector, registry, ctx);
      }
    }
  },

  // 收集玩家整棵装备树（装备 + 铭文/宝石/追加，可无限递归）
  _collectEquipment(player, collector, ctx) {
    (player.equipment || []).forEach(inst => {
      const { def, mods } = this._resolve(inst, EQUIPMENT);
      this._collectMod(def, mods, collector, MODS, ctx);
    });
  },

  // 收集玩家档案挂载的模块条目（config/modules.json + config/profiles.json）
  // 与装备树同构：条目 = 模块节点，带 add / unlockSkills / condition / mods 子挂载，走同一套递归引擎
  // 档案接管装备时 player.equipment 已清空，这里承担全部数值与技能来源
  _collectProfile(player, collector, ctx) {
    (player.profileModules || []).forEach(node => {
      this._collectMod(node.def, node.mods, collector, node.children || MODS, ctx);
    });
  },

  // ---- 数值合成 ----
  // player: { unitId, equipment: [inst...], profileModules: [node...], baseOverride, triggerUnlocked: [skillId...] }
  // 优先级：BASE_STATS < UNITS 模板 base < 玩家档案 base 覆写（baseOverride）< 模块条目 add 叠加
  calcStats(player) {
    const cls = UNITS[player.classId] || UNITS[player.roleId] || UNITS.hero;
    const base = { ...BASE_STATS, ...(cls ? cls.base : {}), ...((player && player.baseOverride) || {}) };
    const ctx = this._buildCtx(player);

    // 装备树 + 档案模块条目递归叠加（带条件过滤）
    const collector = { add: {}, unlockSkills: [] };
    this._collectEquipment(player, collector, ctx);
    this._collectProfile(player, collector, ctx);
    const stats = { ...base };
    for (const k in collector.add) stats[k] = (stats[k] || 0) + collector.add[k];
    // 减伤链数值规整：护甲为非负整数（百分比公式 100/(100+armor)）；
    // 魔抗 resist 支持两种写法：|v| <= 1 为比例减伤（-0.9~0.9），|v| > 1 视为点数（不裁剪）
    stats.armor = Math.max(0, stats.armor || 0);
    const rv = stats.resist || 0;
    stats.resist = (Math.abs(rv) <= 1) ? Math.max(-0.9, Math.min(0.9, rv)) : rv;
    return stats;
  },

  // ---- 候选技能池 ----
  // 返回技能 id 数组：模板技能 + 装备树解锁（任意层级）+ 触发解锁
  // 结果按 config/skillbar.json 的 capacity 截断（格数由配置决定，缺字段时才退回默认 8）
  availableSkills(player, triggerUnlocked = []) {
    const cls = UNITS[player.classId] || UNITS.hero;
    const set = new Set(cls && Array.isArray(cls.skills) ? cls.skills : []);
    // 先以当前已知技能构造 ctx，让装备/铭文的 hasSkill 类条件可感知模板技能
    const ctx = { ...this._buildCtx(player), skills: [...set] };
    const collector = { add: {}, unlockSkills: [] };
    this._collectEquipment(player, collector, ctx);
    this._collectProfile(player, collector, ctx);
    collector.unlockSkills.forEach(s => set.add(s));
    (triggerUnlocked || []).forEach(s => set.add(s));
    return [...set].slice(0, skillbarCapacity());
  },

  // ---- 出战技能选择 ----
  // 战斗模块规定 loadout 个技能位（数量读 config/skillbar.json，缺字段时才退回默认 4）：从候选池按技能 priority 升序选取
  // （后续交互面板可让玩家手动覆盖出战顺序，未覆盖前按优先级自动排）
  selectLoadout(player, pool) {
    const n = Math.max(1, skillbarLoadout());
    const sorted = (pool || []).slice().sort((a, b) => {
      const pa = (SKILLS[a] && SKILLS[a].priority != null) ? SKILLS[a].priority : 99;
      const pb = (SKILLS[b] && SKILLS[b].priority != null) ? SKILLS[b].priority : 99;
      return pa - pb;
    });
    return sorted.slice(0, n);
  },

  // ---- 技能可用判定 ----
  // 出战技能 + 冷却结束 + 技能自身条件（condition）满足，才可释放
  canUseSkill(player, skillId, ctx) {
    const skill = SKILLS[skillId];
    if (!skill) return false;
    if (player.skillCd && player.skillCd[skillId] > 0) return false;
    return Conditions.check(skill.condition, ctx || this._buildCtx(player));
  },

  // ---- 伤害公式 ----
  // 基础伤害 * 施法者伤害倍率，暴击翻倍（护甲/抗性在 mitigate 里按目标属性结算）
  calcDamage(stats, skillDmg, rng = Math.random) {
    let dmg = skillDmg * (stats.damageMul || 1);
    let crit = false;
    if ((stats.critChance || 0) > 0 && rng() < stats.critChance) {
      dmg *= (stats.critMul || 1.5);
      crit = true;
    }
    dmg = Math.max(1, Math.round(dmg));
    return { dmg, crit };
  },

  // 减伤结算（目标侧属性链，v1：按伤害类型分链）
  //   物理（kind 缺省 / 'phys'）：实伤 = 原伤 × 100/(100+armor)  —— 护甲百分比减免
  //   魔法（kind === 'magic'）：走魔抗 resist —— |resist| <= 1 视为比例（0.25 = 减 25%，负值易伤）；
  //                            |resist| > 1 视为点数，按同族公式 100/(100+resist) 结算
  //   数值保护：armor / resist 均为 0（默认）时输出与原伤逐点一致；最低保底 1 点
  //   乘算减伤（damageTakenMul / 护盾吸收）不在此处，由 world.applyDamage 的 buff 链负责
  mitigate(defStats, dmg, kind) {
    const base = Math.max(0, dmg || 0);
    const st = defStats || {};
    let rate;
    if (kind === 'magic') {
      const r = (typeof st.resist === 'number') ? st.resist : 0;
      rate = (Math.abs(r) <= 1) ? Math.max(-0.9, Math.min(0.9, r)) : (r / (100 + Math.abs(r)));
    } else {
      const armor = Math.max(0, st.armor || 0);
      rate = armor / (100 + armor);          // 0 -> 不减伤；20 -> 约 16.7%；100 -> 50%
    }
    return Math.max(1, Math.round(base * (1 - rate)));
  },

  // 伤害类型解析：技能配置声明 damageType:'magic' 走魔抗（resist），其余缺省走护甲（armor）
  damageKindOf(skill) {
    const s = (typeof skill === 'string') ? SKILLS[skill] : skill;
    return (s && s.damageType === 'magic') ? 'magic' : 'phys';
  },

  // 结算一次命中：攻击方数值（暴击）→ 目标减伤链（kind 见 mitigate）
  // defStats 省略时退化为无减伤（兼容旧调用）
  applyHit(stats, skillDmg, rng = Math.random, defStats, kind) {
    const { dmg, crit } = this.calcDamage(stats, skillDmg, rng);
    return { dmg: this.mitigate(defStats || {}, dmg, kind), crit };
  },

  // ---- 子弹上限 ----
  canFireBullet(player, currentCount) {
    const limit = (Combat.calcStats(player).bulletLimit) || 100;
    return currentCount < limit;
  },

  // ---- 统计 ----
  // 连击窗口（秒）：两次命中间隔超过该值，连击清零重算
  COMBO_WINDOW: 2.5,

  recordKill(player, killed) {
    player.stats = player.stats || { kills: 0, dmgDealt: 0 };
    player.stats.kills++;
    if (killed && killed.stats) {
      killed.stats.deaths = (killed.stats.deaths || 0) + 1;
    }
  },
  recordDamage(player, dmg) {
    player.stats = player.stats || { kills: 0, dmgDealt: 0 };
    player.stats.dmgDealt += dmg;
  },
  // 命中计数：攻击者 hits+1、目标 hitTaken+1（供触发器条件链与面板展示）
  recordHit(from, target) {
    if (from) {
      from.stats = from.stats || {};
      from.stats.hits = (from.stats.hits || 0) + 1;
    }
    if (target) {
      target.stats = target.stats || {};
      target.stats.hitTaken = (target.stats.hitTaken || 0) + 1;
    }
  },
  // 连击计数：命中窗口（COMBO_WINDOW）内连续命中累加，超时归零；hit=false 用于死亡/复活清零
  recordCombo(player, now, hit = true) {
    if (!player) return 0;
    player.stats = player.stats || {};
    if (!hit) {
      player.stats.combo = 0;
      player.lastHitAt = -1e9;
      return 0;
    }
    const last = (typeof player.lastHitAt === 'number') ? player.lastHitAt : -1e9;
    player.stats.combo = (now - last <= this.COMBO_WINDOW) ? (player.stats.combo || 0) + 1 : 1;
    player.lastHitAt = now;
    player.stats.maxCombo = Math.max(player.stats.maxCombo || 0, player.stats.combo);
    return player.stats.combo;
  },
};
