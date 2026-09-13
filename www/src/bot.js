// ===== 本地 AI（假装 Boss / 假装玩家）=====
// 生效场景：
//   1. world.solo：离线单人挑战（不走信令/WebRTC）
//   2. world.roomBots：联机房间 AI 补位（仅房主本地挂 bot，作为 AI Boss/AI 队友/AI 勇者，
//      与真人成员同场；host 驱动 bot 并把位置/事件经既有信令中继同步给全员）
// 职责：
//   1. 多档难度（档位数与各档参数全部读 config/ai.json，可增删档；默认档位读 challenge.json.aiLevel）：
//      瞄准噪声 / 预判 / 攻速脉冲 / 躲避阈值 / 走位激进程度
//   2. 假装 Boss：中距环走 + 弹幕/爆炸/光束/大招压制
//   3. 假装玩家（AI 勇者，可做队友也可做敌队）：向 Boss 拉近输出、绕侧走位、
//      感知威胁子弹、横向闪避、锁定目标预判释放技能
//   4. AI 显示名（Boss 后缀 / AI 勇者 / AI 队友 前缀与界面称谓）读 config/units.json 的 _aiNames，不写死名称原文
// 不直接触碰信令握手代码；联机房间内只作为 host 的“本地假人”走既有 fireSkill/pos/state 通道

// 内置兜底难度表：config/ai.json（全局 BOT_LEVELS）缺失 / 为空 / 档位越界时使用，保持原有 5 档手感
const _AI_FALLBACK_LEVELS = [
  { noise: 0.5,   lead: 0,    speedMul: 0.6,  pulse: 0.75, smart: 0.15, dodge: 100,   orbit: 0.35, name: '很拉' },
  { noise: 0.34,  lead: 0.15, speedMul: 0.8,  pulse: 0.55, smart: 0.3,  dodge: 5.0,   orbit: 0.55, name: '简单' },
  { noise: 0.2,   lead: 0.45, speedMul: 1.0,  pulse: 0.38, smart: 0.45, dodge: 2.6,   orbit: 0.75, name: '普通' },
  { noise: 0.1,   lead: 0.75, speedMul: 1.15, pulse: 0.26, smart: 0.6,  dodge: 1.6,   orbit: 1.0,  name: '困难' },
  { noise: 0.035, lead: 1.0,  speedMul: 1.3,  pulse: 0.16, smart: 0.8,  dodge: 0.9,   orbit: 1.3,  name: '高手' },
];

const BotAI = {
  // ---- 难度参数表：读 config/ai.json（config_loader.js 已挂为全局 BOT_LEVELS）----
  // 兼容两种写法：{ defaultLevel, levels: [...] }（可带默认档位）或纯数组 [...]（当前配置形态）
  // 档位数量 = 表长度：数组增删一档，AI 表现与界面下拉档位都自动跟随，无需改代码
  // noise    瞄准角噪声(rad)，越大越歪
  // lead     预判比例：0=直瞄现位，1=按子弹飞行时间全预判
  // speedMul 移动速度倍率（低难度"站桩挨打"，高难度风骚走位）
  // pulse    每次攻击后的节奏停顿(s)，越小出手越密
  // smart    选技能倾向：随机释放(玩花样)的概率
  // dodge    闪避反应阈值（分数 > 该值才闪，低难度几乎不闪）
  // orbit    环绕强度
  // name     界面显示名（可选，仅用于下拉文案）
  _table() {
    const raw = (typeof BOT_LEVELS !== 'undefined' && BOT_LEVELS) ? BOT_LEVELS : null;
    const arr = Array.isArray(raw) ? raw : ((raw && Array.isArray(raw.levels)) ? raw.levels : null);
    return (arr && arr.length) ? arr : _AI_FALLBACK_LEVELS;   // 配置缺失/为空：退回内置表，行为不变
  },
  // 档位总数（界面难度下拉档位数以它为准）
  levelCount() { return this._table().length; },
  // 默认档位：ai.json 的 defaultLevel → challenge.json 的 aiLevel → 兜底 2；越界自动夹到有效范围
  defaultLevel() {
    const raw = (typeof BOT_LEVELS !== 'undefined' && BOT_LEVELS) ? BOT_LEVELS : null;
    const cfg = (typeof CHALLENGE !== 'undefined' && CHALLENGE) ? CHALLENGE : null;
    const want = (raw && !Array.isArray(raw) && raw.defaultLevel) || (cfg && cfg.aiLevel) || 2;
    return Math.max(1, Math.min(this.levelCount(), parseInt(want, 10) || 2));
  },
  // 取第 lv 档参数（未传/非法值用默认档位，越界夹到 1 ~ 档位数）
  _P(lv) {
    const t = this._table();
    const i = Math.max(1, Math.min(t.length, parseInt(lv, 10) || this.defaultLevel()));
    return t[i - 1];
  },

  // ---- AI 显示名：前缀/后缀模板与界面称谓全部读 config/units.json 的 _aiNames，不再写死名称原文 ----
  // 缺字段 / 配置未加载时退回下面内置文案，界面与原来完全一致，不报错
  _NAME_FALLBACK: {
    bossSuffix: '(Bot)',          // AI Boss 名后缀：名称 = 该 Boss 单位的 name + 后缀
    fighterPrefix: 'AI',          // 单人「你当 Boss」的 AI 勇者名前缀：前缀 + 勇者单位 name + 序号
    roomFighterPrefix: 'AI勇者',  // 联机房间房主当 Boss 时的 AI 勇者名前缀：前缀 + 序号
    allyPrefix: '队友',            // AI 队友名前缀：前缀 + 序号
    fighterLabel: 'AI 勇者',       // 界面称谓（AI 数量下拉文案 / 标题）
    allyLabel: 'AI 队友'
  },
  nameCfg(key) {
    const us = (typeof UNITS !== 'undefined' && UNITS && typeof UNITS === 'object') ? UNITS : null;
    const meta = (us && us._aiNames && typeof us._aiNames === 'object' && !Array.isArray(us._aiNames)) ? us._aiNames : null;
    const v = (meta && typeof meta[key] === 'string') ? meta[key].trim() : '';
    return v || this._NAME_FALLBACK[key] || '';
  },
  // 拼 AI 名称：kind = 'boss'（单位名+后缀）/ 'soloFighter' / 'roomFighter' / 'ally'（前缀+序号）
  // unitId 为该 AI 使用的单位模板 id（Boss / 勇者），名称取其 units.json 声明的 name
  botName(kind, idx, unitId) {
    const i = Math.max(1, parseInt(idx, 10) || 1);
    const un = (typeof Profiles !== 'undefined' && Profiles.unitDisplayName) ? Profiles.unitDisplayName(unitId) : '';
    if (kind === 'boss') return un + this.nameCfg('bossSuffix');
    if (kind === 'roomFighter') return this.nameCfg('roomFighterPrefix') + i;
    if (kind === 'soloFighter') return this.nameCfg('fighterPrefix') + un + i;
    return this.nameCfg('allyPrefix') + i;
  },

  // 每帧驱动世界内所有本地 bot
  // 生效范围：world.solo（离线挑战）或 world.roomBots（联机房间 AI 补位，仅 host 挂 bot）；
  // 纯真人联机房（无 bot）不触发；远端成员不挂 bot，故不会重复驱动
  update(world, dt) {
    if (!world || (!world.solo && !world.roomBots)) return;
    if (!(world.bots && world.bots.length)) return;
    if (dt <= 0) return;

    // 每帧记录所有玩家瞬时速度（供 AI 预判射击）
    for (const [, p] of world.players) {
      if (p._px == null) { p._px = p.x; p._py = p.y; p._vx = 0; p._vy = 0; continue; }
      p._vx = (p.x - p._px) / dt;
      p._vy = (p.y - p._py) / dt;
      p._px = p.x; p._py = p.y;
    }

    for (const bot of world.bots || []) {
      if (!bot || !bot.alive) continue;
      bot.update(dt);
      bot._aiThinkT = (bot._aiThinkT || 0) - dt;
      bot._aiAtkT = (bot._aiAtkT || 0) - dt;
      bot._dodgeCd = Math.max(0, (bot._dodgeCd || 0) - dt);   // 需求5：闪避冷却计时，避免被持续弹幕锁死在纯躲
      if (bot._aiThinkT <= 0) {
        bot._aiThinkT = 0.06 + Math.random() * 0.08;
        this._think(bot, world);
      }
      // 应用移动
      const mv = bot._mv || { x: 0, y: 0 };
      const vl = Math.hypot(mv.x, mv.y);
      if (vl > 0.01) {
        const P = this._P(bot.aiLevel);
        const base = (bot.botKind === 'boss' ? 0.9 : 1) * P.speedMul;
        const spd = ((bot.statsTotal && bot.statsTotal.speed) || 150) * base;
        const A = GAME_CONFIG.ARENA;
        bot.x = Math.min(A.w - bot.radius, Math.max(bot.radius, bot.x + mv.x / vl * spd * dt));
        bot.y = Math.min(A.h - bot.radius, Math.max(bot.radius, bot.y + mv.y / vl * spd * dt));
      }
      // 面向目标
      const tgt = this._target(bot, world);
      if (tgt) {
        const dx = tgt.x - bot.x, dy = tgt.y - bot.y;
        const dl = Math.hypot(dx, dy) || 1;
        bot.dir = { x: dx / dl, y: dy / dl };
      }
    }
  },

  // 最近存活敌人
  _target(bot, world) {
    let best = null, bestD = Infinity;
    for (const [, p] of world.players) {
      if (p.id === bot.id || !p.alive) continue;
      if (p.isBoss === bot.isBoss) continue;
      const d = (p.x - bot.x) ** 2 + (p.y - bot.y) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  },

  // 威胁子弹扫描：返回 { vx, vy, t, dist }（最快靠近的一颗敌方子弹）或 null
  _threat(bot, world) {
    let best = null, bestScore = 0;
    for (const [, b] of world.bullets) {
      const owner = world.players.get(b.ownerId);
      if (!owner) continue;
      if (owner.id === bot.id || owner.isBoss === bot.isBoss) continue;
      const dx = b.x - bot.x, dy = b.y - bot.y;
      const vx = b.vx || 0, vy = b.vy || 0;
      const sp2 = vx * vx + vy * vy;
      if (sp2 < 1) continue;
      const t = Math.max(0, -(dx * vx + dy * vy) / sp2);
      if (t > 0.9) continue;                    // 太久才到，暂不管
      const cx = dx + vx * t, cy = dy + vy * t;
      const dist = Math.hypot(cx, cy);
      const rr = b.radius + bot.radius + 12;
      if (dist > rr * 1.7) continue;            // 不会擦到
      const score = rr / (dist + 2) * (1 / (t + 0.08));
      if (score > bestScore) { bestScore = score; best = { vx, vy, dx, dy, dist }; }
    }
    return best ? { ...best, score: bestScore } : null;
  },

  // 单次决策：闪避 / 走位 / 出手
  _think(bot, world) {
    const P = this._P(bot.aiLevel);
    const target = this._target(bot, world);
    if (!target) return;

    // 1) 闪避优先级最高（高难度会主动横向躲弹幕）
    // 需求5修复：闪避带冷却（_dodgeCd）——之前无冷却时，持续弹幕（尤其玩家贴脸射击）会让
    // AI 每个决策帧都命中闪避分支并 return，永远走不到走位/出手，表现为“Boss 只挨打不还手”。
    const threat = this._threat(bot, world);
    if (threat && threat.score > P.dodge && !(bot._dodgeCd > 0)) {
      // 垂直子弹方向的横向闪避，选远离弹道的一侧
      const vx = threat.vx, vy = threat.vy;
      const p1 = { x: -vy, y: vx };
      const p2 = { x: vy, y: -vx };
      // 取把 bot 推离弹道线的方向
      const s1 = p1.x * threat.dx + p1.y * threat.dy;
      const s2 = p2.x * threat.dx + p2.y * threat.dy;
      const d = (s1 > s2 ? p1 : p2);
      const dl = Math.hypot(d.x, d.y) || 1;
      bot._mv = { x: d.x / dl, y: d.y / dl };
      // 闪避后的短冷却：让 AI 在密集弹幕里也能抽出输出窗口，而不是无限横跳
      bot._dodgeCd = 0.45 + Math.random() * 0.4;
      // 闪避不吞输出：若当前不在攻击节奏内，边撤边还击
      if (bot._aiAtkT <= 0) this._attack(bot, world, target, P);
      return;   // 躲的时候不主动拉近距离，但仍可能在下一次 think 出手
    }

    // 1.5) 非 Boss AI：就近 buff 掉落物倾向拾取（P2 增益利用率；Boss bot 保持压制作战不过去蹭）
    if (bot.botKind !== 'boss') {
      let bd = null, bdD = 300;
      for (const d of world.buffDrops || []) {
        const dd = Math.hypot(d.x - bot.x, d.y - bot.y);
        if (dd < bdD) { bd = d; bdD = dd; }
      }
      if (bd) {
        bot._mv = { x: (bd.x - bot.x) / (bdD || 1), y: (bd.y - bot.y) / (bdD || 1) };
        this._attack(bot, world, target, P);   // 边走边输出
        return;
      }
    }

    // 2) 走位
    const dx = target.x - bot.x, dy = target.y - bot.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist, ny = dy / dist;
    let rvx = 0, rvy = 0;

    // 环走方向（周期反转）
    bot._flipT = (bot._flipT || 0) - 1;
    if (bot._flipT <= 0) {
      bot._flipT = 30 + Math.random() * 70;
      bot._sign = (Math.random() < 0.5 ? 1 : -1) * (Math.random() < 0.7 ? 1 : -1);
    }
    const tg = (bot._sign || 1) * P.orbit;

    if (bot.botKind === 'boss') {
      // 假装 Boss：保持压制距离 + 环走 + 必要时小幅进退
      const desired = 340;
      const bias = (dist - desired) / desired;
      if (Math.abs(bias) > 0.16) rvx += nx * Math.sign(bias) * 0.75, rvy += ny * Math.sign(bias) * 0.75;
      rvx += -ny * tg; rvy += nx * tg;
    } else {
      // 假装玩家（勇者 AI）：向 Boss 拉近到射程带，环形绕侧输出
      const desired = 330 - (bot.aiLevel - 1) * 22;
      if (dist > desired + 80) { rvx = nx; rvy = ny; }             // 太远 → 靠近
      else if (dist < desired - 90) { rvx = -nx; rvy = -ny; }      // 太近 → 拉开
      else { rvx = -ny; rvy = nx; }                                // 射程内 → 绕侧
      // 低难度乱晃、高难度绕侧更坚决
      if (bot.aiLevel <= 2 && Math.random() < 0.3) { rvx += (Math.random() - 0.5); rvy += (Math.random() - 0.5); }
      rvx += -ny * tg * 0.35; rvy += nx * tg * 0.35;
    }
    const rl = Math.hypot(rvx, rvy) || 1;
    bot._mv = { x: rvx / rl, y: rvy / rl };

    // 3) 出手（节奏脉冲）
    this._attack(bot, world, target, P);
  },

  // 出手：从出战技能里挑一个（Boss 按大招优先，AI 玩家按顺序+随机花样）
  _attack(bot, world, target, P) {
    if (bot._aiAtkT > 0) return;
    const ready = (bot.loadout || []).filter(sid =>
      bot.inLoadout(sid) && SKILLS[sid] && Combat.canUseSkill(bot, sid));
    if (!ready.length) { bot._aiAtkT = 0.12 + Math.random() * 0.12; return; }

    let picked = null;
    if (bot.botKind === 'boss') {
      // Boss 出手混合（P2）：阶段/时间解锁的尾段大招为主(62%)，基础技能池随机为辅，
      // 保证 4 个基础技能（spray/fire/laser_fan/meteor）也会被主动使用而非被大招完全覆盖。
      // 单位自带技能数 = UNITS[classId].skills.length（skillPool 中位于触发解锁技能之前）。
      const unitCfg = UNITS[bot.classId || bot.roleId] || {};
      const baseN = (unitCfg.skills || []).length || 0;
      const hasPhased = ready.length > baseN;
      if (hasPhased && Math.random() < 0.62) {
        // 阶段/时间解锁的特色技能池随机（血线触发与新技能全部进入，避免只放最后解锁的一个）
        const phased = ready.slice(baseN);
        picked = phased[Math.floor(Math.random() * phased.length)] || ready[ready.length - 1];
      } else {
        const basePool = ready.slice(0, Math.max(1, baseN));
        picked = basePool[Math.floor(Math.random() * basePool.length)] || ready[ready.length - 1];
      }
    } else {
      picked = (Math.random() < P.smart && ready.length > 1)
        ? ready[Math.floor(Math.random() * ready.length)]
        : ready[0];
    }
    if (!picked) { bot._aiAtkT = 0.15; return; }

    // 锁定目标：预判（难度越高越准）+ 噪声
    const skill = SKILLS[picked];
    const isRing = skill && skill.ring;
    const bCfg = skill && skill.bullet ? (BULLETS[skill.bullet] || {}) : {};
    const bSpd = (bCfg.speed || 400) * (skill.speedMul || 1);
    const dist = Math.hypot(target.x - bot.x, target.y - bot.y) || 1;
    const flight = Math.max(0.05, dist / bSpd);
    const tvx = target._vx || 0, tvy = target._vy || 0;
    const px = target.x + tvx * flight * P.lead;
    const py = target.y + tvy * flight * P.lead;
    let dx = px - bot.x, dy = py - bot.y;
    let a = Math.atan2(dy, dx);
    a += (Math.random() + Math.random() - 1) * P.noise;   // 噪声（1 档乱甩、5 档神瞄）
    if (isRing) a = Math.random() * Math.PI * 2;          // 环形弹不用瞄准
    const aim = { x: Math.cos(a), y: Math.sin(a) };
    world.fireSkill(bot, picked, aim);
    // P2：攻速 buff（atkSpeedMul）真实加快 AI 出手节奏（脉冲间隔按攻速缩短）
    const asMul = 1 + ((bot.statsTotal && bot.statsTotal.atkSpeedMul) || 0);
    bot._aiAtkT = P.pulse * (0.7 + Math.random() * 0.6) / asMul;
  },
};
