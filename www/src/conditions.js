// ===== 条件判断模块（逻辑核心，src 层）=====
// 条件描述数据放在 config/*.json（装备/铭文/宝石/技能/触发均可带 condition），
// 判断引擎在 src 层统一处理：不满足则模块不生效（或技能不可用）。
//
// 条件结构（配置即数据，组合无限）：
//   { type: 'always' }                            恒真（缺省即恒真）
//   { type: 'hpBelow', value: 0.5 }               自身血量比例低于 value（0~1）
//   { type: 'hpAbove', value: 0.5 }               自身血量比例高于 value
//   { type: 'killsAtLeast', value: 3 }            击杀数达到 value
//   { type: 'timeAfter', value: 10 }              对局开始后第 value 秒起（onTime / afterTime 同义）
//   { type: 'hitTakenAtLeast', value: 5 }         累计受击次数达到 value（伤害结算写入）
//   { type: 'hitsAtLeast', value: 8 }             累计命中次数达到 value
//   { type: 'comboAtLeast', value: 5 }            当前连击数达到 value（命中窗口内连续命中）
//   { type: 'deathsAtLeast', value: 1 }           累计死亡次数达到 value
//   { type: 'phaseAfter', value: 15 }             距「上一次阶段触发」经过 value 秒（阶段计时）
//   { type: 'onKill' }                            击杀瞬间（事件型，ctx.event === 'kill'）
//   { type: 'onDeath' }                           死亡瞬间（事件型，ctx.event === 'death'）
//   { type: 'onRespawn' }                         复活瞬间（事件型，ctx.event === 'respawn'）
//   { type: 'hasSkill', value: 'fireball' }       已拥有某技能（模块联动）
//   { type: 'and', list: [cond, ...] }            全部满足
//   { type: 'or',  list: [cond, ...] }            任一满足
// 新增"条件类型"才需要在本 switch 加一条；组合型条件全部纯数据可配。

const Conditions = {
  check(cond, ctx = {}) {
    if (!cond) return true;
    switch (cond.type) {
      case 'always': return true;
      case 'hpBelow': return (ctx.hpRatio !== undefined ? ctx.hpRatio : 1) < cond.value;
      case 'hpAbove': return (ctx.hpRatio !== undefined ? ctx.hpRatio : 0) > cond.value;
      case 'killsAtLeast': return (ctx.kills || 0) >= cond.value;
      case 'hitTakenAtLeast': return (ctx.hitTaken || 0) >= cond.value;
      case 'hitsAtLeast': return (ctx.hits || 0) >= cond.value;
      case 'comboAtLeast': return (ctx.combo || 0) >= cond.value;
      case 'deathsAtLeast': return (ctx.deaths || 0) >= cond.value;
      case 'phaseAfter': return (ctx.phaseTime || 0) >= cond.value;
      case 'onKill': return ctx.event === 'kill' || (ctx.killedBy !== undefined && ctx.killedBy === ctx.selfId);
      case 'onDeath': return ctx.event === 'death';
      case 'onRespawn': return ctx.event === 'respawn';
      case 'timeAfter': return (ctx.time || 0) >= cond.value;
      case 'afterTime': return (ctx.time || 0) >= cond.value;   // 兼容旧触发配置（与 timeAfter 同义）
      case 'onTime': return (ctx.time || 0) >= cond.value;      // 兼容旧触发配置（周期/定时）
      case 'hasSkill': return !!(ctx.skills || []).includes(cond.value);
      case 'and': return (cond.list || []).every(c => this.check(c, ctx));
      case 'or': return (cond.list || []).some(c => this.check(c, ctx));
      default: return true;   // 未知类型按恒真处理，不阻断游戏
    }
  },
};
