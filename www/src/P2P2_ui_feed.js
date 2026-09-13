// ===== 中上纵向滚动提示区（FxFeed，本轮新增）=====
// 用途：统一承载屏幕中上部的滚动提示——点击底部 buff 图标的效果说明、Boss 阶段/狂暴横幅文本等。
// 表现：多条提示自下而上堆叠；新消息贴底加入时，已有消息整体"上挤"（错峰过渡，一条条顶上去）；
//       每条按自己的停留时长渐隐渐出；文案按强度分档取不同字号 / 颜色 / 上挤速度。
// 实现：纯 DOM（position:fixed 层，不依赖 PIXI 与相机），容器底部对齐、条目绝对定位 + transform 过渡实现挤出动画，
//       自建 rAF 循环计时（与游戏主循环解耦，返回菜单/战斗结束由 clear() 清空）。
const FxFeed = {
  MAX: 6,             // 同屏最多条数（PC），超出时最旧一条先渐隐退出（再被新消息顶上）
  MAX_COARSE: 4,      // 移动端同屏最多条数：屏幕矮、提示区小，压到 4 条以内避免最新之外的消息被容器顶边裁掉
  GAP: 8,             // 条目间距（px）
  LIFE: { 3: 3.2, 2: 2.5, 1: 1.9 },      // 各档停留秒数
  EASE: { 3: 0.58, 2: 0.44, 1: 0.32 },   // 各档"上挤"过渡时长（秒，档位越高越慢/越沉）
  SIZE: { 3: 21, 2: 17, 1: 14 },         // 各档字号（px）

  _items: [],
  _el: null,
  _raf: 0,

  // 懒创建容器（#fxFeed 写在 index.html 亦可；此处兜底自建，保证任何调用时机都可用）
  ensure() {
    if (this._el && this._el.parentNode) return this._el;
    let el = document.getElementById('fxFeed');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fxFeed';
      document.body.appendChild(el);
    }
    this._el = el;
    this._start();
    return el;
  },

  // 端别上限：触屏端（移动端）压到 4 条，PC 6 条
  _maxCount() {
    return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? this.MAX_COARSE : this.MAX;
  },

  // 实际同屏上限（本轮改动）：取「端别上限」与「容器高度能完整容纳的条数」中的较小值。
  // 提示区高度是 vh 定的、字号随端别变化，写死条数会在矮屏/大字号下把最上面的消息顶出容器被裁掉半截；
  // 这里用最近几条的实际高度估算可容纳条数，保证屏上每条提示都完整可见。
  _fitCount(itemH) {
    const base = this._maxCount();
    const h = (this._el && this._el.clientHeight) || 0;
    if (h <= 0) return base;
    const hs = this._items.slice(-3).map(it => it.h).filter(n => n > 0);
    const ih = hs.length ? Math.max.apply(null, hs) : (itemH || 30);
    const fit = Math.floor(h / (ih + this.GAP));   // 容器高度能完整容纳的条数
    return Math.max(1, Math.min(base, fit));
  },

  // 强度分档：无敌/护盾/狂暴类最强（大字号、停留久、上挤慢），普通增益次之，其余最轻
  tierOf(text) {
    const s = String(text || '');
    if (/无敌|免疫|狂暴|暴怒|护盾|护体|冰晶|第三阶段|第二阶段|狂暴阶段|阶段/.test(s)) return 3;
    if (/提高|提升|攻速|移速|吸血|加速|迅捷|强化|重铸|解锁/.test(s)) return 2;
    return 1;
  },

  // 按 buff 配置分档（点击 buff 图标说明走这里）
  tierOfBuff(def) {
    if (!def) return 1;
    if (def.kind === 'invuln' || def.kind === 'shield') return 3;
    const st = def.stats || {};
    if ((st.damageMul || 0) >= 0.5) return 3;
    if ((st.damageMul || 0) > 0 || (st.atkSpeedMul || 0) > 0 || (st.speedMul || 0) > 0) return 2;
    if (def.kind === 'lifesteal') return 2;
    return 1;
  },

  // push：插入一条提示（自下而上，已有条目自动上挤）
  push(text, color, tier) {
    text = String(text == null ? '' : text).trim();
    if (!text) return false;
    const now = performance.now() / 1000;
    // 去重：同一文案 0.35s 内重复触发只保留一条（chip 自身绑定 + document 委托会各触发一次）
    for (const it of this._items) {
      if (!it.dead && it.text === text && now - it.born < 0.35) return false;
    }
    if (typeof tier !== 'number' || !this.LIFE[tier]) tier = this.tierOf(text);
    const el = this.ensure();
    const node = document.createElement('div');
    node.className = 'fx-item';
    node.style.setProperty('--c', color || '#8be9ff');
    node.style.setProperty('--ease', this.EASE[tier] + 's');
    // 需求4：触屏（移动端）提示文本整体收小一档，避免大面积遮挡战斗画面；PC 保持原字号
    const _k = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 0.75 : 1;
    node.style.fontSize = Math.round(this.SIZE[tier] * _k) + 'px';
    node.textContent = text;
    el.appendChild(node);
    const h = node.offsetHeight || 26;
    this._items.push({ el: node, text: text, h: h, born: now, life: this.LIFE[tier], dead: false, dieAt: 0 });
    // 超过上限：按「超出条数」退掉最旧的若干条（其占位在淡出后由 _layout 收拢）；上限按端别 + 容器高度自适应。
    // 修复：旧写法 while(length>cap){ retire(find(第一条未dead)) } 的循环条件用的是数组长度，
    // 而退场只是标记 dead、不移出数组 —— 条件永远成立，会一路退到只剩最新一条（超出上限时消息整批消失）。
    const cap = this._fitCount(h);
    let over = this._items.filter(it => !it.dead).length - cap;   // 只按仍可见的条数算差额（dead 条目仍占数组位，不能计）
    for (let i = 0; i < this._items.length && over > 0; i++) {
      const it = this._items[i];
      if (it.dead) continue;                                     // 已在淡出的不重复退
      if (it === this._items[this._items.length - 1]) break;      // 兜底：不主动退掉刚加入的最新一条
      this._retire(it);
      over--;
    }
    this._layout();
    return true;
  },

  // 渐隐退出：先 opacity→0（0.45s 后真正移除）
  _retire(it) {
    if (!it || it.dead) return;
    it.dead = true;
    it.dieAt = performance.now() / 1000;
    it.el.style.opacity = '0';
    if (it.el.classList) it.el.classList.add('out');
  },

  // 重排：最新一条贴容器底部，向上逐条堆叠（transform 过渡即为"上挤"动画）
  _layout() {
    let acc = 0;
    for (let i = this._items.length - 1; i >= 0; i--) {
      const it = this._items[i];
      it.el.style.transform = 'translate(-50%, ' + (-acc) + 'px)';
      acc += it.h + this.GAP;
    }
  },

  _start() {
    if (this._raf) return;
    const step = () => {
      this._raf = requestAnimationFrame(step);
      const now = performance.now() / 1000;
      let removed = false;
      for (const it of this._items) {
        if (!it.dead && now - it.born > it.life) this._retire(it);
      }
      this._items = this._items.filter(it => {
        if (it.dead && now - it.dieAt > 0.45) {
          try { it.el.remove(); } catch (e) { /* ignore */ }
          removed = true;
          return false;
        }
        return true;
      });
      if (removed) this._layout();
    };
    this._raf = requestAnimationFrame(step);
  },

  // 战斗结束/返回菜单：清空全部提示
  clear() {
    for (const it of this._items) { try { it.el.remove(); } catch (e) { /* ignore */ } }
    this._items = [];
  }
};

window.FxFeed = FxFeed;
