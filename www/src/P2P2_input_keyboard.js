// ===== 输入 =====
// WASD 移动，鼠标仅用于点击技能按钮（不承担攻击）；触屏设备使用虚拟摇杆 + 技能触摸键（键数见 touch.js）。
// PC 端技能释放：数字键对应出战技能槽，键数由 config/skillbar.json 的 capacity 决定；方向默认瞄准（aim() 鼠标/自瞄）。
// 按键→技能槽映射放在这里，后续换键位只改本文件。

const Input = {
  keys: {},
  mouse: { x: 0, y: 0, down: false, rdown: false },
  // 触屏模式（touch.js 注入）：虚拟摇杆方向 / 自瞄方向 / 技能点击队列
  touchMode: false,
  touchMove: { x: 0, y: 0 },
  touchAim: null,
  touchQueue: [],
  // 自瞄缓存：main 每帧 updateSelf 注入最近敌方方向（PC/触屏统一，需求5）
  _autoAim: null,
  selfPos: null,
  // 基础键位映射到出战技能槽：键数与键位由 config/skillbar.json 的 capacity 生成（见 buildSkillKeys），
  // 代码里不再写死 Digit1~Digit8；配置缺字段时才退回默认 8 键。
  skillKeys: [],

  // 技能栏槽位数：读 config/skillbar.json 的 capacity，字段缺失时退回默认值 8
  skillSlotCapacity() {
    const sb = (typeof SKILLBAR !== 'undefined' && SKILLBAR) || (typeof window !== 'undefined' && window.SKILLBAR) || {};
    const cap = Math.floor(Number(sb.capacity)) || 0;
    return cap > 0 ? cap : 8;
  },

  // 按配置生成技能键位：capacity 个数字键（第 1~9 格 = Digit1~Digit9，第 10 格 = Digit0）；
  // 配置改动后由 rebuildSkillKeys() 重新生成，fireSlot() 的槽位取模同步跟随。
  buildSkillKeys() {
    const n = this.skillSlotCapacity();
    const keys = [];
    for (let i = 1; i <= n; i++) {
      if (i <= 9) keys.push('Digit' + i);
      else if (i === 10) keys.push('Digit0');
    }
    this.skillKeys = keys;
    return keys;
  },
  // 配置刷新入口（由 main.js refreshGameCfg() 调用）：按最新 skillbar.json 重建 PC 技能键位
  rebuildSkillKeys() { return this.buildSkillKeys(); },

  init(canvas) {
    this.buildSkillKeys();   // 键位数量取自 config/skillbar.json capacity（缺字段退回 8 键）
    window.addEventListener('keydown', e => {
      // 菜单输入框（昵称/房间码）打字时不拦截，战斗按键才生效
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing) return;
      if (this.skillKeys.indexOf(e.code) >= 0) {
        this.keys[e.code] = true;
        e.preventDefault();
        return;
      }
      this.keys[e.code] = true;
      if (e.code !== 'ShiftLeft' && e.code !== 'ShiftRight') e.preventDefault();
    });
    window.addEventListener('keyup', e => { this.keys[e.code] = false; });
    canvas.addEventListener('mousemove', e => {
      const r = canvas.getBoundingClientRect();
      this.mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
      this.mouse.y = (e.clientY - r.top) * (canvas.height / r.height);
    });
    // 鼠标左右键不再承担攻击（需求6：鼠标只用于点击技能按钮释放技能）
    canvas.addEventListener('mousedown', e => { e.preventDefault(); });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  },

  // 触屏技能键：入队一帧待消费（方向用 aim() 里算好的自瞄/摇杆方向）
  // 槽位取模数由 config/skillbar.json 的 capacity 决定，不再写死 8
  fireSlot(slot) {
    const cap = this.skillSlotCapacity();
    const s = ((slot % cap) + cap) % cap;
    this.touchQueue.push({ slot: s, dir: this.aim() });
  },

  moveDir() {
    // 触屏：虚拟摇杆优先。只要有摇杆输入即消费，不再依赖 touchMode 布尔
    // （修复部分移动端浏览器 pointer:coarse 误判 / ontouchstart 缺失导致的方向盘失灵）
    if (this.touchMove.x || this.touchMove.y) {
      const l = Math.hypot(this.touchMove.x, this.touchMove.y) || 1;
      return { x: this.touchMove.x / l, y: this.touchMove.y / l };
    }
    let x = 0, y = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp']) y -= 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) y += 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) x -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) x += 1;
    const len = Math.hypot(x, y);
    return len ? { x: x / len, y: y / len } : { x: 0, y: 0 };
  },

  // 技能触发状态：每帧调用后返回 { slot, dir } 或 null（slot 为出战技能槽，槽数由 skillbar.json capacity 决定）
  consumeSkill() {
    // 触屏点击的技能优先消费
    if (this.touchQueue.length) return this.touchQueue.shift();
    // PC：数字键按 skillKeys（由 capacity 生成）依次映射槽 0~N-1（无第二页，去掉 Shift 翻页）
    for (let i = 0; i < this.skillKeys.length; i++) {
      const code = this.skillKeys[i];
      if (this.keys[code]) {
        this.keys[code] = false;
        return { slot: i, dir: this.aim() };
      }
    }
    return null;
  },

  // 每帧由 main 注入：记录本地玩家位置，并自瞄最近存活敌人（无敌人时清空，技能空放回退鼠标方向）
  updateSelf(me, world) {
    if (!me || !world) { this._autoAim = null; return; }
    this.selfPos = { x: me.x, y: me.y };
    let best = null, bd = Infinity;
    world.players.forEach(p => {
      if (p === me || !p.alive || p.team === me.team) return;
      const dx = p.x - me.x, dy = p.y - me.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = p; }
    });
    if (best) {
      const l = Math.sqrt(bd) || 1;
      this._autoAim = { x: (best.x - me.x) / l, y: (best.y - me.y) / l };
    } else {
      this._autoAim = null;
    }
  },

  aim() {
    // 触屏：优先自瞄（touch.js 每帧更新 touchAim：最近敌人或摇杆方向）
    if (this.touchMode && this.touchAim) return this.touchAim;
    // PC/触屏统一自瞄：最近存活敌人方向（需求5：释放自动瞄准，不再手动瞄准）
    if (this._autoAim) return this._autoAim;
    // 无敌人时的兜底：鼠标指向（仅用于空放）
    if (!this.selfPos) return { x: 1, y: 0 };
    const dx = this.mouse.x - this.selfPos.x;
    const dy = this.mouse.y - this.selfPos.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }
};
