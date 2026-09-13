// ===== Buff 体系运行时（P2 新增）=====
// 配置放 config/buffs.json（BUFFS 全局，config_loader CONFIG_FILES 已登记），本文件只做运行时：
//   拾取/叠加/计时 / 效果聚合（effects）/ 护盾吸收（absorb）/ HUD 可见列表（visible）。
// 状态挂 Player.buffs（数组，构造时初始化）：
//   普通条目  { id, defId, stacks, end }            // end = 过期秒（performance.now()/1000 + duration）
//   护盾条目  { id:'shield', defId:'shield', amt, end }  // amt = 剩余吸收量，受击由房主扣减并广播
// 三处消费点：
//   1. world.applyDamage —— 攻击方 damageMul / 吸血 / 目标护盾吸收（房主权威结算）
//   2. Player.update / updateLocal / BotAI —— atkSpeedMul / speedMul（各控制端本地，拾取广播全员一致）
//   3. renderer —— HUD buff 图标 / 倒计时 / 护盾剩余量

const BuffSystem = {
  _now() { return performance.now() / 1000; },

  getDef(buffId) {
    return (window.BUFFS && BUFFS[buffId]) ? BUFFS[buffId] : null;
  },

  // 惰性清理过期条目（buff 非持久状态，过期即消失）
  _list(p) {
    if (!p.buffs) p.buffs = [];
    const now = this._now();
    p.buffs = p.buffs.filter(b => b && b.end > now);
    return p.buffs;
  },

  // 拾取 / 阶段授予：护盾覆盖刷新；其余按 maxStacks 叠层，叠满后刷新时长
  // 本轮改动（需求2）：放行 Boss 阶段自授 buff（opts.selfGrant=true，由 Boss 自身机制触发，
  // 如加攻 / 加防 / 无敌 / 加速，与玩家 buff 同机制，显示在 Boss 血条下方）；
  // 场地掉落与他人授予对 Boss 仍全部拦截。
  addBuff(p, buffId, opts) {
    const def = this.getDef(buffId);
    if (!def || !p) return false;
    if (p.isBoss && !(opts && opts.selfGrant)) return false;   // Boss 只吃自身机制触发的 buff
    // heal：立即回血（固定值，瞬时生效不写入 buff 列表；拾取广播全员一致）
    if (def.kind === 'heal') {
      const cap = (p.statsTotal && p.statsTotal.hp) || p.hp;
      p.hp = Math.min(cap, (p.hp || 0) + (def.healFlat || 0));
      return true;
    }
    const now = this._now();
    const list = this._list(p);
    if (def.kind === 'shield') {
      const ex = list.find(b => b.id === 'shield');
      const amt = Math.max(20, Math.round((p.statsTotal.hp || 1) * (def.shieldPct || 0.3)));
      if (ex) { ex.amt = Math.max(ex.amt, amt); ex.end = now + def.duration; }
      else list.push({ id: 'shield', defId: buffId, amt, end: now + def.duration });
      return true;
    }
    const ex = list.find(b => b.id === buffId);
    const max = Math.max(1, def.maxStacks || 1);
    if (ex) {
      if (ex.stacks < max) ex.stacks += 1;   // 未满：叠层
      ex.end = now + def.duration;            // 满层：刷新时长
    } else {
      list.push({ id: buffId, defId: buffId, stacks: 1, end: now + def.duration });
    }
    return true;
  },

  // 当前生效效果聚合（纯读，供结算/移动/冷却/渲染使用）
  effects(p) {
    const e = { damageMul: 0, atkSpeedMul: 0, speedMul: 0, lifesteal: 0, shield: 0, invuln: 0, damageTakenMul: 0 };
    if (!p || !p.buffs || !p.buffs.length) return e;
    const now = this._now();
    for (const b of p.buffs) {
      if (!b || b.end <= now) continue;
      const def = this.getDef(b.defId);
      if (!def) continue;
      if (def.kind === 'shield') { e.shield += b.amt || 0; continue; }
      if (def.kind === 'invuln') { e.invuln = 1; continue; }   // 无敌：免疫一切伤害（结算在 world.applyDamage）
      if (def.kind === 'lifesteal') {
        e.lifesteal = Math.min(1, e.lifesteal + (def.healRatio || 0) * b.stacks);
        continue;
      }
      const st = def.stats || {};
      for (const k in st) { if (k in e) e[k] += st[k] * b.stacks; }
    }
    return e;
  },

  // 护盾吸收：按当前护盾量扣减，返回实际吸收值
  absorb(p, dmg) {
    if (!p || !p.buffs || !dmg) return 0;
    const now = this._now();
    let absorbed = 0, rest = dmg;
    for (const b of p.buffs) {
      if (!b || b.id !== 'shield' || b.end <= now || b.amt <= 0) continue;
      const take = Math.min(rest, b.amt);
      b.amt -= take; absorbed += take; rest -= take;
      if (rest <= 0) break;
    }
    p.buffs = p.buffs.filter(b => !(b && b.id === 'shield' && b.amt <= 0));
    return absorbed;
  },

  shieldAmt(p) {
    return this.effects(p).shield;
  },

  clearAll(p) {
    if (p) p.buffs = [];
  },

  // 本轮新增：点击 HUD buff 图标时展示的效果说明。
  // 优先取配置 desc（config/buffs.json）；缺失时按 kind / stats 自动兜底生成，保证新增 buff 忘写 desc 也有文案。
  describe(buffId) {
    const def = this.getDef(buffId);
    if (!def) return '';
    const head = (def.icon ? def.icon + ' ' : '') + (def.name || buffId) + '：';
    if (def.desc) return head + def.desc;
    const KEY = { damageMul: '伤害', damageTakenMul: '受伤', atkSpeedMul: '攻速', speedMul: '移速', hp: '生命', hpMax: '生命上限' };
    let core = '';
    if (def.kind === 'invuln') {
      core = '免疫一切伤害';
    } else if (def.kind === 'shield') {
      core = '获得最大生命 ' + Math.round((def.shieldPct || 0) * 100) + '% 的护盾';
    } else if (def.kind === 'lifesteal') {
      core = '造成伤害的 ' + Math.round((def.healRatio || 0) * 100) + '% 转化为回血';
    } else if (def.kind === 'heal') {
      core = '立即回复 ' + (def.healFlat || 0) + ' 点生命';
    } else {
      const st = def.stats || {};
      const parts = [];
      for (const k in st) parts.push((KEY[k] || k) + (st[k] >= 0 ? ' +' : ' ') + Math.round(st[k] * 100) + '%');
      core = parts.join(' / ');
    }
    const bits = [core];
    if (def.duration) bits.push('持续 ' + def.duration + 's');
    if ((def.maxStacks || 1) > 1) bits.push('最多 ' + def.maxStacks + ' 层');
    return head + bits.join('，');
  },

  // HUD：当前生效的可见 buff 列表（含剩余秒 / 层数 / 护盾剩余量）
  visible(p) {
    const list = [];
    if (!p || !p.buffs || !p.buffs.length) return list;
    const now = this._now();
    for (const b of p.buffs) {
      if (!b || b.end <= now) continue;
      const def = this.getDef(b.defId);
      if (!def) continue;
      list.push({
        defId: b.defId, name: def.name, icon: def.icon || '', color: def.color || '#ffffff',
        stacks: b.id === 'shield' ? 1 : (b.stacks || 1),
        tLeft: b.end - now,
        extra: b.id === 'shield' ? Math.round(b.amt) : null
      });
    }
    return list;
  },
};
