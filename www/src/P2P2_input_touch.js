// ===== 浮动操作层（PC 与移动端共用技能键；移动端另含左摇杆） =====
// 进入战斗后显示：移动端左侧虚拟摇杆（移动）+ 右侧攻击/技能按钮；PC 端同样显示右侧 8 技能键（可鼠标点击）。
// 不注入任何游戏逻辑：方向写入 Input.touchMove，技能通过 Input.fireSlot 入队消费，
// 每帧由 main 的 updateLocal 调用 Touch.frame(me, world) 更新自瞄与按钮视觉。
// 自瞄方向只在触屏模式(Input.touchMode)下写入 touchAim；PC 键盘/鼠标路径不受影响。

// 自动普攻技能 id：口径与 main.js 一致 —— config/skills.json 里 auto:true 的条目（改技能 id / 换自动普攻技能后依旧生效）；
// 优先复用 main 暴露的配置判定，main 尚未就绪时按同一规则就地判定，最后退回旧 id
function autoSkillId() {
  if (typeof App !== 'undefined' && App && typeof App.autoAttackSkillId === 'function') return App.autoAttackSkillId();
  const sk = (window.SKILLS || {});
  const hit = Object.keys(sk).find(k => !k.startsWith('_') && sk[k] && typeof sk[k] === 'object' && sk[k].auto === true);
  return hit || 'auto_attack';
}
// 技能按钮文字（需求3）：就绪态显示技能名而非千篇一律的“攻/技”；超长名截断，避免挤出圆钮
// 显示名一律取 config/skills.json 的 name（自动普攻也取配置名，不再写死“普攻”）
function shortSkillName(sid) {
  const sk = (window.SKILLS || {})[sid];
  const nm = String((sk && sk.name) || (autoSkillId() === sid ? '普攻' : (sid || '')));
  return nm.length > 4 ? nm.slice(0, 4) : nm;
}

const Touch = {
  active: false,
  visible: false,
  _joy: null,
  _knob: null,
  _btns: [],
  _joyR: 47,       // 摇杆有效半径（150px 摇杆盘与 56px 旋钮匹配）
  _pid: null,
  _cx: 0,
  _cy: 0,

  init() {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    // PC 与移动端都激活操作层：PC 用样式隐藏摇杆只显示右侧技能键，移动端全显
    this.active = true;
    this._joy = document.getElementById('joyBase');
    this._knob = document.getElementById('joyKnob');
    // 技能键数量与槽位全部由 config/skillbar.json 决定（见 refreshSkillKeys），代码里不再写死 8 键
    this.refreshSkillKeys();
    const layer = document.getElementById('touchLayer');
    if (!this._joy || !layer) return;
    // 摇杆有效半径按实际盘/钮尺寸计算（需求6 放大控件后仍保持旋钮贴边不越界）
    const jw = this._joy.offsetWidth || this._joy.clientWidth || 150;
    const kw = (this._knob && (this._knob.offsetWidth || this._knob.clientWidth)) || 56;
    this._joyR = Math.max(28, Math.round((jw - kw) / 2));
    Input.touchMode = coarse || ('ontouchstart' in window);
    // 需求4：触屏设备强制显示摇杆——避免个别浏览器/WebView 上报 (pointer:fine)
    // 命中桌面媒体查询把摇杆 display:none（事件逻辑正常却无控件可摸）
    if (Input.touchMode) {
      if (this._joy) this._joy.style.display = 'block';
      if (this._knob) this._knob.style.display = 'block';
    }

    // 虚拟摇杆：pointer capture 保持跟手
    const joy = this._joy;
    const down = e => {
      if (!Touch.visible) return;
      e.preventDefault();
      try { joy.setPointerCapture(e.pointerId); } catch (err) { /* 部分浏览器不支持 */ }
      Touch._pid = e.pointerId;
      const r = joy.getBoundingClientRect();
      Touch._cx = r.left + r.width / 2;
      Touch._cy = r.top + r.height / 2;
      Touch._moveJoy(e.clientX, e.clientY, true);
    };
    const move = e => {
      if (e.pointerId !== Touch._pid) return;
      e.preventDefault();
      Touch._moveJoy(e.clientX, e.clientY, false);
    };
    const up = e => {
      if (e.pointerId !== undefined && e.pointerId !== Touch._pid) return;
      Touch._pid = null;
      Input.touchMove = { x: 0, y: 0 };
      if (Touch._knob) Touch._knob.style.transform = 'translate(0,0)';
    };
    joy.addEventListener('pointerdown', down);
    joy.addEventListener('pointermove', move);
    joy.addEventListener('pointerup', up);
    joy.addEventListener('pointercancel', up);

    // 技能按钮：槽位 0..N-1 与出战 loadout 一一对应，N 由 config/skillbar.json 决定（见 refreshSkillKeys）。
    // 需求3：持续释放类技能（skills.json 里 auto:true 的自动普攻）点击 = 开/关切换（关闭后需等收招 CD），其余技能点击即发射。
    this.bindSkillButtons();
    // 需求4：不支持 PointerEvent 的旧移动端 WebView/内置浏览器 → touch 事件桥接（不重复绑定）
    if (!window.PointerEvent) {
      const pt = e => { const t = e.touches && e.touches[0]; return t ? { x: t.clientX, y: t.clientY } : null; };
      const joyR = joy.getBoundingClientRect();
      const resetJoy = () => {
        Touch._pid = null;
        Input.touchMove = { x: 0, y: 0 };
        if (Touch._knob) Touch._knob.style.transform = 'translate(0,0)';
      };
      joy.addEventListener('touchstart', e => {
        e.preventDefault();
        if (!Touch.visible) return;
        const pt0 = pt(e); if (!pt0) return;
        const r = joyR;
        Touch._cx = r.left + r.width / 2;
        Touch._cy = r.top + r.height / 2;
        Touch._moveJoy(pt0.x, pt0.y, true);
      }, { passive: false });
      joy.addEventListener('touchmove', e => {
        e.preventDefault();
        const pt0 = pt(e); if (!pt0) return;
        Touch._moveJoy(pt0.x, pt0.y, false);
      }, { passive: false });
      joy.addEventListener('touchend', resetJoy, { passive: false });
      joy.addEventListener('touchcancel', resetJoy, { passive: false });
    }
    // 横竖屏切换 / 视口尺寸变化后，按新的几何位置重新归一技能键顺序（幂等，正常布局下无变化）
    if (!window._p2pTouchOrderBound) {
      window._p2pTouchOrderBound = true;
      window.addEventListener('orientationchange', () => {
        setTimeout(() => { if (Touch.visible) Touch._syncOrder(); }, 160);
      });
      let _ordT = 0;
      window.addEventListener('resize', () => {
        clearTimeout(_ordT);
        _ordT = setTimeout(() => { if (Touch.visible) Touch._syncOrder(); }, 200);
      });
    }
  },

  // 技能键的槽位数 / 布局完全由 config/skillbar.json 决定，代码里不再写死键数。
  // http(s) 下用 fetch 读盘最新值（联机端也能生效），file:// 下回退到启动时载入的 window.SKILLBAR。
  refreshSkillKeys() {
    const apply = sb => { this.skillbar = sb || null; this.rebuildSkillKeys(); };
    try {
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && typeof fetch === 'function') {
        fetch('config/skillbar.json?v=' + Date.now(), { cache: 'no-store' })
          .then(r => (r && r.ok) ? r.json() : null)
          .then(j => { if (j) { window.SKILLBAR = j; apply(j); } })
          .catch(() => {});
      }
    } catch (e) { /* 读盘失败：保持现有键位 */ }
    apply(typeof SKILLBAR !== 'undefined' ? SKILLBAR : null);
  },

  // 槽位总数：布局数 capacity 与出战数 loadout 取「两者较大值」（既显示全部布局槽，也容得下超配出战），
  // 两者缺省时按 1 兜底
  skillSlots() {
    const sb = this.skillbar || {};
    const cap = Math.max(1, Math.floor(Number(sb.capacity)) || 0);
    const lo = Math.max(1, Math.floor(Number(sb.loadout)) || 0);
    return Math.max(cap, lo);
  },

  // 按配置重建技能键：槽位数取自 skillbar.json（capacity / loadout），键位布局由 #skillRow 的网格自动排布
  rebuildSkillKeys() {
    const layer = document.getElementById('touchLayer');
    if (!layer) return;
    let row = document.getElementById('skillRow');
    if (!row) {   // 技能键容器：键数量由配置生成，不再依赖 HTML 里写死的固定键
      const pad = document.getElementById('skillPad') || layer;
      row = document.createElement('div');
      row.id = 'skillRow';
      pad.appendChild(row);
    }
    const slots = this.skillSlots();
    while (row.children.length > slots) row.removeChild(row.lastElementChild);   // 配置减少 → 删多余键
    while (row.children.length < slots) {                                        // 配置增加 → 补键
      const b = document.createElement('button');
      b.type = 'button';
      b.appendChild(document.createElement('span'));
      row.appendChild(b);
    }
    for (let i = 0; i < slots; i++) {
      const b = row.children[i];
      b.id = 'btnSkill' + i;
      b.className = 'tp-btn tp-skill';        // 键样式由 CSS 的 .tp-btn/.tp-skill 统一提供，与键数无关
      b.setAttribute('data-slot', String(i));
      const sp = b.querySelector('span');
      if (sp && !sp.textContent) sp.textContent = (i === 0 ? '攻' : '技');
    }
    this._btns = Array.prototype.slice.call(row.children);
    // 每次重建后都重新走一遍绑定：技能键数量会随 config/skillbar.json 异步到达（capacity/loadout）
    // 由少变多，旧实现用 _skillBound 做"只绑一次"的守卫，后补出来的按钮永远拿不到 pointerdown 监听，
    // 表现为「键盘能放技能、鼠标/手指点技能格完全没反应」。
    // bindSkillButtons 内部按 btn._tpSkillBound 幂等，已绑定的按钮不会重复绑定。
    this.bindSkillButtons();
  },

  // 绑定技能键点击：槽位 0..N-1 与出战 loadout 一一对应（N 由配置决定）；持续释放类点击 = 开/关，其余点击即发射
  bindSkillButtons() {
    (this._btns || []).forEach(btn => {
      if (btn._tpSkillBound) return;   // 幂等：重建技能键后不重复绑定
      btn._tpSkillBound = true;
      btn.addEventListener('pointerdown', e => {
        e.preventDefault();
        const slot = parseInt(btn.getAttribute('data-slot'), 10);
        if (Touch.toggleSustain(slot)) return;
        Input.fireSlot(slot);
      });
      // 第三轮修正·需求③：手势抬起（pointerup / pointercancel）= 蓄力技能的"提前松手"。
      //   与键盘 keyup 完全同语义：只结束"按住"阶段，剩余蓄力时间继续走，读条走完才真正释放。
      const onUp = e => { if (Touch.endSkillGesture(parseInt(btn.getAttribute('data-slot'), 10))) e.preventDefault(); };
      btn.addEventListener('pointerup', onUp);
      btn.addEventListener('pointercancel', onUp);
      if (!window.PointerEvent) {
        btn.addEventListener('touchstart', e => {
          e.preventDefault();
          const slot = parseInt(btn.getAttribute('data-slot'), 10);
          if (Touch.toggleSustain(slot)) return;   // 需求3：持续技能开关（触屏桥接分支）
          Input.fireSlot(slot);
        }, { passive: false });
        btn.addEventListener('touchend', onUp, { passive: false });
      }
    });
  },

  // 第三轮修正·需求③：技能键手势抬起入口（pointerup / pointercancel / touchend 桥接）。
  //   仅当本机（本地玩家）正在蓄力「该槽位对应的蓄力技能」时才消费本次抬起，
  //   交由 world.releaseChargeGesture 走与 keyup 相同的"标记松手、继续读条"流程；
  //   其他技能的抬手不产生任何副作用（返回 false，不拦截默认行为）。
  endSkillGesture(slot) {
    const w = this._world || ((typeof App !== 'undefined' && App) ? App.world : null);
    if (!w || typeof w.releaseChargeGesture !== 'function') return false;
    const myId = (w.net && w.net.myId != null) ? w.net.myId
      : ((typeof App !== 'undefined' && App && App.net && App.net.myId != null) ? App.net.myId : null);
    if (myId == null) return false;
    const me = (w.players && w.players.get) ? w.players.get(myId) : null;
    const sid = (me && me.loadout) ? me.loadout[slot] : null;
    const q = w._charges;
    if (!sid || !q || !q.length) return false;
    const item = q.find(c => c.playerId === myId && c.skillId === sid);
    if (!item || item.hold === false) return false;   // 非按住型蓄力：无松手语义
    return w.releaseChargeGesture(myId) !== false;
  },

  // 第三轮修正·需求①/③：本机正在「读条 / 蓄力」中的技能 id（无则 null）。
  //   CastSystem 只为读条型释放方式登记本机实例（channel 持续释放 / charge 蓄力 / forbid 禁咒 / chant 吟唱），
  //   瞬间发射不登记。因此"本机存在施法实例"即等价于"该技能正在读条"，按钮据此进入持续释放态。
  _castingSkillId() {
    if (typeof CastSystem === 'undefined' || !CastSystem.instances) return null;
    const w = this._world;
    const myId = (w && w.net && w.net.myId != null) ? w.net.myId
      : ((typeof App !== 'undefined' && App && App.net && App.net.myId != null) ? App.net.myId : null);
    if (myId == null) return null;
    const it = CastSystem.instances[myId];
    if (!it || it.remote || !it.skillId) return null;
    return it.skillId;
  },

  // 需求3：持续技能（开关型，即 config/skills.json 里 auto:true 的自动普攻技能）的点按开关。
  // 返回 true = 该槽位是持续技能且本次点击已被本函数消费（不再走普通发射流程）。
  // 规则：开启 → 自动释放；再点关闭 → 进入"收招 CD"（_sustainOffCd 秒），CD 走完前不允许重新开启。
  toggleSustain(slot) {
    const me = (typeof App !== 'undefined' && App && App.world && App.net)
      ? App.world.players.get(App.net.myId) : null;
    const autoId = autoSkillId();
    if (!me || !me.loadout || me.loadout[slot] !== autoId) return false;
    const now = performance.now();
    const offAt = (me._sustainOffAt && me._sustainOffAt[autoId]) || 0;
    const coolingLeft = offAt > 0 ? this._sustainOffCd - (now - offAt) / 1000 : 0;
    if (App.autoAttack) {
      // 关闭：登记收招 CD 起点（_paint 内亦会幂等补登记），随后进入 CD 读秒
      me._sustainOffAt = me._sustainOffAt || {};
      me._sustainOffAt[autoId] = now;
      me._sustainOn = false;
      if (App.setAutoAttack) App.setAutoAttack(false); else App.autoAttack = false;
    } else {
      if (coolingLeft > 0) return true;   // 收招 CD 未走完：吞掉点击，视觉上继续读秒
      me._sustainOn = true;
      if (App.setAutoAttack) App.setAutoAttack(true); else App.autoAttack = true;
    }
    this._lastCdTick = 0;                 // 状态已变：下一帧立即重绘（不等 0.3s 档）
    this._paint(me);
    return true;
  },

  setVisible(v) {
    this.visible = !!v;
    const layer = document.getElementById('touchLayer');
    if (layer) layer.style.display = (this.active && this.visible) ? 'block' : 'none';
    if (this.active && this.visible) this._syncOrder();   // 上屏后按屏幕真实几何顺序归一槽位
    if (!this.visible) {
      Input.touchMove = { x: 0, y: 0 };
      Input.touchAim = null;
    }
  },

  // 本轮修复：技能键"第一个=槽0、最后一个=槽7"在 PC 与移动端保持一致。
  // 旧实现只依赖 DOM 顺序 + CSS 网格，部分移动端浏览器（横屏镜像 / RTL 继承 / 旧 WebView）
  // 会把网格渲染成反向，表现为"移动端第一个技能与 PC 端最后一个技能对调"。
  // 这里按按钮在屏幕上的真实几何位置（先上后下、同一行先左后右）重排按钮数组并回写 data-slot，
  // 使显示位置与释放槽位永远对应；布局正常时重排结果与 DOM 顺序一致，幂等无副作用。
  _syncOrder() {
    // 需求3（本轮重写）：技能键顺序严格按 DOM / data-slot 固定为「第1格=槽0（普攻）… 第8格=槽7」。
    // 旧实现按屏幕几何位置（先上后下、同行先左后右）排序并回写 data-slot：网格换行方式 / 视口缩放 /
    // 横竖屏切换瞬间算出的次序会与 PC 不同，把 slot 映射写乱，表现为「移动端第一个技能不是普攻」。
    // 现在只做幂等归一：按 data-slot 升序整理数组并回写 order，显示位与释放槽位永久一一对应。
    if (!this._btns || this._btns.length < 2) return;
    this._btns = this._btns.slice().sort((a, b) => {
      return (parseInt(a.getAttribute('data-slot'), 10) || 0) - (parseInt(b.getAttribute('data-slot'), 10) || 0);
    });
    this._btns.forEach((btn, i) => {
      btn.setAttribute('data-slot', String(i));
      btn.style.order = String(i);   // CSS order 兜底：即便个别浏览器网格反向渲染，显示位仍按槽位固定
    });
  },

  _moveJoy(clientX, clientY, press) {
    let dx = clientX - this._cx;
    let dy = clientY - this._cy;
    const dist = Math.hypot(dx, dy);
    const R = this._joyR;
    if (dist > R) { dx = dx / dist * R; dy = dy / dist * R; }
    if (this._knob) this._knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    if (press && dist < 8) { Input.touchMove = { x: 0, y: 0 }; return; }
    Input.touchMove = dist > 4 ? { x: dx / R, y: dy / R } : { x: 0, y: 0 };
  },

  // 每帧更新：自瞄（最近存活敌人方向，无敌人回退摇杆方向）+ 按钮 CD/就绪视觉
  frame(me, world) {
    if (!this.active || !this.visible || !me || !world) return;
    this._world = world;   // 第三轮修正·需求①/③：按钮态需要读 CastSystem 的本机施法实例
    let best = null, bd = Infinity;
    world.players.forEach(p => {
      if (p === me || !p.alive || p.team === me.team) return;
      const d = (p.x - me.x) * (p.x - me.x) + (p.y - me.y) * (p.y - me.y);
      if (d < bd) { bd = d; best = p; }
    });
    if (best) {
      const len = Math.sqrt(bd) || 1;
      Input.touchAim = { x: (best.x - me.x) / len, y: (best.y - me.y) / len };
    } else if (Input.touchMove.x || Input.touchMove.y) {
      const l = Math.hypot(Input.touchMove.x, Input.touchMove.y) || 1;
      Input.touchAim = { x: Input.touchMove.x / l, y: Input.touchMove.y / l };
    }
    this._paint(me);
  },

  // 按钮视觉（三态+）：就绪 ready / CD 读秒 cooling（0.3s 一档转圈遮罩 + 剩余秒）/
  //   持续释放 casting（旋转 LOADING 光环）——第三轮修正后，读条（channel/禁咒/吟唱）与蓄力（charge）
  //   进行中的技能，其按钮同样进入 casting，不再只显示读条而不进按钮态。
  _sustainOffCd: 1.0,   // 需求3：关闭持续释放类技能（普攻）后的“收招”CD（秒），期间不允许再次开启
  _lastCdTick: 0,
  _paint(me) {
    if (!this._btns.length) return;
    const now = performance.now();
    const doTick = now - this._lastCdTick >= 300;   // 0.3s 一档刷新倒计时视觉
    if (doTick) this._lastCdTick = now;
    const castSid = this._castingSkillId();   // 第三轮修正·需求①/③：本机读条/蓄力中的技能 id（无则 null）
    // 需求3：App 是 main.js 顶层的 const（全局词法绑定），不会挂到 window 上；
    // 旧代码用 window.App 恒为 undefined，导致持续释放态永远判定为“关闭”，按钮一直卡在 CD 转圈。
    const autoOn = !!(typeof App !== 'undefined' && App && App.autoAttack);
    const autoId = autoSkillId();   // 持续技能判定：config/skills.json 的 auto:true 条目（每帧解析一次）
    this._btns.forEach((btn, i) => {
      const label = btn.querySelector('span');
      const wasCooling = btn.classList.contains('cooling');
      btn.classList.remove('ready', 'cooling', 'casting', 'empty');
      const sid = me && me.loadout ? me.loadout[i] : null;
      // 本轮改动：所有技能底色统一为一套色系，不再按技能各自的子弹颜色着色
      // （原先 color 取自 BULLETS[sk.bullet].color，导致每个技能一种底色）。
      const SKILL_READY_BASE = '#5b8cff';
      if (sid) {
        const sk = (window.SKILLS || {})[sid];
        const cdLeft = (me.skillCd && me.skillCd[sid]) || 0;
        // 需求3：持续释放类技能（即 auto:true 的自动普攻技能，只有 开/关 两态）——
        // 开：按钮走“释放中”旋转光环（LOADING）；关：才进入收招 CD 读秒。
        const isSustain = sid === autoId;
        const sustainOn = isSustain && autoOn;
        if (isSustain && me._sustainOn && !sustainOn) {
          me._sustainOffAt = me._sustainOffAt || {};
          me._sustainOffAt[sid] = now;      // 关闭瞬间登记收招 CD 起点
        }
        if (isSustain) me._sustainOn = sustainOn;
        const offLeft = (isSustain && !sustainOn && me._sustainOffAt && me._sustainOffAt[sid])
          ? Math.max(0, this._sustainOffCd - (now - me._sustainOffAt[sid]) / 1000) : 0;
        if (sustainOn) {
          // 第三态：持续释放中（旋转光环）。此态优先于 CD —— 持续施放期间技能本身会不停刷新冷却，
          // 若按 CD 判断会表现为“CD 一直在转、永远转不完”，与需求3 的期望相反。
          btn.classList.add('casting');
          if (label) label.textContent = shortSkillName(sid);
          btn.style.removeProperty('--cd');
        } else if (castSid && castSid === sid) {
          // 第三轮修正·需求①/③：读条 / 蓄力进行中 → 「持续释放中」态（沿用同一套转圈光环）。
          //   该分支必须早于 CD 判断：deferCd 机制下读条期间 CD 尚未落实（skillCd 仍为 0），
          //   旧实现会把按钮判成「就绪可点」，表现为"只在屏幕里读条、按钮不进态"。
          //   蓄力提前松手后（item.released）读条继续走，故此态一直保持到真正出膛。
          btn.classList.add('casting');
          if (label) label.textContent = shortSkillName(sid);
          btn.style.removeProperty('--cd');
        } else if (offLeft > 0) {
          // 关闭持续释放：进入收招 CD 读秒，读秒结束回到就绪态
          btn.classList.add('cooling');
          const deg = Math.max(0, Math.min(360, (offLeft / this._sustainOffCd) * 360));
          if (doTick || !wasCooling) {
            if (label) label.textContent = (Math.ceil(offLeft * 10) / 10).toFixed(1);
            btn.style.setProperty('--cd', deg.toFixed(1) + 'deg');
          }
        } else if (cdLeft > 0) {
          // 第二态：CD 读秒。转圈遮罩角度 = 剩余冷却占比，0.3s 档随倒计时收窄
          btn.classList.add('cooling');
          const total = Math.max((sk && sk.cd) || 0, 0.001);
          const deg = Math.max(0, Math.min(360, (cdLeft / total) * 360));
          if (doTick || !wasCooling) {
            if (label) label.textContent = (Math.ceil(cdLeft * 10) / 10).toFixed(1);
            btn.style.setProperty('--cd', deg.toFixed(1) + 'deg');
          }
        } else {
          // 第一态：准备就绪，可点击释放（显示技能名，不再千篇一律“攻/技”）
          btn.classList.add('ready');
          if (label) label.textContent = shortSkillName(sid);
          btn.style.removeProperty('--cd');
        }
      } else {
        btn.classList.add('empty');
        if (label) label.textContent = '';
        btn.style.removeProperty('--cd');
      }
      // 需求3 视觉分层：就绪/待开启 = 浅色亮底；CD 读秒 = 深色暗底（叠加 conic 暗遮罩）；
      // 持续释放 = 深底 + 高对比亮色光环（光环由 CSS .tp-skill.casting::before 提供）
      if (btn.classList.contains('empty')) {
        btn.style.background = 'radial-gradient(circle at 35% 30%, #232a3d 0%, #0a0d16 130%)';
      } else if (btn.classList.contains('cooling')) {
        btn.style.background = 'radial-gradient(circle at 35% 30%, #121a2b 0%, #04060c 130%)';
      } else if (btn.classList.contains('casting')) {
        // 持续释放：深底（与 CD 同一套深蓝底色）+ 高对比亮金光环（见 CSS .tp-skill.casting::before）
        btn.style.background = 'radial-gradient(circle at 35% 30%, #121a2b 0%, #04060c 130%)';
      } else {
        // 就绪：统一浅色亮底（不再逐个技能取色）
        btn.style.background = 'radial-gradient(circle at 35% 30%, ' + SKILL_READY_BASE + ' 0%, rgba(86, 124, 214, .95) 135%)';
      }
    });
  }
};

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => Touch.init());
} else {
  Touch.init();
}
