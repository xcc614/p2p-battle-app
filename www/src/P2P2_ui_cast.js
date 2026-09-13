// ============================================================================
// P2P2_ui_cast.js —— 释放方式的表现层（读条 + 禁咒打点小游戏 + 吟唱描摹画布）
//  需求一（1/2/3）：屏幕中下位置的强力读条（玩家自身技能 + Boss 技能都要有）；
//  禁咒：屏幕中央多个小圆点，外圈光环向内收缩，按时机点击累计积分；
//  吟唱：新增判定画布，画布上预显示目标字/图案，玩家覆盖描摹，结束按贴合度折算伤害。
//  说明：本模块只负责"画"与"采集输入"，判定与结算全部在 P2P2_battle_cast.js（CastSystem）。
//  读条 / 小游戏的显示与否完全由配置开关驱动（CastSystem.bars() 只返回 bar:true 的施法）。
// ============================================================================

const UiCast = {
  _wrap: null,        // 读条容器
  _bars: {},          // pid -> { root, fill, name, tip }
  _overlay: null,     // 小游戏浮层
  _canvas: null,
  _ctx: null,
  _glyphCache: null,  // { key, canvas } 目标字缓存（吟唱）
  _key: null,         // 当前小游戏实例标识（切换时重置交互状态）
  _drawing: false,
  _last: null,
  _hit: null,         // 禁咒：最近一次判定结果（用于飘字）

  // ---- DOM 构建 ----------------------------------------------------------
  ensure() {
    if (typeof document === 'undefined') return;
    if (!this._wrap) {
      const w = document.createElement('div');
      w.id = 'castBars';
      document.body.appendChild(w);
      this._wrap = w;
    }
    if (!this._overlay) {
      const ov = document.createElement('div');
      ov.id = 'castOverlay';
      const cv = document.createElement('canvas');
      cv.id = 'castCanvas';
      ov.appendChild(cv);
      document.body.appendChild(ov);
      this._overlay = ov;
      this._canvas = cv;
      this._ctx = cv.getContext('2d');
      cv.addEventListener('pointerdown', (e) => this._down(e));
      cv.addEventListener('pointermove', (e) => this._move(e));
      cv.addEventListener('pointerup', (e) => this._up(e));
      cv.addEventListener('pointercancel', (e) => this._up(e));
      cv.addEventListener('pointerleave', (e) => this._up(e));
      window.addEventListener('resize', () => this._resize());
    }
  },

  _resize() {
    if (!this._canvas) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const w = window.innerWidth, h = window.innerHeight;
    this._canvas.width = Math.round(w * dpr);
    this._canvas.height = Math.round(h * dpr);
    this._canvas.style.width = w + 'px';
    this._canvas.style.height = h + 'px';
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w; this._h = h;
  },

  // ---- 隐藏（离开战斗 / 回菜单 / 结算）--------------------------------------
  // 需求1~4：读条与禁咒·吟唱浮层必须随对局结束一起收走，否则会残留在菜单上遮挡操作。
  hide() {
    if (this._overlay) this._overlay.style.display = 'none';
    for (const pid in this._bars) {
      const row = this._bars[pid];
      if (row && row.root && row.root.parentNode) row.root.parentNode.removeChild(row.root);
    }
    this._bars = {};
    this._key = null;
    this._drawing = false;
    this._last = null;
    this._hit = null;
    this._chant = null;
  },

  // ---- 读条（屏幕中下：玩家自身技能 + Boss 技能） --------------------------
  syncBars(world) {
    if (!this._wrap || typeof CastSystem === 'undefined') return;
    const list = CastSystem.bars(world);
    const seen = {};
    for (const b of list) {
      seen[b.pid] = true;
      let row = this._bars[b.pid];
      if (!row) {
        const root = document.createElement('div');
        root.className = 'cast-bar';
        const name = document.createElement('div');
        name.className = 'cast-bar-name';
        const track = document.createElement('div');
        track.className = 'cast-bar-track';
        const fill = document.createElement('div');
        fill.className = 'cast-bar-fill';
        const tip = document.createElement('div');
        tip.className = 'cast-bar-tip';
        track.appendChild(fill);
        root.appendChild(name); root.appendChild(track); root.appendChild(tip);
        this._wrap.appendChild(root);
        row = { root, fill, name, tip };
        this._bars[b.pid] = row;
      }
      const isSelf = !!(world && world.net && b.pid === world.net.myId);
      const isBoss = !!(world && world.players && world.players.get(b.pid) && world.players.get(b.pid).isBoss);
      row.root.className = 'cast-bar' + (isSelf ? ' self' : '') + (isBoss ? ' boss' : '');
      row.fill.style.width = Math.round(b.ratio * 100) + '%';
      row.fill.style.background = b.color || '#8ad2ff';
      row.name.textContent = (isSelf ? '自身' : (isBoss ? 'BOSS' : (b.name || ''))) + ' · ' + (b.skillName || '') + '「' + (b.releaseName || '') + '」';
      let tip = '';
      if (b.type === 'charge') tip = '长按蓄力 · 松手提前释放';
      else if (b.type === 'forbid') tip = '禁咒：光环收缩到位时点击 · 积分 ' + (b.score || 0);
      else if (b.type === 'chant') tip = '吟唱：在画布上描摹「' + (b.glyph || '') + '」';
      else if (b.type === 'channel') tip = '持续释放中 · 期间无法释放其它技能';
      row.tip.textContent = tip;
    }
    for (const pid in this._bars) {
      if (seen[pid]) continue;
      const row = this._bars[pid];
      if (row.root.parentNode) row.root.parentNode.removeChild(row.root);
      delete this._bars[pid];
    }
  },

  // ---- 小游戏（禁咒 / 吟唱） ----------------------------------------------
  frame(world) {
    this.ensure();
    if (!this._overlay) return;
    this.syncBars(world);
    const inst = (typeof CastSystem !== 'undefined') ? CastSystem.localInstance(world) : null;
    if (!inst || inst.remote) {
      if (this._overlay.style.display !== 'none') this._overlay.style.display = 'none';
      this._key = null; this._drawing = false; this._last = null; this._hit = null;
      return;
    }
    if (this._overlay.style.display !== 'block') {
      this._overlay.style.display = 'block';
      this._resize();
      if (!this._w) this._resize();
    }
    const key = inst.pid + '#' + inst.seed;
    if (this._key !== key) {
      this._key = key; this._drawing = false; this._last = null; this._hit = null;
      inst.strokes = inst.strokes || [];
      this._glyphCache = null;
      if (inst.def.type === 'chant') this._prepareChant(inst);
    }
    if (inst.def.type === 'forbid') this._drawForbid(inst);
    else if (inst.def.type === 'chant') this._drawChant(inst);
  },

  // 禁咒：判定点 + 收缩光环 + 积分
  //  本轮手感增强：判定点更大更亮、判定窗口内的光环高亮加粗、判定后（命中/落空）仍停留 markHold 秒后再淡出
  _drawForbid(inst) {
    const ctx = this._ctx, W = this._w, H = this._h, d = inst.def;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.fillStyle = 'rgba(6,10,20,0.5)';
    ctx.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const arenaR = Math.min(W, H) * 0.3;
    inst._arenaR = arenaR;
    const hold = (d.markHold != null) ? d.markHold : 0.9;

    // 判定区（外圈实线 + 虚线，提高可见度）
    ctx.beginPath();
    ctx.arc(cx, cy, arenaR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(150,200,255,0.55)';
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(cx, cy, arenaR + 12, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(120,180,255,0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const pointR = d.pointR || 28;
    const ringScale = d.ringScale || 3;
    const win = d.hitWindow || 0.52;
    const glow = (d.markGlow !== false);

    for (const p of inst.points) {
      // 命中：停留 markHold 秒后淡出（绿）
      if (p.state === 'hit') {
        const age = inst.t - ((p.clickT != null) ? p.clickT : p.at);
        // age >= 0 兜底：clickT 若领先于本帧游戏时钟（时钟基准差异/极端补帧），
        //   外扩冲击环半径 pointR*(1+u*1.8) 会算出负值并抛 IndexSizeError，这里跳过负 age。
        if (age >= 0 && age < hold) {
          const k = 1 - age / hold;
          this._drawPointMark(ctx, cx, cy, p, arenaR, pointR, '#5cff9d', 0.55 + 0.45 * k, glow);
          if (age < 0.28) {                       // 命中瞬间的外扩冲击环
            const u = age / 0.28;
            ctx.beginPath();
            ctx.arc(cx + p.ax * arenaR, cy + p.ay * arenaR, pointR * (1 + u * 1.8), 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(92,255,157,' + (0.85 * (1 - u)).toFixed(3) + ')';
            ctx.lineWidth = 3;
            ctx.stroke();
          }
          if (p.score != null) {
            ctx.globalAlpha = Math.min(1, k + 0.3);
            ctx.fillStyle = p.score >= 100 ? '#ffd76a' : '#8fe3ff';
            ctx.font = '700 14px "Microsoft YaHei",sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('+' + p.score, cx + p.ax * arenaR, cy + p.ay * arenaR - pointR - 8);
            ctx.globalAlpha = 1;
          }
        }
        continue;
      }
      // 落空：短暂停留后淡出（红）
      if (p.state === 'gone') {
        const age = inst.t - ((p.goneT != null) ? p.goneT : p.at);
        if (age < hold * 0.7) {
          const k = 1 - age / (hold * 0.7);
          this._drawPointMark(ctx, cx, cy, p, arenaR, pointR * 0.8, '#ff7b7b', 0.75 * k, false);
        }
        continue;
      }
      const appear = p.at - p.period;
      if (inst.t < appear) continue;
      const prog = Math.max(0, Math.min(1, (inst.t - appear) / p.period));   // 0 → 1 向内收缩
      const ringR = pointR + (ringScale - 1) * pointR * (1 - prog);
      const dtAbs = Math.abs(inst.t - p.at);
      const near = dtAbs <= win;
      const perfect = dtAbs <= (d.perfect || 0.1);
      this._drawPointMark(ctx, cx, cy, p, arenaR, pointR,
        perfect ? '#fff0a8' : (near ? '#ffd76a' : 'rgba(170,215,255,0.85)'), 1, glow || near);
      // 外圈光环（判定窗口内加粗高亮）
      ctx.beginPath();
      ctx.arc(cx + p.ax * arenaR, cy + p.ay * arenaR, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = perfect ? 'rgba(255,240,168,1)'
        : (near ? 'rgba(255,215,106,0.98)' : 'rgba(120,180,255,0.72)');
      ctx.lineWidth = perfect ? 6 : (near ? 4.5 : 2.5);
      if (near) { ctx.shadowColor = 'rgba(255,215,106,0.85)'; ctx.shadowBlur = 14; }
      ctx.stroke();
      ctx.shadowBlur = 0;
      // 判定窗口内的内圈提示（提前量指示：内圈缩到最小即判定时刻）
      if (near) {
        ctx.beginPath();
        ctx.arc(cx + p.ax * arenaR, cy + p.ay * arenaR, pointR * 0.62, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,215,106,0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // 积分 / 失败数
    const max = inst.maxScore || 1;
    ctx.font = '700 20px "Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText('禁咒积分  ' + (inst.score || 0) + ' / ' + max, cx, cy - arenaR - 40);
    ctx.fillStyle = 'rgba(255,140,140,0.9)';
    ctx.font = '600 14px "Microsoft YaHei",sans-serif';
    ctx.fillText('失败 ' + (inst.fails || 0) + ' 次 · 剩余 ' + (Math.max(0, inst.dur - inst.t)).toFixed(1) + 's', cx, cy + arenaR + 34);

    // 最近一次判定飘字
    if (this._hit && this._hit.life > 0) {
      this._hit.life -= 1 / 60;
      ctx.fillStyle = this._hit.kind === 'perfect' ? '#ffd76a' : (this._hit.kind === 'good' ? '#8fe3ff' : '#ff7b7b');
      ctx.font = '700 22px "Microsoft YaHei",sans-serif';
      ctx.fillText(this._hit.text, cx, cy + arenaR * 0.62);
    }
  },

  _drawPointMark(ctx, cx, cy, p, arenaR, pointR, color, alpha, glow) {
    const x = cx + p.ax * arenaR, y = cy + p.ay * arenaR;
    ctx.globalAlpha = alpha;
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 16; }
    ctx.beginPath();
    ctx.arc(x, y, pointR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16,24,42,0.72)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
    // 外描边（提高在亮背景上的对比度）
    ctx.beginPath();
    ctx.arc(x, y, pointR + 3, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 中心点 + 十字准星
    ctx.beginPath();
    ctx.arc(x, y, Math.max(3, pointR * 0.2), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    const cr = pointR * 0.55;
    ctx.beginPath();
    ctx.moveTo(x - cr, y); ctx.lineTo(x + cr, y);
    ctx.moveTo(x, y - cr); ctx.lineTo(x, y + cr);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = alpha * 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
  },

  // 吟唱：目标字/图案预显示 + 玩家覆盖描摹 + 笔迹采集
  _prepareChant(inst) {
    const N = inst.grid || 24;
    const oc = document.createElement('canvas');
    oc.width = oc.height = N;
    const g = oc.getContext('2d');
    g.clearRect(0, 0, N, N);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 ' + Math.floor(N * 0.86) + 'px "Microsoft YaHei","SimHei",sans-serif';
    g.fillText(String(inst.glyph || '火'), N / 2, N / 2 + N * 0.03);
    const img = g.getImageData(0, 0, N, N).data;
    const raw = new Set();
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (img[(y * N + x) * 4 + 3] > 50) raw.add(x + ',' + y);
      }
    }
    // 少画/偏移容差：目标掩码按 tolerance 膨胀
    const tol = (inst.def.tolerance != null) ? inst.def.tolerance : 1;
    const mask = new Set(raw);
    for (let t = 0; t < tol; t++) {
      for (const k of Array.from(mask)) {
        const [x, y] = k.split(',').map(Number);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < N && ny < N) mask.add(nx + ',' + ny);
        }
      }
    }
    inst.targetCells = mask;
    inst.targetCount = mask.size;
    inst.userCells = new Set();
    inst.strokes = [];
    this._glyphCache = { key: inst.pid + '#' + inst.seed, canvas: oc, N };
    if (typeof CastSystem !== 'undefined') CastSystem.setChantData(inst.pid, mask, inst.userCells);
  },

  _drawChant(inst) {
    const ctx = this._ctx, W = this._w, H = this._h;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,10,20,0.5)';
    ctx.fillRect(0, 0, W, H);
    const S = Math.min(W, H) * 0.62;
    this._chant = { x: (W - S) / 2, y: (H - S) / 2, S };
    const N = inst.grid || 24, cell = S / N;

    // 判定格底纹
    ctx.strokeStyle = 'rgba(120,170,230,0.14)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= N; i++) {
      ctx.beginPath(); ctx.moveTo(this._chant.x + i * cell, this._chant.y);
      ctx.lineTo(this._chant.x + i * cell, this._chant.y + S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(this._chant.x, this._chant.y + i * cell);
      ctx.lineTo(this._chant.x + S, this._chant.y + i * cell); ctx.stroke();
    }

    // 目标字（预显示，供玩家覆盖描摹）
    if (inst.def.showTarget !== false && this._glyphCache) {
      ctx.globalAlpha = 0.26;
      ctx.drawImage(this._glyphCache.canvas, this._chant.x, this._chant.y, S, S);
      ctx.globalAlpha = 1;
    }

    // 玩家笔迹（覆盖描绘的可视化）
    ctx.strokeStyle = 'rgba(140,235,255,0.95)';
    ctx.lineWidth = Math.max(3, cell * 1.6);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const strokes = inst.strokes || [];
    for (const s of strokes) {
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }

    // 提示：贴合度实时预估 + 剩余时间
    const pre = (typeof CastSystem !== 'undefined') ? CastSystem.chantScore(inst) : 0;
    const tx = W / 2, ty = this._chant.y - 26;
    ctx.textAlign = 'center';
    ctx.font = '700 18px "Microsoft YaHei",sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText('吟唱：「' + String(inst.glyph || '') + '」  贴合度 ' + Math.round(pre * 100) + '%', tx, ty);
    ctx.font = '600 14px "Microsoft YaHei",sans-serif';
    ctx.fillStyle = 'rgba(180,220,255,0.85)';
    ctx.fillText('在目标字形上覆盖描绘 · 剩余 ' + (Math.max(0, inst.dur - inst.t)).toFixed(1) + 's', tx, this._chant.y + S + 28);
  },

  // ---- 输入 --------------------------------------------------------------
  _local(e) {
    if (typeof CastSystem === 'undefined') return null;
    const world = (typeof App !== 'undefined') ? App.world : null;
    return CastSystem.localInstance(world);
  },

  _pos(e) {
    const r = this._canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  },

  _down(e) {
    const inst = this._local(e);
    if (!inst) return;
    e.preventDefault();
    const p = this._pos(e);
    if (inst.def.type === 'forbid') {
      const cx = this._w / 2, cy = this._h / 2;
      const res = CastSystem.click((typeof App !== 'undefined') ? App.world : null,
        p.x - cx, p.y - cy, inst._arenaR || (Math.min(this._w, this._h) * 0.24));
      if (res) {
        this._hit = {
          life: 0.5,
          kind: res.kind,
          text: res.kind === 'perfect' ? '完美 +100' : (res.kind === 'good' ? ('命中 +' + res.score) : '落空 · 失败'),
        };
      }
      return;
    }
    if (inst.def.type === 'chant') {
      this._drawing = true;
      this._last = p;
      inst._cur = p;
    }
  },

  _move(e) {
    const inst = this._local(e);
    if (!inst || inst.def.type !== 'chant' || !this._drawing) return;
    e.preventDefault();
    const p = this._pos(e);
    this._seg(inst, this._last, p);
    this._last = p;
  },

  _up(e) {
    this._drawing = false;
    this._last = null;
    const inst = this._local(e);
    if (inst) inst._cur = null;
  },

  // 笔迹落格：把线段覆盖到的网格标记为用户笔迹（越贴合目标扣分越少/得分越高）
  _seg(inst, a, b) {
    if (!a || !b || !this._chant) return;
    const N = inst.grid || 24, cell = this._chant.S / N;
    const nx = (b.x - a.x), ny = (b.y - a.y);
    const len = Math.max(1e-3, Math.hypot(nx, ny));
    const brush = (inst.def.brush != null ? inst.def.brush : 1.1) * cell;
    const steps = Math.ceil(len / Math.max(2, cell * 0.5));
    inst.strokes = inst.strokes || [];
    inst.strokes.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    if (inst.strokes.length > 900) inst.strokes.splice(0, inst.strokes.length - 900);
    for (let i = 0; i <= steps; i++) {
      const px = a.x + nx * (i / steps), py = a.y + ny * (i / steps);
      const gx = (px - this._chant.x) / cell, gy = (py - this._chant.y) / cell;
      const rr = brush / cell;
      const x0 = Math.floor(gx - rr), x1 = Math.ceil(gx + rr);
      const y0 = Math.floor(gy - rr), y1 = Math.ceil(gy + rr);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          if (Math.hypot(x + 0.5 - gx, y + 0.5 - gy) > rr) continue;
          inst.userCells.add(x + ',' + y);
        }
      }
    }
    if (typeof CastSystem !== 'undefined') CastSystem.setChantData(inst.pid, inst.targetCells, inst.userCells);
  },
};
