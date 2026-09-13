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
    this.radius = this.cfg.radius;
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
    this.life = this.cfg.life;
    this.life0 = this.cfg.life;
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

  update(dt, arena, enemies) {
    // 已消亡（本帧命中判定置 dead，等 world 下一帧回收）：不再位移，仅保留坐标供分裂/渲染取点
    if (this.dead) { this.prevX = this.x; this.prevY = this.y; return; }
    this.age += dt;
    this.life -= dt;
    if (this.life <= 0) { this.dead = true; return; }
    this.prevX = this.x; this.prevY = this.y;
    // 弹道运动（配置驱动，见 config/bullets.json motion 字段；参数已在构造时归一化）
    const m = this.mo;
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

    // 分裂请求：进度达到 at（默认 0.4）且未超出层级上限时置标记，由 world 生成子弹
    if (m.split && !this._splitDone) {
      const at = m.split.at;
      const prog = this.life0 > 0 ? 1 - this.life / this.life0 : 1;
      if (prog >= at && this.depth < m.split.maxDepth) { this._splitDone = true; this.splitReq = true; }
    }
    // 撞墙
    if (this.cfg.onWall !== 'ignore') {
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

  // 命中处理：返回 { hit:true, explode:bool, wallBoom:bool, damage, crit } 或 null（未命中）
  hit(target) {
    this.hitIds.add(target.id);
    this._requestSplitOnHit();
    const roll = this._rollDamage(target.id);      // 方案 A：暴击按攻击者属性掷骰（各端一致）
    if (this.cfg.onHit === 'explode' || this._wallBoom || this.blastR != null) {
      this.dead = true;
      const er = (this.blastR != null) ? this.blastR : this.cfg.explodeRadius;
      return { hit: true, explode: true, damage: roll.dmg, crit: roll.crit, explodeRadius: er };
    }
    if (this.pierce > 0) {
      this.pierce--;
      return { hit: true, explode: false, damage: roll.dmg, crit: roll.crit };
    }
    this.dead = true;
    return { hit: true, explode: false, damage: roll.dmg, crit: roll.crit };
  }
}
