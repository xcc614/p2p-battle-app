// ===== 权威世界（房主侧）=====
// 房主持有唯一权威状态：玩家 hp、存活、技能冷却、伤害结算、Boss 阶段。
// 各端上报命中，房主校验后广播 damage/die/respawn/phase/gameover。
// 位置采用乐观同步（各端广播 pos），伤害绝对权威。
//
// 单人挑战（离线 AI）扩展：
//   world.solo=true：本地权威 stub，不走信令/WebRTC，玩家 + 任意 AI 队友/Boss 混战。
//   world.challenge=true：挑战模式。胜负对称判定——
//     Boss 死亡 => 勇者阵营胜；勇者阵营全员阵亡 => Boss 阵营胜。
//     （玩家扮演 Boss 也成立：AI 勇者全灭即 Boss 胜）
//   world.fxQueue：本机特效事件队列（命中/爆炸/死亡/弹幕发射口/阶段横幅/震屏），
//     由 Renderer 每帧消费播放。只影响表现，不参与同步。

class World {
  constructor(net) {
    this.net = net;
    this.players = new Map();   // id -> Player
    this._posDirectAt = {};     // memberId -> 最近直连 pos 到达时间(ms)，供 state 位置兜底判断
    this.bullets = new Map();   // id -> Bullet（本地模拟，非权威）
    this.bulletSeq = 0;
    this.bulletCount = {};      // ownerId -> 在场子弹数
    this.stateSeq = 0;
    this.gameOver = null;       // { winner: 'players'|'boss', by }
    this.lastStateAt = 0;
    this.hitBuffer = [];        // 本 tick 收到的 hit，房主统一处理
    this.solo = false;          // 单人模式（含离线 AI 挑战）
    this.roomBots = false;      // 联机房间 AI 补位：host 本地挂 bot（BotAI 据此在联机房驱动）
    this.challenge = false;     // 挑战模式（离线 AI 挑战）：胜负对称判定
    this.bots = [];             // 离线 AI（Boss bot / AI 勇者 bot）
    this.time = 0;              // 对局累计秒（房主 tick 注入）
    this.bossPhaseId = null;    // 最近触发阶段事件的 Boss 实体 id（新成员快照据此对齐阶段）
    this.fxQueue = [];          // 本机特效事件队列（渲染消费）
    this.buffDrops = [];        // 场地 buff 掉落物（房主权威生成/拾取，P2）
    this.buffDropSeq = 0;
    this._nextDropT = 0;        // 下次掉落时刻（host tick）
  }

  // profile（可选）：玩家档案（config/profiles.json 的单条档案对象），随房间同步下发；Boss 传 null
  addPlayer(id, name, roleId, isHost, profile) {
    const p = new Player(id, name, roleId, isHost, profile);
    const cfg = UNITS[roleId] || UNITS.hero || {};
    let spawn;
    if (cfg.isBoss) {
      spawn = Player.spawnPos(4, GAME_CONFIG.ARENA);   // Boss 恒出生在场中央
    } else {
      const idx = this.net.members.findIndex(m => m.id === id);
      spawn = Player.spawnPos((idx >= 0 ? idx : this.players.size) % 4, GAME_CONFIG.ARENA);
    }
    p.x = spawn.x; p.y = spawn.y;
    p.local = id === this.net.myId;
    // 同模板多单位按入场顺序分视觉位（仅观感：effColor / palette）
    const slotIdx = this.net.members.findIndex(m => m.id === id);
    p.setSlot(slotIdx >= 0 ? slotIdx : this.players.size);
    p.stampAlive(this.time || 0);     // v1：入场即开存活计时（中途加入者从入局时刻算起）
    this.players.set(id, p);
    return p;
  }

  // 离线挑战：把玩家实体注册为 AI bot（kind: 'boss' | 'fighter'，level: 1~N，档位数与默认档位取自 config/ai.json）
  addSoloBot(p, kind, level) {
    const cfg = (typeof BotAI !== 'undefined' && BotAI) ? BotAI : null;
    const maxLv = (cfg && cfg.levelCount) ? cfg.levelCount() : 5;
    const defLv = (cfg && cfg.defaultLevel) ? cfg.defaultLevel() : 3;
    const lv = Math.max(1, Math.min(maxLv, level || defLv));
    p.botKind = kind;
    p.aiLevel = lv;
    p._aiThinkT = 0;
    p._aiAtkT = Math.random() * 0.4;
    p._mv = { x: 0, y: 0 };
    p.stampAlive(this.time || 0);   // v1：AI 入场即开存活计时
    this.bots.push(p);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.bots = this.bots.filter(b => b.id !== id);
    this.net.removePeer(id);
  }

  // 本机特效事件（Renderer 消费）
  pushFx(type, x, y, color, data) {
    this.fxQueue.push({ type, x, y, color, ...(data || {}) });
  }

  // 本地玩家产生技能事件（统一入口：各端本地生成子弹 + 广播）
  fireSkill(player, skillId, dir) {
    const skill = SKILLS[skillId];
    if (!skill) return;
    // 出战位校验：技能栏模块选出的 loadout 才能放（loadout 存技能 id 字符串，入参 skillId 即 id）
    if (!player.inLoadout(skillId)) return;
    // 可用判定：冷却 + 技能条件（Conditions.check）
    if (!Combat.canUseSkill(player, skillId)) return;
    // 子弹上限校验（战斗模块按合成数值判定，支持装备加成上限）
    if (!Combat.canFireBullet(player, this.bulletCount[player.id] || 0)) return;
    player.cast(skillId);
    // 大招提示（本轮改动）：不再按出战位（旧版写死 index 7 = 8 号技能）判定，
    // 改为读技能属性标记 —— 仅 skills.json 中标了 ultimate:true 的技能（当前为 nova 新星爆发）
    // 释放成功时才打一条大字幕（与 Boss 阶段字幕同一套 FxFeed 队列），其余技能不再误报大招。
    if (skill.ultimate) {
      // 名称缺省取该玩家单位在 units.json 声明的 name（原写死 '勇者'）
      this.pushFx('banner', 0, 0, '#ff2d55', { text: '★ ' + (player.name || unitDisplayName(player.roleId) || player.roleId || '') + ' 释放大招「' + (skill.name || skillId) + '」！' });
    }
    // 发射口特效（本地）：颜色用观感色；技能配了 fxImage(粒子图)就按图播放
    this.pushFx('muzzle', player.x, player.y, player.effColor || '#ffffff', { d: 8, image: skill.fxImage || null });
    // 事件携带发射原点（ox/oy），远端据此重建，保证"开火端/接收端"子弹起点完全一致
    // 需求4：事件带发送侧时间戳（performance.now），接收端据此判断过期并丢弃
    const nowMs = performance.now();
    const ev = { t: 'shoot', from: player.id, skillId, dir, seq: ++this.bulletSeq,
                 time: nowMs, ts: nowMs, ox: player.x, oy: player.y };
    this.spawnSkillBullets(ev);
    // 子弹事件经信令服务器 TCP 中继广播（WebRTC UDP 直连丢包会让两端"子弹是两回事"）
    // 蓄力炮按下阶段（ev._chargePending=true）：本次不广播，出膛时由 _chargeShot 另发带 chargeRatio 的事件
    if (!ev._chargePending && this.net && this.net.relayShoot) this.net.relayShoot(ev);
  }

  // 释放方式（skills.json -> cast）：决定一次技能事件生成多少子弹、怎么排布、何时发射
  //   spread 扇形散射（默认，发数 count、张角 _spreadOf）/ ring 环形弹幕（count、ringEven 是否均匀）
  //   burst 连射（count、castInterval 间隔、burstTogether 是否同时起爆）
  //   charge 蓄力炮（单发重弹：伤害 ×chargeMul、弹速 ×1.15；chargeTime 蓄满时长 / chargeHold 可中途松手）
  //   lock 锁定追踪（自动锁定 lockRange 内最近敌人，bullet homing 转向）/ lockon 锁定追踪（扇形直射 + 追踪转向）
  //   strike 区域轰炸（瞄准点附近延迟落弹，count 发 × castInterval）
  //   barrage 区域轰炸·落点可配（castRange 投送距离 / barrageRadius 落点半径 / blastRadius 爆炸半径）
  // 缺省回退：cast 未配时按旧字段 ring 判定（true=环形，否则扇形），旧配置零改动
  _castOf(skill) {
    if (skill.cast) return skill.cast;
    return skill.ring ? 'ring' : 'spread';
  }

  // 扇形张角（弧度）：主字段 spread；兼容 castSpread / spreadAngle / spreadRad(弧度)、spreadDeg(度)
  // 全部缺省 = 0（张角 0 即直线，与旧单发行为一致）
  _spreadOf(skill) {
    const rad = (v) => ((typeof v === 'number' && isFinite(v) && v > 0) ? v : null);
    let v = rad(skill.spread) != null ? skill.spread : null;
    if (v == null) {
      for (const k of ['castSpread', 'spreadAngle', 'spreadRad']) {
        if (rad(skill[k]) != null) { v = skill[k]; break; }
      }
    }
    if (v == null && rad(skill.spreadDeg) != null) v = skill.spreadDeg * Math.PI / 180;
    return (v != null && isFinite(v) && v > 0) ? v : 0;
  }

  // 敌方单位列表（追踪 / 锁定用；按阵营取反，Boss 与勇者互为敌方）
  _enemiesOf(owner) {
    const out = [];
    if (!owner) return out;
    for (const [, p] of this.players) {
      if (!p.alive || p.id === owner.id) continue;
      if (p.isBoss === owner.isBoss) continue;
      out.push(p);
    }
    return out;
  }

  // 最近敌方单位（锁定追踪用）：距离最小者；并列时按 id 字典序，保证各端选同一人（确定性）
  _nearestEnemy(owner, range) {
    let best = null, bd = Infinity;
    for (const [, p] of this.players) {
      if (!p.alive || p.id === owner.id) continue;
      if (p.isBoss === owner.isBoss) continue;
      const d = Math.hypot(p.x - owner.x, p.y - owner.y);
      if (d > range) continue;
      if (d < bd - 1e-6) { bd = d; best = p; continue; }
      if (Math.abs(d - bd) <= 1e-6 && best && String(p.id) < String(best.id)) best = p;
    }
    return best;
  }

  // 生成单发子弹（统一登记到本地弹道表与 owner 计数）
  // 方案 A：生成时把攻击者运行时属性快照注入子弹（owner.statsTotal：单位 base + 装备/宝石/铭文/追加/档案模块），
  // 使子弹伤害 = 弹型基础 damage × 释放方式倍率 × 攻击者 damageMul，并按攻击者 critChance/critMul 掷暴击。
  // 房主端实体属性即权威属性（远端玩家的 statsTotal 由 applyProfile/applySnapshot + 条件重算维护），
  // 远端玩家子弹由房主按同一份属性结算，各端飘字/扣血以房主广播为准 -> 三者数值一致。
  _newBullet(owner, skill, ev, tag, x, y, dir, opts) {
    const o = Object.assign({}, opts || {});       // 复制，避免污染调用方共享的 opts（commonOpts）
    o.attackerStats = (owner && owner.statsTotal) ? owner.statsTotal : null;
    const b = new Bullet(
      ev.from + '_' + ev.seq + '_' + tag, ev.from, ev.skillId, skill.bullet,
      x, y, dir, (o.speedMul != null) ? o.speedMul : skill.speedMul, o
    );
    this.bullets.set(b.id, b);
    this.bulletCount[ev.from] = (this.bulletCount[ev.from] || 0) + 1;
    return b;
  }

  // 依据技能配置生成子弹（释放方式决定排布；见 _castOf）
  spawnSkillBullets(ev) {
    const skill = SKILLS[ev.skillId];
    if (!skill) return;
    // 需求4：过期弹道直接丢弃——不生成子弹（不参与计算、不参与碰撞），自然也不会被渲染。
    // 本机自己发射时 age≈0 不受影响；后台切回前台的闸门命中时 age 返回 99，同样丢弃。
    // 阈值 0.9s 与 main.js 的 MSG_MAX_AGE 保持一致。
    if (typeof App !== 'undefined' && App && App.msgAgeSec
        && App.msgAgeSec(ev.from, ev) > 0.9) return;
    const owner = this.players.get(ev.from);
    if (!owner) return;
    // 优先使用事件携带的发射原点（远端重建时与开火端一致）
    const ox = (typeof ev.ox === 'number') ? ev.ox : owner.x;
    const oy = (typeof ev.oy === 'number') ? ev.oy : owner.y;
    const count = Math.max(1, skill.count || 1);
    const base = Math.atan2(ev.dir.y, ev.dir.x);
    const cast = this._castOf(skill);
    // 同一释放事件的子弹共享 castId（观感联动 / 分裂归属）
    const castId = (typeof ev.castId === 'number') ? ev.castId : (ev.seq || 0);
    const commonOpts = { castId };
    // 连射/轰炸的发射间隔：可配 castInterval，缺省按 CD 均摊
    const interval = (skill.castInterval != null && skill.castInterval >= 0)
      ? skill.castInterval
      : Math.max(0.05, ((skill.cd || 1) / count) * 0.4);
    const nowSec = performance.now() / 1000;
    const bullets = [];
    const spawn = (tag, x, y, dir, opts) => {
      const b = this._newBullet(owner, skill, ev, tag, x, y, dir, opts || commonOpts);
      bullets.push(b);
      return b;
    };
    const muzzle = (dir) => ({ x: ox + dir.x * (owner.radius + 4), y: oy + dir.y * (owner.radius + 4) });

    if (cast === 'charge') {
      // 蓄力炮：单发重弹，伤害与弹速提升，释放时带一次蓄力特效
      //   chargeTime 蓄满时长（秒，缺省 0 = 按下即出膛，旧行为不变）
      //   chargeMul 蓄满伤害倍率（缺省 1.6）
      //   chargeHold=true 允许中途松手提前出膛（倍率按已蓄力比例线性折算）
      const mul = (skill.chargeMul != null) ? skill.chargeMul : 1.6;
      const ct = (skill.chargeTime != null && skill.chargeTime > 0) ? skill.chargeTime : 0;
      const ratio = (typeof ev.chargeRatio === 'number') ? Math.max(0, Math.min(1, ev.chargeRatio)) : 1;
      // 本机按下（事件无 chargeRatio）：chargeTime>0 时进入蓄力，等松手/蓄满由 _chargeShot 出膛并广播
      if (ct > 0 && typeof ev.chargeRatio !== 'number' && ev.from === (this.net && this.net.myId)) {
        this._beginCharge(owner, skill, ev, base, ct);
        ev._chargePending = true;      // 按下阶段不广播（fireSkill 据此跳过 relayShoot）
        return bullets;
      }
      const dmgMul = 1 + (mul - 1) * ratio;      // ratio=1（满蓄力/旧配置）时 = chargeMul，与旧行为一致
      const dir = { x: Math.cos(base), y: Math.sin(base) };
      const p = muzzle(dir);
      this.pushFx('muzzle', ox, oy, skill.color || owner.effColor || '#ffffff', { d: 16, image: skill.fxImage || null });
      spawn('c0', p.x, p.y, dir, { castId, dmgMul, speedMul: (skill.speedMul || 1) * 1.15 });
    } else if (cast === 'burst') {
      // 连射：缺省按 castInterval 依次发射（不占同屏帧，节奏稳定；各端用事件时间戳对齐）
      // burstTogether=true（别名 together / simultaneous）：count 发同帧一起出膛（同时起爆，扇形排布）
      const spread = this._spreadOf(skill);
      const together = (skill.burstTogether === true || skill.together === true || skill.simultaneous === true);
      if (together) {
        for (let i = 0; i < count; i++) {
          const a = base + spread * (count > 1 ? (i / (count - 1) - 0.5) : 0);
          const dir = { x: Math.cos(a), y: Math.sin(a) };
          const p = muzzle(dir);
          spawn('s' + i, p.x, p.y, dir);
        }
      } else {
        for (let i = 0; i < count; i++) {
          const a = base + spread * (count > 1 ? (i / (count - 1) - 0.5) : 0);
          this._scheduleCast({
            at: nowSec + i * interval, ev, skill, tag: 'b' + i,
            dir: { x: Math.cos(a), y: Math.sin(a) },
            ox: (typeof ev.ox === 'number') ? ev.ox : null, opts: commonOpts,
          });
        }
      }
    } else if (cast === 'strike') {
      // 区域轰炸：以瞄准点为中心，count 发延迟落弹（下落方向朝下，落点按黄金角错开，各端一致）
      const range = (skill.castRange != null) ? skill.castRange : 260;
      const spreadR = (skill.castRadius != null) ? skill.castRadius : 90;
      const aimX = Math.max(20, Math.min(GAME_CONFIG.ARENA.w - 20, ox + Math.cos(base) * range));
      const aimY = Math.max(20, Math.min(GAME_CONFIG.ARENA.h - 20, oy + Math.sin(base) * range));
      this.pushFx('mark', aimX, aimY, skill.color || '#ff9f43', { r: spreadR });
      for (let i = 0; i < count; i++) {
        const f = (i * 0.6180339887) % 1;
        const ang = f * Math.PI * 2 + i * 0.9;
        const rr = Math.sqrt((i + 0.5) / count) * spreadR;
        this._scheduleCast({
          at: nowSec + i * interval, ev, skill, tag: 'k' + i,
          dir: { x: 0, y: 1 },                         // 自天而降
          x: aimX + Math.cos(ang) * rr, y: aimY - 260,
          opts: commonOpts,
        });
      }
    } else if (cast === 'lock') {
      // 锁定追踪：自动锁定范围内最近的敌方单位，子弹朝目标发射并带追踪转向
      //   lockRange 锁定范围（px，缺省不限制；范围内无敌人 → 退回朝瞄准方向直射，不丢手感）
      //   homing 追踪转向速率（弧度/秒，缺省 3.2）；count / spread 同扇形散射
      const lockRange = (skill.lockRange != null && skill.lockRange > 0) ? skill.lockRange : Infinity;
      const target = this._nearestEnemy(owner, lockRange);
      const homingRate = (skill.homing != null) ? skill.homing : 3.2;
      const raw = target ? { x: target.x - ox, y: target.y - oy } : { x: Math.cos(base), y: Math.sin(base) };
      const rl = Math.hypot(raw.x, raw.y) || 1;
      const aimDir = { x: raw.x / rl, y: raw.y / rl };
      const lkSpread = this._spreadOf(skill);
      for (let i = 0; i < count; i++) {
        const off = lkSpread * (count > 1 ? (i / (count - 1) - 0.5) : 0);
        const c = Math.cos(off), s = Math.sin(off);
        const dir = { x: aimDir.x * c - aimDir.y * s, y: aimDir.x * s + aimDir.y * c };
        const p = muzzle(dir);
        spawn('l' + i, p.x, p.y, dir, { castId, homing: homingRate });
      }
    } else if (cast === 'barrage') {
      // 区域轰炸：以瞄准点为中心，在半径内确定性地落 count 发延迟弹（下落方向朝下，落点黄金角错开，各端一致）
      //   castRange 投送距离（px，缺省 260）/ barrageRadius 落点半径（px，缺省 castRadius 或 90）
      //   castInterval 落弹间隔（秒，缺省按 CD 均摊）/ blastRadius 爆炸半径（px，缺省用弹型自带 explodeRadius）
      const range = (skill.castRange != null) ? skill.castRange : 260;
      const spreadR = (skill.barrageRadius != null) ? skill.barrageRadius
        : ((skill.castRadius != null) ? skill.castRadius : 90);
      const blast = (skill.blastRadius != null && skill.blastRadius > 0) ? skill.blastRadius : null;
      const aimX = Math.max(20, Math.min(GAME_CONFIG.ARENA.w - 20, ox + Math.cos(base) * range));
      const aimY = Math.max(20, Math.min(GAME_CONFIG.ARENA.h - 20, oy + Math.sin(base) * range));
      this.pushFx('mark', aimX, aimY, skill.color || '#ff9f43', { r: spreadR });
      for (let i = 0; i < count; i++) {
        const f = (i * 0.6180339887) % 1;
        const ang = f * Math.PI * 2 + i * 0.9;
        const rr = Math.sqrt((i + 0.5) / count) * spreadR;
        this._scheduleCast({
          at: nowSec + i * interval, ev, skill, tag: 'g' + i,
          dir: { x: 0, y: 1 },                         // 自天而降
          x: aimX + Math.cos(ang) * rr, y: aimY + Math.sin(ang) * rr - 260,
          opts: blast != null ? { castId, blastRadius: blast } : commonOpts,
        });
      }
    } else if (cast === 'ring') {
      // 环形弹幕：360° 均分（ringEven 缺省 true）
      // ringEven=false：在均分基础上加确定性错位（错位量只由序号决定，不用随机），形成非均匀分布，各端一致
      const even = (skill.ringEven !== false);
      const step = Math.PI * 2 / count;
      for (let i = 0; i < count; i++) {
        const a = even ? step * i : step * i + step * 0.42 * Math.sin(i * 2.3999632297286535);
        const dir = { x: Math.cos(a), y: Math.sin(a) };
        const p = muzzle(dir);
        spawn(i, p.x, p.y, dir);
      }
    } else {
      // 扇形散射（含 lockon 锁定追踪：排布同扇形，追踪由子弹 motion.homing/技能 homing 提供）
      const spread = this._spreadOf(skill);
      const homing = (cast === 'lockon') ? ((skill.homing != null) ? skill.homing : 3.2) : null;
      for (let i = 0; i < count; i++) {
        const off = spread * (count > 1 ? (i / (count - 1) - 0.5) : 0);
        const dir = { x: Math.cos(base + off), y: Math.sin(base + off) };
        const p = muzzle(dir);
        spawn(i, p.x, p.y, dir, homing != null ? { castId, homing } : commonOpts);
      }
    }
    return bullets;
  }

  // 延迟发射队列（连射 / 区域轰炸）：用本机时钟对齐，各端事件时间戳一致 => 弹道一致
  _scheduleCast(item) {
    this._castQueue = this._castQueue || [];
    this._castQueue.push(item);
  }
  _updateCastQueue() {
    const q = this._castQueue;
    if (!q || !q.length) return;
    const now = performance.now() / 1000;
    const kept = [];
    for (const it of q) {
      if (now < it.at) { kept.push(it); continue; }
      if (now - it.at > 0.9) continue;                 // 过期不补发（与 shoot 消息同阈值）
      const owner = this.players.get(it.ev.from);
      if (!owner) continue;
      const ev = it.ev, skill = it.skill;
      // 发射原点：远端事件用其 ox/oy，本机用当下位置
      const ox = (it.ox != null) ? it.ox : owner.x;
      const oy = (typeof it.ev.oy === 'number' && it.ox != null) ? it.ev.oy : owner.y;
      const x = (it.x != null) ? it.x : ox + it.dir.x * (owner.radius + 4);
      const y = (it.y != null) ? it.y : oy + it.dir.y * (owner.radius + 4);
      this._newBullet(owner, skill, ev, it.tag, x, y, it.dir, it.opts);
    }
    this._castQueue = kept;
  }

  // ===== 蓄力炮（charge）：按下 → 蓄力 → 出膛（第二批）=====
  // 本机按下时进入蓄力（按下阶段不广播）；出膛瞬间构造带 chargeRatio 的 shoot 事件，本机生成 + 广播，各端按同一比例重建。
  // chargeHold=true：按住技能键期间松手（keyup）立即出膛，伤害倍率按已蓄力比例折算；
  //                  未挂到按键（触屏 / 无输入环境）时自动退化为蓄满出膛，不影响功能与联机一致性。
  _beginCharge(owner, skill, ev, base, ct) {
    if (!this._charges) this._charges = [];
    const nowSec = performance.now() / 1000;
    const item = { playerId: owner.id, skillId: ev.skillId, dir: ev.dir, base, start: nowSec,
                   at: nowSec + ct, ct, hold: (skill.chargeHold === true), handler: null };
    // 中途松手：仅本机按键场景挂一次性 keyup（按该技能所在槽位取键码）
    if (item.hold && typeof window !== 'undefined' && typeof Input !== 'undefined'
        && Input && Input.skillKeys && owner.loadout) {
      const idx = owner.loadout.indexOf(ev.skillId);
      const code = (idx >= 0) ? Input.skillKeys[idx] : null;
      if (code) {
        item.handler = (e) => { if (e && e.code === code) this._releaseCharge(owner.id, 'keyup'); };
        window.addEventListener('keyup', item.handler);
      }
    }
    this._charges.push(item);
  }

  // 蓄力出膛：ratio = 已蓄力比例（0~1）。0.08s 内的误触松手忽略，避免"点一下就洒"破坏手感
  _releaseCharge(playerId, reason) {
    const q = this._charges;
    if (!q || !q.length) return;
    const idx = q.findIndex(c => c.playerId === playerId);
    if (idx < 0) return;
    const item = q[idx];
    const nowSec = performance.now() / 1000;
    const ratio = Math.max(0, Math.min(1, (nowSec - item.start) / item.ct));
    if (reason === 'keyup' && ratio < 0.08) return;      // 误触：继续蓄力
    q.splice(idx, 1);
    if (item.handler && typeof window !== 'undefined') window.removeEventListener('keyup', item.handler);
    this._chargeShot(item, ratio);
  }

  // 出膛：按已蓄力比例系数倍率（ratio=1 时 = chargeMul，与旧行为一致）
  _chargeShot(item, ratio) {
    const player = this.players.get(item.playerId);
    if (!player || !player.alive) return;
    const nowMs = performance.now();
    const ev = { t: 'shoot', from: player.id, skillId: item.skillId, dir: item.dir, seq: ++this.bulletSeq,
                 time: nowMs, ts: nowMs, ox: player.x, oy: player.y, chargeRatio: ratio };
    this.spawnSkillBullets(ev);
    if (this.net && this.net.relayShoot) this.net.relayShoot(ev);
  }

  // 每帧检查蓄力进度：达 chargeTime 视为蓄满，自动出膛（ratio=1）
  _updateCharges() {
    const q = this._charges;
    if (!q || !q.length) return;
    const nowSec = performance.now() / 1000;
    for (const item of q.slice()) if (nowSec >= item.at) this._releaseCharge(item.playerId, 'full');
  }

  // 分裂：世界统一生成子子弹（子弹只置 splitReq 标记），保证各端 id 与位置一致
  // 触发来源：进度达 motion.split.at（到时）或命中目标（motion.split.onHit=true），二者先到先触发
  _spawnSplit(b, owner) {
    const m = (b.mo && b.mo.split) ? b.mo.split : ((b.cfg && b.cfg.motion && b.cfg.motion.split) || null);
    if (!m || !owner) return [];
    // 递归层级护栏：达到 maxDepth（缺省 1）不再分裂，避免子弹爆炸式增殖
    const maxDepth = (m.maxDepth != null) ? m.maxDepth : 1;
    if ((b.depth || 0) >= maxDepth) return [];
    const count = Math.max(2, m.count || 3);
    const spread = (m.spread != null) ? m.spread : 1.0;
    const sm = (m.speedMul != null) ? m.speedMul : 0.85;
    const childId = m.childBullet || b.bulletId;   // 子子弹弹型（缺省继承母弹）
    const base = Math.atan2(b.vy, b.vx);
    const out = [];
    for (let k = 0; k < count; k++) {
      const a = base + spread * (k / (count - 1) - 0.5);
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      out.push(new Bullet(
        b.id + 's' + k, b.ownerId, b.skillId, childId, b.x, b.y, dir,
        b.speedMul * sm,
        // 方案 A：子子弹继承释放方式倍率，并按生成时刻取攻击者运行时属性（条件型模块重算后的最新值）
        { castId: b.castId, depth: (b.depth || 0) + 1, dmgMul: b.dmgMul,
          attackerStats: (owner && owner.statsTotal) ? owner.statsTotal : b.attackerStats }
      ));
    }
    return out;
  }

  // 每帧本地模拟子弹（各端一致，因初始事件一致）：追踪需要敌方列表，分裂由 world 生成
  updateBullets(dt) {
    const arena = GAME_CONFIG.ARENA;
    const enemyCache = {};
    const extra = [];
    for (const [id, b] of this.bullets) {
      const owner = this.players.get(b.ownerId);
      let enemies = enemyCache[b.ownerId];
      if (!enemies) enemies = enemyCache[b.ownerId] = this._enemiesOf(owner);
      b.update(dt, arena, enemies);
      if (b.splitReq) {
        b.splitReq = false;
        const kids = this._spawnSplit(b, owner);
        for (const k of kids) extra.push(k);
      }
      if (b.dead) {
        this.bullets.delete(id);
        this.bulletCount[b.ownerId] = Math.max(0, (this.bulletCount[b.ownerId] || 1) - 1);
      }
    }
    // 分裂子子弹下一帧起参与模拟/碰撞（避免同帧二次更新）
    for (const b of extra) {
      this.bullets.set(b.id, b);
      this.bulletCount[b.ownerId] = (this.bulletCount[b.ownerId] || 0) + 1;
    }
    this._updateCastQueue();
    this._updateCharges();
  }

  // 碰撞检测：本端可见的所有子弹 vs 所有玩家
  // 命中结果上报房主（hit 事件），房主做权威结算
  // 阵营判定：Boss 的子弹打玩家，玩家子弹打 Boss（按 owner 阵营，配置无关）
  checkCollisions() {
    const isHost = this.net.isHost;
    for (const [, b] of this.bullets) {
      const owner = this.players.get(b.ownerId);
      if (!owner) continue;
      for (const [, t] of this.players) {
        if (t.id === b.ownerId) continue;              // 不打自己
        if (owner.isBoss === t.isBoss) continue;       // 同阵营不命中
        if (!t.alive) continue;
        if (!b.collides(t)) continue;
        const r = b.hit(t);
        if (!r) continue;
        // 本地命中特效：火花；爆炸弹额外炸圈
        this.pushFx('hit', b.x, b.y, b.cfg.color || '#ffffff');
        if (r.explode) {
          this.pushFx('explode', b.x, b.y, b.cfg.color || '#ff8c42', { r: r.explodeRadius || 70 });
          this.pushFx('shake', 0, 0, '', { dur: 0.22 });
        }
        // 上报房主（自己不是房主时；房主自己直接结算）
        // crit 为按攻击者属性掷出的暴击标记（确定性，各端一致），随命中上报/结算一路带到飘字
        if (isHost) {
          this.handleHit(null, { from: b.ownerId, targetId: t.id, dmg: r.damage, crit: r.crit, explode: r.explode, x: t.x, y: t.y, r: r.explodeRadius });
        } else {
          this.net.sendTo(this.hostId(), { t: 'hit', from: b.ownerId, targetId: t.id, dmg: r.damage, crit: r.crit, explode: r.explode, x: t.x, y: t.y, r: r.explodeRadius });
        }
      }
    }
  }

  hostId() {
    return this.net.members.length ? this.net.members[0].id : this.net.myId;
  }

  // 房主：伤害结算（含爆炸范围二次判定）
  // crit：本次命中的暴击标记（子弹按攻击者 critChance/critMul 掷出，随伤害一起结算与广播，
  //       使飘字与扣血同源同值 —— 方案 A 的「命中飘字 / 扣血 / 结算」一致）
  handleHit(by, hit) {
    const target = this.players.get(hit.targetId);
    if (!target || !target.alive) return;
    // v1：伤害类型（hit.kind 优先，缺省回落到技能配置 damageType 判定）
    const kind = hit.kind || Combat.damageKindOf(hit.skillId);
    if (hit.explode) {
      // 爆炸：对范围内所有敌方（或所有非友方）结算
      for (const [, p] of this.players) {
        if (p.id === hit.from) continue;
        if (!p.alive) continue;
        const d = Math.hypot(p.x - hit.x, p.y - hit.y);
        if (d <= hit.r + p.radius) this.applyDamage(hit.from, p, hit.dmg, kind, hit.crit);
      }
    } else {
      this.applyDamage(hit.from, target, hit.dmg, kind, hit.crit);
    }
  }

  applyDamage(fromId, target, dmg, kind, crit) {
    // P2：攻击者增伤 buff（damageMul）权威乘入
    const from = this.players.get(fromId);
    const effFrom = from ? BuffSystem.effects(from) : { damageMul: 0 };
    // v1 减伤链：先按目标合成属性结算「物理走护甲 100/(100+armor) / 魔法走魔抗 resist」，再叠攻击者增伤 buff
    // （攻击者装备侧 damageMul 已在子弹生成时乘入 dmg —— 与这里的 buff 增伤是两个乘区，不重复计算）
    let real = Combat.mitigate(target.statsTotal || {}, dmg, kind);
    real = Math.max(1, Math.round(real * (1 + (effFrom.damageMul || 0))));
    // 需求2：Boss 阶段自授 buff 的结算——无敌（免疫一切伤害）与减伤（damageTakenMul，负值减伤）
    const effT = BuffSystem.effects(target);
    if ((effT.invuln || 0) > 0) {
      // 无敌：本次伤害完全免疫（不扣血、不消耗护盾、不计伤害/吸血）
      this.broadcast({ t: 'damage', targetId: target.id, hp: target.hp, by: fromId, dmg: 0, crit: false });
      return;
    }
    if (effT.damageTakenMul) real = Math.max(0, Math.round(real * (1 + effT.damageTakenMul)));
    // P2：目标护盾吸收（护盾优先抵消真实伤害，不足部分才扣血）
    const absorbed = BuffSystem.absorb(target, real);
    real -= absorbed;
    if (real < 0) real = 0;
    target.hp = Math.max(0, target.hp - real);
    // 伤害浮动数字：房主/单机端结算点弹扣血数值；远端由 damage 消息接收端弹出
    // 数值与 crit 标记均取自本次结算结果（同一份 real），因此飘字、扣血、结算三者同值
    if (real > 0) this.pushFx('dmg', target.x, target.y - (target.radius || 26) - 10, target.isBoss ? '#ff6b4a' : '#e63b3b', { val: Math.round(real), crit: !!crit });
    // 战斗统计（伤害/击杀）统一走战斗模块
    if (from) Combat.recordDamage(from, real);
    // v1 计数：有效伤害（real>0）才算一次命中——攻击者 hits+1、目标 hitTaken+1，并推进攻击者连击
    if (real > 0) {
      Combat.recordHit(from, target);
      if (from) Combat.recordCombo(from, performance.now() / 1000, true);
    }
    // P2：吸血：造成真实伤害后按 lifesteal 比例治疗攻击者（护盾吃掉的伤害不吸血）
    // 直接用 BuffSystem.effects 实时聚合（远端真人实体在 host 端不跑 Player.update/_refreshBuffStats，
    // statsTotal.lifesteal 会过期；effects() 直接读 buffs 列表无此问题）
    let healById = null, healBy = 0;
    if (from && real > 0 && from.alive && (effFrom.lifesteal || 0) > 0) {
      healBy = Math.min(from.statsTotal.hp - from.hp, Math.round(real * effFrom.lifesteal));
      if (healBy > 0) { from.hp += healBy; healById = from.id; }
    }
    this.broadcast({ t: 'damage', targetId: target.id, hp: target.hp, by: fromId, dmg: real, crit: !!crit,
                     sh: BuffSystem.shieldAmt(target), healById, healBy });
    // v1：命中结算后双方各过一遍触发器（受击方看受击/血量/阶段条件，攻击方看命中/连击/击杀条件）
    if (from && from.alive) this._runTriggers(from, 'hit');
    if (target.hp <= 0 && target.alive) {
      target.alive = false;
      if (from) Combat.recordKill(from, target);
      target.markDeath(this.time);                   // v1：记录死亡时刻，aliveTime 冻结
      target.breakCombo('death');                    // v1：死亡即断连击（打断规则②）
      this.broadcast({ t: 'die', id: target.id, by: fromId });
      // v1 事件条件：死亡瞬间（目标自身）/ 击杀瞬间（攻击者）
      this._runTriggers(target, 'death');
      if (from && from.id !== target.id) this._runTriggers(from, 'kill');
      if (target.isBoss) {
        // Boss 死亡 => 勇者阵营胜（Boss 不复活）
        this.pushFx('die', target.x, target.y, target.effColor || '#ff2d55', { r: 110 });
        this.pushFx('shake', 0, 0, '', { dur: 0.4 });
        this.gameOver = { winner: 'players', by: fromId };
        this.broadcast({ t: 'gameover', winner: 'players', by: fromId });
      } else {
        // 挑战模式：死亡 AI 不复活（仅本地玩家可复活）；勇者全灭 => Boss 胜
        this.pushFx('die', target.x, target.y, target.effColor || '#ffd700', { r: 70 });
        const playersAllDead = [...this.players.values()].filter(p => !p.isBoss).every(p => !p.alive);
        // 多人联机 / 离线挑战判 Boss 胜；传统休闲单人（solo && !challenge）不判负，等复活/超时
        if (playersAllDead && (!this.solo || this.challenge)) {
          this.gameOver = { winner: 'boss' };
          this.broadcast({ t: 'gameover', winner: 'boss' });
          return;
        }
        target.respawnAt = performance.now() / 1000 + GAME_CONFIG.RESPAWN_DELAY;
      }
    } else if (target.alive) {
      // 触发模块（条件式解锁：血量阈值 / 计数条件 / 阶段计时），事件类型 = hit
      this._runTriggers(target, 'hit');
    }
  }

  // 触发模块统一入口（v1）：注入事件类型（hit / kill / death / respawn / time / ''）与对局时间，
  // 条件判定与计数全部在内（triggers.js），触发后广播技能栏变化并落地横幅 / 自授 buff 等动作
  _runTriggers(p, event) {
    if (!p) return [];
    const events = p.checkTriggers({ time: this.time, event });
    if (!events.length) return [];
    if (p.isBoss) this.bossPhaseId = p.id;   // 记录 Boss 阶段推进，供快照对齐
    this.broadcast({ t: 'phase', id: p.id, skills: p.loadout, text: (events[0] && events[0].text) || '' });
    this._applyEvents(p, events);
    return events;
  }

  // P2：触发事件落地（横幅/Boss 演出/自授 buff），阶段广播由调用方先行发出
  _applyEvents(target, events) {
    events.forEach(ev => {
      if (ev.emit) BossFx.onPhase(target, ev);
      if (ev.emit) this.pushFx('banner', 0, 0, '#ff2d55', { text: ev.text || (ev.emit === 'rage' ? 'Boss 进入狂暴阶段!' : '') });
      if (ev.selfBuffs && ev.selfBuffs.length) {
        // 需求2：Boss 阶段自授 buff 放行（提升攻击 / 提升防御 / 无敌 / 加速 等），
        // 由 Boss 自身机制（阶段 / 血量阈值 / 时间轴）触发，展示在 Boss 血条下方（render._syncDomHud 的 .hb-buffs）
        ev.selfBuffs.forEach(sb => { if (sb && sb.buff) this._grantBuff(target, sb.buff, { selfGrant: true }); });
      }
      // 全场对立阵营减益（配置驱动：新增 Boss 想让全场玩家吃 Debuff 只需配 allOpponentBuffs）
      if (ev.allOpponentBuffs && ev.allOpponentBuffs.length) {
        for (const [, p] of this.players) {
          if (!p.alive || p.id === target.id) continue;
          if (p.isBoss === target.isBoss) continue;
          ev.allOpponentBuffs.forEach(sb => { if (sb && sb.buff) this._grantBuff(p, sb.buff); });
        }
      }
    });
    this.pushFx('shake', 0, 0, '', { dur: 0.3 });
  }

  // P2：房主给目标授予 buff（本地生效 + 特效 + 广播）
  // opts.selfGrant=true：Boss 阶段自授——唯一允许 Boss 获得 buff 的来源（见 BuffSystem.addBuff）
  _grantBuff(p, buffId, opts) {
    if (!p || !p.alive) return;
    if (p.isBoss && !(opts && opts.selfGrant)) return;   // Boss 只吃自身机制触发的 buff
    if (!BuffSystem.addBuff(p, buffId, opts)) return;
    const def = BUFFS[buffId] || {};
    this.pushFx('buff', p.x, p.y, def.color || '#ffffff', { buffId });
    this.pushFx('banner', 0, 0, def.color || '#ffffff', { text: p.name + ' 获得 ' + (def.name || buffId), dur: 1.6 });
    this.broadcast({ t: 'buff_add', id: p.id, buff: buffId, x: p.x, y: p.y, color: def.color || '#ffffff' });
  }

  // P2：对局时间双轨触发（房主 tick，仅 Boss；血量/计数/事件触发保留在 applyDamage 路径）
  checkBossTimeTriggers() {
    for (const [, p] of this.players) {
      if (!p.alive || !p.isBoss) continue;
      this._runTriggers(p, 'time');
    }
  }

  // P2：场地 buff 掉落：定时批量生成 + 仅玩家就近拾取（Boss 不拾取，房主权威）
  updateBuffDrops(dt) {
    const cfg = GAME_CONFIG;
    if (this.time >= (cfg.BUFF_DROP_START || 5) && this.time >= (this._nextDropT || 0)) {
      this._nextDropT = this.time + (cfg.BUFF_DROP_INTERVAL || 9);
      const max = cfg.BUFF_DROP_MAX_ON_FIELD || 3;
      const batch = Math.max(1, cfg.BUFF_DROP_BATCH || 1);
      for (let i = 0; i < batch && this.buffDrops.length < max; i++) this.spawnBuffDrop();
    }
    for (const [, p] of this.players) {
      if (!p.alive) continue;
      if (p.isBoss) continue;   // 场地 buff 仅玩家可拾取：Boss 不碰掉落物
      for (const d of this.buffDrops) {
        const rr = p.radius + 20;
        const dx = p.x - d.x, dy = p.y - d.y;
        if (dx * dx + dy * dy <= rr * rr) { this.pickupBuff(p, d); break; }
      }
    }
  }

  spawnBuffDrop() {
    const defIds = Object.keys(BUFFS || {}).filter(k => BUFFS[k] && k[0] !== '_' && BUFFS[k].drop !== false);
    if (!defIds.length) return;
    const defId = defIds[Math.floor(Math.random() * defIds.length)];
    const A = GAME_CONFIG.ARENA;
    // 本轮修复：掉落点内缩（原 60px 边距会紧贴边界墙，在左上角两面墙交汇处看起来像一个
    // 贴在墙角的元素）。改为按场地尺寸取比例边距，保证掉落物始终离四面墙足够远。
    const pad = Math.max(180, Math.round(Math.min(A.w, A.h) * 0.18));
    const drop = { id: 'bd' + (++this.buffDropSeq), defId,
                   x: pad + Math.random() * Math.max(1, A.w - pad * 2),
                   y: pad + Math.random() * Math.max(1, A.h - pad * 2),
                   born: performance.now() / 1000 };
    this.buffDrops.push(drop);
    this.broadcast({ t: 'buff_drop', drop });
  }

  pickupBuff(p, drop) {
    // 同帧多人同踩同一掉落：第一个拾取后 drop 已从场列表移除，后续玩家直接跳过（防同一掉落重复发放）
    if (!p.alive || p.isBoss || !this.buffDrops.some(x => x.id === drop.id)) return;
    this.buffDrops = this.buffDrops.filter(x => x.id !== drop.id);
    BuffSystem.addBuff(p, drop.defId);
    const def = BUFFS[drop.defId] || {};
    this.pushFx('buff', p.x, p.y, def.color || '#ffffff', { buffId: drop.defId });
    this.pushFx('banner', 0, 0, def.color || '#ffffff', { text: p.name + ' 获得 ' + (def.name || drop.defId), dur: 1.6 });
    this.broadcast({ t: 'buff_pickup', id: p.id, buff: drop.defId, dropId: drop.id,
                     x: p.x, y: p.y, color: def.color || '#ffffff' });
  }

  // 房主：检查死亡玩家复活时间
  // AI 单位（botKind，含离线挑战与联机房间 AI）死亡即离场不复活；
  // 真人（本地或远端成员）按 RESPAWN_DELAY 复活，保证"全灭即终局"可判定
  checkRespawns() {
    const now = performance.now() / 1000;
    for (const [, p] of this.players) {
      if (p.botKind) continue;                     // AI 单位不自动复活
      if (!p.alive && p.respawnAt && now >= p.respawnAt) {
        const idx = this.net.members.findIndex(m => m.id === p.id);
        const spawn = Player.spawnPos(idx >= 0 ? idx % 4 : 0, GAME_CONFIG.ARENA);
        p.x = spawn.x; p.y = spawn.y;
        p.hp = p.statsTotal.hp;
        p.alive = true;
        p.respawnAt = 0;
        this.pushFx('respawn', p.x, p.y, p.effColor || '#ffffff');
        this.broadcast({ t: 'respawn', id: p.id, x: p.x, y: p.y, hp: p.hp });
        p.breakCombo('respawn');           // v1：复活重置连击（打断规则③）
        p.stampAlive(this.time);           // v1：复活重开存活计时
        this._runTriggers(p, 'respawn');   // v1：复活瞬间条件
      }
    }
  }

  // 条件型模块重算巡检（方案 C，各端统一执行）：
  //   ① 把对局时间回填到单位（条件 timeAfter 用）——房主用本端推进的 this.time，
  //      非房主用 state 广播同步过来的 this.time，两端时间同源；
  //   ② 条件签名（血量分档 / 计数 / 对局整秒）变化时才重算合成数值，
  //      使「血之遗物（半血以下 +200 hp）」「风之遗物（10 秒后 +25 速）」等条件型模块真正生效。
  // 各端输入同一套数据（血量由房主权威广播、计数由结算写入、时间同源），因此重算结果一致。
  refreshConditionalStats() {
    const t = this.time || 0;
    for (const [, p] of this.players) {
      if (!p || typeof p.tickConditionalStats !== 'function') continue;
      p.worldTime = t;
      p.tickConditionalStats();
    }
  }

  // 房主：每 tick 广播权威状态（hp/存活/阶段）
  tick(dt) {
    // 需求3：边界墙——所有单位位置统一约束在场地内（本地/远端/复活/插值偏差全覆盖）
    {
      const A = GAME_CONFIG.ARENA;
      this.players.forEach(p => {
        const r = p.radius || 0;
        if (p.x < r) p.x = r; else if (p.x > A.w - r) p.x = A.w - r;
        if (p.y < r) p.y = r; else if (p.y > A.h - r) p.y = A.h - r;
      });
    }
    // 结算后：只保留子弹运动表现，停止结算/复活/广播
    if (this.gameOver) { this.updateBullets(dt); return; }
    this.updateBullets(dt);
    this.checkCollisions();          // 各端都做：本地模拟子弹 + 命中上报
    if (!this.net.isHost) {
      // 非房主：对局时间由 state 广播同步（this.time），同样按条件签名重算条件型属性，
      // 保证同一时刻各端算出的模块数值一致（方案 C）
      this.refreshConditionalStats();
      return;
    }
    // 对局时间（供模块条件判断：timeAfter 等）
    this.time = (this.time || 0) + dt;
    // v1 按单位维护运行时量：世界时间回填 + 连击窗口超时巡检（断击规则①，与命中写点同为墙钟）
    this.players.forEach(p => {
      p.worldTime = this.time;
      p.tickComboWindow();
    });
    // 方案 C：时间/血量推进后巡检条件型模块（血之遗物 hpBelow / 风之遗物 timeAfter 等），
    // 使条件满足瞬间即生效；权威端重算后经 state 广播对齐，各端数值一致。
    this.refreshConditionalStats();
    // P2：时间双轨（Boss afterTime 解锁）与场地 buff 掉落/拾取（房主权威）
    this.checkBossTimeTriggers();
    this.updateBuffDrops(dt);
    // 限时判负：超时未击杀 Boss → Boss 胜（多人/单人通用）
    if (!this.gameOver && this.time >= GAME_CONFIG.MATCH_DURATION) {
      this.gameOver = { winner: 'boss', by: 'timeout' };
      this.broadcast({ t: 'gameover', winner: 'boss', by: 'timeout' });
      return;
    }
    this.checkRespawns();
    const now = performance.now();
    if (now - this.lastStateAt >= 1000 / GAME_CONFIG.TICK_RATE) {
      this.lastStateAt = now;
      this.broadcastState();
    }
  }

  broadcastState() {
    const list = [...this.players.values()].map(p => ({
      id: p.id, hp: p.hp, alive: p.alive,
      x: p.x, y: p.y, dir: p.dir, skills: p.loadout,
      // 方案 C：判定计数随权威状态同步（kills/hits/hitTaken/combo）——
      // 条件型模块（含 k/c 计数的 condition）在各端用同一份计数重算，结果才能一致
      k: (p.stats && p.stats.kills) || 0,
      h: (p.stats && p.stats.hits) || 0,
      ht: (p.stats && p.stats.hitTaken) || 0,
      cb: (p.stats && p.stats.combo) || 0
    }));
    this.broadcast({ t: 'state', seq: ++this.stateSeq, players: list,
                     time: this.time, bossPhaseId: this.bossPhaseId });
  }
  // P1-4：新成员加入时房主回复的全量状态快照。
  // 覆盖：成员角色 / 血量 / 存活 / 位置基线 / 对局时间 / Boss 阶段（含已解锁技能）/ AI 名单 / 结算态。
  // 由 net.onPeer connected（host 主动下发 bot_sync）与 snap_req（成员主动请求）两条路径兜底，
  // 保证中途加入者拿到一次可用基线，之后继续由 tick broadcastState 权威同步。
  buildSnapshot() {
    const players = [...this.players.values()].map(p => {
      const snap = {
        id: p.id, name: p.name, roleId: p.roleId, isHost: p.isHost,
        isBot: !!p.botKind, botKind: p.botKind || null, aiLevel: p.aiLevel || null,
        // 玩家档案：房主权威版本随快照下发，中途加入 / 重建的端按档案重建属性与技能栏（Boss 不带）
        profile: (!p.isBoss && !p.botKind && p.profile) ? p.profile : null,
        profileId: (!p.isBoss && p.profileId) ? p.profileId : null,
        hp: p.hp, alive: p.alive, x: p.x, y: p.y, dir: p.dir,
        // 方案 C：判定计数随快照下发，中途加入者按同一份计数重算条件型模块（与 state 同源）
        k: (p.stats && p.stats.kills) || 0,
        h: (p.stats && p.stats.hits) || 0,
        ht: (p.stats && p.stats.hitTaken) || 0,
        cb: (p.stats && p.stats.combo) || 0,
        // P2：buff 随快照对齐；end 为房主端绝对时钟，跨端不可直接用，改传剩余秒 tLeft（applySnapshot 换算回本地 end）
        buffs: (p.buffs || []).map(b => {
          const o = { ...b };
          if (typeof o.end === 'number') {
            o.tLeft = Math.max(0, o.end - performance.now() / 1000);
            delete o.end;
          }
          return o;
        })
      };
      // Boss 阶段技能只随 Boss 带（阶段推进由房主裁决后覆盖），避免覆盖普通成员本地技能栏
      if (p.isBoss) snap.skills = p.loadout;
      return snap;
    });
    return { t: 'snap', seq: this.stateSeq + 1, time: this.time,
             bossPhaseId: this.bossPhaseId,
             buffDrops: this.buffDrops.map(d => ({ ...d })),   // P2：场上掉落物对齐
             gameOver: this.gameOver ? { winner: this.gameOver.winner, by: this.gameOver.by } : null,
             players };
  }

  broadcast(msg) {
    if (this.net) this.net.broadcast(msg);
  }
}
