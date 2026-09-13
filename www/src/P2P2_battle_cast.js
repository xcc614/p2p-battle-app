// ============================================================================
// P2P2_battle_cast.js —— 释放方式（release）框架
//  需求一（1~4）：瞬间发射 / 持续释放 / 蓄力 / 禁咒 / 吟唱 五种释放方式统一由
//  config/skills.json 的 release（别名 castConfig）配置驱动：
//    · 禁止移动 / 禁止释放其他技能 / 显示进度条 均为可配置开关项（lockMove / lockCast / bar）
//    · 禁咒、吟唱默认启用（出厂 enabled:true，配置里可随时关掉）
//    · 扩展位：CastSystem.register('新方式', {...}) 注册即可，主循环无需改动
//  职责边界：本模块只做「施法状态 + 判定（读条比例 / 禁咒打点积分 / 吟唱笔迹贴合度）」，
//  真正的出膛（生成子弹、广播）仍由 P2P2_battle_world.finishCast 统一负责，
//  保持"纯配置驱动 + 各端本地生成 + 房主权威结算"的既有架构不变。
// ============================================================================

const CastSystem = {
  // 出厂注册表：skills.json 的 _releases[释放方式] 可覆盖其中任意字段（含 enabled 开关）
  RELEASES: {
    // 瞬间发射：按下即出膛（原 spread/ring/burst/lock/lockon/strike/barrage 等排布方式同属此类）
    instant: {
      name: '瞬间发射', enabled: true,
      lockMove: false, lockCast: false, bar: false, duration: 0, mul: 1,
    },
    // 持续释放：释放期间锁定技能栏（同时只能维持一个技能），显示进度条（持续型技能的施法窗口）
    channel: {
      name: '持续释放', enabled: true,
      lockMove: false, lockCast: true, bar: true, duration: 0, mul: 1,
    },
    // 蓄力：长按读条、松手提前释放，伤害按实际蓄力比例折算；蓄力期间禁止释放其他技能
    //   lockMove 出厂 false（蓄力中仍可走位，避免破坏原有手感）——需要"蓄力定身"在配置里置 true 即可
    charge: {
      name: '蓄力', enabled: true,
      lockMove: false, lockCast: true, bar: true, duration: 1.2, hold: true,
      mul: 1.6, dmgFloor: 0.15, barPos: 'bottom',
    },
    // 禁咒：点击后禁止移动/禁止释放其他技能并显示读条；屏幕中央出现收缩光环，按时机点击积分
    //   手感增强（本轮）：读条加长到 5.5s 一档、判定点更大更亮、命中窗口放宽、判定点判定后仍停留 markHold 秒
    forbid: {
      name: '禁咒', enabled: true,
      lockMove: true, lockCast: true, bar: true, duration: 5.5, mul: 2.4, dmgFloor: 0.15,
      points: 7,            // 圆点数量
      pointR: 28,           // 判定点半径（px）
      ringScale: 3.0,       // 光环起始半径 = pointR * ringScale（向内收缩）
      period: null,         // 每个点光环收缩时长（秒，缺省按读条时长自动分配）
      hitWindow: 0.52,      // 判定窗口：|Δ| ≤ hitWindow 内点击有效（越准分越高）
      perfect: 0.10,        // 完美判定（满分）
      hitTol: 42,           // 点击命中容差（px）
      markHold: 0.9,        // 判定点命中/落空后的停留显示时长（秒）——让判定结果看得清
      markGlow: true,       // 判定点是否带发光/外扩脉冲
      botRatio: 0.7,        // AI/Boss 无人操作时的自动判定比例
    },
    // 吟唱：点击后在画布上描摹目标字/图案，结束按笔迹贴合度折算伤害
    chant: {
      name: '吟唱', enabled: true,
      lockMove: true, lockCast: true, bar: true, duration: 4.5, mul: 2.2, dmgFloor: 0.15,
      glyph: '火',          // 目标字（也可配 1~2 个字符的图案符号，如 '★' '△'）
      glyphs: null,         // 每次吟唱随机取一个（确定性：按事件序号取，各端一致）；为空则用 glyph
      grid: 24,             // 判定网格 N×N
      brush: 1.1,           // 笔迹粗细（格）
      tolerance: 1,         // 目标膨胀格数（少画/偏移容差）
      botRatio: 0.7,
      showTarget: true,     // 画布上是否预显示目标字
    },
  },

  // 旧 cast 值 → 释放方式 的别名映射（老配置零改动即可运行）
  ALIASES: {
    spread: 'instant', ring: 'instant', burst: 'instant', lock: 'instant',
    lockon: 'instant', strike: 'instant', barrage: 'instant',
    orbit: 'instant', area_drop: 'instant', droparea: 'instant',
    melee: 'instant', aura: 'instant',
    sustained: 'channel', continue: 'channel', hold: 'charge',
  },

  instances: {},       // playerId -> 施法实例
  seq: 0,
  _applied: null,      // 配置覆盖已应用标记

  // ---- 注册 / 配置 ---------------------------------------------------------
  // 扩展新释放方式：CastSystem.register('blood', { name:'血祭', lockMove:true, duration:2 })
  register(id, def) {
    if (!id) return;
    this.RELEASES[id] = Object.assign({}, this.RELEASES[id] || {}, def || {});
    this._applied = null;      // 注册后重新应用配置覆盖（保证 _releases 里的开关仍生效）
    return this.RELEASES[id];
  },

  // 合并 skills.json 的 _releases 配置（含 enabled 开关与任意数值项）
  _applyCfg() {
    if (this._applied) return;
    const cfg = (typeof SKILLS !== 'undefined' && SKILLS && SKILLS._releases) ? SKILLS._releases : null;
    if (cfg) {
      for (const k in cfg) {
        if (!cfg[k] || typeof cfg[k] !== 'object') continue;
        this.RELEASES[k] = Object.assign({}, this.RELEASES[k] || { name: k, duration: 0 }, cfg[k]);
      }
    }
    this._applied = true;
  },

  defOf(id) {
    this._applyCfg();
    if (!id) return null;
    const key = this.ALIASES[id] || id;
    return this.RELEASES[key] || null;
  },

  // 该释放方式当前是否开放（默认：注册表里的 enabled；配置可整项覆盖）
  enabled(def) {
    const d = def || {};
    if (d.enabled === false || d.enabled === 0) return false;
    if (d.enabled === true || d.enabled === 1) return true;
    const base = this.defOf(d.type);
    return !base || base.enabled !== false;
  },

  // ---- 技能 → 释放描述（配置归一化） ---------------------------------------
  // 读取顺序：castConfig/releaseConfig（对象，优先级最高）> release（字符串/对象）
  //          > cast（旧字符串：'charge' → 蓄力，'channel' → 持续释放，其余 → 瞬间发射）
  // 开关项：castConfig.lockMove / lockCast / bar 显式配置优先，否则回落 skill.lockMove 等，再回落注册表默认
  norm(skill) {
    const s = skill || {};
    const rc = (s.castConfig && typeof s.castConfig === 'object') ? s.castConfig
      : ((s.releaseConfig && typeof s.releaseConfig === 'object') ? s.releaseConfig : {});
    const rawRel = (typeof s.release === 'string') ? s.release
      : ((s.release && typeof s.release === 'object') ? s.release.type : null);
    const castStr = (typeof s.cast === 'string') ? s.cast : '';
    let id = rawRel || rc.type || (castStr === 'charge' ? 'charge'
      : (castStr === 'channel' ? 'channel' : 'instant'));
    if (this.ALIASES[id]) id = this.ALIASES[id];
    const base = this.defOf(id) || this.defOf('instant') || {};
    const def = Object.assign({}, base, rc);
    def.type = id;
    def.name = def.name || id;

    // 读条时长：castConfig.duration > skill.chargeTime > skill.charge(数值) > skill.castDuration > 注册表默认
    const num = (v) => ((typeof v === 'number' && isFinite(v)) ? v : null);
    let dur = num(rc.duration);
    if (dur == null) dur = num(s.chargeTime);
    if (dur == null) dur = num(s.charge);
    if (dur == null) dur = num(s.castDuration);
    if (dur == null) dur = num(def.duration);
    def.duration = Math.max(0, dur || 0);

    // 开关项（禁止移动 / 禁止释放其他技能 / 显示读条）
    def.lockMove = (rc.lockMove != null) ? !!rc.lockMove : ((s.lockMove != null) ? !!s.lockMove : !!def.lockMove);
    def.lockCast = (rc.lockCast != null) ? !!rc.lockCast : ((s.lockCast != null) ? !!s.lockCast : !!def.lockCast);
    def.bar = (rc.bar != null) ? !!rc.bar : ((s.castBar != null) ? !!s.castBar : !!def.bar);

    // 蓄力特殊项：hold（长按蓄力 / 松手提前释放）、mul（满蓄力伤害倍率）
    def.hold = (rc.hold != null) ? !!rc.hold
      : ((s.chargeHold != null) ? !!s.chargeHold : (def.hold !== false));
    def.mul = num(rc.mul) != null ? rc.mul
      : (num(s.chargeMul) != null ? s.chargeMul
        : (num(s.releaseMul) != null ? s.releaseMul : (num(def.mul) != null ? def.mul : 1)));
    def.dmgFloor = (num(def.dmgFloor) != null) ? def.dmgFloor : 0.15;
    def.enabled = this.enabled(def);
    return def;
  },

  // 判定比例 → 伤害倍率（charge 与传统 chargeMul 完全兼容：ratio=1 时等于 mul）
  dmgMul(def, ratio) {
    const d = def || {};
    const r = Math.max(0, Math.min(1, (typeof ratio === 'number' && isFinite(ratio)) ? ratio : 1));
    const mul = (typeof d.mul === 'number' && isFinite(d.mul)) ? d.mul : 1;
    if (d.type === 'charge' || d.type === 'forbid' || d.type === 'chant') {
      return 1 + (mul - 1) * r;
    }
    return 1;
  },

  // ---- 施法状态 -----------------------------------------------------------
  get(pid) { return this.instances[pid] || null; },

  // 施法中：禁止移动 / 禁止释放其他技能
  locksMove(pid) {
    const it = this.instances[pid];
    return !!(it && it.def && it.def.lockMove);
  },
  locksCast(pid) {
    const it = this.instances[pid];
    return !!(it && it.def && it.def.lockCast);
  },
  busy(pid) { return !!this.instances[pid]; },

  // 开始一次「非即时」施法（禁咒 / 吟唱 / 其它注册的读条型释放方式）
  // 返回实例；已在施法中的玩家返回 null（调用方据此不再出膛）
  // silent=true：只做本地登记，不广播（用于接收远端蓄力进度时补登记读条）
  begin(world, player, skill, def, dir, silent) {
    if (!world || !player || !skill || !def) return null;
    if (this.instances[player.id]) return null;
    const myId = (world.net && world.net.myId) ? world.net.myId : null;
    const isLocal = (player.id === myId);
    const isBot = !!(world.bots && world.bots.some(b => b.id === player.id));
    const dur = Math.max(0.2, def.duration || 0);
    // 技能 id：skills.json 的技能对象本身不带 id 字段（window.SKILLS 以 id 为键名），
    //   这里按引用反查回 id。否则 inst.skillId 为 undefined，读条结束时
    //   world.finishCast 里 SKILLS[inst.skillId] 取不到技能会直接 return ——
    //   表现为禁咒/吟唱读条走完不出膛、伤害恒 0（本轮实测复现）。
    let sid = skill.id || skill.skillId;
    if (!sid && typeof SKILLS !== 'undefined' && SKILLS) {
      for (const k in SKILLS) { if (SKILLS[k] === skill) { sid = k; break; } }
    }
    const inst = {
      pid: player.id, skillId: sid, def, dir: dir || { x: 1, y: 0 },
      t: 0, dur, start: nowSec(), ratio: 0, local: isLocal, auto: (!isLocal),
      name: player.name || player.id, skillName: skill.name || skill.id || '',
      color: skill.color || player.effColor || '#8ad2ff',
      release: def.type, score: 0, fails: 0, points: [], strokes: [],
      seed: ++this.seq, done: false, dir0: dir || { x: 1, y: 0 },
    };
    // 禁咒：预生成判定点（确定性分布，各端一致；只有本机玩家才需要点）
    if (def.type === 'forbid') {
      const n = Math.max(1, def.points || 6);
      const per = Math.max(0.35, def.period || (dur * 0.8 / n));
      const span = Math.max(0, dur - per);
      for (let i = 0; i < n; i++) {
        const a = i * 2.3999632297286535;                    // 黄金角，确定性铺开
        const rr = Math.sqrt((i + 0.5) / n);
        inst.points.push({
          id: i, ax: Math.cos(a) * rr, ay: Math.sin(a) * rr,
          at: per + (n > 1 ? span * (i / (n - 1)) : 0),      // 判定时刻（相对施法起点）
          period: per, state: 'wait',
        });
      }
      inst.maxScore = n * 100;
    }
    // 吟唱：目标字（确定性选取，各端一致）
    if (def.type === 'chant') {
      const list = (def.glyphs && def.glyphs.length) ? def.glyphs : null;
      inst.glyph = list ? list[(inst.seed % list.length)] : (def.glyph || '火');
      inst.grid = Math.max(8, Math.min(64, def.grid || 24));
    }
    this.instances[player.id] = inst;
    // 读条广播（远端显示 Boss / 队友的读条；判定仍由各自客户端或房主负责）
    if (!silent && world.net && world.net.broadcast) {
      world.net.broadcast({
        t: 'cast', from: player.id, skillId: inst.skillId, release: def.type,
        name: def.name, skillName: inst.skillName, color: inst.color, dur: dur,
        glyph: inst.glyph || null,
      });
    }
    return inst;
  },

  // 蓄力读条登记：真正的蓄力逻辑仍在 world._beginCharge / _releaseCharge（既有机制不变），
  // 本方法只把"蓄力中"登记进 CastSystem，使其享受 lockMove / lockCast 与读条显示。
  // 注意：relay='charge' 的实例由 world._releaseCharge 结束，这里不做自动结算（避免重复出膛）。
  beginCharge(world, player, skill, def, dur, dir) {
    const d = (def && def.dir) ? def.dir : (dir || (skill && skill._castDir) || { x: 1, y: 0 });
    const it = this.begin(world, player, skill, def, d);
    if (it) {
      it.relay = 'charge';
      it.dur = Math.max(0.05, dur || def.duration || 0.05);
      it.charging = true;
    }
    return it;
  },

  // 远端读条（仅显示，不参与判定）：由 P2P2_app_main 的 'cast' 消息驱动
  showRemote(world, msg) {
    if (!msg || !msg.from) return null;
    if (this.instances[msg.from]) return this.instances[msg.from];
    const def = this.defOf(msg.release) || this.RELEASES.instant;
    const inst = {
      pid: msg.from, skillId: msg.skillId, def: Object.assign({}, def, { type: msg.release }),
      dir: { x: 1, y: 0 }, t: 0, dur: Math.max(0.2, msg.dur || def.duration || 0.2),
      start: nowSec(), ratio: 0, local: false, auto: true, remote: true,
      name: msg.name || msg.from, skillName: msg.skillName || '', color: msg.color || '#8ad2ff',
      release: msg.release, score: 0, fails: 0, points: [], strokes: [], seed: ++this.seq, done: false,
      glyph: msg.glyph || null,
    };
    this.instances[msg.from] = inst;
    return inst;
  },

  end(pid) {
    const it = this.instances[pid];
    delete this.instances[pid];
    return it || null;
  },

  reset() { this.instances = {}; },

  // 本机玩家当前的读条型施法实例（供 P2P2_ui_cast 绘制小游戏）
  localInstance(world) {
    const myId = (world && world.net && world.net.myId) ? world.net.myId : null;
    if (!myId) return null;
    const it = this.instances[myId];
    if (!it || it.remote) return null;
    if (it.def.type !== 'forbid' && it.def.type !== 'chant') return null;
    return it;
  },

  // 读条信息（HUD：玩家自身技能读条 + Boss 技能读条，屏幕中下位置展示）
  bars(world) {
    const out = [];
    for (const pid in this.instances) {
      const it = this.instances[pid];
      if (!it || !it.def || !it.def.bar) continue;
      const d = it.def;
      // 读条比例：禁咒按剩余时间（读条＝剩余判定窗口），其余按已施法进度
      const p = Math.max(0, Math.min(1, it.t / it.dur));
      const ratio = (d.type === 'forbid' || d.type === 'chant') ? p : p;
      out.push({
        pid, name: it.name, skillName: it.skillName, release: it.release,
        releaseName: d.name || it.release, color: it.color, ratio,
        left: Math.max(0, it.dur - it.t), dur: it.dur, type: d.type,
        score: it.score, maxScore: it.maxScore || 0, glyph: it.glyph || null,
      });
    }
    return out.sort((a, b) => (a.pid === (world && world.net && world.net.myId) ? -1 : 1));
  },

  // ---- 每帧推进 -----------------------------------------------------------
  update(dt, world) {
    if (!world) return;
    if (world.gameOver) {
      for (const pid in this.instances) this.end(pid);
      return;
    }
    for (const pid of Object.keys(this.instances)) {
      const it = this.instances[pid];
      if (!it) continue;
      const owner = world.players ? world.players.get(pid) : null;
      // 施法者消失/阵亡：直接中断（不出膛）
      if (!owner || !owner.alive) { this.end(pid); continue; }
      it.t += dt;
      it.ratio = Math.max(0, Math.min(1, it.t / it.dur));

      // 远端只读条（由 'cast' 消息重建，remote=true）：只刷新进度，不参与判定、不出膛——
      // 否则非拥有者端也会 finishCast 生成一份子弹，与拥有者广播的 shoot 事件重复。
      if (it.remote) {
        if (it.t >= it.dur + 0.4) this.end(pid);
        continue;
      }

      // 禁咒：光环收缩越过判定点 → 该点消失（此后点击无效，记失败）
      //   本轮：消失时记录 goneT，供 UI 继续停留显示 markHold 秒（判定结果看得清）
      if (it.def.type === 'forbid' && it.points.length) {
        for (const p of it.points) {
          if (p.state === 'wait' && it.t >= p.at + (it.def.hitWindow || 0.3)) {
            p.state = 'gone';
            p.goneT = it.t;
            it.fails++;
          }
        }
      }

      if (it.t < it.dur) continue;

      // 读条结束 → 结算判定比例
      if (it.relay === 'charge') {          // 蓄力：出膛由 world._updateCharges 负责，这里只兜底回收
        if (it.t > it.dur + 0.8) this.end(pid);
        continue;
      }
      const ratio = this.finalRatio(it);
      this.end(pid);
      if (typeof world.finishCast === 'function') world.finishCast(it, ratio);
    }
  },

  // 判定比例（伤害折算的输入）
  finalRatio(it) {
    const d = it.def || {};
    let r = 1;
    if (d.type === 'forbid') {
      const max = it.maxScore || 1;
      r = Math.max(0, Math.min(1, it.score / max));
      if (it.auto) r = (d.botRatio != null) ? d.botRatio : 0.7;
    } else if (d.type === 'chant') {
      r = this.chantScore(it);
      if (it.auto) r = (d.botRatio != null) ? d.botRatio : 0.7;
    } else if (d.type === 'charge') {
      r = 1;
    }
    const floor = (typeof d.dmgFloor === 'number') ? d.dmgFloor : 0;
    return Math.max(floor, Math.min(1, r));
  },

  // 吟唱：笔迹贴合度（多画了扣精确率、少画了扣召回率，取 F1）
  chantScore(it) {
    const tgt = it.targetCells;
    const usr = it.userCells;
    if (!tgt || !tgt.size) return 0;
    if (!usr || !usr.size) return 0;
    let hit = 0;
    for (const k of usr) if (tgt.has(k)) hit++;
    const precision = hit / usr.size;      // 多画了哪些部分 → 精确率
    const recall = hit / tgt.size;         // 少画了哪些部分 → 召回率
    if (precision + recall <= 0) return 0;
    return (2 * precision * recall) / (precision + recall);
  },

  // P2P2_ui_cast 采集到的笔迹/目标掩码回填（cell 键为 "x,y" 字符串）
  setChantData(pid, targetCells, userCells) {
    const it = this.instances[pid];
    if (!it) return;
    if (targetCells) it.targetCells = targetCells;
    if (userCells) it.userCells = userCells;
  },

  // 禁咒：玩家点击（dx/dy 为相对屏幕中心的像素位移，arenaR 为判定区半径）
  // 返回 {hit:bool, kind:'perfect'|'good'|'miss'|'invalid', score:number}
  click(world, dx, dy, arenaR, nowT) {
    const inst = this.localInstance(world);
    if (!inst || inst.def.type !== 'forbid') return null;
    const d = inst.def;
    // 判定时刻统一用「相对施法起点的秒数」（与 p.at / inst.t 同一基准）：
    //   nowT 传的是绝对时钟（performance.now/1000）时换算成相对值；未传则直接用实例内已推进的 inst.t。
    //   （原实现直接用绝对秒和相对的 p.at 比较，Δt 恒为巨值 → 判定永远落到 miss 分支）
    const t = (typeof nowT === 'number')
      ? Math.max(0, nowT - (inst.start || 0))
      : (inst.t || 0);
    // 取离点击点最近的"仍在场"的判定点（须在 hitTol 内）
    let best = null, bd = Infinity;
    for (const p of inst.points) {
      if (p.state !== 'wait') continue;
      if (t < p.at - p.period) continue;                 // 光环尚未出现
      const px = p.ax * arenaR, py = p.ay * arenaR;
      const dist = Math.hypot(px - dx, py - dy);
      if (dist <= (d.hitTol || 34) && dist < bd) { bd = dist; best = p; }
    }
    if (!best) { inst.fails++; return { hit: false, kind: 'invalid', score: 0 }; }
    const dtAbs = Math.abs(t - best.at);
    const win = d.hitWindow || 0.3;
    if (dtAbs > win) { inst.fails++; return { hit: false, kind: 'miss', score: 0 }; }
    const score = (dtAbs <= (d.perfect || 0.06)) ? 100
      : Math.round(100 * Math.max(0, 1 - (dtAbs - (d.perfect || 0.06)) / Math.max(0.05, win - (d.perfect || 0.06))));
    best.state = 'hit';
    best.score = score;
    best.clickT = t;
    inst.score = (inst.score || 0) + score;
    return { hit: true, kind: score >= 100 ? 'perfect' : 'good', score, point: best };
  },
};

// 施法/判定统一时钟（秒）：与子弹、特效同一时间基准（performance.now）
function nowSec() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now() / 1000;
  return Date.now() / 1000;
}
