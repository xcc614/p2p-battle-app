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
    // 需求4：释放方式通用开关
    //   · 施法中（lockCast：禁止释放其他技能）直接拒绝——蓄力/禁咒/吟唱期间按其它技能无效
    //   · 未启用的释放方式（禁咒/吟唱默认 enabled:false）不可释放
    //   注意：rel0 必须声明在本函数作用域（而非 if 块内）——下方"读条型释放"分支仍要用它的 type，
    //   原写法把 const 写在块内、块外引用，任何一次技能释放都抛 ReferenceError，直接打断整帧循环（本次严重回归根因）。
    let rel0 = null;
    if (typeof CastSystem !== 'undefined') {
      rel0 = CastSystem.norm(skill);
      if (!rel0.enabled) return;
      // 第 8 批需求②：蓄力中「再次点击同一技能」= 立即提前释放出膛（不再等读条结束）。
      //   必须在 locksCast 拒绝分支之前拦截：蓄力期间 locksCast 为真，否则第二次点击会被当作
      //   "施法中非法操作"直接丢弃，玩家感受就是"点了没反应、只能等蓄满"。
      if (rel0.type === 'charge' && this._charges
          && this._charges.some(c => c.playerId === player.id && c.skillId === skillId)) {
        this._releaseCharge(player.id, 'click');
        return;
      }
      if (CastSystem.locksCast(player.id)) return;
    }
    // 出战位校验：技能栏模块选出的 loadout 才能放（loadout 存技能 id 字符串，入参 skillId 即 id）
    if (!player.inLoadout(skillId)) return;
    // 可用判定：冷却 + 技能条件（Conditions.check）
    if (!Combat.canUseSkill(player, skillId)) return;
    // 子弹上限校验（战斗模块按合成数值判定，支持装备加成上限）
    // 本轮修复（第 3 条·清空路径③）：改为只统计"非 persist 弹"——常驻环绕弹（环绕飞刃）不吃生命周期、
    //   永久在场，若照旧计入 bulletCount，会长期占住 MAX_BULLETS_PER_PLAYER 名额（每发 +1 且不归还），
    //   上限被吃满后连"再次释放飞刃/放其它技能"都会被这里直接 return 拒绝，观感上就是"飞刃没了、技能放不出来"。
    if (!Combat.canFireBullet(player, this._countQuotaBullets(player.id))) return;
    // 第 8 批需求②/④：读条型释放（蓄力 charge / 持续释放 channel）**点击当帧先不进 CD**，
    //   改由读条结束（出膛 / 收招）时 commitCd 落实，即"读条结束才进 CD"；
    //   即时释放（instant）与其它类型保持"按下即进 CD"的原行为（旧配置零改动）。
    const deferCd = !!(rel0 && (rel0.type === 'charge' || rel0.type === 'channel')
      && ((this._num(rel0.duration, 0) > 0) || (this._num(skill.chargeTime, 0) > 0)));
    player.cast(skillId, deferCd);
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
    // 需求4：禁咒 / 吟唱等读条型释放——本机按下即进入施法（读条 + 小游戏 + 禁移/禁技），首帧不出膛；
    //   读条结束由 CastSystem.update → finishCast 统一出膛，伤害按判定比例折算。
    //   （原先只在收到远端 'cast' 消息时登记实例，本机自己反而放不出来）
    if (typeof CastSystem !== 'undefined' && CastSystem.begin && rel0) {
      if (rel0.type === 'channel') {
        // 第 8 批需求④：持续释放类技能（环绕飞刃等）释放期间进入「持续释放态」——读条时长 = 持续时长，
        //   受 CastSystem 的禁移/禁技约束；结束由 CastSystem.update → finishCast 统一收招
        //   （清空残余飞刃 + 落实 CD），本帧仍照常生成环绕飞刃（不 return）。
        const it = CastSystem.begin(this, player, skill, rel0, dir);
        if (it) it.relay = 'channel';
      } else if (rel0.type !== 'instant' && rel0.type !== 'charge') {
        if (CastSystem.begin(this, player, skill, rel0, dir)) return;
      }
    }
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
    // 需求4/8：释放结构以纯配置描述——castConfig.layout（或别名 castConfig.cast）优先，其次顶层 cast
    const rc = (skill.castConfig && typeof skill.castConfig === 'object') ? skill.castConfig : null;
    const raw = (rc && (rc.layout || rc.cast)) ? (rc.layout || rc.cast) : skill.cast;
    if (raw) return raw;
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

  // 数值配置读取：非有限数一律回退缺省值（纯配置驱动的容错入口）
  _num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  // 需求11：区域落点的圆形结算区域配置
  //   landingRadius 结算圆半径（px，缺省取落点散落半径/爆炸半径）
  //   landingArea=false 可显式关闭结算圈；开启时子弹落到圈内即结束并结算伤害（不再落到屏幕外）
  _landingOf(skill, fallbackR) {
    const s = skill || {};
    const area = (s.landingArea !== false);
    const r = Math.max(20, this._num(s.landingRadius, this._num(fallbackR, 90)));
    // 需求⑥（本轮）：落点锁定与投放限制——纯配置，旧配置零改动（全部缺省关闭 / 兜底行为不变）
    //   landingLock  落点锁定敌方单位（缺省 false）
    //   landingLead  提前量（秒，缺省 0.35；实际提前量 = 该值 + 下落飞行时间）
    //   landingClamp 'view' = 落点限制在「当前镜头可见的战场区域」内（缺省 null = 只限制在战场内）
    //   landingFall  下落距离（px，缺省 300；用于估算飞行时间 → 提前量）
    //   landingMark  是否在瞄准点投放持续锁定指示（缺省 true）
    //   landingFollow 落点是否跟随锁定目标移动（第 8 批需求①：缺省 false = 释放后在目标位置固定）
    // ②（本轮）：落点/范围提示可见度与持续时间——统一可调，缺省取 GAME_CONFIG.FX.mark
    //   landingMarkLead  预告圈最短可见时长（秒，缺省 FX.mark.lead = 1.2）
    //   landingMarkHold  落地结算后残留圈时长（秒，缺省 FX.mark.hold = 0.8）
    //   landingMarkWidth 预告圈线宽（px，缺省 FX.mark.width = 7；更粗）
    //   landingMarkGlow  是否加外发光圈 + 内圈双环（缺省 true；更亮）
    const fxMark = (GAME_CONFIG.FX && GAME_CONFIG.FX.mark) || {};
    const fxLand = (GAME_CONFIG.FX && GAME_CONFIG.FX.landing) || {};
    // 第 6 条（本轮）：三处几何/跟随口径统一（全部可配，缺省即修复行为）
    //   landingTrackRate 簇中心跟随速率（圈与逐发落点共用同一速率，缺省 FX.landing.trackRate = 16）
    //   landingWallInset 落点离边界墙的留白（px，缺省 FX.landing.wallInset = 34）——保证圈不被墙压/挡在场外
    //   landingRing      是否额外画「整簇包络圈」（半径 = 簇半径 + 结算半径，缺省 FX.landing.ring = true）
    return {
      area, r,
      lock: (s.landingLock === true),
      lead: Math.max(0, this._num(s.landingLead, 0.35)),
      clamp: (s.landingClamp === 'view') ? 'view' : null,
      fall: Math.max(0, this._num(s.landingFall, 300)),
      mark: (s.landingMark !== false),
      markLead: Math.max(0, this._num(s.landingMarkLead, this._num(fxMark.lead, 1.2))),
      markHold: Math.max(0, this._num(s.landingMarkHold, this._num(fxMark.hold, 0.8))),
      markWidth: Math.max(1, this._num(s.landingMarkWidth, this._num(fxMark.width, 7))),
      markGlow: (s.landingMarkGlow !== false),
      // 第 8 批需求①：落点/范围圈「是否跟随目标移动」开关（技能级，缺省 false = 固定位置）
      follow: (s.landingFollow === true),
      trackRate: Math.max(1, this._num(s.landingTrackRate, this._num(fxLand.trackRate, 16))),
      wallInset: Math.max(0, this._num(s.landingWallInset, this._num(fxLand.wallInset, 34))),
      ring: (s.landingRing !== false) && (fxLand.ring !== false),
    };
  }

  // ②（本轮）：预告圈存活时长统一计算
  //   = max(从施法到最后一发落地的时长, 最短预告时长 landingMarkLead) + 结算后残留 landingMarkHold
  //   保证玩家至少看到 landingMarkLead 秒的落点/范围预告，且落地结算后残留圈再停留 landingMarkHold 秒
  _markLife(L, impactSec) {
    const lead = Math.max(0, this._num(L && L.markLead, 1.2));
    const hold = Math.max(0, this._num(L && L.markHold, 0.8));
    return Math.max(this._num(impactSec, 0), lead) + hold;
  }

  // 需求⑥：把落点圆心夹进「战场合法区域」——半径内缩，保证结算圈完整落在场内、不被四面墙挡住；
  //   mode='view' 时再按当前镜头可见范围收敛（屏幕外的落点也拉回可见区，避免"砸在看不见的地方"）
  _clampLanding(x, y, r, mode, inset) {
    const arena = GAME_CONFIG.ARENA;
    const ins = Math.max(0, this._num(inset,
      this._num(GAME_CONFIG.FX && GAME_CONFIG.FX.landing && GAME_CONFIG.FX.landing.wallInset, 34)));
    // 第 6 条（本轮）：基础内缩 = 结算半径 + 离墙留白（wallInset），
    //   使落点圈与四面实体墙（墙厚 26px，绘制在 0..W / 0..H 之外）之间始终留出空隙，
    //   不再出现"圈压着墙 / 被墙挡在场地外"的观感。
    const rr0 = r + ins;
    let x0 = rr0, y0 = rr0, x1 = arena.w - rr0, y1 = arena.h - rr0;
    if (mode === 'view' && this.viewRect) {
      // 需求⑥：镜头内限制额外留白（FX.landing.viewPad），避免圆环正好贴住屏幕边缘像被"截断"
      const pad = this._num(GAME_CONFIG.FX && GAME_CONFIG.FX.landing && GAME_CONFIG.FX.landing.viewPad, 34);
      const rr = rr0 + Math.max(0, pad);
      const v = this.viewRect;
      const vw = this._num(v.x1, 0) - this._num(v.x0, 0);
      const vh = this._num(v.y1, 0) - this._num(v.y0, 0);
      // 第 8 批需求①（左上角无关圆圈根因修复）：镜头矩形未就绪（相机未初始化 → x0/x1 同为 0）
      //   或可见区比落点圈还小时，旧写法会把 x0/x1 收敛成同一个值，落点被"钉"在 (rr0, rr0)——
      //   即场景左上角：表现为"放区域轰炸时场上莫名多出一个圈、且完全不跟随目标"。
      //   现在只有镜头矩形确实容得下这个圈时才施加镜头收敛，否则退回战场内夹取（与缺省行为一致）。
      if (vw > rr * 2 + 2 && vh > rr * 2 + 2) {
        x0 = Math.max(x0, v.x0 + rr); y0 = Math.max(y0, v.y0 + rr);
        x1 = Math.min(x1, v.x1 - rr); y1 = Math.min(y1, v.y1 - rr);
      }
    }
    if (x1 < x0) { const c = (x0 + x1) / 2; x0 = c; x1 = c; }
    if (y1 < y0) { const c = (y0 + y1) / 2; y0 = c; y1 = c; }
    // 第 8 批需求①：非有限入参兜底（NaN/Infinity 会经 Math.min/max 传染 → 圈被画到 (0,0)）
    const ix = isFinite(x) ? x : (x0 + x1) / 2;
    const iy = isFinite(y) ? y : (y0 + y1) / 2;
    return { x: Math.max(x0, Math.min(x1, ix)), y: Math.max(y0, Math.min(y1, iy)) };
  }

  // 第 6 条（本轮）：天降落点簇的「确定性散点」——各端同种子同结果，且**唯一来源**：
  //   预告圈（整簇包络圈 + 逐发落点圈）与逐发子弹 landing 全部使用这一份偏移，几何严格同源。
  //   返回 [{x,y,r}]：x/y = 相对簇中心的偏移，r = 该发偏移距离（用于算包络半径）。
  _fallStrip(count, spreadR) {
    const out = [];
    const n = Math.max(1, Math.floor(this._num(count, 1)));
    const R = Math.max(0, this._num(spreadR, 0));
    for (let i = 0; i < n; i++) {
      const f = (i * 0.6180339887) % 1;
      const ang = f * Math.PI * 2 + i * 0.9;
      const rr = Math.sqrt((i + 0.5) / n) * R;
      out.push({ x: Math.cos(ang) * rr, y: Math.sin(ang) * rr, r: rr });
    }
    return out;
  }

  // 需求⑥：落点锁定目标——取「离瞄准点最近」的敌方单位（Boss 权重更高，锁定时优先咬 Boss）
  //   并列时按 id 字典序，保证各端选同一目标（确定性，联机一致）
  _lockTargetFor(owner, ax, ay, range) {
    let best = null, bd = Infinity;
    if (!owner) return null;
    for (const [, p] of this.players) {
      if (!p.alive || p.id === owner.id) continue;
      if (!!p.isBoss === !!owner.isBoss) continue;
      const d = Math.hypot(p.x - ax, p.y - ay);
      if (d > range) continue;
      const w = p.isBoss ? d * 0.55 : d;
      if (w < bd - 1e-6) { bd = w; best = p; continue; }
      if (Math.abs(w - bd) <= 1e-6 && best && String(p.id) < String(best.id)) best = p;
    }
    return best;
  }

  // 需求⑥：投掷/天降类技能的落点参数统一计算（提前量 = 配置提前量 + 下落飞行时间）
  _fallLead(skill, L, fallDist) {
    const bcfg = (typeof BULLETS !== 'undefined' && BULLETS[skill.bullet]) ? BULLETS[skill.bullet] : null;
    const spd = ((bcfg && bcfg.speed) ? bcfg.speed : 420) * (this._num(skill.speedMul, 1) || 1);
    const dist = (fallDist != null && fallDist > 0) ? fallDist : this._num(L && L.fall, 300);
    return Math.max(0, this._num(L && L.lead, 0.35)) + (dist / Math.max(60, spd));
  }

  // 需求⑥ + 第 6 条（本轮）：天降类（strike / barrage）落点排布统一入口
  //   1) 先在瞄准点附近锁定敌方单位（Boss 优先），按「配置提前量 + 下落飞行时间」预判其未来位置，
  //      并用预判点复核一次（两轮迭代）——移动目标稳定锁定、落点落在其"将要去的地方"；
  //   2) 落点簇整体平移到预判位置，**只对簇中心**按 landingClamp 夹进战场/镜头合法区域
  //      （内缩 = 簇半径 + 结算半径 + 离墙留白），逐发落点 = 簇中心 + 固定偏移，不再各自夹取——
  //      这样"夹边界"不会破坏簇内几何，圈与落点始终同源；
  //   3) 每发子弹的 landing 带上 trackId / lead / 同一 trackRate，以及相对簇中心的固定偏移
  //      offX/offY：飞行途中簇中心向目标（含提前量）平滑靠拢，逐发落点 = 中心 + 偏移同步平移；
  //   4) 预告圈与逐发落点共用同一份 offsets 与同一跟随参数——整簇包络圈（半径 = 簇半径 + 结算半径，
  //      圆心 = 簇中心）+ 逐发落点圈（半径 = 结算半径）与真实结算范围像素级对齐。
  //   返回 { items:[{x,y,opts}], aimX, aimY, target, lead }
  //   volleyTail（②本轮，秒）：从施法到「最后一发」落地的额外错峰时长（= (count-1)*interval），
  //     仅用于让预告圈活到最后一发落地之后再残留 landingMarkHold 秒；不影响落点对齐与预判。
  _planFallVolley(owner, skill, base, ox, oy, count, spreadR, L, fallDist, color, baseOpts, volleyTail) {
    const range = (skill.castRange != null) ? skill.castRange : 260;
    const rawX = ox + Math.cos(base) * range;
    const rawY = oy + Math.sin(base) * range;
    // 唯一来源：簇内确定性散点偏移（预告圈与逐发 landing 共用）
    const offs = this._fallStrip(count, spreadR);
    let maxOff = 0;
    for (const o of offs) maxOff = Math.max(maxOff, o.r);
    const inset = Math.max(0, this._num(L.wallInset, 34));
    const clusterR = Math.max(20, maxOff + L.r);          // 整簇覆盖半径（= 簇半径 + 结算半径）
    const centerInset = clusterR + inset;                 // 簇中心的合法内缩
    // 预判：锁定范围内最近敌方（Boss 优先）→ 用预判点复核一次，稳定锁同一目标
    const lockRange = this._num(skill.lockRange, 420);
    let tg = null;
    if (L.lock) {
      tg = this._lockTargetFor(owner, rawX, rawY, lockRange);
      if (tg) {
        const lead0 = this._fallLead(skill, L, fallDist);
        const pre = this._clampLanding(tg.x + (tg.vx || 0) * lead0, tg.y + (tg.vy || 0) * lead0,
          centerInset, L.clamp, 0);
        const tg2 = this._lockTargetFor(owner, pre.x, pre.y, lockRange);
        if (tg2) tg = tg2;
      }
    }
    const lead = this._fallLead(skill, L, fallDist);
    const aim = this._clampLanding(tg ? tg.x + (tg.vx || 0) * lead : rawX,
      tg ? tg.y + (tg.vy || 0) * lead : rawY, centerInset, L.clamp, 0);
    const trackRate = Math.max(1, this._num(L.trackRate, 16));
    // 第 8 批需求①：落点提示收敛为「一个圈」——半径 = 整簇释放范围（clusterR），
    //   不再下发逐发小圈(points) / 整簇包络圈(ringR) / 外发光圈 / 内圈双环 / 收缩进度环 / 金色卡角。
    //   目的：只标记"这个技能会打到哪一片"，玩家一眼看清该往哪儿躲，同时消除多层圈嵌套的观感噪音。
    //   landingFollow（L.follow）语义：true = 圈与逐发落点跟随锁定目标持续移动；
    //                                  false（缺省）= 释放瞬间定死在该位置，之后不再跟随。
    const follow = (L.follow === true);
    if (L.mark) {
      const flight = Math.max(0, this._fallLead(skill, L, fallDist) - this._num(L.lead, 0.35));
      this.pushFx('mark', aim.x, aim.y, color, {
        r: clusterR,            // 单圈：半径 = 整簇覆盖半径（技能释放范围）
        simple: true,           // 渲染侧单圈模式（见 view_render.fxMark）
        lock: false, progress: false, doubleRing: false, glow: false,
        trackId: (follow && tg) ? tg.id : null, lead: lead, trackRate: trackRate,
        life: this._markLife(L, flight + Math.max(0, this._num(volleyTail, 0))),
        width: L.markWidth,
      });
    }
    const items = [];
    for (let i = 0; i < offs.length && i < count; i++) {
      const off = offs[i];
      // 第 6 条：逐发落点 = 簇中心 + 固定偏移（与预告圈 points 同源）；不再逐发夹取，保证簇内几何不被破坏
      const cx = aim.x + off.x, cy = aim.y + off.y;
      const o = Object.assign({}, baseOpts);
      if (L.area) {
        // 伤害只由落点结算圈给出：飞行途中不做身体命中（避免半空蹭伤 + 与结算圈重复扣血）
        o.noBodyHit = true;
        // ②（本轮）：结算圈同样带上技能级线宽/发光开关（渲染侧统一取用）
        // 第 6 条：offX/offY 供飞行途中"簇中心 + 偏移"同步平移；centerInset 为簇中心夹取口径
        o.landing = { x: cx, y: cy, r: L.r, trackId: (follow && tg) ? tg.id : null, lead: lead, clamp: L.clamp,
                      width: L.markWidth, glow: L.markGlow, trackRate: trackRate,
                      offX: off.x, offY: off.y, centerInset: centerInset, wallInset: inset };
      }
      items.push({ x: cx, y: cy - Math.max(0, fallDist), opts: o });
    }
    return { items: items, aimX: aim.x, aimY: aim.y, target: tg, lead: lead };
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

  // 子弹上限配额统计（第 3 条修复配套）：只统计"会计入 MAX_BULLETS_PER_PLAYER 的弹"，
  //   即排除 persist 常驻环绕弹（环绕飞刃）。这类弹要么一直绕、要么由"替换/死亡"显式回收，
  //   不应与常规弹争抢上限名额，否则常驻越久、可释放空间越小（表现为技能逐渐"放不出来"）。
  _countQuotaBullets(pid) {
    if (!this.bullets || this.bullets.size === 0) return 0;
    let n = 0;
    for (const [, b] of this.bullets) {
      if (b.ownerId !== pid) continue;
      if (b.orbit && (b.orbit.persist || b.orbit.keep)) continue;   // 常驻环绕弹不占配额
      n++;
    }
    return n;
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
    // 需求4：释放方式（CastSystem 归一化）——读条型释放（charge / forbid / chant / 以后新增的）由 CastSystem 驱动，
    //   本函数只负责"出膛排布"；非 instant/channel 的释放方式在首帧不出膛，等读条结束回调 finishCast。
    const rel = (typeof CastSystem !== 'undefined') ? CastSystem.norm(skill) : null;
    // 同一释放事件的子弹共享 castId（观感联动 / 分裂归属）
    const castId = (typeof ev.castId === 'number') ? ev.castId : (ev.seq || 0);
    // 需求9：形状/颜色/半径扩展——技能级外观配置统一下发到本事件所有子弹
    const lookOpts = {};
    for (const k of ['shape', 'color', 'colorB', 'radius']) if (skill[k] != null) lookOpts[k] = skill[k];
    // 读条型释放（蓄力/禁咒/吟唱）：伤害倍率随事件携带（确定性，各端一致）
    if (typeof ev.dmgMul === 'number') lookOpts.dmgMul = ev.dmgMul;
    // 本轮新增：撕裂（DoT）随技能下发给本事件所有子弹——命中后由房主按同一份配置权威结算持续掉血，
    //   两端（本机/远端）都只在这里读一次配置，命中走同一个 handleHit，避免双写与状态分歧。
    //   技能级 tear 缺省项由 BuffSystem.dotDef 从 config/buffs.json 的 tear 条目取值。
    if (skill.tear && typeof skill.tear === 'object') {
      lookOpts.tear = Object.assign({}, skill.tear, { skillId: ev.skillId });
    }
    const commonOpts = Object.assign({ castId }, lookOpts);
    // 连射/轰炸的发射间隔：可配 castInterval，缺省按 CD 均摊
    const interval = (skill.castInterval != null && skill.castInterval >= 0)
      ? skill.castInterval
      : Math.max(0.05, ((skill.cd || 1) / count) * 0.4);
    const nowSec = performance.now() / 1000;
    const bullets = [];
    // 需求4：非 instant / channel 的释放方式（蓄力以外的读条型：禁咒、吟唱及以后新增的）首帧不出膛，
    //   由 CastSystem.update 在读条结束时回调 finishCast 出膛（伤害按比例结算）；
    //   castDone=true 表示本次事件来自 finishCast（读条已结束），正常出膛。
    if (!ev.castDone && rel && rel.type !== 'instant' && rel.type !== 'channel' && rel.type !== 'charge') return bullets;
    const spawn = (tag, x, y, dir, opts) => {
      const b = this._newBullet(owner, skill, ev, tag, x, y, dir, Object.assign({}, commonOpts, opts || {}));
      bullets.push(b);
      return b;
    };
    const muzzle = (dir) => ({ x: ox + dir.x * (owner.radius + 4), y: oy + dir.y * (owner.radius + 4) });

    if (cast === 'charge') {
      // 蓄力炮：单发重弹，伤害与弹速提升，释放时带一次蓄力特效
      //   chargeTime 蓄满时长（秒，缺省 0 = 按下即出膛，旧行为不变）
      //   chargeMul 蓄满伤害倍率（缺省 1.6）
      //   chargeHold=true 允许中途松手提前出膛（倍率按已蓄力比例线性折算）
      const mul = (rel && rel.mul != null) ? rel.mul : ((skill.chargeMul != null) ? skill.chargeMul : 1.6);
      const ct = (rel && rel.duration > 0) ? rel.duration
        : ((skill.chargeTime != null && skill.chargeTime > 0) ? skill.chargeTime : 0);
      const ratio = (typeof ev.chargeRatio === 'number') ? Math.max(0, Math.min(1, ev.chargeRatio)) : 1;
      // 本端模拟的单位按下（事件无 chargeRatio）：chargeTime>0 时进入蓄力，等松手/蓄满由 _chargeShot 出膛并广播
      // 需求1：除了本机玩家，本端模拟的 AI / Boss 同样要走蓄力流程——Boss 技能才有蓄力读条，
      //        远端（非本端拥有者）不进入蓄力，只按 'cast' 广播显示只读条
      const localOwner = (ev.from === (this.net && this.net.myId))
        || !!(this.bots && this.bots.some(b => b.id === ev.from));
      if (ct > 0 && typeof ev.chargeRatio !== 'number' && localOwner) {
        this._beginCharge(owner, skill, ev, base, ct);
        ev._chargePending = true;      // 按下阶段不广播（fireSkill 据此跳过 relayShoot）
        return bullets;
      }
      // 需求1：按实际蓄力时间结算伤害（ratio=1 满蓄力时 = chargeMul，与旧行为一致）
      const dmgMul = (rel && typeof CastSystem !== 'undefined') ? CastSystem.dmgMul(rel, ratio)
        : (1 + (mul - 1) * ratio);
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
      const L = this._landingOf(skill, spreadR);          // 需求11：圆形结算区
      // 需求⑥：落点排布统一走 _planFallVolley（锁定/提前量/投放限制/锁定指示），
      //   落点圆环与结算圈共用同一份 landing，圆心半径完全一致
      // ②（本轮）：额外把「最后一发落地的错峰时长」传入，供预告圈时长计算（不改落点与预判）
      const plan = this._planFallVolley(owner, skill, base, ox, oy, count, spreadR, L,
        L.fall, skill.color || '#ff9f43', commonOpts, (count - 1) * interval);
      for (let i = 0; i < count; i++) {
        const it = plan.items[i];
        this._scheduleCast({
          at: nowSec + i * interval, ev, skill, tag: 'k' + i,
          dir: { x: 0, y: 1 },                         // 自天而降
          x: it.x, y: it.y,
          opts: it.opts,
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
      const L = this._landingOf(skill, (blast != null) ? blast : spreadR);   // 需求11：圆形结算区
      // 需求⑥：与 strike 共用落点排布（锁定 + 提前量 + 投放限制 + 锁定指示）
      const plan = this._planFallVolley(owner, skill, base, ox, oy, count, spreadR, L,
        L.fall, skill.color || '#ff9f43', commonOpts, (count - 1) * interval);
      for (let i = 0; i < count; i++) {
        const it = plan.items[i];
        if (blast != null) it.opts.blastRadius = blast;
        this._scheduleCast({
          at: nowSec + i * interval, ev, skill, tag: 'g' + i,
          dir: { x: 0, y: 1 },                         // 自天而降
          x: it.x, y: it.y,
          opts: it.opts,
        });
      }
    } else if (cast === 'melee') {
      // 需求5：近战类技能（突刺 thrust / 斩击 slash / 旋转 spin）——纯配置驱动
      //   melee.style 招式（缺省 thrust）/ melee.range 攻击距离（px，缺省 90）/ melee.arc 张角（弧度，缺省 1.6）
      //   melee.life 弹体存活（秒，缺省 0.16）/ melee.radius 判定半径（缺省 14）/ melee.count 段数（缺省 count）
      //   melee.speedMul 弹速倍率 / melee.spin 旋转斩角速度（弧度/秒）/ melee.orbitRadius 旋转半径
      // 近战弹体统一：短命 + 高穿透 + 不撞墙，避免飞出去变成远程弹
      const me = (skill.melee && typeof skill.melee === 'object') ? skill.melee : {};
      const style = me.style || skill.meleeStyle || 'thrust';
      const mr = this._num(me.range, 90);
      const marc = this._num(me.arc, 1.6);
      const mo = { life: this._num(me.life, 0.16), radius: this._num(me.radius, 14),
                   pierce: 999, onWall: 'ignore' };
      const mn = Math.max(1, this._num(me.count, count));
      if (style === 'spin') {
        // 旋转斩：围绕自身一圈的环绕弹体（需求6 环绕效果的近战用法）
        for (let i = 0; i < mn; i++) {
          spawn('m' + i, ox, oy, { x: Math.cos(base), y: Math.sin(base) }, Object.assign({}, mo, {
            orbit: { radius: this._num(me.orbitRadius, mr * 0.8), spin: this._num(me.spin, 9),
                     phase: Math.PI * 2 * i / mn, follow: true,
                     keep: false, block: false },     // 近战旋斩是短命弹体：不持续、不参与格挡
          }));
        }
      } else if (style === 'slash') {
        // 斩击：沿张角方向铺开的多段弹体（分布在弧线上，依次扫出）
        for (let i = 0; i < mn; i++) {
          const a = base + marc * (mn > 1 ? (i / (mn - 1) - 0.5) : 0);
          const d = { x: Math.cos(a), y: Math.sin(a) };
          spawn('m' + i, ox + d.x * mr * 0.55, oy + d.y * mr * 0.55, d,
            Object.assign({}, mo, { speedMul: this._num(me.speedMul, 1.1) }));
        }
      } else {
        // 突刺：沿瞄准方向的短程高速弹体
        for (let i = 0; i < mn; i++) {
          const a = base + marc * 0.08 * (mn > 1 ? (i / (mn - 1) - 0.5) : 0);
          const d = { x: Math.cos(a), y: Math.sin(a) };
          spawn('m' + i, ox + d.x * mr * 0.35, oy + d.y * mr * 0.35, d,
            Object.assign({}, mo, { speedMul: this._num(me.speedMul, 1.2) }));
        }
      }
    } else if (cast === 'aura' || cast === 'field') {
      // 需求7：以玩家为中心的圆形区域伤害判定（领域/范围类）——复用弹体碰撞，不引入新实体
      //   领域按 tick 分跳投放"锚定玩家的圆形弹体"，每跳对圈内敌方各结算一次（房主权威结算不变）
      //   aura.radius 领域半径（px，缺省 120）/ aura.duration 持续（秒，缺省 3）
      //   aura.tick 结算间隔（秒，缺省 0.5）/ aura.follow 是否跟随玩家（缺省 true）/ aura.damageMul 每跳倍率
      // 第 5 条（本轮）：领域跟随施法者——技能级 aura.* 未写时回落 config/runtime.json 的 FX.aura 全局缺省
      //   （与第 4 条 FX.throw 同一范式，保证"领域 = 以施法者为中心"的语义可配且默认开启）
      const au = (skill.aura && typeof skill.aura === 'object') ? skill.aura : {};
      const fxA = (GAME_CONFIG.FX && GAME_CONFIG.FX.aura) || {};
      const ar = Math.max(10, this._num(au.radius, this._num(fxA.radius, 120)));
      const adur = Math.max(0.2, this._num(au.duration, this._num(fxA.duration, 3)));
      const atick = Math.max(0.1, this._num(au.tick, this._num(fxA.tick, 0.5)));
      const apulses = Math.max(1, Math.ceil(adur / atick));
      // 伤害区跟随（缺省开）：决定锚定弹（radius:0 压在施法者身上的圆形判定区）是否随人移动
      const afollow = (au.follow != null) ? (au.follow !== false) : (fxA.follow !== false);
      // 预告圈跟随（缺省开）：决定"范围可视圈"是否同样随人移动（第 5 条新增）
      const amarkFollow = (au.markFollow != null) ? (au.markFollow !== false) : (fxA.markFollow !== false);
      // 预告圈跟随速率（越大越"硬跟随"，每秒吸附比例；缺省 24 ≈ 每帧吸附 40%）
      const amarkRate = Math.max(1, this._num(au.markTrackRate, this._num(fxA.markTrackRate, 24)));
      // 预告圈硬跟随（缺省开）：true = 每帧圆心直接等于施法者位置（零滞后，领域"恒以施法者为中心"）；
      //   false = 按 markTrackRate 平滑吸附（用于落点锁定类目标）
      const amarkSnap = (au.markSnap != null) ? (au.markSnap !== false) : (fxA.markSnap !== false);
      const aMul = this._num(au.damageMul, this._num(fxA.damageMul, 1));
      // ②（本轮）：领域类技能的"范围预告圈"——施法即在半径内铺一层更粗更亮的范围圈，
      //   可见时长 = max(领域持续 adur, landingMarkLead) + landingMarkHold（领域结束后残留淡出）；
      //   参数取技能级 landingMark / landingMarkLead / landingMarkHold / landingMarkWidth / landingMarkGlow
      const L = this._landingOf(skill, ar);
      if (L.mark) {
        // 第 5 条（本轮）：预告圈同样跟随施法者——trackId = 施法者实体 id，渲染侧每帧把圈吸附到其当前位置
        //   （lead = 0：领域不预判、实时贴人；trackRate 越高越"硬跟随"，领域缺省 24）
        this.pushFx('mark', ox, oy, skill.color || '#ff7a45', {
          r: Math.max(20, L.r), lock: false, width: L.markWidth, glow: L.markGlow,
          life: this._markLife(L, adur),
          trackId: (afollow && amarkFollow && owner) ? owner.id : null, lead: 0,
          trackRate: amarkRate, trackSnap: amarkSnap,
        });
      }
      for (let i = 0; i < apulses; i++) {
        const o = Object.assign({}, commonOpts, {
          radius: ar, pierce: 999, onWall: 'ignore', life: atick + 0.08,
          dmgMul: ((commonOpts.dmgMul != null) ? commonOpts.dmgMul : 1) * aMul,
          // 锚定玩家：领域圆心（radius 0 = 正好压在施法者身上，随其移动，需求③）
          //   keep:false —— 领域按 tick 脉冲生成，必须照常消亡，否则弹体无限堆积
          //   block:false —— 领域只负责范围内的持续伤害，不参与抵消子弹
          orbit: { radius: 0, spin: 0, follow: afollow, keep: false, block: false },
        });
        this._scheduleCast({ at: nowSec + i * atick, ev, skill, tag: 'a' + i, dir: { x: 0, y: 1 }, x: ox, y: oy, opts: o });
      }
    } else if (cast === 'orbit') {
      // 需求6/④：环绕效果——围绕玩家做圆周旋转的子弹（count 发均分相位）
      //   orbit.radius 旋转半径（px，缺省 70）/ orbit.spin 角速度（弧度/秒，缺省 4，负值反向）
      //   orbit.follow 是否跟随玩家（缺省 true）
      //   orbit.persist 是否持续环绕不清空（缺省 true；false = 按 orbit.life 到时消散；keep 为历史别名）
      //   orbit.block  是否可抵挡/抵消敌方子弹（缺省 true）
      //   orbit.blocks / orbit.refill / orbit.rehit 格挡次数 / 冷却后回复 / 冷却秒
      //   orbit.consume 拦截成功后是否消耗该发飞刃（缺省 false = 不消耗，飞刃继续绕圈）
      // 需求②：技能级 orbit.* 未写时统一回落到 config/runtime.json 的 FX.orbit 全局缺省（兜底可配）
      const ob = (skill.orbit && typeof skill.orbit === 'object') ? skill.orbit : {};
      const fxO = (GAME_CONFIG.FX && GAME_CONFIG.FX.orbit) || {};
      const orr = Math.max(0, this._num(ob.radius, this._num(fxO.radius, 70)));
      const ospin = this._num(ob.spin, this._num(fxO.spin, 4));
      // 第 3 条修复配套：life 只对"非持久"环绕弹有意义，这里统一给正下限，避免 0/负值把弹体当场判死
      const olife = Math.max(0.05, this._num(ob.life, this._num(skill.orbitLife, this._num(fxO.life, 2))));
      // persist：技能级优先，其次 runtime 兜底；keep 作为历史别名等价读取
      // 本轮修复（可配置性增强）：技能顶层别名 orbitPersist / orbitBlock 也参与判定（顺序：
      //   技能级 orbit.persist(persist/keep) > 技能顶层 orbitPersist > 全局 FX.orbit.persist(keep) 兜底）
      const opersist = (ob.persist != null) ? (ob.persist !== false)
        : ((ob.keep != null) ? (ob.keep !== false)
          : ((skill.orbitPersist != null) ? (skill.orbitPersist !== false)
            : ((fxO.persist != null) ? (fxO.persist !== false) : (fxO.keep !== false))));
      const oblock = (ob.block != null) ? (ob.block !== false)
        : ((skill.orbitBlock != null) ? (skill.orbitBlock !== false) : (fxO.block !== false));
      const oblocks = this._num(ob.blocks, this._num(fxO.blocks, 1));
      const orefill = (ob.refill != null) ? (ob.refill !== false) : (fxO.refill !== false);
      const orehit = this._num(ob.rehit, this._num(fxO.rehit, 0.6));
      const oconsume = (ob.consume != null) ? (ob.consume === true) : (fxO.consume === true);
      // 本轮修复（第 3 条·清空路径①）：持续环绕（persist）时再次释放同一技能，改为**无缝续期**，
      //   不再像旧实现那样"先整批删除上一批、再重新生成 count 发"。旧写法的隐患：删除是立即的，
      //   而重新生成可能被任何原因打断（子弹上限拒绝、事件过期丢弃、队列时序），一旦如此就是
      //   "旧飞刃已删、新飞刃没出来" —— 观感即"环绕飞刃被清空"。
      //   新行为：
      //     · orbit.replace !== false（默认替换语义）—— 保留在位飞刃（最多 count 发），逐发把本次释放的
      //       radius/spin/follow/block/blocks/refill/rehit/consume 刷成最新配置并按圆周重排相位；
      //       仅回收"超出 count"的多余发，仅补生成缺额（缺几发补几发，视觉上飞刃不断档）；
      //     · orbit.replace === false（叠加语义）—— 在位飞刃全部保留并刷新，另按 count 全量新增；
      //       用 orbit.maxPersist（缺省 count*8、下限 64）做堆积护栏，超出时按 id 序回收最旧的若干发。
      let orbitKeep = 0;
      if (opersist) {
        const sid = ev && ev.skillId;
        const mine = [];
        for (const [bid, bb] of Array.from(this.bullets)) {
          if (bb.ownerId !== owner.id || !bb.orbit || !(bb.orbit.persist || bb.orbit.keep)) continue;
          if (sid != null && bb.skillId != null && bb.skillId !== sid) continue;
          mine.push(bb);
        }
        if (mine.length) {
          const replaceMode = (ob.replace !== false);
          const cap = Math.max(count, this._num(ob.maxPersist, Math.max(count * 8, 64)));
          // 稳定排序（按子弹 id 字典序）：保证"保留哪几发 / 回收哪几发"在各端完全一致（确定性）
          mine.sort((a, bb) => String(a.id).localeCompare(String(bb.id)));
          if (!replaceMode && mine.length + count > cap) {
            const drop = Math.min(mine.length, mine.length + count - cap);   // 叠加模式：腾出护栏空间（FIFO）
            for (let i = 0; i < drop; i++) {
              const bb = mine[i];
              bb.dead = true;
              this.bullets.delete(bb.id);
              this.bulletCount[owner.id] = Math.max(0, (this.bulletCount[owner.id] || 1) - 1);
            }
            mine.splice(0, drop);
          }
          const keepN = replaceMode ? Math.min(count, mine.length) : mine.length;
          for (let i = 0; i < mine.length; i++) {
            const bb = mine[i];
            if (i >= keepN) {                    // 替换模式：超出 count 的多余发回收（不新增，净数量不增）
              bb.dead = true;
              this.bullets.delete(bb.id);
              this.bulletCount[owner.id] = Math.max(0, (this.bulletCount[owner.id] || 1) - 1);
              continue;
            }
            // 无缝续期：把在位的这发刷成"本次释放"的最新配置（改配置后不必等死亡重放即可生效）
            bb.orbit.radius = orr;
            bb.orbit.spin = ospin;
            bb.orbit.follow = (ob.follow !== false);
            bb.orbit.persist = true;
            bb.orbit.keep = true;
            bb.orbit.block = oblock;
            bb.orbit.blocks = oblocks;
            bb.orbit.refill = orefill;
            bb.orbit.rehit = orehit;
            bb.orbit.consume = oconsume;
            bb.orbit.phase = Math.PI * 2 * (i % count) / count;   // 相位重排：续期后仍沿圆周均匀分布
            bb._orbA = bb.orbit.phase;
            bb.life = olife;
            bb.orbitBlocksLeft = oblocks;         // 重新释放 = 格挡次数回满（"飞刃护盾"被刷新）
            bb.orbitBlockCd = 0;
          }
          orbitKeep = replaceMode ? keepN : 0;    // 叠加模式：下方的生成循环照常补满 count 发
        }
      }
      for (let i = orbitKeep; i < count; i++) {
        spawn('o' + i, ox, oy, { x: Math.cos(base), y: Math.sin(base) }, {
          life: olife,
          orbit: {
            radius: orr, spin: ospin, phase: Math.PI * 2 * i / count,
            follow: (ob.follow !== false),
            persist: opersist,
            keep: opersist,
            block: oblock,
            blocks: oblocks,
            refill: orefill,
            rehit: orehit,
            consume: oconsume,
          },
        });
      }
    } else if (cast === 'area_drop' || cast === 'droparea' || cast === 'drop') {
      // 需求10/⑤：在指定圆形区域内投放子弹
      //   drop.x / drop.y 圆心绝对坐标（缺省按 drop.origin 推算）
      //   drop.origin 'aim'（缺省，沿瞄准方向 drop.range 处）| 'self'（玩家自身位置）
      //   drop.range 投送距离（px，缺省 220）/ drop.radius 投放圆半径（px，缺省 80）
      //   drop.dir 'outward'（缺省，自圆心向外）| 'down' | 'aim' | 'inward'（朝圆心）
      //   drop.together 是否同帧投放（缺省 true；false 则按 castInterval 依次投放）
      // 本轮新增（需求⑤）：投掷动作与飞行轨迹——
      //   drop.throw        true 时从施法者处"抛出"，沿抛物线飞向落点（可看清从哪投、飞向哪、何时炸）
      //   drop.throwDur     单发飞行时长（秒，缺省 0.55）
      //   drop.throwPeak    抛物线最高抬升（px，缺省 90）
      //   drop.throwStagger 多发之间的投掷间隔（秒，缺省 0.05，依次抛出）
      //   飞行途中不判身体命中（noBodyHit），抵达落点后由圆形结算区统一结算伤害
      const dr = (skill.drop && typeof skill.drop === 'object') ? skill.drop : {};
      const dorg = dr.origin || 'aim';
      const drange = this._num(dr.range, 220);
      const drad = Math.max(1, this._num(dr.radius, this._num(skill.dropRadius, 80)));
      const L = this._landingOf(skill, drad);              // 需求⑤/⑥：落点圆环 = 结算圈（同源数据）
      const rawCx = this._num(dr.x, (dorg === 'self') ? ox : ox + Math.cos(base) * drange);
      const rawCy = this._num(dr.y, (dorg === 'self') ? oy : oy + Math.sin(base) * drange);
      const dtg = L.lock ? this._lockTargetFor(owner, rawCx, rawCy, this._num(skill.lockRange, 420)) : null;
      const dlead = dtg ? this._fallLead(skill, L, L.fall) : 0;
      const dc = this._clampLanding(dtg ? dtg.x + (dtg.vx || 0) * dlead : rawCx,
        dtg ? dtg.y + (dtg.vy || 0) * dlead : rawCy, Math.max(drad, L.r), L.clamp);
      const cx = dc.x, cy = dc.y;
      const ddir = dr.dir || 'outward';
      const together = (dr.together !== false);
      const dthrow = (dr.throw === true);
      // 第 4 条：投掷参数支持「技能级配置」+ config/runtime.json 的 FX.throw 全局兜底
      const fxt = ((typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG.FX && GAME_CONFIG.FX.throw)
        ? GAME_CONFIG.FX.throw : {});
      const tDur = Math.max(0.15, this._num(dr.throwDur, this._num(fxt.dur, 0.85)));
      const tPeak = Math.max(0, this._num(dr.throwPeak, this._num(fxt.peak, 150)));
      const tStagger = Math.max(0, this._num(dr.throwStagger, this._num(fxt.stagger, 0.08)));
      const tArm = (dr.throwArm != null) ? (dr.throwArm !== false) : (fxt.arm !== false);
      // 第 4 条：投掷动作——施法者处播"抬手投出"起手表现，并把落点方向一并下发（渲染侧据此画方向指示）
      if (dthrow && tArm) this.pushFx('throwCast', ox, oy, skill.color || '#8ad2ff', { tx: cx, ty: cy });
      if (L.mark) {
        // 第 8 批需求①：与天降类同一口径——单个范围圈（半径 = 投放圆半径 drad），
        //   去掉外发光圈 / 内圈双环 / 收缩进度环 / 金色卡角；landingFollow=false 时圈固定在投放点，
        //   true 时跟随锁定目标（trackId + lead 由渲染侧逐帧同步）
        this.pushFx('mark', cx, cy, skill.color || '#8ad2ff',
          { r: drad, simple: true, lock: false, progress: false, doubleRing: false, glow: false,
            width: L.markWidth,
            trackId: (L.follow === true && dtg) ? dtg.id : null, lead: dlead,
            life: this._markLife(L, tDur + tStagger * Math.max(0, count - 1)) });
      }
      for (let i = 0; i < count; i++) {
        const f = (i * 0.6180339887) % 1;
        const ang = f * Math.PI * 2 + i * 0.9;
        const rr = Math.sqrt((i + 0.5) / count) * drad;
        const pc = this._clampLanding(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, L.r, L.clamp);
        const px = pc.x, py = pc.y;
        const d = (ddir === 'down') ? { x: 0, y: 1 }
          : (ddir === 'aim') ? { x: Math.cos(base), y: Math.sin(base) }
            : (ddir === 'inward') ? { x: -Math.cos(ang), y: -Math.sin(ang) }
              : { x: Math.cos(ang), y: Math.sin(ang) };
        if (dthrow) {
          const o = Object.assign({}, commonOpts, {
            throw: { x0: ox, y0: oy, tx: px, ty: py, dur: tDur, peak: tPeak },
            life: tDur + 0.12,
          });
          if (L.area) {
            // 飞行途中不判命中，伤害只走落点结算（避免双重结算）
            o.noBodyHit = true;
            o.landing = { x: px, y: py, r: L.r, clamp: L.clamp, width: L.markWidth, glow: L.markGlow };
          }
          this._scheduleCast({ at: nowSec + (together ? i * tStagger : i * interval),
            ev, skill, tag: 'd' + i, dir: d, x: ox, y: oy, opts: o });
        } else if (together) {
          spawn('d' + i, px, py, d, commonOpts);
        } else {
          this._scheduleCast({ at: nowSec + i * interval, ev, skill, tag: 'd' + i, dir: d, x: px, y: py, opts: commonOpts });
        }
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
      const nb = this._newBullet(owner, skill, ev, it.tag, x, y, it.dir, it.opts);
      // 第 4 条：投掷弹真正出手的一刻，在出手点补一次短促的抛出特效（与抛物线飞行同步的节奏感）
      if (nb && nb.throw) {
        this.pushFx('muzzle', nb.throw.x0, nb.throw.y0, skill.color || '#8ad2ff',
          { d: 14, image: skill.fxImage || null });
      }
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
    // 需求1：蓄力读条登记——读条显示 / 禁止移动 / 禁止释放其他技能统一由 CastSystem 提供，
    // 出膛逻辑仍走既有 _chargeShot（ratio 按实际蓄力时间结算），不改变原有手感
    if (typeof CastSystem !== 'undefined' && CastSystem.beginCharge) {
      const cd = CastSystem.norm(skill);
      item.castDef = cd;
      CastSystem.beginCharge(this, owner, skill, cd, ct, ev.dir);
    }
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

  // 蓄力出膛 / 松手标记：ratio = 已蓄力比例（0~1）。
  // 第三轮修正·需求③（行为重定义）：提前松手（键盘 keyup / 触屏手势抬起 gesture / 蓄力中再次点击 click）
  //   **不再立即出膛**，只结束"按住"阶段并打上 released 标记；剩余蓄力时间继续走，由 _updateCharges 在
  //   蓄满时刻统一出膛（ratio=1），即"松手后仍保留剩余蓄力时间，读条走完再真正释放技能"。
  //   误触保护保留：进度不足 chargeMinRatio（缺省 0.08）的松手忽略，继续蓄力。
  //   reason='full' 是唯一真正的出膛路径（蓄满自动出膛）。
  _releaseCharge(playerId, reason) {
    const q = this._charges;
    if (!q || !q.length) return false;
    const idx = q.findIndex(c => c.playerId === playerId);
    if (idx < 0) return false;
    const item = q[idx];
    const nowSec = performance.now() / 1000;
    const ratio = Math.max(0, Math.min(1, (nowSec - item.start) / item.ct));
    const minR = this._num((SKILLS[item.skillId] || {}).chargeMinRatio, 0.08);
    const early = (reason === 'keyup' || reason === 'click' || reason === 'gesture');
    if (early) {
      if (item.hold === false) return false;         // 非"按住型"蓄力：无松手语义（保持蓄满自动出膛）
      if (item.released) return false;               // 已松手：重复抬手忽略
      if (ratio < Math.max(0, minR)) return false;   // 误触保护：进度太少不认，继续蓄力
      item.released = true;
      item.releasedAt = nowSec;
      item.releaseReason = reason;
      if (item.handler && typeof window !== 'undefined') {
        window.removeEventListener('keyup', item.handler);
        item.handler = null;
      }
      // 关键：这里既不结束 CastSystem 实例、也不出膛 —— 读条与「持续释放中」按钮态保持到蓄满出膛
      return true;
    }
    // reason === 'full'：蓄力时间走满 → 真正出膛
    q.splice(idx, 1);
    if (item.handler && typeof window !== 'undefined') window.removeEventListener('keyup', item.handler);
    // 需求1：蓄力读条结束 → 关闭 CastSystem 里的施法状态（解除禁移/禁技）
    if (typeof CastSystem !== 'undefined' && CastSystem.end) CastSystem.end(playerId);
    this._chargeShot(item, ratio);
    return true;
  }

  // 第三轮修正·需求③：触屏技能键「手势抬起」（pointerup / pointercancel）入口。
  //   与键盘 keyup 完全同语义：只结束按住阶段，剩余蓄力时间照走，读条结束再出膛。
  releaseChargeGesture(playerId) { return this._releaseCharge(playerId, 'gesture'); }

  // 出膛：按已蓄力比例系数倍率（ratio=1 时 = chargeMul，与旧行为一致）
  _chargeShot(item, ratio) {
    const player = this.players.get(item.playerId);
    if (!player || !player.alive) return;
    // 第 8 批需求②：出膛这一刻才落实冷却——蓄满(full) / 松手(keyup) / 再次点击(click) 三条路径统一在此进 CD
    if (player.commitCd) player.commitCd(item.skillId);
    const nowMs = performance.now();
    const ev = { t: 'shoot', from: player.id, skillId: item.skillId, dir: item.dir, seq: ++this.bulletSeq,
                 time: nowMs, ts: nowMs, ox: player.x, oy: player.y, chargeRatio: ratio };
    this.spawnSkillBullets(ev);
    if (this.net && this.net.relayShoot) this.net.relayShoot(ev);
  }

  // 读条型释放（蓄力 / 禁咒 / 吟唱 / 后续新增读条方式）的统一出膛入口：
  //   由 CastSystem.update 在读条结束时回调，ratio = 判定比例（禁咒=积分比例 / 吟唱=笔迹贴合度）
  //   伤害按 CastSystem 定义的倍率折算，事件随 relayShoot 广播，各端用同一事件重建（房主权威结算不变）
  finishCast(inst, ratio) {
    if (!inst || inst.finished) return null;
    inst.finished = true;
    const pid = (inst.pid != null) ? inst.pid : inst.playerId;
    const player = (pid != null) ? this.players.get(pid) : null;
    if (!player || !player.alive) return null;
    const skill = SKILLS[inst.skillId];
    if (!skill) return null;
    const def = inst.def || ((typeof CastSystem !== 'undefined') ? CastSystem.norm(skill) : null);
    // 第 8 批需求④：持续释放（channel）+ 环绕飞刃 → 读条结束只做「收招」：清空残余飞刃并落实 CD，不再出膛。
    //   旧行为问题：伤害判定早已结束，但绕圈飞刃仍留在场上（还继续占子弹配额），观感是"技能结束了还在打"。
    if (def && def.type === 'channel' && skill.orbit) {
      const cleared = this.clearOrbitBullets(player.id, inst.skillId);
      if (player.commitCd) player.commitCd(inst.skillId);
      return { cleared: cleared };
    }
    const r = Math.max(0, Math.min(1, this._num(ratio, 0)));
    const mul = (def && typeof CastSystem !== 'undefined') ? CastSystem.dmgMul(def, r) : 1;
    const nowMs = performance.now();
    const ev = {
      t: 'shoot', from: player.id, skillId: inst.skillId, dir: inst.dir || { x: 1, y: 0 },
      seq: ++this.bulletSeq, time: nowMs, ts: nowMs, ox: player.x, oy: player.y,
      castRatio: r, dmgMul: mul, castDone: true,     // castDone：跳过"读条型释放首帧不出膛"的拦截
    };
    // 读条结束的统一起手特效（本机与远端表现一致）
    this.pushFx('muzzle', player.x, player.y, skill.color || player.effColor || '#ffffff',
      { d: 18, image: skill.fxImage || null });
    const bullets = this.spawnSkillBullets(ev);
    if (this.net && this.net.relayShoot) this.net.relayShoot(ev);
    if (player.commitCd) player.commitCd(inst.skillId);   // 第 8 批需求②：读条走完才进 CD
    return bullets;
  }

  // 第 8 批需求④：清空某施法者名下（可限定技能 id）的常驻环绕弹——持续释放结束时的收招清理。
  //   账目与"阵亡回收"口径一致：删除子弹 + 归还 bulletCount 配额，避免残余飞刃继续绕圈/占配额。
  //   返回清掉的发数（供调用方记录/日志）。
  clearOrbitBullets(ownerId, skillId) {
    let n = 0;
    for (const [bid, b] of Array.from(this.bullets)) {
      if (!b || b.ownerId !== ownerId) continue;
      if (!b.orbit || !(b.orbit.persist || b.orbit.keep)) continue;
      if (skillId != null && b.skillId != null && b.skillId !== skillId) continue;
      b.dead = true;
      this.bullets.delete(bid);
      this.bulletCount[ownerId] = Math.max(0, (this.bulletCount[ownerId] || 1) - 1);
      n++;
    }
    return n;
  }

  // 每帧检查蓄力进度：达 chargeTime 视为蓄满，自动出膛（ratio=1）
  _updateCharges() {
    const q = this._charges;
    if (!q || !q.length) return;
    const nowSec = performance.now() / 1000;
    for (const item of q.slice()) if (nowSec >= item.at) this._releaseCharge(item.playerId, 'full');
  }

  // 需求1：本机蓄力进度广播（约 10Hz）——远端据此显示蓄力读条，不参与任何伤害结算
  chargeBarTick(interval) {
    const q = this._charges;
    if (!q || !q.length) return;
    const nowSec = performance.now() / 1000;
    const gap = (typeof interval === 'number' && interval > 0) ? interval : 0.1;
    if (this._lastChargeBarAt && nowSec - this._lastChargeBarAt < gap) return;
    this._lastChargeBarAt = nowSec;
    for (const item of q) {
      this.broadcast({
        t: 'charge_bar', from: item.playerId, skillId: item.skillId,
        t0: Math.max(0, nowSec - item.start), dur: item.ct, dir: item.dir,
      });
    }
  }

  // 需求1：远端蓄力读条刷新（仅表现层；进度由 charge_bar 消息驱动，超时未续报即清理）
  _updateRemoteCharges() {
    const rc = this._remoteCharges;
    if (!rc) return;
    const nowSec = performance.now() / 1000;
    for (const pid of Object.keys(rc)) {
      const st = rc[pid];
      const inst = (typeof CastSystem !== 'undefined') ? CastSystem.get(pid) : null;
      if (!inst) { delete rc[pid]; continue; }
      inst.t = st.t; inst.dur = st.dur;
      inst.ratio = Math.max(0, Math.min(1, st.t / st.dur));
      const owner = this.players.get(pid);
      if (owner) { inst.x = owner.x; inst.y = owner.y; }
      if (nowSec - st.recv > 0.4 && typeof CastSystem !== 'undefined') { CastSystem.end(pid); delete rc[pid]; }
    }
  }

  // 收到远端蓄力进度消息：第一次到达时补登记一条读条（后续只刷新进度）
  onChargeBar(msg) {
    if (!msg || !msg.from || !this.players.has(msg.from)) return;
    if (this.net && this.net.myId === msg.from) return;          // 自己的读条由本端维护
    if (!this._remoteCharges) this._remoteCharges = {};
    let inst = (typeof CastSystem !== 'undefined') ? CastSystem.get(msg.from) : null;
    if (!inst) {
      const p = this.players.get(msg.from);
      const skill = SKILLS[msg.skillId];
      if (p && skill && typeof CastSystem !== 'undefined') {
        inst = CastSystem.begin(this, p, skill, CastSystem.norm(skill), msg.dir || { x: 1, y: 0 }, true);
        if (inst) inst.relay = 'charge';
      }
    }
    if (!inst) return;
    this._remoteCharges[msg.from] = {
      t: Math.max(0, this._num(msg.t0, 0)),
      dur: Math.max(0.05, this._num(msg.dur, inst.dur || 1)),
      recv: performance.now() / 1000,
    };
    inst.t = this._remoteCharges[msg.from].t;
    inst.dur = this._remoteCharges[msg.from].dur;
    inst.ratio = Math.max(0, Math.min(1, inst.t / inst.dur));
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
        { castId: b.castId, depth: (b.depth || 0) + 1, dmgMul: b.dmgMul, tear: b.tear,
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
      // 需求④/①：持续环绕弹（persist）依附于施法者——施法者阵亡/离场时一并回收，避免残留无限期绕圈
      if (b.orbit && (b.orbit.persist || b.orbit.keep) && (!owner || !owner.alive)) {
        b.dead = true;
        if (b.landingHit && !b._landSettled) { b._landSettled = true; this._settleLanding(b, owner); }
        this.bullets.delete(id);
        this.bulletCount[b.ownerId] = Math.max(0, (this.bulletCount[b.ownerId] || 1) - 1);
        continue;
      }
      let enemies = enemyCache[b.ownerId];
      if (!enemies) enemies = enemyCache[b.ownerId] = this._enemiesOf(owner);
      b.update(dt, arena, enemies, owner);
      // 需求⑥：落点锁定跟随的「屏内」复校——锁定目标移动后，落点可能被目标带出镜头可见区，
      //   这里按 landingClamp:'view' 再收敛一次（子弹内部只保证不出战场，此处保证不出屏幕）
      //   第 6 条（本轮）：收敛作用在「簇中心」上（内缩 centerInset，已含簇半径 + 结算半径 + 离墙留白），
      //   再按固定偏移写回逐发落点——逐发不再各自被镜头拉回，簇内几何与预告圈保持同源。
      if (b.landing && !b.landingHit && b.landing.clamp === 'view') {
        const L = b.landing;
        const c0 = L.center || (L.center = { x: L.x - (L.offX || 0), y: L.y - (L.offY || 0) });
        const ins = (L.centerInset != null) ? L.centerInset : (L.r + Math.max(0, L.wallInset || 0));
        const c = this._clampLanding(c0.x, c0.y, ins, 'view', 0);
        c0.x = c.x; c0.y = c.y;
        L.x = c0.x + (L.offX || 0);
        L.y = c0.y + (L.offY || 0);
      }
      if (b.splitReq) {
        b.splitReq = false;
        const kids = this._spawnSplit(b, owner);
        for (const k of kids) extra.push(k);
      }
      if (b.dead) {
        // 需求11：区域落点——子弹落入圆形结算区即结束，此处对该区域内的敌方结算伤害
        if (b.landingHit && !b._landSettled) { b._landSettled = true; this._settleLanding(b, owner); }
        this.bullets.delete(id);
        this.bulletCount[b.ownerId] = Math.max(0, (this.bulletCount[b.ownerId] || 1) - 1);
      }
    }
    // 需求④：环绕飞刃的子弹拦截判定（默认开启，可用 orbit.block:false 关闭）
    this._updateOrbitBlocks(dt);
    // 分裂子子弹下一帧起参与模拟/碰撞（避免同帧二次更新）
    for (const b of extra) {
      this.bullets.set(b.id, b);
      this.bulletCount[b.ownerId] = (this.bulletCount[b.ownerId] || 0) + 1;
    }
    this._updateCastQueue();
    this._updateCharges();
  }

  // 需求④：环绕飞刃的「抵挡其他子弹」判定（默认开启）
  //   规则：环绕弹（orbit.block，缺省 true）碰到敌方普通子弹即把对方抵消（对方直接消亡、不结算伤害），
  //         自身消耗一次格挡次数（orbit.blocks，缺省 1）；orbit.refill=true 时冷却 rehit 秒后回复次数，
  //         因此默认表现为"每隔 rehit 秒可弹开一发"，可用 block:false 完全关闭。
  //         orbit.consume=true 时（缺省 false = 飞刃不消耗）拦截成功的那发飞刃一并消亡。
  //   不拦截：环绕弹之间、以及天降/投掷类落点弹（noBodyHit，它们的伤害走结算圈）。
  //   敌我区分：只挡 ownerId 不同且非同一阵营（isBoss 标记不同）的来袭弹，自己与队友的子弹一律穿过。
  //   两端一致：拦截判定只在房主端权威计算（房主端摘除来袭弹后 broadcast 'orbit_block'），
  //     远端不自行判定、只镜像执行（摘掉同一 id 的子弹 + 对齐格挡计数表现），避免双端各算一次。
  _updateOrbitBlocks(dt) {
    if (!this.bullets || this.bullets.size === 0) return;
    // 权威端限定：只有房主（含单机/本地权威桩）结算拦截；远端等 broadcast 镜像
    if (!(this.net && this.net.isHost)) return;
    const arr = [];
    for (const [, b] of this.bullets) arr.push(b);
    let any = false;
    for (const b of arr) { if (b.orbit && b.orbit.block && !b.dead) { any = true; break; } }
    if (!any) return;
    for (const b of arr) {
      // 第 3 条修复配套："能否挡子弹"除 block 开关外，blocks 次数也参与——
      //   blocks<=0 视同完全不挡（旧写法在 blocks:0 + refill:true 时会先回复到 0 再自减成 -1，
      //   变成"配了 0 次却仍能挡一下"，与配置意图相反）。
      if (!b.orbit || !b.orbit.block || !(b.orbit.blocks > 0) || b.dead) continue;
      if (b.orbitBlockCd > 0) b.orbitBlockCd = Math.max(0, b.orbitBlockCd - dt);
      for (const t of arr) {
        if (t === b || t.dead || t.orbit || t.noBodyHit) continue;
        if (t.ownerId === b.ownerId) continue;               // 只挡敌方子弹
        const ob = this.players.get(b.ownerId), ot = this.players.get(t.ownerId);
        if (!ob || !ot || !!ob.isBoss === !!ot.isBoss) continue;
        const rr = (b.radius || 0) + (t.radius || 0) + 2;
        const dx = t.x - b.x, dy = t.y - b.y;
        if (dx * dx + dy * dy > rr * rr) continue;
        if (b.orbitBlocksLeft <= 0) {
          if (!b.orbit.refill || b.orbitBlockCd > 0) continue;   // 次数用尽且不可回复/冷却中：漏过
          b.orbitBlocksLeft = b.orbit.blocks;                    // 冷却结束：回复格挡次数
        }
        b.orbitBlocksLeft--;
        b.orbitBlockCd = b.orbit.rehit;
        b.orbitHits = (b.orbitHits || 0) + 1;
        const hx = (t.x + b.x) / 2, hy = (t.y + b.y) / 2;
        const hcolor = t.cfg.color || '#ffffff';
        const consume = (b.orbit.consume === true);
        t.dead = true;                                            // 抵消来袭弹：直接消亡，不结算伤害
        this.bullets.delete(t.id);                                // 本帧即从表里摘掉，避免其再参与命中判定
        this.bulletCount[t.ownerId] = Math.max(0, (this.bulletCount[t.ownerId] || 1) - 1);
        if (consume) {                                            // 配置为"消耗飞刃"：该发飞刃一并消亡
          b.dead = true;
          this.bullets.delete(b.id);
          this.bulletCount[b.ownerId] = Math.max(0, (this.bulletCount[b.ownerId] || 1) - 1);
        }
        this.pushFx('hit', hx, hy, hcolor);
        // 权威结果广播：远端只按这份结果镜像（摘弹 + 对齐格挡计数 + 同一位置播抵消火花）
        this.broadcast({
          t: 'orbit_block', bladeId: b.id, bulletId: t.id,
          left: b.orbitBlocksLeft, cd: b.orbitBlockCd, consume,
          x: hx, y: hy, color: hcolor,
        });
      }
    }
  }

  // 需求④：远端镜像房主广播的拦截结果（纯表现执行，不重复判定、不结算伤害）
  applyOrbitBlock(msg) {
    if (!msg || !this.bullets) return;
    if (msg.bulletId != null) {
      const t = this.bullets.get(msg.bulletId);
      if (t && !t.dead) {
        t.dead = true;
        this.bullets.delete(msg.bulletId);
        this.bulletCount[t.ownerId] = Math.max(0, (this.bulletCount[t.ownerId] || 1) - 1);
      }
    }
    if (msg.bladeId != null) {
      const b = this.bullets.get(msg.bladeId);
      if (b) {
        if (typeof msg.left === 'number') b.orbitBlocksLeft = msg.left;
        if (typeof msg.cd === 'number') b.orbitBlockCd = msg.cd;
        if (msg.consume === true) {
          b.dead = true;
          this.bullets.delete(msg.bladeId);
          this.bulletCount[b.ownerId] = Math.max(0, (this.bulletCount[b.ownerId] || 1) - 1);
        } else {
          b.orbitHits = (b.orbitHits || 0) + 1;
        }
      }
    }
    this.pushFx('hit', (msg.x != null) ? msg.x : 0, (msg.y != null) ? msg.y : 0, msg.color || '#ffffff');
  }

  // 需求11：圆形结算区域的伤害结算（子弹落入结算圈后由 updateBullets 调用）
  //   与该子弹的普通命中走同一套通道：房主直接权威结算；非房主把 hit 事件上报房主，由房主结算
  //   伤害掷骰沿用子弹自身的确定性 _rollDamage（各端一致），命中特效本端即播
  _settleLanding(b, owner) {
    if (!b || !b.landing || !owner) return;
    const L = b.landing;
    const isHost = !!(this.net && this.net.isHost);
    // 需求⑤/⑥：落点引爆——先用"结算圈指示"特效画出与实际结算半径等大的圆环并停留一段时间，
    //   再叠加爆炸特效，避免"一闪就没"看不清结算范围
    this.pushFx('settle', L.x, L.y, (b.color || (b.cfg && b.cfg.color) || '#ff8c42'), { r: L.r });
    this.pushFx('explode', L.x, L.y, (b.color || (b.cfg && b.cfg.color) || '#ff8c42'),
      { r: L.r, image: (b.cfg && b.cfg.fxImage) || null });
    this.pushFx('shake', 0, 0, '', { dur: 0.18 });
    for (const [, t] of this.players) {
      if (!t || !t.alive) continue;
      if (t.id === b.ownerId) continue;
      if (!!t.isBoss === !!owner.isBoss) continue;
      const rr = L.r + (t.radius || 0);
      const dx = t.x - L.x, dy = t.y - L.y;
      if (dx * dx + dy * dy > rr * rr) continue;
      const roll = (typeof b._rollDamage === 'function') ? b._rollDamage(t.id)
        : { dmg: b.damage, crit: false };
      // 本轮补线：圆形结算区的命中同样带上 skillId 与 tear（撕裂 DoT），
      //   否则「落点结算型」技能（如 barrage + landingArea 的崩裂天罚）的撕裂不会挂到目标身上。
      const hit = { from: b.ownerId, targetId: t.id, dmg: roll.dmg, crit: roll.crit,
                    explode: false, x: L.x, y: L.y, r: L.r,
                    skillId: b.skillId, tear: b.tear || null };
      if (isHost) this.handleHit(null, hit);
      else if (this.net && this.net.sendTo) this.net.sendTo(this.hostId(), Object.assign({ t: 'hit' }, hit));
    }
  }

  // 碰撞检测：本端可见的所有子弹 vs 所有玩家
  // 命中结果上报房主（hit 事件），房主做权威结算
  // 阵营判定：Boss 的子弹打玩家，玩家子弹打 Boss（按 owner 阵营，配置无关）
  checkCollisions() {
    const isHost = this.net.isHost;
    for (const [, b] of this.bullets) {
      const owner = this.players.get(b.ownerId);
      if (!owner) continue;
      // 天降/投掷类落点弹（noBodyHit）：不做身体命中，伤害只由落点结算圈统一给出，
      //   避免"半空蹭到人"和"结算圈再打一次"造成重复扣血
      if (b.noBodyHit) continue;
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
        // 本轮新增：命中载荷带上 skillId 与 tear（撕裂 DoT 配置）——
        //   本机链路：直接进 handleHit 由房主结算；远端链路：随 hit 信令上报房主，房主端同一入口结算。
        const payload = { from: b.ownerId, targetId: t.id, dmg: r.damage, crit: r.crit,
                          explode: r.explode, x: t.x, y: t.y, r: r.explodeRadius,
                          skillId: b.skillId, tear: b.tear || null };
        if (isHost) {
          this.handleHit(null, payload);
        } else {
          this.net.sendTo(this.hostId(), Object.assign({ t: 'hit' }, payload));
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
    // 本轮新增（撕裂 DoT）：命中应用的唯一权威入口——
    //   本机链路（checkCollisions 直调 handleHit）与远端链路（app_main case 'hit' 上报房主）都汇到这里，
    //   配置优先取命中载荷携带的 tear（非房主端由子弹 skill.tear 带出），缺省回落技能配置 SKILLS[skillId].tear。
    const tearCfg = (hit.tear && typeof hit.tear === 'object')
      ? hit.tear
      : ((hit.skillId && SKILLS[hit.skillId] && SKILLS[hit.skillId].tear) ? SKILLS[hit.skillId].tear : null);
    if (hit.explode) {
      // 爆炸：对范围内所有敌方（或所有非友方）结算
      for (const [, p] of this.players) {
        if (p.id === hit.from) continue;
        if (!p.alive) continue;
        const d = Math.hypot(p.x - hit.x, p.y - hit.y);
        if (d <= hit.r + p.radius) {
          this.applyDamage(hit.from, p, hit.dmg, kind, hit.crit);
          if (tearCfg) this._applyTear(p, tearCfg, hit.skillId);
        }
      }
    } else {
      this.applyDamage(hit.from, target, hit.dmg, kind, hit.crit);
      if (tearCfg) this._applyTear(target, tearCfg, hit.skillId);
    }
  }

  // 本轮新增（撕裂 DoT）：命中应用——零侵入，不改既有伤害链路，只在结算后附加一个可叠层/刷新的持续掉血状态。
  //   状态挂在目标 p.dots（BuffSystem 管理）；扣血由房主 _tickTears 统一结算，
  //   非房主端只接收 dot_add 广播 / 快照做表现镜像（红环 + 状态条 chip），不自行扣血。
  _applyTear(target, tearCfg, skillId) {
    if (!target || !target.alive || !tearCfg || typeof BuffSystem === 'undefined') return null;
    const nowS = performance.now() / 1000;
    const r = BuffSystem.addDot(target, Object.assign({}, tearCfg, { skillId: skillId || tearCfg.skillId || null }), nowS);
    if (!r) return null;
    const color = r.color || '#c04bff';
    const cur = (target.dots || []).find(d => d.defId === r.defId);
    const tLeft = cur ? Math.max(0, cur.end - nowS) : 0;
    // 表现：命中点血花（各端由 fx 广播消费，观感一致）
    this.pushFx('buff', target.x, target.y, color, { buffId: 'tear' });
    // 权威广播：层数 + 剩余时长 + 技能来源（远端仅做镜像，不参与结算）
    this.broadcast({ t: 'dot_add', id: target.id, stacks: r.stacks, skillId: r.skillId || null,
                     tLeft, color });
    return r;
  }

  // 本轮新增（撕裂 DoT）：房主 tick 权威扣血。
  //   按 dps × 层数 × 已过 tick 时长累计（帧率无关），伤害统一走 applyDamage——
  //   护盾吸收 / 减伤 / 无敌 / 飘字 / damage 广播 / 死亡判定与击杀结算全部复用既有链路。
  //   from 传 null：撕裂视为环境伤害，不重复计入命中数/连击（避免与命中结算重复计数），
  //   击杀判定仍由 applyDamage 统一处理，各端扣血以房主广播为准。
  _tickTears(dt) {
    if (typeof BuffSystem === 'undefined') return;
    const nowS = performance.now() / 1000;
    for (const [, p] of this.players) {
      if (!p || !p.alive || !p.dots || !p.dots.length) continue;
      const r = BuffSystem.tickDots(p, dt, nowS);
      if (!r || !(r.dmg > 0)) continue;
      const kind = (r.skillId && typeof Combat !== 'undefined' && Combat.damageKindOf)
        ? Combat.damageKindOf(r.skillId) : 'phys';
      this.applyDamage(null, p, r.dmg, kind, false);
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
      // 本轮新增（撕裂 DoT）：死亡清空撕裂状态（含 Boss 死亡后不再被 DoT 结算）
      if (typeof BuffSystem !== 'undefined') BuffSystem.clearDots(target);
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
        // 本轮新增（撕裂 DoT）：复活清空撕裂状态（死亡时已清，此处兜底，保证重生不带旧 DoT）
        if (typeof BuffSystem !== 'undefined') BuffSystem.clearDots(p);
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
    // 需求1~4：释放方式状态推进（各端统一执行）——读条结束由 CastSystem 回调 finishCast 出膛，
    // 禁咒打点 / 吟唱描摹的判定也在这一步收尾；蓄力进度由本端持有，远端靠 charge_bar 消息刷新
    if (typeof CastSystem !== 'undefined' && CastSystem.update) CastSystem.update(dt, this);
    this._updateRemoteCharges();
    // 需求1：本机蓄力进度广播（约 10Hz）——远端据此显示 Boss / 队友的蓄力读条，不参与结算
    if (!this.gameOver) this.chargeBarTick(0.1);
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
    // 本轮新增（撕裂 DoT）：房主权威周期扣血——先于条件型模块巡检执行，
    //   使「血量分档」类条件模块能在同一 tick 内读到 DoT 扣血后的血量（各端经 state 广播对齐）。
    this._tickTears(dt);
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
        }),
        // 本轮新增（撕裂 DoT）：撕裂状态随快照对齐——中途加入 / 断线重连者据此重建红环与状态条 chip；
        //   同样只传剩余秒 tLeft（房主端 end 为绝对时钟，跨端不可直接用），扣血仍由房主权威结算。
        dots: (p.dots || []).map(d => {
          const o = { ...d };
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
