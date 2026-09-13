// ===== 触发模块（逻辑核心，src 层）=====
// 触发规则数据放 config/triggers.json（Boss 阶段、限时解锁等全部条件式配置），
// 本文件只做判断引擎：条件达成 -> 解锁技能 / 广播事件。
// 条目结构（见 config/triggers.json）：
//   id: {
//     units: ['demon_lord'],     // 作用单位模板（留空=所有单位），防误伤同场其他阵营
//     when: 'hpBelow' | 'hpAbove' | 'onKill' | 'onTime' | 'afterTime',
//     value: 阈值（hpBelow: 0~1 比例；afterTime/onTime: 秒），
//     once: true 表示只触发一次（默认 true），
//     then: {
//       unlockSkills: ['skillId'],   // 解锁技能（加入可用技能组）
//       emit: 'boss_phase_2',        // 广播事件名（前端/音效/特效可监听）
//       text: '提示文案',
//       action: 'spawnAdds',         // 预留：执行动作名（后续可扩展，需在 src 加分支）
//       payload: { count: 2 }
//     }
//   }
// world.js 在 tick 中调用 Triggers.check(player, ctx) 即可。
// ctx（由 world 传入）：{ time, event, killedBy }
//   event 取值：'' | 'hit' | 'kill' | 'death' | 'respawn' | 'time'
//   —— 事件型条件（onKill / onDeath / onRespawn）只在对应事件那一帧成立。
//
// 条件统一走 src/P2P2_core_conditions.js（新增条件类型只需在那边加一条分支，本文件不改），
// 计数与阶段计时由本模块负责：ctx 里注入 hits / hitTaken / combo / maxCombo / deaths / phaseTime，
// 以及按单位暴露的运行时量 alive / aliveTime / respawnLeft / maxHp（见 _ctx）。

const Triggers = {
  // 计数型条件 -> 玩家统计字段（once:false 默认边沿触发；显式 repeat:'step' 时才按「整数台阶」判定）
  COUNTER_OF: {
    killsAtLeast: 'kills',
    hitsAtLeast: 'hits',
    hitTakenAtLeast: 'hitTaken',
    comboAtLeast: 'combo',
    deathsAtLeast: 'deaths',
  },
  // once:false 的规则：两次触发的最小间隔（秒），防止同一帧反复触发
  REPEAT_INTERVAL: 0.5,

  // 构造条件上下文（血量比例 / 各类计数 / 阶段经过秒数 / 技能池）
  _ctx(player, ctx) {
    const stats = player.statsTotal || {};
    const st = player.stats || {};
    const time = ctx.time || 0;
    // v1 运行时量（按单位）：存活状态 / 连续存活秒数 / 复活倒计时 / 血量上限，由 Player.runtimeInfo 统一产出
    const rt = (typeof player.runtimeInfo === 'function')
      ? player.runtimeInfo(time)
      : { alive: !!player.alive, aliveTime: 0, respawnLeft: 0, maxHp: stats.hp || 0 };
    // 血量比与模块条件（Combat._buildCtx）用同一分母：条件重算基线上限（_statsBaseNoCond），
    // 使同一单位在「模块条件」与「触发器条件」下的 hpBelow / hpAbove 判定完全一致（各端同理）
    const maxHp = rt.maxHp || stats.hp || 0;
    const hp = (typeof player.hp === 'number' && player.hp >= 0) ? player.hp : maxHp;
    return {
      time,
      event: ctx.event || '',
      killedBy: ctx.killedBy,
      selfId: player.id,
      hpRatio: maxHp ? hp / maxHp : 1,
      kills: st.kills || 0,
      deaths: st.deaths || 0,
      hits: st.hits || 0,
      hitTaken: st.hitTaken || 0,
      combo: st.combo || 0,
      maxCombo: st.maxCombo || 0,
      // 阶段计时：距该单位「上一次阶段触发」的经过秒数（未触发过则从对局开始算）
      phaseTime: Math.max(0, time - (player.phaseAt || 0)),
      // 存活时长等运行时量（与 phaseTime 同一时间基准 = 对局秒）
      alive: rt.alive,
      aliveTime: rt.aliveTime,
      respawnLeft: rt.respawnLeft,
      maxHp: rt.maxHp,
      skills: player.skillPool || [],
    };
  },

  // 判定单个玩家当前应触发的规则，返回事件数组（then 内容 + id + times 第几次触发）
  check(player, ctx = {}) {
    const fired = player._triggers = player._triggers || {};      // id -> 已触发次数
    const lastAt = player._triggerAt = player._triggerAt || {};   // id -> 上次触发时间
    const lastCount = player._triggerCount = player._triggerCount || {}; // id -> 上次触发时的计数快照
    const edge = player._triggerEdge = player._triggerEdge || {};        // id -> 上次采样时条件是否成立（边沿检测）
    const c = this._ctx(player, ctx);
    const events = [];
    for (const id in TRIGGERS) {
      const t = TRIGGERS[id];
      // 角色作用域过滤（P2）：配置声明了 units 时仅对应单位模板可触发，防 hero 误判 Boss 阶段
      if (t.units && t.units.length && !t.units.includes(player.unitId || player.roleId)) continue;
      const n = fired[id] || 0;
      if (t.once !== false && n > 0) continue;                              // once:true（默认）只触发一次
      if (t.times != null && n >= Math.max(1, t.times)) continue;           // 显式限定总次数
      // 条件链统一判定：新增条件（血量高于 / 受击达N次 / 命中达N次 / 连击达N次 /
      // 阶段已过N秒 / 死亡瞬间 / 复活瞬间）与既有条件同走 src/P2P2_core_conditions.js，均为纯数据可配
      const ok = Conditions.check({ type: t.when, value: t.value }, c);
      // 边沿采样：记录本条规则「上次采样时条件是否成立」，供 once:false 判断上升沿
      const wasOk = edge[id] === true;
      edge[id] = ok;
      if (!ok) continue;
      if (t.once === false) {
        // v1 修复：once:false 由「每 REPEAT_INTERVAL 重复触发」改为「边沿触发」——
        // 只有「上次不满足 -> 本次满足」才触发一次，条件持续成立期间不再重复触发。
        // 另保留最小间隔（interval，默认 REPEAT_INTERVAL），防止阈值附近来回抖动时连续刷屏。
        const ck = this.COUNTER_OF[t.when];
        if (t.repeat === 'step' && ck) {
          // 显式声明 repeat:'step' 时，才保留旧「每爬上一个整数台阶触发一次」的计数语义
          const step = Math.max(1, Math.floor(t.step != null ? t.step : (Math.floor(t.value) || 1)));
          const cur = c[ck] || 0;
          if (Math.floor(cur / step) <= Math.floor((lastCount[id] || 0) / step)) continue;
          lastCount[id] = cur;
        } else if (wasOk) {
          continue;   // 条件持续成立（非上升沿）→ 本次不触发
        }
        const iv = (t.interval != null && t.interval >= 0) ? t.interval : this.REPEAT_INTERVAL;
        if (c.time - (lastAt[id] || -1e9) < iv) continue;
      } else if (this.COUNTER_OF[t.when]) {
        lastCount[id] = c[this.COUNTER_OF[t.when]] || 0;
      }
      fired[id] = n + 1;
      lastAt[id] = c.time;
      // 阶段计时基准刷新：该单位每次触发规则都视为一次「阶段推进」，phaseAfter 从此刻重新计秒
      if (t.phase !== false) player.phaseAt = c.time;
      events.push({ id, times: n + 1, ...t.then });
    }
    return events;
  },
};
