// ===== 玩家实体（勇者 / Boss / AI 共用）=====
// 单位模板（config/units.json -> UNITS）定义 基础属性/初始技能/配色/贴图。
// 去职业化：不存在"职业"概念，玩家 = 单位模板 + 装备 + 触发解锁。
// 数值一律由 Combat.calcStats 合成（BASE_STATS <- 单位 base <- 装备树），逻辑不写死单位数值。
//
// 资源/换皮接口（配置驱动，缺图自动回退色块）：
//   cfg.color    色块主色（无贴图回退色）
//   cfg.image    assets/ 下实体贴图（可选）
//   cfg.fxImage  assets/ 下技能发射粒子图（可选；未配则色块粒子）
//   setSlot(n)   同模板多单位时的视觉位：effColor = 模板 color，模板无 color 用 PALETTE 兜底
//
// 技能栏（config/skillbar.json）：
//   skillPool = 全部来源技能（单位初始 + 装备解锁 + 触发解锁）进候选池，上限 capacity 格
//   loadout   = Combat.selectLoadout 按 priority 选出战技能（loadout 个技能位），战斗只放得出战技能

class Player {
  constructor(id, name, unitId, isHost, profile) {
    this.id = id;
    this.name = name;
    this.unitId = unitId;          // 单位模板 id（config/units.json 的 key）
    this.roleId = unitId;          // 兼容字段（网络/服务器透传沿用 roleId 命名）
    this.classId = unitId;         // 兼容字段（底层沿用 classId 命名，语义=单位模板）
    this.isHost = isHost;
    this.cfg = UNITS[unitId] || UNITS.hero || {};
    this.image = this.cfg.image || null;      // 实体贴图（assets/，换皮接口）
    this.isBoss = !!this.cfg.isBoss;
    this.team = this.isBoss ? 'boss' : 'players';   // 阵营（AI 敌我判断用）
    this.slot = 0;                 // 视觉位（同模板多人时由 World 排定，纯观感）
    this.effColor = this.cfg.color || Player.PALETTE[0];  // 观感主色
    this.profile = null;           // 玩家档案（config/profiles.json）：底座 + 基础属性覆写 + 挂载模块
    this.profileId = null;         // 档案 id（房间同步/面板回显用）
    this.profileModules = [];      // 档案条目解析出的模块节点（Combat 统一收集数值与技能）
    this.baseOverride = null;      // 档案基础属性覆写（叠加在单位模板 base 之上）
    this.equipment = (this.cfg.equipment || []).slice();  // 默认装备实例（单位模板预配；档案接管时清空）
    if (profile && typeof Profiles !== 'undefined') {
      // 档案接管装配：base 覆写 + 模块条目（装备/宝石/铭文/技能/自定义），数值仍由 Combat.calcStats 合成
      Profiles.applyTo(this, profile);
    }
    this.triggerUnlocked = [];                            // 触发解锁技能
    this.statsTotal = Combat.calcStats(this);
    this._statsBase = this.statsTotal;                    // 无 buff 基础值（buff 合成基数，P2）
    this._statsBaseNoCond = this.statsTotal;              // 条件重算基线（方案 C；血量比分母，防条件自激）
    this._condKey = null;                                 // 条件签名（Combat.statsKey）：不变则不重算
    this.buffs = [];                                      // 生效 buff（BuffSystem 管理，P2）
    this.dots = [];                                       // 生效持续伤害（撕裂 DoT，BuffSystem 管理；本轮新增）
    this.x = 0; this.y = 0;
    this.dir = { x: 1, y: 0 };
    this.hp = this.statsTotal.hp;
    this.radius = this.statsTotal.radius;
    this.alive = true;
    this.respawnAt = 0;
    this.skillCd = {};
    this.castUntil = {};   // 需求10：释放中视觉窗口（CD/就绪/释放中三态用）
    this.worldTime = 0;
    this.skillPool = [];
    this.loadout = [];
    this.rebuildSkillBar();
    this.kills = 0;
    this.local = false;
    // 战斗统计：kills 击杀 / dmgDealt 造成伤害 / deaths 死亡 / hits 命中次数 /
    // hitTaken 受击次数 / combo 当前连击 / maxCombo 最高连击（后四项供触发器条件链使用）
    this.stats = { kills: 0, dmgDealt: 0, deaths: 0, hits: 0, hitTaken: 0, combo: 0, maxCombo: 0 };
    this.lastHitAt = -1e9;         // 上次命中时间（连击窗口判定）
    this.phaseAt = 0;              // 阶段计时基准（触发器每触发一次即推进，phaseAfter 条件用）
    // v1 运行时量（按单位维护，经 Triggers._ctx / runtimeInfo 暴露给 when 条件链）
    this.aliveSince = 0;           // 本轮连续存活起点（世界时间秒，aliveTime = 现在 - 本值）
    this.deathAt = 0;              // 最近一次死亡时刻（世界时间秒；0 = 尚未死亡，aliveTime 在此冻结）
    this.comboBreakReason = '';    // 最近一次连击被打断的原因：timeout | death | respawn（自检/面板）
    this.botKind = null;           // AI 类型（world.addSoloBot 注入）
    this.aiLevel = 0;
    this._aiThinkT = 0; this._aiAtkT = 0; this._mv = { x: 0, y: 0 };
  }

  // 同模板多单位时给观感位（纯色区分用）；模板有 color 则模板色优先
  setSlot(n) {
    this.slot = n || 0;
    this.effColor = (this.cfg && this.cfg.color)
      ? this.cfg.color
      : Player.PALETTE[this.slot % Player.PALETTE.length];
    return this.effColor;
  }

  // 重建技能栏：候选池（单位+装备+触发，截断 capacity）-> 出战技能（selectLoadout）
  // Boss 不做出战位截断：候选池即出战（阶段解锁的新技能全部可放）
  rebuildSkillBar() {
    this.skillPool = Combat.availableSkills(this, this.triggerUnlocked);
    this.loadout = this.isBoss ? this.skillPool.slice() : Combat.selectLoadout(this, this.skillPool);
  }

  // 运行期应用 / 更新玩家档案（快照对齐、房间重开换档案时用）：重算属性与技能栏
  // 传 null = 卸下档案，回退单位模板预配
  applyProfile(profile) {
    if (typeof Profiles === 'undefined') return null;
    if (!profile) {
      this.profile = null;
      this.profileId = null;
      this.profileModules = [];
      this.baseOverride = null;
      this.equipment = (this.cfg.equipment || []).slice();
    } else {
      if (!this.isBoss) this.profileId = profile.__id || this.profileId;   // 同步下发的档案可带 __id 便于回显
      Profiles.applyTo(this, profile);
    }
    this.statsTotal = this._applyHpScale(Combat.calcStats(this));
    this._statsBase = this.statsTotal;
    this._statsBaseNoCond = this.statsTotal;
    this._condKey = null;                                                    // 条件签名失效，下帧强制重算
    this.hp = Math.min(this.hp || this.statsTotal.hp, this.statsTotal.hp);   // 属性变化后血量不超上限
    this.radius = this.statsTotal.radius;
    if (this._refreshBuffStats) this._refreshBuffStats();                    // buff 加成基于新基数重算
    this.rebuildSkillBar();
    return this.profile;
  }

  // 血量缩放（快速试玩 bossHpMul 等外部数值调整的持久因子）：
  // 条件重算会用 calcStats 覆盖基线，这里在每次重算后重新套用同一因子，保证削弱不被重算抹掉。
  _applyHpScale(st) {
    const m = this._hpScaleMul;
    if (m && m !== 1 && st) st.hp = Math.max(1, Math.round((st.hp || 0) * m));
    return st;
  }

  // ===== 方案 C：条件型模块重算（各端统一，由 world.tick 每帧巡检调用）=====
  // 背景：装备/宝石/铭文里的条件模块（如血之遗物 hpBelow 0.5、风之遗物 timeAfter 10）
  //      原先只在开局 calcStats 判定一次并缓存，条件后来满足也不再重算 -> 永不生效。
  // 做法：以「条件签名」（Combat.statsKey：血量分档 + 击杀/死亡/命中/受击/连击计数 + 对局整秒）短路；
  //      签名变化时用同一套 Combat.calcStats 重算基线（条件由 conditions.js 实时判定），
  //      再交 _refreshBuffStats 叠加 buff —— 合成路径与构造/applyProfile 完全一致，故各端同值。
  // 说明：血量上限变化只做上限收敛（当前血量不因遗物生效而回血/掉血）。
  tickConditionalStats(force) {
    if (typeof Combat === 'undefined' || !Combat.statsKey) return this.statsTotal;
    if (!this._statsBaseNoCond) this._statsBaseNoCond = this._statsBase || this.statsTotal;
    const key = Combat.statsKey(this);
    if (!force && key === this._condKey) return this.statsTotal;   // 签名未变：条件判定结果不变，零开销跳过
    this._condKey = key;
    const base = this._applyHpScale(Combat.calcStats(this));
    this._statsBase = base;
    // 注意：_statsBaseNoCond 是「血量比」的分母，必须始终为「不含条件加成」的基线上限。
    // 若在此把它覆盖成带条件的结果（如血之遗物 +200 后的上限），条件会把自己的抬升代入分母，
    // 造成判定迟滞、并在端间血量短暂不同步时放大成数值漂移——故仅在缺失时补种，之后不再改写。
    if (!this._statsBaseNoCond) this._statsBaseNoCond = base;
    if (this._refreshBuffStats) this._refreshBuffStats();
    else this.statsTotal = base;
    this.hp = Math.min(this.hp, this.statsTotal.hp);
    if (this.statsTotal.radius) this.radius = this.statsTotal.radius;
    return this.statsTotal;
  }

  // 出生布阵：Boss 恒在场地正中，其余单位围绕中心近距离环形分布
  // （旧逻辑把玩家放在四角 20%/80%，离中心太远，刷新后要跑很久才能接敌）
  static spawnPos(index, arena) {
    const cx = arena.w / 2, cy = arena.h / 2;
    const idx = ((index % 5) + 5) % 5;
    if (idx === 4) return { x: cx, y: cy };              // Boss / 中央位：场地正中
    const r = Math.min(arena.w, arena.h) * 0.26;         // 出生环半径：围绕中心、相距不远
    const ang = -Math.PI / 2 + idx * (Math.PI / 2);      // 上 / 右 / 下 / 左
    return { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r };
  }

  update(dt) {
    this._refreshBuffStats();
    // 攻击速度加成：加速技能冷却递减（攻速 buff 真实缩短出手间隔）
    const asMul = 1 + ((this.statsTotal && this.statsTotal.atkSpeedMul) || 0);
    for (const k in this.skillCd) {
      this.skillCd[k] = Math.max(0, this.skillCd[k] - dt * asMul);
    }
    return null;
  }

  // ===== v1 判定计数生命周期（按单位维护；写入点仍在 world.applyDamage → Combat.recordHit/recordCombo）=====
  // 计数分工：hits 命中次数 / hitTaken 受击次数 / combo 当前连击 / maxCombo 最高连击（数值在 Combat 里累加），
  // 本类负责「连击被打断时清零」与「存活时长等运行时量」的维护，并由 Triggers._ctx 按单位读取。
  //
  // 连击清零规则（「被打断」的唯一定义，命中任一条即 combo 归零、lastHitAt 复位）：
  //   ① timeout  距上次命中已超过连击窗口（Combat.COMBO_WINDOW，默认 2.5s）——tickComboWindow 每帧巡检
  //   ② death    本单位被击倒（world.applyDamage 结算死亡时调用 breakCombo('death')）
  //   ③ respawn  本单位复活重新入场（world.checkRespawns 调用 breakCombo('respawn')）
  // 说明：单纯受击不打断连击，只有「受击导致死亡」（②）才清零；连击衡量的是本单位主动命中的连续性。
  breakCombo(reason) {
    if (typeof Combat !== 'undefined' && Combat.recordCombo) Combat.recordCombo(this, 0, false);
    else { this.stats.combo = 0; this.lastHitAt = -1e9; }
    this.comboBreakReason = reason || '';
    return this.stats.combo;
  }

  // 墙钟秒（与写点 Combat.recordCombo(..., performance.now() / 1000) 同源，避免与世界时间混用）
  static wallNow() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now() / 1000;
    return Date.now() / 1000;
  }

  // 连击窗口巡检（房主每 tick 调用）：超时即清零，避免 stats.combo 长期残留过期连击误导条件链
  tickComboWindow(now) {
    const t = (typeof now === 'number') ? now : Player.wallNow();
    const win = (typeof Combat !== 'undefined' && Combat.COMBO_WINDOW) ? Combat.COMBO_WINDOW : 2.5;
    const last = (typeof this.lastHitAt === 'number') ? this.lastHitAt : -1e9;
    if ((this.stats && (this.stats.combo || 0)) > 0 && (t - last) > win) this.breakCombo('timeout');
    return this.stats.combo || 0;
  }

  // 存活计时打点：出生 / 复活时调用（世界时间秒）；死亡后由 markDeath 冻结
  stampAlive(now) {
    this.aliveSince = (typeof now === 'number') ? now : 0;
    this.deathAt = 0;
    return this.aliveSince;
  }

  // 死亡打点：aliveTime 从此冻结在死亡时刻
  markDeath(now) {
    this.deathAt = (typeof now === 'number') ? now : 0;
    return this.deathAt;
  }

  // 运行时量快照（供触发器上下文按单位注入）：存活状态 / 连续存活秒数 / 复活倒计时 / 血量上限
  // aliveTime 与 world.time 同源；respawnLeft 依据 respawnAt（墙钟）换算，二者单位都是秒
  runtimeInfo(time) {
    const t = (typeof time === 'number') ? time : 0;
    const since = (typeof this.aliveSince === 'number') ? this.aliveSince : 0;
    const endAt = this.alive ? t : ((this.deathAt || 0) > 0 ? this.deathAt : t);
    return {
      alive: !!this.alive,
      aliveTime: Math.max(0, endAt - since),
      respawnLeft: (!this.alive && this.respawnAt)
        ? Math.max(0, this.respawnAt - Player.wallNow()) : 0,
      // 上限取「条件重算基线」的上限（方案 C：条件型遗物生效后仍以同一分母衡量血量比，防条件自激）
      maxHp: (this._statsBaseNoCond && this._statsBaseNoCond.hp) || (this.statsTotal && this.statsTotal.hp) || 0,
    };
  }

  // buff 状态 → statsTotal 合成（buff 时效/叠加见 BuffSystem；无 buff 还原 base，避免残留）
  _refreshBuffStats() {
    if (!this._statsBase) this._statsBase = Combat.calcStats(this);
    if (!this.buffs || !this.buffs.length) { this.statsTotal = this._statsBase; return; }
    const e = BuffSystem.effects(this);
    const base = this._statsBase;
    const st = { ...base };
    if (e.speedMul) st.speed = Math.max(0, Math.round((base.speed || 0) * (1 + e.speedMul)));
    // 伤害加成不写 statsTotal.damageMul：权威伤害结算在 world.applyDamage 用 BuffSystem.effects().damageMul
    // 一次性实时消费（dmg*(1+增益)），此处不再聚合，避免与 base 倍率混写造成双算隐患
    if (e.atkSpeedMul) st.atkSpeedMul = (base.atkSpeedMul || 0) + e.atkSpeedMul;
    if (e.lifesteal) st.lifesteal = (base.lifesteal || 0) + e.lifesteal;
    this.statsTotal = st;
  }

  // 同步护盾剩余量（房主 damage 广播带回权威值，覆盖本地 buff 中的 shield 条目）
  setShieldLeft(amount) {
    if (!this.buffs) this.buffs = [];
    if (!amount || amount <= 0) {
      this.buffs = this.buffs.filter(b => b.id !== 'shield');
      return;
    }
    const sh = this.buffs.find(b => b.id === 'shield');
    if (sh) sh.amt = amount;
  }

  inLoadout(skillId) {
    return this.loadout.includes(skillId);
  }

  // 第 8 批需求②：CD 进账时机可延迟——deferCd=true（蓄力 / 持续释放这类"读条型"）时，
  //   点击当帧只登记「待落实 CD」，真正的 skillCd 由 commitCd() 在出膛 / 读条收招时写入，
  //   实现"读条结束才进 CD"；即时释放仍走"按下即进 CD"的原行为（旧配置零改动）。
  cast(skillId, deferCd) {
    this.flushStaleCd();
    const _cd = (SKILLS[skillId] && SKILLS[skillId].cd != null) ? SKILLS[skillId].cd : 0;
    if (deferCd) {
      this._pendingCd = this._pendingCd || {};
      // deadline = 兜底期限：异常路径（施法被打断 / 目标阵亡 / 读条实例被清理）导致未落实时，
      //   由 flushStaleCd 在之后补写，避免"CD 永久不生效"或"技能卡死"两种坏状态
      this._pendingCd[skillId] = { cd: _cd, deadline: performance.now() / 1000 + 6 };
    } else {
      this.skillCd[skillId] = _cd;
    }
    // 需求10：释放中窗口（视觉三态用）；配置可经 skills.json 的 castWindow 微调
    const s = SKILLS[skillId] || {};
    const win = (s.castWindow != null && s.castWindow > 0) ? s.castWindow : (s.cd > 1.2 ? 0.45 : 0.25);
    this.castUntil[skillId] = performance.now() / 1000 + win;
  }

  // 第 8 批需求②：落实延迟 CD（蓄力出膛 / 持续释放收招时调用）
  commitCd(skillId) {
    if (!this._pendingCd) return;
    const it = this._pendingCd[skillId];
    if (!it) return;
    delete this._pendingCd[skillId];
    this.skillCd[skillId] = it.cd;
  }

  // 第 8 批需求②：兜底——超过 deadline 仍未落实的挂起 CD 就地补写（防异常路径让 CD 永久不生效）
  flushStaleCd(nowSec) {
    if (!this._pendingCd) return;
    const now = (typeof nowSec === 'number') ? nowSec : performance.now() / 1000;
    for (const k of Object.keys(this._pendingCd)) {
      const it = this._pendingCd[k];
      if (it && now >= it.deadline) { delete this._pendingCd[k]; this.skillCd[k] = it.cd; }
    }
  }

  // 触发模块入口（房主结算伤害后调用）
  // 返回本次触发事件，并应用解锁技能（Boss 阶段切换即走这里）
  checkTriggers(ctx) {
    const events = Triggers.check(this, ctx);
    if (events.length) {
      for (const ev of events) {
        if (ev.unlockSkills) {
          ev.unlockSkills.forEach(s => {
            if (!this.triggerUnlocked.includes(s)) this.triggerUnlocked.push(s);
          });
        }
      }
      this.rebuildSkillBar();
    }
    return events;
  }
}

// 同模板多人时的观感位配色（模板无 color 时按入场顺序取）
Player.PALETTE = ['#58a6ff', '#ffd166', '#06d6a0', '#ef476f', '#c084fc'];
