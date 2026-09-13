// ===== 子弹实体 =====
// 由技能发射事件在各端本地生成，统一规则模拟，保证各端视觉一致。
// 消亡条件枚举：life 到期 / pierce 穿透耗尽 / onHit 命中 / onWall 撞墙。
// 高速防穿透：每帧记录上一帧位置，碰撞按「上帧->本帧」扫掠线段判定。
//
// 运动轨迹（config/bullets.json -> 条目.motion，全部纯数值可配，缺省 = 直线）：
//   accel     沿速度方向的加速度（像素/秒²），>0 加速弹，<0 减速弹
//   drag      速度衰减系数（每秒乘 (1-drag)），>0 减速弹
//   turn      方向旋转角速度（弧度/秒）
//   homing    追踪转向速率（弧度/秒）：每帧朝最近敌方单位转向（需 world 传入敌方列表）
//   spiral    螺旋：数值 = 自转角速度（弧度/秒，方向旋转 + 径向增速）；
//             对象 = { radius 环绕半径(px), turn 自转角速度(rad/s), grow 半径增长率(px/s, 可选) }
//             对象形式为「绕基准线做圆周环绕」的螺旋（半径由 radius 决定，自转由 turn 决定）
//   sine      { amp, freq } 正弦蛇形：沿初始方向的基准线 + 垂直正弦偏移（像素 / 次每秒）
//   boomerang 0~1 回旋：飞行进度（life 已消耗比例）达到该值后速度反向（去而复返）
//   bounce    撞墙反弹次数（整数，优先于 onWall=destroy；次数耗尽后消亡）
//   jitter    抖动强度（弧度/秒，确定性噪声，各端表现一致，不做随机）
//   split     { count, spread, at, speedMul, maxDepth, onHit } 分裂：进度达 at 或（onHit=true 时）命中目标，
//             二者先到先触发，仅触发一次；子子弹由 world 统一生成（id/位置各端一致）
// 分裂由 world 统一生成（子弹只置 splitReq 标记），保证各端子弹 id/位置一致。

class Bullet {
  constructor(id, ownerId, skillId, bulletId, x, y, dir, speedMul, opts) {
    opts = opts || {};
    this.id = id;
    this.ownerId = ownerId;
    this.skillId = skillId;
    this.bulletId = bulletId;                  // 弹型 id（分裂子子弹继承）
    this.cfg = BULLETS[bulletId] || BULLETS.arrow;
    this.x = x; this.y = y;
    this.prevX = x; this.prevY = y;
    this.dir = dir;
    const len = Math.hypot(dir.x, dir.y) || 1;
    const ux = dir.x / len, uy = dir.y / len;
    this.speedMul = speedMul || 1;
    this.vx = ux * this.cfg.speed * this.speedMul;
    this.vy = uy * this.cfg.speed * this.speedMul;
    this.radius = (opts.radius != null && opts.radius > 0) ? opts.radius : this.cfg.radius;
    // 需求9：形状 / 颜色扩展——释放事件或技能配置可直接覆盖弹型默认值（更多形状、多颜色子弹）
    this.shape = opts.shape || this.cfg.shape || 'circle';
    this.color = opts.color || this.cfg.color || '#ffffff';
    this.colorB = opts.colorB || this.cfg.colorB || null;     // 第二色（内芯/高光），渲染层做双色处理
    // 本轮新增（撕裂 DoT）：技能级 tear 配置随释放事件下发（world.spawnSkillBullets → commonOpts），
    //   子弹只负责原样携带并在命中载荷中带出，不做任何结算——结算统一在房主 handleHit 权威入口完成。
    this.tear = (opts.tear && typeof opts.tear === 'object') ? opts.tear : null;
    this.dmgMul = opts.dmgMul || 1;                 // 蓄力炮等释放方式的伤害倍率
    // —— 攻击属性接线（方案 A）——
    // 伤害 = 弹型基础 damage（bullets.json）× 释放方式倍率 dmgMul × 攻击者运行时 damageMul
    // attackerStats 由 world 生成子弹时注入（owner.statsTotal：单位 base + 装备/宝石/铭文/追加/档案模块）；
    // 缺省（无攻击者属性，如环境弹）退化为旧行为（倍率 1、不暴击）
    const at = opts.attackerStats || null;
    this.attackerStats = at;
    this.castDamage = this.cfg.damage * this.dmgMul;                     // 释放方式基础伤害（未含攻击属性）
    this.damage = (typeof Combat !== 'undefined' && Combat.attackDamage)
      ? Combat.attackDamage(at, this.castDamage)
      : Math.max(1, Math.round(this.castDamage));
    this.critChance = (at && at.critChance) || 0;    // 暴击率（攻击者合成属性，装备/宝石/铭文/追加提供）
    this.critMul = (at && at.critMul) || 1.5;        // 暴击倍率
    // 需求5/6：存续时间可由释放事件覆盖（近战弹短存续、环绕弹按 orbitLife 控制时长）
    this.life = (opts.life != null && opts.life > 0) ? opts.life : this.cfg.life;
    this.life0 = this.life;
    this.pierce = this.cfg.pierce;
    this.hitIds = new Set();   // 已命中目标，防重复
    this.dead = false;
    // —— 轨迹扩展用的运行时状态 ——
    this.age = 0;
    this.castId = opts.castId != null ? opts.castId : 0;   // 同一释放事件的子弹共享 id（便于观感联动）
    this.depth = opts.depth || 0;                          // 分裂层级（限制递归分裂）
    this.ux = ux; this.uy = uy;                            // 初始方向（正弦基准线用）
    this.sx = x; this.sy = y;                              // 正弦基准点
    // 轨迹参数归一化（缺省全零 = 现有直线行为，不受影响）
    this.mo = Bullet.normMotion(this.cfg.motion, this.cfg.speed * this.speedMul, this.cfg.life);
    this.spiral = this.mo.spiral;
    this.sine = this.mo.sine;
    this.bounceLeft = this.mo.bounce;
    // 追踪转向速率（弧度/秒）：优先取 opts.homing（锁定追踪释放方式注入），否则取弹型 motion.homing
    this.homingRate = (opts.homing != null) ? opts.homing : this.mo.homing;
    // 释放方式注入的爆炸半径（区域轰炸等）：覆盖弹型自带 explodeRadius（未注入为 null，走弹型配置）
    this.blastR = (opts.blastRadius != null && opts.blastRadius > 0) ? opts.blastRadius : null;
    // —— 需求11/⑥：区域落点（子弹从屏幕上方下落，进入圆形结算区域即结束并结算，不再无限下落）——
    //   landing = { x, y, r }：由 world 写入世界坐标并随释放事件广播，各端结算区域一致；
    //   渲染层的「落点圆环」与结算伤害共用这同一份 landing，故两者圆心/半径天然完全对齐。
    //   trackId/lead（本轮新增·需求⑥）：落点锁定目标后，飞行途中每帧向目标真实位置平滑靠拢，
    //   并按 lead 秒提前量预判，实现「锁 Boss 时圆环跟随其真实位置」。
    this.landing = (opts.landing && typeof opts.landing === 'object')
      ? { x: opts.landing.x, y: opts.landing.y, r: Math.max(8, opts.landing.r || 60),
          trackId: (opts.landing.trackId != null) ? opts.landing.trackId : null,
          lead: (opts.landing.lead != null) ? opts.landing.lead : 0,
          // 需求⑥：落点夹取模式（'view' = 跟随途中也限制在镜头可见区内，避免圆环被目标带出屏幕）
          clamp: (opts.landing.clamp === 'view') ? 'view' : null,
          trackRate: (opts.landing.trackRate != null) ? opts.landing.trackRate : 16,
          // 第 6 条（本轮）：相对「落点簇中心」的固定偏移——飞行途中改由「簇中心 + 偏移」同步平移，
          //   与预告圈（渲染侧 points 使用同一份偏移）完全同源，逐发之间不会各走各的；
          //   centerInset = 簇中心夹取内缩（簇半径 + 结算半径 + 离墙留白），wallInset = 离墙留白。
          offX: (opts.landing.offX != null) ? opts.landing.offX : 0,
          offY: (opts.landing.offY != null) ? opts.landing.offY : 0,
          centerInset: (opts.landing.centerInset != null) ? opts.landing.centerInset : null,
          wallInset: (opts.landing.wallInset != null) ? opts.landing.wallInset : null,
          center: null,   // 运行时簇中心（惰性初始化 = 落点 - 偏移；各发同一初值 + 同一速率 → 严格同步）
          // 需求②（本轮）：落点圆环的线宽 / 发光开关随技能级配置下发（缺省回退 FX.landing）
          width: (opts.landing.width != null) ? opts.landing.width : null,
          glow: (opts.landing.glow != null) ? !!opts.landing.glow : null }
      : null;
    this.landingHit = false;
    // 需求⑥/⑤：天降 / 投掷类弹体飞行途中不做身体命中判定，伤害统一由落点结算圈给出
    //   （否则会出现「半空蹭到人」的额外伤害，与「落点圈 = 结算区」的承诺不符）
    this.noBodyHit = (opts.noBodyHit === true);
    // —— 需求⑤：圆域投弹的「投掷动作」——从施法者抛向落点的抛物线飞行 ——
    //   throw = { x0,y0 出手点, tx,ty 目标点, dur 飞行时长(秒), peak 抛物高度(px) }
    //   飞满 dur 后视为抵达：置 landingHit/dead，由 world 在落点结算圈内统一结算伤害
    this.throw = (opts.throw && typeof opts.throw === 'object')
      ? { x0: opts.throw.x0, y0: opts.throw.y0, tx: opts.throw.tx, ty: opts.throw.ty,
          dur: Math.max(0.12, opts.throw.dur || 0.55),
          peak: Math.max(0, (opts.throw.peak != null) ? opts.throw.peak : 90),
          t: 0, done: false } : null;
    // —— 需求6/④：环绕子弹（围绕玩家旋转；位置由角度直接求得，不参与常规弹道/撞墙积分）——
    //   radius 允许为 0（领域类子弹圆心锚定玩家，需求③）
    //   persist (缺省 true) 持续环绕不清空：不吃生命周期，直到角色死亡/复活、技能被替换或显式清除
    //                        （keep 为历史别名，等价）
    //   block (缺省 true)  可抵挡/抵消来袭子弹；blocks 可格挡次数；refill 冷却后回复次数；rehit 冷却秒
    //   consume(缺省 false) 拦截成功后是否消耗（消亡）该发飞刃
    // persist 缺省 true（未显式关闭即持续环绕）；keep 为历史别名，二者等价
    const _orbCfg = (opts.orbit && typeof opts.orbit === 'object') ? opts.orbit : null;
    const opersist = _orbCfg
      ? ((_orbCfg.persist != null) ? (_orbCfg.persist !== false) : (_orbCfg.keep !== false))
      : true;
    this.orbit = (opts.orbit && typeof opts.orbit === 'object')
      ? {
        radius: Math.max(0, (opts.orbit.radius != null) ? opts.orbit.radius : 70),
        spin: (opts.orbit.spin != null) ? opts.orbit.spin : 2.4,        // 角速度（弧度/秒，负值反向）
        phase: (opts.orbit.phase != null) ? opts.orbit.phase : 0,       // 初始相位（弧度）
        follow: (opts.orbit.follow !== false),                          // 是否跟随玩家移动
        persist: opersist,
        keep: opersist,                                                 // 历史别名（兼容旧配置/旧调用）
        block: (opts.orbit.block !== false),
        blocks: Math.max(0, (opts.orbit.blocks != null) ? opts.orbit.blocks : 1),
        refill: (opts.orbit.refill !== false),
        rehit: Math.max(0, (opts.orbit.rehit != null) ? opts.orbit.rehit : 0.6),
        consume: (opts.orbit.consume === true),
      } : null;
    this._orbA = this.orbit ? this.orbit.phase : 0;
    // 不跟随（follow:false）时的锚点 = 生成位置。此前该字段从未赋值，
    //   一旦配置 follow:false 就会取到 undefined，圆心变 NaN、子弹整帧消失——本轮补上。
    this._orbCx = x; this._orbCy = y;
    this.orbitBlocksLeft = this.orbit ? this.orbit.blocks : 0;    // 剩余格挡次数
    this.orbitBlockCd = 0;                                        // 格挡冷却计时
    this.orbitHits = 0;                                           // 累计抵消数（调试/表现用）
    this.splitReq = false;
    this._splitDone = false;
  }

  // 轨迹参数归一化：把 config/bullets.json 的 motion 收敛为运行时结构；缺省值 = 不启用任何轨迹（直线）。
  // 键名兼容《原子属性与模块化配置设计_v1》§5.4 写法（amplitude/frequency、spin、bounces、atTime/atHit、jitter.amplitude）。
  static normMotion(motion, baseSpeed, life) {
    const m = (motion && typeof motion === 'object') ? motion : {};
    const num = (v, d) => ((typeof v === 'number' && isFinite(v)) ? v : d);
    const lifeS = (life > 0) ? life : 1;
    // 追踪 homing：数值 = 转向速率（弧度/秒）；对象 = { turn | rate }
    const hm = m.homing;
    const homing = (num(hm, null) != null) ? num(hm, 0)
      : ((hm && typeof hm === 'object') ? num(hm.turn, num(hm.rate, 0)) : 0);
    // 螺旋 spiral：数值 = 自转角速度（rad/s，方向旋转 + 径向增速）；
    //              对象 = { radius 半径(px), spin | turn 自转角速度(rad/s), grow 半径增长率(px/s), speed 基准速度 }
    const sp = m.spiral;
    const spiral = (sp && typeof sp === 'object')
      ? { orbit: true, radius: Math.max(0, num(sp.radius, 24)), spin: num(sp.spin, num(sp.turn, 2.4)), grow: num(sp.grow, 0), speed: num(sp.speed, 0) }
      : { orbit: false, radius: 0, spin: num(sp, 0), grow: 0, speed: 0 };
    // 正弦 sine：{ amp | amplitude, freq | frequency }
    const si = m.sine;
    const sine = (si && typeof si === 'object')
      ? { amp: num(si.amp, num(si.amplitude, 24)), freq: num(si.freq, num(si.frequency, 2.4)) }
      : null;
    // 回旋 boomerang：数值 = 折返进度（0~1）；对象 = { at | range(px), returnSpeed 回程速度倍率 }
    const bo = m.boomerang;
    let boomerang = null;
    if (typeof bo === 'number' && isFinite(bo)) {
      boomerang = { at: Math.min(0.98, Math.max(0.05, bo)), returnSpeed: 1 };
    } else if (bo && typeof bo === 'object') {
      const travel = Math.max(1, baseSpeed * lifeS);
      const rawAt = (typeof bo.at === 'number') ? bo.at : ((typeof bo.range === 'number') ? bo.range / travel : 0.5);
      boomerang = { at: Math.min(0.98, Math.max(0.05, rawAt)), returnSpeed: num(bo.returnSpeed, 1) };
    }
    // 分裂 split：{ count, spread, at | atTime(秒), onHit | atHit, speedMul, maxDepth, childBullet }
    const sd = m.split;
    let split = null;
    if (sd && typeof sd === 'object') {
      const rawAt = (typeof sd.at === 'number') ? sd.at : ((typeof sd.atTime === 'number') ? sd.atTime / lifeS : 0.4);
      split = {
        count: Math.max(2, num(sd.count, 3)),
        spread: num(sd.spread, 1.0),
        at: Math.min(1, Math.max(0, rawAt)),
        onHit: (sd.onHit === true || sd.atHit === true),
        speedMul: num(sd.speedMul, 0.85),
        maxDepth: num(sd.maxDepth, 1),
        childBullet: (typeof sd.childBullet === 'string' && sd.childBullet) ? sd.childBullet : null,
      };
    }
    // 抖动 jitter：数值 = 振幅；对象 = { amplitude }
    const jm = m.jitter;
    const jitter = (jm && typeof jm === 'object') ? num(jm.amplitude, 0) : num(jm, 0);
    // 反弹 bounce：bounce | bounces（次数）
    const bounce = Math.max(0, Math.floor(num(m.bounce, num(m.bounces, 0))));
    return {
      accel: num(m.accel, 0), drag: num(m.drag, 0), turn: num(m.turn, 0),
      homing, spiral, sine, boomerang, split, jitter, bounce,
    };
  }

  update(dt, arena, enemies, owner) {
    // 已消亡（本帧命中判定置 dead，等 world 下一帧回收）：不再位移，仅保留坐标供分裂/渲染取点
    if (this.dead) { this.prevX = this.x; this.prevY = this.y; return; }
    this.age += dt;
    // 需求④：环绕飞刃 persist=true（缺省，keep 历史别名等价）不吃生命周期——
    //   持续绕角色旋转，直到角色死亡/复活、该技能被替换或被显式清除
    // 本轮修复（第 3 条·清空路径④）：持久环绕弹不仅不吃 life 衰减，还补一道初始值护栏——
    //   若 orbit.life 未配 / 配成 0 或负数，旧写法会立刻命中下方 this.life <= 0 而当场消亡，
    //   表现为"飞刃刚放出来就没了"。这里对持久环绕弹强制给出正的生命基数（仅作兜底，不影响非持久弹）。
    const _persistOrbit = !!(this.orbit && (this.orbit.persist || this.orbit.keep));
    if (_persistOrbit) { if (!(this.life > 0)) this.life = 1; } else { this.life -= dt; }
    if (this.life <= 0) { this.dead = true; return; }
    this.prevX = this.x; this.prevY = this.y;
    // 需求⑤：投掷飞行（抛物线：出手点 → 落点，飞满 dur 秒抵达并引爆）
    //   投掷期间不参与常规弹道 / 撞墙 / 落点判定，抵达后用 landing 走统一结算通道
    if (this.throw && !this.throw.done) {
      const th = this.throw;
      th.t += dt;
      const p = Math.max(0, Math.min(1, th.t / th.dur));
      this.x = th.x0 + (th.tx - th.x0) * p;
      this.y = th.y0 + (th.ty - th.y0) * p - th.peak * Math.sin(Math.PI * p);
      if (dt > 0) { this.vx = (this.x - this.prevX) / dt; this.vy = (this.y - this.prevY) / dt; }
      if (p >= 1) {
        th.done = true;
        this.x = th.tx; this.y = th.ty;
        if (this.landing) { this.landing.x = th.tx; this.landing.y = th.ty; }
        this.landingHit = true;                       // 抵达落点 → world._settleLanding 结算
        this.dead = true;
      }
      return;
    }
    // 弹道运动（配置驱动，见 config/bullets.json motion 字段；参数已在构造时归一化）
    const m = this.mo;
    // 需求6：环绕子弹——围绕玩家旋转（位置由角度直接求得，不走下方位移积分）
    if (this.orbit) this._updateOrbit(dt, owner);
    if (!this.orbit) {
    {
      const sp = Math.hypot(this.vx, this.vy) || 1;
      if (m.drag) {
        const f = Math.max(0, 1 - m.drag * dt);
        this.vx *= f; this.vy *= f;
      }
      if (m.accel) {
        // 变速：正值加速、负值减速，方向始终沿当前速度方向
        this.vx += (this.vx / sp) * m.accel * dt;
        this.vy += (this.vy / sp) * m.accel * dt;
      }
      if (m.turn) {
        const a = m.turn * dt;
        const c = Math.cos(a), s = Math.sin(a);
        const nx = this.vx * c - this.vy * s;
        const ny = this.vx * s + this.vy * c;
        this.vx = nx; this.vy = ny;
      }
      // 螺旋（数值形式）：连续旋转 + 径向增速（外旋弹幕）；对象形式见下方「环绕半径」分支
      if (!this.spiral.orbit && this.spiral.spin) {
        const sv = this.spiral.spin;
        const a = sv * dt;
        const c = Math.cos(a), s = Math.sin(a);
        const nx = this.vx * c - this.vy * s;
        const ny = this.vx * s + this.vy * c;
        const grow = Math.max(0, 1 + Math.abs(sv) * 0.35 * dt);
        this.vx = nx * grow; this.vy = ny * grow;
      }
      // 追踪见下方 if (m) 之外的统一处理（锁定追踪释放方式可对任意弹型生效）
      // 抖动：确定性噪声（按 id 生成种子），各端表现一致
      if (m.jitter) {
        const seed = (this.id.length * 2.7 + this.depth * 1.3) % 6.283;
        const a = Math.sin(this.age * 23.7 + seed) * m.jitter * dt;
        const c = Math.cos(a), s = Math.sin(a);
        const nx = this.vx * c - this.vy * s;
        const ny = this.vx * s + this.vy * c;
        this.vx = nx; this.vy = ny;
      }
      // 回旋：飞行进度达到折返点（boomerang.at）后速度反向，去程结束转入回程
      if (m.boomerang && !this._turned) {
        const prog = this.life0 > 0 ? 1 - this.life / this.life0 : 1;
        if (prog >= m.boomerang.at) {
          this._turned = true;
          const rs = m.boomerang.returnSpeed;      // 回程速度倍率（缺省 1 = 原速返回）
          this.vx = -this.vx * rs; this.vy = -this.vy * rs;
        }
      }
    }
    // 追踪：每帧朝最近敌方单位转向，转向速率 = homingRate（弹型 motion.homing 或释放方式注入）；
    // 放在 if (m) 之外，使「锁定追踪」释放方式对任意弹型都生效；无目标则保持直行
    if (this.homingRate && enemies && enemies.length) {
      let best = null, bestD = Infinity;
      for (const e of enemies) {
        if (!e || e.alive === false) continue;
        const d = (e.x - this.x) * (e.x - this.x) + (e.y - this.y) * (e.y - this.y);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) {
        const want = Math.atan2(best.y - this.y, best.x - this.x);
        const cur = Math.atan2(this.vy, this.vx);
        let diff = want - cur;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const maxA = this.homingRate * dt;
        const a = Math.max(-maxA, Math.min(maxA, diff));
        const c = Math.cos(a), s = Math.sin(a);
        const nx = this.vx * c - this.vy * s;
        const ny = this.vx * s + this.vy * c;
        this.vx = nx; this.vy = ny;
      }
    }
    // 正弦蛇形：基准线直行 + 垂直正弦偏移（不直接积分 vx/vy，避免与偏移叠加抖动）
    // 螺旋（对象形式）：基准线直行 + 绕基准线做「半径 radius、自转 spin」的圆周环绕
    const sn = this.sine;
    const orbitSp = (this.spiral.orbit && this.spiral.spin) ? this.spiral : null;
    if (sn || orbitSp) {
      let spd = Math.hypot(this.vx, this.vy) || 0;
      if (orbitSp && orbitSp.speed > 0) spd = orbitSp.speed * this.speedMul;   // 螺旋可配置基准速度
      this.sx += this.ux * spd * dt;
      this.sy += this.uy * spd * dt;
      if (sn) {
        const off = Math.sin(this.age * sn.freq * Math.PI * 2) * sn.amp;
        this.x = this.sx - this.uy * off;
        this.y = this.sy + this.ux * off;
      } else {
        const th = this.age * orbitSp.spin;                              // 自转角（rad/s → 累计弧度）
        const rr = Math.max(0, orbitSp.radius + orbitSp.grow * this.age); // 环绕半径（grow 可随时间增长）
        const px = -this.uy, py = this.ux;                               // 基准线法向
        const c = Math.cos(th), s = Math.sin(th);
        this.x = this.sx + (px * c - py * s) * rr;
        this.y = this.sy + (px * s + py * c) * rr;
        // 环绕弹按位置差分还原真实速度，供朝向渲染与反弹判定使用
        if (dt > 0) { this.vx = (this.x - this.prevX) / dt; this.vy = (this.y - this.prevY) / dt; }
      }
    } else {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
    }
    }   // ← 环绕子弹分支结束（其位置在 _updateOrbit 中直接求得）

    // 需求⑥ + 第 6 条（本轮）：落点锁定——飞行途中**簇中心**向目标真实位置平滑靠拢（带 lead 秒提前量），
    //   逐发落点 = 簇中心 + 固定偏移（offX/offY），因此「预告圈（同一份偏移）」与「结算圈」几何严格一致；
    //   各发共用同一初值与同一吸附速率（确定性），不会出现"圈跑得快、弹落得慢"的错位。
    //   限制：簇中心按 centerInset（簇半径 + 结算半径 + 离墙留白）夹在战场合法区域内，不贴墙/不出界。
    if (this.landing && !this.landingHit && this.landing.trackId != null && enemies && enemies.length) {
      const tg = enemies.find(e => e && e.id === this.landing.trackId && e.alive !== false);
      if (tg) {
        const L = this.landing;
        const c = L.center || (L.center = { x: L.x - (L.offX || 0), y: L.y - (L.offY || 0) });
        const px = tg.x + (tg.vx || 0) * (L.lead || 0);
        const py = tg.y + (tg.vy || 0) * (L.lead || 0);
        const k = Math.min(1, Math.max(0, (L.trackRate || 16) * dt));
        c.x += (px - c.x) * k;
        c.y += (py - c.y) * k;
        const ar = arena || GAME_CONFIG.ARENA;
        const ins = Math.max(L.r, (L.centerInset != null) ? L.centerInset : (L.r + Math.max(0, L.wallInset || 0)));
        const mx = (ar.w - ins < ins) ? ar.w / 2 : ins;
        const my = (ar.h - ins < ins) ? ar.h / 2 : ins;
        c.x = Math.max(mx, Math.min(ar.w - mx, c.x));
        c.y = Math.max(my, Math.min(ar.h - my, c.y));
        L.x = c.x + (L.offX || 0);
        L.y = c.y + (L.offY || 0);
      }
    }

    // 需求11：区域落点——圆形结算区域（子弹从上方下落，进入结算圈或越过落点水平线即结束，不再无限下落）
    //   结算伤害由 world._settleLanding 统一处理（房主权威），此处只负责"结束飞行"的判定
    if (this.landing && !this.landingHit) {
      const L = this.landing;
      const rr = L.r + this.radius;
      const dx = this.x - L.x, dy = this.y - L.y;
      const crossed = (this.prevY <= L.y && this.y >= L.y);   // 高速下落兜底：越过落点水平线
      if (dx * dx + dy * dy <= rr * rr || crossed) { this.landingHit = true; this.dead = true; }
    }

    // 分裂请求：进度达到 at（默认 0.4）且未超出层级上限时置标记，由 world 生成子弹
    if (m.split && !this._splitDone) {
      const at = m.split.at;
      const prog = this.life0 > 0 ? 1 - this.life / this.life0 : 1;
      if (prog >= at && this.depth < m.split.maxDepth) { this._splitDone = true; this.splitReq = true; }
    }
    // 撞墙（环绕子弹锚定玩家，不做撞墙处理）
    if (!this.orbit && this.cfg.onWall !== 'ignore') {
      const orbit = this.spiral.orbit;      // 环绕螺旋的速度由位置差分得出，撞墙改为翻转基准线方向
      let hit = false;
      if (this.x - this.radius < 0) { this.x = this.radius; if (!orbit) this.vx = -this.vx; hit = true; }
      if (this.x + this.radius > arena.w) { this.x = arena.w - this.radius; if (!orbit) this.vx = -this.vx; hit = true; }
      if (this.y - this.radius < 0) { this.y = this.radius; if (!orbit) this.vy = -this.vy; hit = true; }
      if (this.y + this.radius > arena.h) { this.y = arena.h - this.radius; if (!orbit) this.vy = -this.vy; hit = true; }
      if (hit) {
        // bounce 次数优先：还有余量则继续飞，用尽后按 onWall 规则处理（destroy 消亡）
        if (this.bounceLeft > 0) {
          this.bounceLeft--;
          if (orbit) { this.ux = -this.ux; this.uy = -this.uy; }
          this.sx = this.x; this.sy = this.y;          // 正弦基准点跟随反弹点，避免回拉
        } else if (this.cfg.onWall === 'destroy') this.dead = true;
        else if (this.cfg.onWall === 'explode') { this.dead = true; this._wallBoom = true; }
        else if (orbit) { this.ux = -this.ux; this.uy = -this.uy; this.sx = this.x; this.sy = this.y; }
        // 'bounce' 则继续飞行（已反转速度）
      }
    }
  }

  // 需求6：环绕子弹——围绕玩家做圆周旋转（角度直接积分，不参与常规弹道/撞墙积分）
  //   follow:true（缺省）跟随玩家移动；owner 缺失时锚点固定在生成位置，保证各端表现一致
  // 第 5 条（本轮）：领域/环绕类"锚定玩家"加固——owner 在场时记录其最后已知位置，
  //   owner 瞬时缺失（尚未同步到本端 / 已离场）时沿用该位置，而不是回跳生成点，
  //   消除"领域忽然弹回施法原点"的观感（生成点仅在从未拿到过 owner 时使用）。
  _updateOrbit(dt, owner) {
    const o = this.orbit;
    const canFollow = !!o.follow;
    if (canFollow && owner) { this._orbLastX = owner.x; this._orbLastY = owner.y; }
    const cx = (canFollow && owner) ? owner.x
      : ((canFollow && this._orbLastX != null) ? this._orbLastX : this._orbCx);
    const cy = (canFollow && owner) ? owner.y
      : ((canFollow && this._orbLastY != null) ? this._orbLastY : this._orbCy);
    this._orbA += o.spin * dt;
    const a = this._orbA;
    this.x = cx + Math.cos(a) * o.radius;
    this.y = cy + Math.sin(a) * o.radius;
    // 速度按位置差分还原：供朝向渲染与命中判定使用
    if (dt > 0) { this.vx = (this.x - this.prevX) / dt; this.vy = (this.y - this.prevY) / dt; }
  }

  // 碰撞判定：扫掠线段对圆（高速弹不穿透），beam 无视间距按当前点判
  collides(target) {
    if (this.hitIds.has(target.id)) return false;
    const rr = this.radius + target.radius;
    const rr2 = rr * rr;
    // 当前点命中
    const dx = this.x - target.x;
    const dy = this.y - target.y;
    if (dx * dx + dy * dy <= rr2) return true;
    // 高速扫掠：上帧到本帧的线段离圆心最近距离 <= rr
    const px = this.prevX - target.x, py = this.prevY - target.y;
    const mx = this.x - this.prevX, my = this.y - this.prevY;
    const m2 = mx * mx + my * my;
    if (m2 > 0.0001) {
      let t = -(px * mx + py * my) / m2;
      t = Math.max(0, Math.min(1, t));
      const qx = px + mx * t, qy = py + my * t;
      if (qx * qx + qy * qy <= rr2) return true;
    }
    return false;
  }

  // 命中分裂：装配了 split.onHit 的弹型在命中目标瞬间置标记，
  // 由 world 在下一次 updateBullets 统一生成子子弹（保证各端 id / 位置一致）
  _requestSplitOnHit() {
    const sp = this.mo.split;
    if (!sp || !sp.onHit || this._splitDone) return;
    if (this.depth >= sp.maxDepth) return;
    this._splitDone = true;
    this.splitReq = true;
  }

  // 确定性掷骰（0~1）：种子由「子弹 id + 目标 id」派生，不用 Math.random ——
  // 同一次命中在各端得到同一结果，保证飘字 / 扣血 / 结算三者数值完全一致（方案 A）。
  static roll01(bulletId, targetId) {
    const s = String(bulletId) + '|' + String(targetId);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ((h >>> 8) % 100000) / 100000;
  }

  // 本次命中的最终伤害：基础伤害（已含攻击者 damageMul）× 攻击者暴击属性（critChance / critMul）
  _rollDamage(targetId) {
    const stats = { critChance: this.critChance, critMul: this.critMul };
    const rng = () => Bullet.roll01(this.id, targetId);
    return (typeof Combat !== 'undefined' && Combat.rollCrit)
      ? Combat.rollCrit(stats, this.damage, rng)
      : { dmg: this.damage, crit: false };
  }

  // 命中处理：返回 { hit:true, explode:bool, wallBoom:bool, damage, crit, tear } 或 null（未命中）
  //   tear（本轮新增）：技能级撕裂配置随命中载荷带出，交由 world.handleHit → _applyTear 应用 DoT。
  hit(target) {
    this.hitIds.add(target.id);
    this._requestSplitOnHit();
    const roll = this._rollDamage(target.id);      // 方案 A：暴击按攻击者属性掷骰（各端一致）
    if (this.cfg.onHit === 'explode' || this._wallBoom || this.blastR != null) {
      this.dead = true;
      const er = (this.blastR != null) ? this.blastR : this.cfg.explodeRadius;
      return { hit: true, explode: true, damage: roll.dmg, crit: roll.crit, explodeRadius: er, tear: this.tear };
    }
    if (this.pierce > 0) {
      this.pierce--;
      return { hit: true, explode: false, damage: roll.dmg, crit: roll.crit, tear: this.tear };
    }
    this.dead = true;
    return { hit: true, explode: false, damage: roll.dmg, crit: roll.crit, tear: this.tear };
  }
}
