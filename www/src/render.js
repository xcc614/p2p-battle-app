// ===== Canvas 渲染（PixiJS v8，WebGL/WebGPU，GPU 加速）=====
// 分层渲染：viewport(背景/子弹/实体/特效) + HUD。
// 角色圆形色块 / 贴图二选一；子弹支持圆弹、光束(beam)两类渲染。
// 特效系统：fxQueue（World 事件队列）→ 火花/爆炸/光环/横幅/震屏；另有粒子扩展点 fxBurst。

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.app = null;
    this.viewport = null;
    this.bgLayer = null;
    this.bulletLayer = null;
    this.entityLayer = null;
    this.fxLayer = null;
    this.hudLayer = null;
    this.entityViews = new Map();   // playerId -> { root, spr, hpBg, hpBar, nameText, texKey }
    this.bulletViews = new Map();   // bulletId -> { spr, texKey }
    this.dropViews = new Map();     // buffDropId -> { root, t0 }（P2 场地掉落物）
    this.fxSprites = [];            // { spr, life, max, kind, vx, vy, grow, baseScale }
    this.texCache = new Map();      // colorKey -> Texture（色块纹理缓存）
    this._white = null;             // 1x1 白纹理（血条染色用）
    this._ring = null;              // 白色圆环纹理（光环特效）
    this._shakeT = 0;
    // 全局开关：子弹发光外圈(glow)。false = 所有子弹都不再绘制光晕。
    // 配置(config/bullets.json 的 glow/glowColor/glowScale/glowAlpha)与渲染代码保留，改回 true 即可恢复。
    this.glowEnabled = false;
    // 需求1：中央横幅队列（多条阶段/状态文本依序展示，避免一次性堆叠在同一坐标）
    this._bannerQueue = [];
    this._bannerCur = null;
    this._bannerAt = 0;
  }

  async init() {
    const app = new PIXI.Application();
    await app.init({
      canvas: this.canvas,
      width: GAME_CONFIG.ARENA.w,
      height: GAME_CONFIG.ARENA.h,
      backgroundColor: GAME_CONFIG.RENDER.background,
      antialias: GAME_CONFIG.RENDER.antialias,
      resolution: GAME_CONFIG.RENDER.resolution || window.devicePixelRatio || 1,
      preference: GAME_CONFIG.RENDER.mode   // 'webgl' | 'webgpu'
    });
    this.app = app;

    this.bgLayer = new PIXI.Container();
    this.bulletLayer = new PIXI.Container();
    this.entityLayer = new PIXI.Container();
    this.fxLayer = new PIXI.Container();
    this.hudLayer = new PIXI.Container();
    this.viewport = new PIXI.Container();
    this.viewport.addChild(this.bgLayer, this.bulletLayer, this.entityLayer, this.fxLayer);
    app.stage.addChild(this.viewport, this.hudLayer);
    // 需求1/2：已删除原「屏幕边缘四色光条」_edgeHint（贴屏幕的装饰边框，其右上角交汇处
    // 在窄屏/贴边时表现为彩色光块）。边界只由世界坐标的地图边界墙（_drawGrid）表达，
    // stage 上不再挂任何屏幕坐标装饰层。

    this._white = this._colorTexture('#ffffff', 1);
    this._ring = this._ringTexture('#ffffff');
    this._drawGrid();
    this._buildHud();
    return this;
  }

  // ---- 纹理工具 ----
  _colorTexture(hexColor, r) {
    const key = hexColor + '_' + r;
    if (this.texCache.has(key)) return this.texCache.get(key);
    const c = document.createElement('canvas');
    const size = Math.max(2, Math.ceil(r * 2));
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.beginPath();
    g.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    g.fillStyle = hexColor;
    g.fill();
    const t = PIXI.Texture.from(c);
    this.texCache.set(key, t);
    return t;
  }

  _ringTexture(color) {
    const key = color + '_ring';
    if (this.texCache.has(key)) return this.texCache.get(key);
    const c = document.createElement('canvas');
    const S = 64;
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.strokeStyle = color;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 5, 0, Math.PI * 2);
    g.stroke();
    const t = PIXI.Texture.from(c);
    this.texCache.set(key, t);
    return t;
  }

  _hexNum(color) {
    if (typeof color === 'number') return color;
    return parseInt(String(color || '#ffffff').replace('#', ''), 16) || 0xffffff;
  }

  // 实体取纹理：有 image 用贴图，否则色块
  _entityTexture(entity, fallbackColor, size) {
    const tex = Assets.spriteOf(entity);
    if (tex) return { tex, key: entity.image };
    return { tex: this._colorTexture(fallbackColor, size), key: fallbackColor };
  }

  // 通用形状纹理：64 画布中心绘制 + 缓存，Sprite 拉伸到目标尺寸
  // （P3：新增 arrow/triangle/diamond/square/star/ring，供 bullets.json 按 shape 配置；无图/贴图依赖）
  _shapeTexture(shape, color) {
    const key = 'shape_' + shape + '_' + color;
    if (this.texCache.has(key)) return this.texCache.get(key);
    const c = document.createElement('canvas');
    const S = 64, mid = 32, R = 24;
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.strokeStyle = color;
    g.beginPath();
    if (shape === 'ring') {
      g.arc(mid, mid, R - 5, 0, Math.PI * 2);
      g.lineWidth = 6;
      g.stroke();
    } else if (shape === 'square') {
      g.rect(mid - R * 0.85, mid - R * 0.85, R * 1.7, R * 1.7);
      g.fill();
    } else if (shape === 'diamond') {
      g.moveTo(mid, mid - R); g.lineTo(mid + R, mid); g.lineTo(mid, mid + R); g.lineTo(mid - R, mid);
      g.closePath(); g.fill();
    } else if (shape === 'star') {
      const p = 5;
      for (let i = 0; i < p * 2; i++) {
        const rad = i % 2 === 0 ? R : R * 0.45;
        const a = -Math.PI / 2 + (i * Math.PI) / p;
        const x = mid + Math.cos(a) * rad, y = mid + Math.sin(a) * rad;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
    } else if (shape === 'arrow') {
      // 尖头箭头：头部右侧顶点，视觉沿飞行方向拉伸（需配合 sprite 旋转）
      g.moveTo(mid + R, mid);
      g.lineTo(mid - R * 0.82, mid - R * 0.74);
      g.lineTo(mid - R * 0.22, mid);
      g.lineTo(mid - R * 0.82, mid + R * 0.74);
      g.closePath(); g.fill();
    } else if (shape === 'triangle') {
      g.moveTo(mid + R, mid);
      g.lineTo(mid - R * 0.72, mid - R);
      g.lineTo(mid - R * 0.72, mid + R);
      g.closePath(); g.fill();
    } else {
      g.arc(mid, mid, R, 0, Math.PI * 2);
      g.fill();
    }
    const t = PIXI.Texture.from(c);
    this.texCache.set(key, t);
    return t;
  }

  _refreshEntitySprite(v, p) {
    const { tex, key } = this._entityTexture(p, p.effColor, p.radius);
    const spr = new PIXI.Sprite(tex);
    spr.anchor.set(0.5);
    spr.width = spr.height = p.radius * 2;
    if (v.root.children.indexOf(v.spr) === 0) v.root.removeChildAt(0);
    else v.root.removeChild(v.spr);
    v.root.addChildAt(spr, 0);
    v.spr = spr;
    v.texKey = key;
  }

  _drawGrid() {
    const W = GAME_CONFIG.ARENA.w, H = GAME_CONFIG.ARENA.h;
    const CELL = 80;
    // 需求2：场外空白缓冲区按"当前视口尺寸"决定（≥ 半屏世界尺寸 + 余量），
    // 玩家贴到任一边界墙时外露的空白都能被底色铺满（不会露黑）；窗口变大时由
    // ensureOuterArea() 按需重建本层。
    // 移动端视野放宽 2.5 倍：相机缩放 1.55 / 2.5 ≈ 0.62，
    // 屏幕内可见的世界范围变为原来的 2.5 倍（PC 端维持 1.22 不变）。
    const zc = this._coarse ? 0.62 : 1.22;
    const scrC = (this.app && this.app.screen) || { width: window.innerWidth || W, height: window.innerHeight || H };
    const needExt = Math.max(scrC.width, scrC.height) / zc / 2 + CELL * 4;
    const EXT = Math.max(2600, Math.ceil(needExt / CELL) * CELL);
    const bg = GAME_CONFIG.RENDER.background;
    // 重建前先移除上一次的三张图（resize 扩容时会再次进入本方法）
    if (this._gridNodes) {
      this._gridNodes.forEach(n => { try { this.bgLayer.removeChild(n); n.destroy(); } catch (e) {} });
      this._gridNodes = null;
    }
    // 三段分别用独立 Graphics，避免 fill/stroke 混用时路径互相叠加导致“网格与背景区不一致”
    // 1) 场外空白缓冲区（需求2）：只填充背景色——不画网格线、不加边框、不放任何装饰元素
    const gOut = new PIXI.Graphics();
    gOut.rect(-EXT, -EXT, W + EXT * 2, H + EXT * 2).fill(bg);
    this.bgLayer.addChild(gOut);
    this._outerExt = EXT;
    // 2) 场地：底色 + 网格（与场地边界严格 0..W / 0..H 对齐）
    const g = new PIXI.Graphics();
    g.rect(0, 0, W, H).fill(bg);
    for (let x = 0; x <= W; x += CELL) { g.moveTo(x, 0); g.lineTo(x, H); }
    for (let y = 0; y <= H; y += CELL) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke({ width: 1, color: 0xa8b0b7 });
    this.bgLayer.addChild(g);
    const gw = new PIXI.Graphics();
    // 3) 地图边界墙（需求1）：围绕整个可活动场地（世界坐标 0..W / 0..H）画四面实体墙，
    //    四面使用同一套配色（墙体主色 + 内沿亮边 + 外沿暗边），不再四色各异；
    //    也不再绘制任何屏幕坐标的装饰边框（原 _edgeHint 已删除），
    //    因此「墙」在世界里随相机移动，只有走到地图边缘才会贴到屏幕边。
    const T = 26;                     // 墙厚（世界像素）
    const C_WALL = 0x3f4f9e;          // 墙体主色（四面统一）
    const C_IN = 0xe8eeff;            // 内沿亮边（贴场地一侧，标示可活动区域边界）
    const C_OUT = 0x1d2540;           // 外沿暗边（与场外延伸区分隔）
    gw.rect(-T, -T, W + T * 2, T).fill(C_WALL);       // 上墙
    gw.rect(-T, H, W + T * 2, T).fill(C_WALL);        // 下墙
    gw.rect(-T, 0, T, H).fill(C_WALL);                // 左墙
    gw.rect(W, 0, T, H).fill(C_WALL);                 // 右墙
    // 四角补齐（相邻两面墙在角落交汇处的方形块）
    gw.rect(-T, -T, T, T).fill(C_WALL);
    gw.rect(W, -T, T, T).fill(C_WALL);
    gw.rect(-T, H, T, T).fill(C_WALL);
    gw.rect(W, H, T, T).fill(C_WALL);
    // 内沿亮边（4px，贴场地一侧）
    gw.rect(-T, -4, W + T * 2, 4).fill(C_IN);
    gw.rect(-T, H, W + T * 2, 4).fill(C_IN);
    gw.rect(-4, -T, 4, H + T * 2).fill(C_IN);
    gw.rect(W, -T, 4, H + T * 2).fill(C_IN);
    // 外沿暗边（4px）
    gw.rect(-T, -T, W + T * 2, 4).fill(C_OUT);
    gw.rect(-T, H + T - 4, W + T * 2, 4).fill(C_OUT);
    gw.rect(-T, -T, 4, H + T * 2).fill(C_OUT);
    gw.rect(W + T - 4, -T, 4, H + T * 2).fill(C_OUT);
    this.bgLayer.addChild(gw);
    // 记录本层三张图与当前铺底范围，供 ensureOuterArea() 在视口变大时整体重建（需求2）
    this._gridNodes = [gOut, g, gw];
  }

  // 需求2：视口尺寸变化（切全屏 / 4K 等）后，若场外空白铺底范围不够则整体重建一次；
  // 范围足够时直接返回，不增加每帧开销。
  ensureOuterArea() {
    const zc = this._coarse ? 0.62 : 1.22;   // 与 _drawGrid 保持一致（移动端视野放宽 2.5 倍）
    const scr = (this.app && this.app.screen) || { width: window.innerWidth || 0, height: window.innerHeight || 0 };
    const need = Math.max(scr.width, scr.height) / zc / 2 + 80;
    if (this._outerExt && this._outerExt >= need) return;
    this._drawGrid();
  }

  _buildHud() {
    const mob = this._coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const fs = mob ? 22 : 14;      // 移动端横向屏距远：HUD 字放大
    // 需求12：旧 PIXI 左上统计文本（房间/在场/子弹/剩余）已废除，由 DOM HUD（hudTop/hudTeam/statusBar）承接
    this.hudLayer = this.hudLayer || null;

    // 结算遮罩
    this.overlay = new PIXI.Container();
    this.overlay.visible = false;
    const mask = new PIXI.Sprite(this._white);
    mask.tint = 0x000000;
    mask.alpha = 0.6;
    // 结算遮罩：覆盖场地并向外扩展，宽屏居中视野下也不会露出未遮罩区域
    mask.width = GAME_CONFIG.ARENA.w * 3;
    mask.height = GAME_CONFIG.ARENA.h * 3;
    mask.position.set(-GAME_CONFIG.ARENA.w, -GAME_CONFIG.ARENA.h);
    this.overlayTitle = new PIXI.Text({ text: '', style: { fontFamily: 'sans-serif', fontSize: 44, fontWeight: 'bold', fill: 0xffffff } });
    this.overlayTitle.anchor.set(0.5);
    this.overlayTitle.position.set(GAME_CONFIG.ARENA.w / 2, GAME_CONFIG.ARENA.h / 2 - 20);
    this.overlayTip = new PIXI.Text({ text: '按 R 返回房间菜单', style: { fontFamily: 'sans-serif', fontSize: 16, fill: 0xc9d6e8 } });
    this.overlayTip.anchor.set(0.5);
    this.overlayTip.position.set(GAME_CONFIG.ARENA.w / 2, GAME_CONFIG.ARENA.h / 2 + 36);
    this.overlay.addChild(mask, this.overlayTitle, this.overlayTip);
    this.hudLayer.addChild(this.overlay);
  }

  // ---- 实体视图管理 ----
  addPlayer(p) {
    if (this.entityViews.has(p.id)) return;
    const { tex, key } = this._entityTexture(p, p.effColor, p.radius);
    const spr = new PIXI.Sprite(tex);
    spr.anchor.set(0.5);
    spr.width = spr.height = p.radius * 2;

    const nameText = new PIXI.Text({ text: '', style: { fontFamily: 'sans-serif', fontSize: 12, fill: 0x2e3c4d, stroke: { color: 0xffffff, width: 2 } } });
    nameText.anchor.set(0.5, 0);

    const hpBg = new PIXI.Sprite(this._white);
    hpBg.tint = 0x333333;
    hpBg.height = 6;
    const hpBar = new PIXI.Sprite(this._white);
    hpBar.tint = 0x4caf50;
    hpBar.height = 6;

    const root = new PIXI.Container();
    root.addChild(spr, nameText, hpBg, hpBar);
    this.entityLayer.addChild(root);
    this.entityViews.set(p.id, { root, spr, hpBg, hpBar, nameText, texKey: key, lastHp: -1, lastAlive: null });
  }

  removePlayer(id) {
    const v = this.entityViews.get(id);
    if (v) {
      this.entityLayer.removeChild(v.root);
      v.root.destroy({ children: true });
      this.entityViews.delete(id);
    }
  }

  addBullet(b) {
    if (this.bulletViews.has(b.id)) return;
    const cfg = b.cfg || {};
    const color = cfg.color || '#ffffff';
    const shape = cfg.shape || 'circle';
    const isBeam = shape === 'beam' || shape === 'line';
    // 带方向形状需按飞行方向旋转（beam/line 是细长条，arrow/triangle/diamond 尖头朝前）
    const dirShape = isBeam || shape === 'arrow' || shape === 'triangle' || shape === 'diamond';
    const size = Math.max(3, b.radius * 2);
    const root = new PIXI.Container();
    let spr;
    // 真实贴图优先（bullets 可配 image；缺图/未加载则按 shape 回退绘制）
    const imgTex = cfg.image ? Assets.spriteOf({ image: cfg.image }) : null;
    if (imgTex) {
      spr = new PIXI.Sprite(imgTex);
      spr.anchor.set(0.5);
      spr.width = cfg.imgW || size;
      spr.height = cfg.imgH || (shape === 'beam' || shape === 'line' ? size * 0.9 : size);
      if (isBeam) { spr.width = (cfg.length || 60) + size; spr.height = size * 0.9; }
    } else if (isBeam) {
      // 光束/线条：细长白色精灵按颜色染色，旋转指向飞行方向（line 略细且半透明区分）
      spr = new PIXI.Sprite(this._white);
      spr.tint = this._hexNum(color);
      spr.anchor.set(0.5, 0.5);
      spr.width = (cfg.length || 60) + size;
      spr.height = Math.max(3, size * (shape === 'line' ? 0.8 : 1));
      spr.alpha = shape === 'beam' ? 0.95 : 0.8;
    } else if (shape === 'ring' || shape === 'arrow' || shape === 'triangle' || shape === 'diamond' || shape === 'square' || shape === 'star') {
      spr = new PIXI.Sprite(this._shapeTexture(shape, color));
      spr.anchor.set(0.5);
      spr.width = spr.height = size;
    } else {
      // circle 或未知 shape：保留 image 贴图优先、缺图回退圆形色块的既有机制
      const { tex, key } = this._entityTexture(cfg, color, b.radius);
      spr = new PIXI.Sprite(tex);
      spr.anchor.set(0.5);
      spr.width = spr.height = size;
    }
    root.addChild(spr);
    // 发光外圈（Boss/高威胁弹视觉强化，可配 glow / glowColor / glowScale / glowAlpha）
    let glowSpr = null;
    if (cfg.glow && this.glowEnabled) {
      const gs = new PIXI.Sprite(this._colorTexture(cfg.glowColor || color, Math.max(3, Math.ceil(b.radius * 1.4))));
      gs.anchor.set(0.5);
      gs.alpha = cfg.glowAlpha || 0.34;
      gs.width = gs.height = size * (cfg.glowScale || 2.4);
      root.addChild(gs);
      glowSpr = gs;
    }
    this.bulletLayer.addChild(root);
    this.bulletViews.set(b.id, { root, spr, glow: glowSpr, dirShape: !!dirShape, shape, lastTrail: 0 });
  }

  removeBullet(id) {
    const v = this.bulletViews.get(id);
    if (v) {
      this.bulletLayer.removeChild(v.root);
      v.root.destroy({ children: true });
      this.bulletViews.delete(id);
    }
  }

  // 需求4：页面从后台切回前台时，一次性清空屏幕上所有子弹表现——
  // 不逐条补渲染后台期间累积的历史弹道，之后只呈现"当前仍有效"的子弹（由房主快照/新消息重建）。
  clearBullets() {
    [...this.bulletViews.keys()].forEach(id => this.removeBullet(id));
  }

  // 需求4：清空在途特效与未播放的横幅队列，避免切回前台后集中爆发（旧爆炸/旧弹幕拖尾一次性刷屏）。
  clearFx() {
    for (const f of this.fxSprites) {
      try { this.fxLayer.removeChild(f.spr); f.spr.destroy({ children: true }); } catch (e) {}
    }
    this.fxSprites.length = 0;
    if (this._bannerQueue) this._bannerQueue.length = 0;
  }

  // ---- 特效系统 ----
  _pushFx(spr, opt) {
    const kind = opt.kind || 'p';
    const f = { spr, life: opt.life || 0.6, max: opt.life || 0.6, kind, vx: opt.vx || 0, vy: opt.vy || 0, grow: opt.grow || 0, baseScale: opt.baseScale || 1, spin: opt.spin || 0 };
    // 圆环(kind 'r')：grow 语义=最终像素直径，d0 记录初始像素直径，避免旧 scale 语义把环撑成全屏
    if (kind === 'r') { f.d0 = (spr.width || 10); f.grow = opt.grow || f.d0; }
    this.fxSprites.push(f);
    this.fxLayer.addChild(spr);
    return f;
  }

  // 弹道拖尾：沿弹道反向低速漂移渐隐的粒子（由子弹 cfg.trail 触发）
  _spawnTrail(b, color, size) {
    const s = new PIXI.Sprite(this._colorTexture(color || '#ffffff', 6));
    s.anchor.set(0.5);
    s.x = b.x + (Math.random() - 0.5) * (b.radius || 4);
    s.y = b.y + (Math.random() - 0.5) * (b.radius || 4);
    s.width = s.height = Math.max(3, (size || b.radius || 4) * 0.85);
    s.alpha = 1;
    this._pushFx(s, { kind: 'p', vx: -(b.vx || 0) * 0.08, vy: -(b.vy || 0) * 0.08, life: 0.22 + Math.random() * 0.15 });
  }

  // 小粒子爆散
  // image: assets/ 下粒子图路径（配置了即按图粒子：火焰/冰霜等特效后续纯配置接入）
  fxBurst(x, y, color, count, power, life, image) {
    const imgTex = image ? Assets.spriteOf({ image }) : null;
    const tex = imgTex || this._colorTexture(color, 6);
    const isImg = !!imgTex;
    for (let i = 0; i < (count || 8); i++) {
      const s = new PIXI.Sprite(tex);
      s.anchor.set(0.5);
      s.x = x; s.y = y;
      s.tint = 0xffffff;
      s.alpha = 1;
      const a = Math.random() * Math.PI * 2;
      const sp = (Math.random() * 0.6 + 0.4) * (power || 320);
      if (isImg) {
        // 图片粒子：略大、可旋转，更贴近真实素材观感
        s.width = s.height = 16 + Math.random() * 18;
        s.rotation = Math.random() * Math.PI;
      } else {
        s.width = s.height = 4 + Math.random() * 7;
      }
      this._pushFx(s, { kind: 'p', vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: life || (0.35 + Math.random() * 0.5) });
    }
  }

  // 碎裂小块：方块碎片带重力下坠与自旋，表达“被击碎”而不是全屏光环
  fxShards(x, y, color, count, power) {
    const tex = this._shapeTexture('square', color || '#ffb648');
    for (let i = 0; i < (count || 6); i++) {
      const s = new PIXI.Sprite(tex);
      s.anchor.set(0.5);
      s.x = x + (Math.random() - 0.5) * 8;
      s.y = y + (Math.random() - 0.5) * 8;
      s.width = s.height = 5 + Math.random() * 6;
      s.rotation = Math.random() * Math.PI * 2;
      const a = Math.random() * Math.PI * 2;
      const sp = (Math.random() * 0.55 + 0.45) * (power || 240);
      this._pushFx(s, { kind: 'sh', vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, spin: (Math.random() - 0.5) * 14, life: 0.4 + Math.random() * 0.35 });
    }
  }

  // 伤害浮动数字：命中点上方弹出血量变化（-N），1 秒内上浮淡出
  fxDamageText(x, y, val, color, crit) {
    const t = new PIXI.Text({
      text: '-' + val,
      style: {
        fontFamily: 'sans-serif',
        fontSize: crit ? 30 : 22,                       // 暴击：更大字号 + 金色，数值不变（与扣血同值）
        fontWeight: 'bold',
        fill: this._hexNum(crit ? '#ffd76a' : (color || '#e63b3b')),
        stroke: { color: crit ? 0x7a3b00 : 0xffffff, width: crit ? 4 : 3 }
      }
    });
    t.anchor.set(0.5);
    t.position.set(x + (Math.random() - 0.5) * 14, y);
    this._pushFx(t, { kind: 't', life: 0.95 });
  }

  // 吃 buff 头顶气泡：buff 名称停留 1.5~2.5s（护盾 2.5s / 强攻速增伤 2.2s / 普通 1.5s），上浮淡出
  fxBuffLabel(x, y, name, color, def) {
    let dur = 1.5;
    if (def) {
      const st = def.stats || {};
      if (def.kind === 'shield') dur = 2.5;
      else if (st.damageMul >= 0.35 || st.atkSpeedMul >= 0.35) dur = 2.2;
    }
    const t = new PIXI.Text({
      text: name,
      style: { fontFamily: 'sans-serif', fontSize: 15, fontWeight: 'bold', fill: this._hexNum(color || '#ffd76a'), stroke: { color: 0x1f2b36, width: 3 } }
    });
    t.anchor.set(0.5);
    t.position.set(x, y);
    this._pushFx(t, { kind: 't', life: dur });
  }

  // 爆炸：闪光球 + 冲击环 + 粒子
  fxExplosion(x, y, color, radius) {
    const num = this._hexNum(color || '#ff8c42');
    // 闪光核心
    const fl = new PIXI.Sprite(this._colorTexture(color || '#ff8c42', 16));
    fl.anchor.set(0.5);
    fl.x = x; fl.y = y;
    fl.tint = 0xffffff;
    fl.width = fl.height = (radius || 60) * 1.2;
    this._pushFx(fl, { kind: 'f', grow: 2.4, life: 0.22 });
    // 冲击环
    const ring = new PIXI.Sprite(this._ring);
    ring.anchor.set(0.5);
    ring.x = x; ring.y = y;
    ring.tint = num;
    ring.width = ring.height = 20;
    // grow=最终像素直径（旧 *2.4 会被当 scale 增量把环扩到全屏，改为约 2 倍半径的局部冲击圈）
    this._pushFx(ring, { kind: 'r', grow: (radius || 60) * 2.2, life: 0.4 });
    // 粒子
    this.fxBurst(x, y, color || '#ff8c42', 16 + Math.floor((radius || 60) / 6), 380 + (radius || 60) * 3);
    // 二次火光
    const fl2 = new PIXI.Sprite(this._colorTexture('#ffffff', 8));
    fl2.anchor.set(0.5);
    fl2.x = x + (Math.random() - 0.5) * 20;
    fl2.y = y + (Math.random() - 0.5) * 20;
    fl2.width = fl2.height = (radius || 60) * 0.6;
    this._pushFx(fl2, { kind: 'f', grow: 1.5, life: 0.3 });
  }

  // 屏幕横幅（阶段 / 大招提示）：需求1——不再写死世界坐标，也不再占屏幕正中央（避免挡住锁定的人物）。
  // 多条状态文本进入 _bannerQueue 依序展示，条与条之间留 0.3s 的简单时间差；
  // 渲染挂在 hudLayer（不受 viewport/相机位移影响），位置固定屏幕中上区域并随屏幕尺寸走。
  fxBanner(text, color) {
    if (!text) return;
    // 本轮改动（需求1）：横幅文本统一交给 FxFeed（屏幕中上纵向滚动提示区）——
    // 多条自下而上堆叠、逐条渐隐渐出，并按文案强度自动分档字号 / 上挤速度；
    // FxFeed 不可用时回退原 PIXI 单条横幅。
    if (typeof FxFeed !== 'undefined' && FxFeed && FxFeed.push) {
      FxFeed.push(text, color || '#ff2d55', FxFeed.tierOf(text));
      return;
    }
    this._bannerQueue.push({ text: String(text), color: color || '#ff2d55', total: 1.8 });
  }

  // 消费横幅队列：淡入停留淡出；屏幕尺寸取 app.screen，窗口缩放后自动跟随
  _tickBanners(dt) {
    if (!this.hudLayer) return;
    this._tNow = (this._tNow || 0) + dt;
    if (!this._bannerCur) {
      if (!this._bannerQueue.length) return;
      if (this._bannerAt && this._tNow - this._bannerAt < 0.3) return;   // 连续多条：留简单时间差
      const it = this._bannerQueue.shift();
      const t = new PIXI.Text({
        text: it.text,
        style: { fontFamily: 'sans-serif', fontSize: 30, fontWeight: 'bold', fill: this._hexNum(it.color), stroke: { color: 0x000000, width: 4 }, align: 'center' }
      });
      t.anchor.set(0.5);
      const scr = (this.app && this.app.screen) || { width: GAME_CONFIG.ARENA.w, height: GAME_CONFIG.ARENA.h };
      t.x = scr.width / 2;
      t.y = Math.round(scr.height * 0.26);   // 屏幕中上：不再锁正中央，避免挡住人物
      this.hudLayer.addChild(t);
      this._bannerCur = { spr: t, life: 0, total: it.total };
      return;
    }
    const b = this._bannerCur;
    b.life += dt;
    const inT = 0.12, outT = 0.35;
    let a = 1;
    if (b.life < inT) a = b.life / inT;
    else if (b.life > b.total - outT) a = Math.max(0, (b.total - b.life) / outT);
    b.spr.alpha = a;
    if (b.life >= b.total) {
      this.hudLayer.removeChild(b.spr);
      try { b.spr.destroy(); } catch (e) { /* ignore */ }
      this._bannerCur = null;
      this._bannerAt = this._tNow;   // 记下本条结束时刻，下一条据此拉开时间差
    }
  }

  // World 特效队列消费
  drainFx(world) {
    if (!world.fxQueue || !world.fxQueue.length) return;
    for (const q of world.fxQueue.splice(0)) {
      switch (q.type) {
        case 'muzzle': this.fxBurst(q.x, q.y, q.color || '#ffffff', 6, 170, 0.28, q.image); break;
        // 命中：碰撞点的小光效——轻微爆点 + 方块碎屑，杜绝全屏光环
        case 'hit':
          this.fxBurst(q.x, q.y, q.color || '#ff9d5c', 5, 190, 0.22);
          this.fxShards(q.x, q.y, q.color || '#ffb648', 4, 210);
          break;
        case 'explode':this.fxExplosion(q.x, q.y, q.color || '#ff8c42', q.r || 70); break;
        case 'die':    this.fxExplosion(q.x, q.y, q.color || '#ff2d55', q.r || 100); break;
        case 'respawn':
          this.fxBurst(q.x, q.y, q.color || '#ffffff', 10, 200, 0.45);
          { const ring = new PIXI.Sprite(this._ring); ring.anchor.set(0.5); ring.x = q.x; ring.y = q.y; ring.tint = 0xffffff; ring.width = ring.height = 10;
            this._pushFx(ring, { kind: 'r', grow: 150, life: 0.5 }); }
          break;
        case 'banner': this.fxBanner(q.text || '', q.color || '#ff2d55'); break;
        case 'shake':  this._shakeT = Math.max(this._shakeT || 0, q.dur || 0.3); break;
        // 吃 buff：作用于自身的小脉冲（角色位置局部彩圈 + 上飘粒子，时长加长到肉眼可辨的 ~1s），
        // 并在头顶弹出 buff 名称气泡（1.5~2.5s 分档，强增益/护盾停留更久），不再撑全屏光环
        case 'buff':   {
          this.fxBurst(q.x, q.y, q.color || '#ffd76a', 10, 150, 0.7);
          const ring = new PIXI.Sprite(this._ring);
          ring.anchor.set(0.5); ring.x = q.x; ring.y = q.y;
          ring.tint = this._hexNum(q.color || '#ffd76a');
          ring.width = ring.height = 14;
          this._pushFx(ring, { kind: 'r', grow: 110, life: 1.0 });
          const bDef = (q.buffId && window.BUFFS && BUFFS[q.buffId]) ? BUFFS[q.buffId] : null;
          const nm = (bDef && bDef.name) || q.name || '';
          if (nm) this.fxBuffLabel(q.x, q.y - 26, nm, q.color || '#ffd76a', bDef);
          break;
        }
        // 伤害浮动数字：命中 Boss / 玩家后血量变化（-20 ~ -30 级），浅底白描边深红清晰
        // 暴击命中（q.crit）：同一数值加大加金色显示，数值与扣血同源（房主结算广播的 dmg）
        case 'dmg':
          this.fxDamageText(q.x, q.y, q.val || 20, q.color || '#e63b3b', !!q.crit);
          break;
      }
    }
  }

  _updateFx(dt) {
    for (let i = this.fxSprites.length - 1; i >= 0; i--) {
      const f = this.fxSprites[i];
      f.life -= dt;
      const s = f.spr;
      if (f.kind === 'p') {
        s.x += f.vx * dt; s.y += f.vy * dt;
        s.alpha = Math.max(0, Math.min(1, f.life / f.max));
      } else if (f.kind === 'f') {
        s.alpha = Math.max(0, Math.min(1, f.life / f.max)) * 0.9;
        const k = f.baseScale + f.grow * (f.max - f.life);
        s.scale.set(k);
      } else if (f.kind === 'r') {
        // 直径像素语义：d0(初始) -> grow(最终直径)，纹理为 64px 圆环
        s.alpha = Math.max(0, Math.min(1, f.life / f.max));
        const progress = 1 - f.life / f.max;
        const d = (f.d0 || 10) + ((f.grow || f.d0) - (f.d0 || 10)) * progress;
        const k = d / 64;
        s.scale.set(k);
      } else if (f.kind === 'sh') {
        // 碎裂小块：带重力下坠 + 自旋
        f.vy += 620 * dt;
        s.x += f.vx * dt; s.y += f.vy * dt;
        s.rotation += (f.spin || 0) * dt;
        s.alpha = Math.max(0, Math.min(1, f.life / f.max));
      } else if (f.kind === 't') {
        s.y -= 26 * dt;
        s.alpha = Math.max(0, Math.min(1, f.life / (f.max * 0.55)));
      }
      if (f.life <= 0) {
        this.fxLayer.removeChild(s);
        s.destroy();
        this.fxSprites.splice(i, 1);
      }
    }
  }

  // ---- 每帧同步（main 主循环调用）----
  // 需求1/2：原 _syncEdgeHint（屏幕坐标四色光条）已整体删除——那正是"贴着屏幕的彩色边框"，
  // 其四边交汇处在窄屏/贴边时表现为屏幕角落的彩色光块（右上角呼吸色块的来源）。
  // 边界统一由世界坐标地图边界墙（_drawGrid）表达，不再有屏幕坐标的装饰层。

  // 战斗相机（需求1/2）：PC 与移动端统一跟随本地角色，玩家恒居屏幕中心。
  // 旧实现把相机位移硬 clamp 在 [-arena*(z-1), 0]，等价于“视野永不越过地图 0..W / 0..H”，
  // 于是落在场地左上外侧的“上墙/左墙”永远进不了画面（只有贴右/下边时才露出右墙、下墙），
  // 这就是“只有右侧和底部墙可见”的根因。现在放开该限制：玩家走到任一边界墙位置时
  // 相机继续跟随，地图四周自然留出约半屏宽高的空白缓冲（只由场外背景色铺底），
  // 四面边界墙均可完整出现在画面中。
  _applyCamera(world, local) {
    this._camX = this._camX || 0;
    this._camY = this._camY || 0;
    // 移动端视野放宽 2.5 倍（1.55 / 2.5 ≈ 0.62）：屏幕内可见世界范围约为原来的 2.5 倍，
    // 角色不再占满画面，能同时看到自己与场地中央的 Boss；PC 端维持 1.22。
    const z = this._coarse ? 0.62 : 1.22;
    this.viewport.scale.set(z);
    const aw = GAME_CONFIG.ARENA.w, ah = GAME_CONFIG.ARENA.h;
    const scr = (this.app && this.app.screen) || { width: aw * z, height: ah * z };
    if (!local) {
      // 无本地角色（观战 / 结算 / 等待入场）：整个场地居中显示
      this._camX = scr.width / 2 - (aw * z) / 2;
      this._camY = scr.height / 2 - (ah * z) / 2;
    } else {
      // 相机目标：把本地角色放在屏幕正中
      this._camX = scr.width / 2 - local.x * z;
      this._camY = scr.height / 2 - local.y * z;
    }
    // 需求2：空白缓冲上限 ≈ 半屏（世界侧）——屏幕左/上边缘最多露出地图外半屏，右/下同理。
    // 玩家在 0..aw / 0..ah 内时，该区间两端恰好等于“贴左/上”与“贴右/下”的居中值，
    // 因此不会误裁跟随；仅在视口比地图本身还大（超宽屏）时才退回“地图居中”的合理表现。
    const vw = scr.width / z, vh = scr.height / z;
    const minX = scr.width / 2 - aw * z, maxX = (vw / 2) * z;
    const minY = scr.height / 2 - ah * z, maxY = (vh / 2) * z;
    this._camX = Math.max(minX, Math.min(maxX, this._camX));
    this._camY = Math.max(minY, Math.min(maxY, this._camY));
  }

  render(world, local, ui, dt) {
    // 特效事件消费
    this.drainFx(world);
    this._applyCamera(world, local);

    // 震屏（叠加在相机基准位移上，避免覆盖移动端镜头跟随）
    if (this._shakeT > 0) {
      this._shakeT -= dt || 0;
      const m = Math.max(0, this._shakeT) * 46;
      this.viewport.position.set((this._camX || 0) + (Math.random() - 0.5) * m, (this._camY || 0) + (Math.random() - 0.5) * m);
    } else {
      this.viewport.position.set(this._camX || 0, this._camY || 0);
    }

    // 玩家实体
    for (const [, p] of world.players) {
      let v = this.entityViews.get(p.id);
      if (!v) { this.addPlayer(p); v = this.entityViews.get(p.id); }
      const root = v.root;
      const wantKey = Assets.spriteOf(p) ? p.image : (p.effColor || '#ffffff');
      if (v.texKey !== wantKey || Math.abs(v.spr.width - p.radius * 2) > 0.1) this._refreshEntitySprite(v, p);
      root.position.set(p.x, p.y);
      v.spr.visible = p.alive;
      const isBot = p.botKind != null;
      v.nameText.visible = false;   // 头顶名称/血条已改为左侧成员列表 + 顶部 Boss 条
      v.hpBg.visible = false;
      v.hpBar.visible = false;
    }
    [...this.entityViews.keys()].forEach(id => {
      if (!world.players.has(id)) this.removePlayer(id);
    });

    // 子弹：按 shape 分发视觉（圆弹/光束/线条/箭头/三角/菱形/方块/星形/圆环 + 发光/拖尾）
    const nowT = performance.now() / 1000;
    for (const [, b] of world.bullets) {
      let v = this.bulletViews.get(b.id);
      if (!v) { this.addBullet(b); v = this.bulletViews.get(b.id); }
      if (!v) continue;
      v.spr.position.set(b.x, b.y);
      // 修复：发光外圈(glow)必须跟随子弹本体同步坐标。
      // 此前只同步了 spr，glow 一直停在容器本地 (0,0)，即场地世界原点，形成左上角滞留的大圆斑。
      if (v.glow) v.glow.position.set(b.x, b.y);
      const cfg = b.cfg || {};
      // 旋转：自旋(spin, 弧度/秒) > 朝向飞行方向(dirShape) > 静态角(rot, 一次)
      if (cfg.spin) v.spr.rotation = (v.spr.rotation || 0) + (cfg.spin || 0) * (dt || 0.016);
      else if (v.dirShape && (b.vx || b.vy)) v.spr.rotation = Math.atan2(b.vy, b.vx);
      else if (cfg.rot && !v.rotSet) { v.spr.rotation = cfg.rot; v.rotSet = true; }
      // 弹道拖尾（cfg.trail 可配：true=默认 0.045s 一颗；number=生成间隔秒）
      if (cfg.trail && b.life > 0) {
        const interval = (typeof cfg.trail === 'number' && cfg.trail > 0) ? cfg.trail : 0.045;
        if (nowT - (v.lastTrail || 0) >= interval) {
          v.lastTrail = nowT;
          this._spawnTrail(b, cfg.trailColor || cfg.color || '#ffffff', cfg.trailSize);
        }
      }
    }
    [...this.bulletViews.keys()].forEach(id => {
      if (!world.bullets.has(id)) this.removeBullet(id);
    });

    // 场地 buff 掉落物（P2）
    this._syncDrops(world);

    // 需求12：左上角旧统计文本（房间/在场/子弹/剩余）改为 DOM HUD：顶部 Boss 条 + 左上本队成员
    this._syncDomHud(world, local);

    // P3-5：底部状态栏（buff 状态 + 技能冷却倒计时，屏幕中底部 DOM 渲染）
    this._syncStatusDom(local);

    // P0-1：结算展示移交 DOM 结算面板（showGameoverPanel），画布内置 overlay 恒隐藏，
    // 避免与 #panelGameover 双层遮罩重叠；对应文案/按钮统一走 DOM。
    this.overlay.visible = false;

    // 特效
    if (dt) this._updateFx(dt);
    // 需求1：中央横幅队列消费（挂 hudLayer，屏幕正中央、带时间差）
    if (dt) this._tickBanners(dt);
  }

  // P2：场地 buff 掉落物视图同步（出现/拾取消失），数据源 world.buffDrops
  // 本轮改动：该视图原先带 42px 高亮外环 + 上下浮动 + 缩放脉动，在场地左上角两面墙交汇处
  // 会表现为持续“呼吸”的彩色圆球；现删除外环与全部脉动动画，只保留静态圆形底 + buff 图标。
  // 掉落点贴墙问题由 world.spawnBuffDrop 内缩边距修正（不在这里做坐标裁剪，避免与权威数据不一致）。
  _syncDrops(world) {
    const drops = world.buffDrops || [];
    const alive = new Set(drops.map(d => d.id));
    for (const [id, v] of this.dropViews) {
      if (!alive.has(id)) {
        this.bgLayer.removeChild(v.root);
        v.root.destroy({ children: true });
        this.dropViews.delete(id);
      }
    }
    for (const d of drops) {
      let v = this.dropViews.get(d.id);
      const def = (window.BUFFS && BUFFS[d.defId]) || {};
      if (!v) {
        const root = new PIXI.Container();
        const bg = new PIXI.Sprite(this._colorTexture(def.color || '#ffffff', 16));
        bg.anchor.set(0.5); bg.width = bg.height = 32;
        const lbl = new PIXI.Text({ text: def.icon || '?', style: { fontFamily: 'sans-serif', fontSize: 17, fill: 0xffffff } });
        lbl.anchor.set(0.5); lbl.position.set(0, 1);
        root.addChild(bg, lbl);
        this.bgLayer.addChild(root);
        v = { root };
        this.dropViews.set(d.id, v);
      }
      // 固定站位、固定尺寸：不再浮动、不再缩放脉动（去掉“呼吸”观感）
      v.root.position.set(d.x, d.y);
      v.root.scale.set(1);
    }
  }

  // P3-6：战斗 DOM HUD 同步：右上角 Boss 条（血条 + buff 徽章区）+ 左上本队成员血条。
  // 本轮改动：Boss 不再获得任何 buff，徽章区恒为空（保留容器以便后续扩展）。
  // 与 _syncStatusDom 同策略：仅内容变化时重绘，避免高频 DOM 写。
  _syncDomHud(world, local) {
    const top = document.getElementById('hudTop');
    const team = document.getElementById('hudTeam');
    if (!top || !team) return;
    const esc = function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    };
    let bossHtml = '', teamHtml = '';
    if (world && world.players) {
      const list = Array.from(world.players.values());
      const boss = list.find(function (p) { return p.isBoss && p.alive; });
      if (boss) {
        const cap = (boss.statsTotal && boss.statsTotal.hp) || (boss._statsBase && boss._statsBase.hp) || 1;
        const pct = Math.max(0, Math.min(100, (boss.hp || 0) / cap * 100));
        let bb = '';
        const vis = (typeof BuffSystem !== 'undefined' && BuffSystem.visible) ? BuffSystem.visible(boss) : [];
        vis.forEach(function (b) {
          const suf = (b.stacks > 1 ? '×' + b.stacks : '') + (b.extra != null ? ' ' + b.extra : '');
          // 需求2：Boss buff 也带 data-buff，点击（document 事件委托）弹同款效果说明
          bb += '<span class="bb" data-buff="' + esc(b.defId || '') + '" style="--c:' + (b.color || '#ff7a9c') + '">' + (b.icon || '') + ' ' + esc(b.name || b.defId) + suf + ' ' + Math.ceil(b.tLeft) + 's</span>';
        });
        const hpNow = Math.max(0, Math.round(boss.hp || 0));
        bossHtml = '<span class="hb-name">' + esc(boss.name || 'Boss') + '</span>'
          + '<div class="hb-track"><div class="hb-fill" style="width:' + pct.toFixed(1) + '%"></div><span class="hb-hp">' + hpNow + ' / ' + cap + ' (' + pct.toFixed(0) + '%)</span></div>'
          + '<div class="hb-buffs">' + bb + '</div>';
      }
      const me = (local && local.id) ? list.find(function (p) { return p.id === local.id; }) : null;
      if (me) {
        const rows = [];
        const mc = (me.statsTotal && me.statsTotal.hp) || (me._statsBase && me._statsBase.hp) || 1;
        const mpct = Math.max(0, Math.min(100, (me.hp || 0) / mc * 100));
        rows.push('<div class="ht-row me' + (me.alive ? '' : ' dead') + '"><span class="ht-name">' + esc(me.name || '我') + '</span><span class="ht-bar"><i class="ht-fill" style="width:' + mpct.toFixed(1) + '%"></i></span><span class="ht-hp">' + Math.max(0, Math.round(me.hp || 0)) + '/' + mc + '</span></div>');
        list.forEach(function (a) {
          if (a.id === me.id || a.team !== me.team || a.isBoss !== me.isBoss) return;
          const ac = (a.statsTotal && a.statsTotal.hp) || (a._statsBase && a._statsBase.hp) || 1;
          const apct = Math.max(0, Math.min(100, (a.hp || 0) / ac * 100));
          rows.push('<div class="ht-row ally' + (a.alive ? '' : ' dead') + '"><span class="ht-name">' + esc(a.name || '') + '</span><span class="ht-bar"><i class="ht-fill" style="width:' + apct.toFixed(1) + '%"></i></span><span class="ht-hp">' + Math.max(0, Math.round(a.hp || 0)) + '/' + ac + '</span></div>');
        });
        teamHtml = rows.join('');
      }
    }
    if (bossHtml) {
      top.style.display = 'flex';
      if (top._k !== bossHtml) { top._k = bossHtml; top.innerHTML = bossHtml; }
    } else if (top.style.display !== 'none') { top.style.display = 'none'; }
    if (teamHtml) {
      team.style.display = 'flex';
      if (team._k !== teamHtml) { team._k = teamHtml; team.innerHTML = teamHtml; }
    } else if (team.style.display !== 'none') { team.style.display = 'none'; }
  }

  // P3-5：底部状态栏同步（DOM，居中底部）：仅显示状态 buff（BuffSystem.visible）与剩余秒。
  // 仅在内容变化时重绘（倒计时取整数秒，同一秒内不频繁刷新 DOM）。
  // 本轮改动：技能本身没有 buff 效果，底部状态栏只显示真正的状态 buff（BuffSystem.visible）并居中底部；
  // 技能冷却只在触屏技能键自身转 CD，既不进底部状态栏，也不混入 buff 列。
  _syncStatusDom(local) {
    const sb = document.getElementById('statusBar');
    if (!sb) return;
    const me = (local && local.alive) ? local : null;
    const vis = (me && typeof BuffSystem !== 'undefined' && BuffSystem.visible) ? BuffSystem.visible(me) : [];

    // 本轮修复：chip 节点复用，不再每秒整块重建 innerHTML。
    // 旧实现里倒计时每秒变化就重建整条状态栏，点击落下的瞬间元素已被替换成新节点，
    // 浏览器不会派发 click（按下与抬起不在同一节点），于是"点 buff 没反应"。
    // 现在元素只在 buff 增删时创建/移除，文本与进度条原地更新，点击目标稳定。
    sb._chips = sb._chips || new Map();
    let row = sb.firstElementChild;
    if (!row || !row.classList || !row.classList.contains('st-row')) {
      row = document.createElement('div');
      row.className = 'st-row';
      sb.appendChild(row);
    }
    let box = row.querySelector('.st-buffs');
    if (!box) { box = document.createElement('div'); box.className = 'st-buffs'; row.appendChild(box); }

    const seen = Object.create(null);
    vis.forEach(b => {
      const defId = b.defId;
      if (!defId) return;
      seen[defId] = 1;
      let chip = sb._chips.get(defId);
      if (!chip) {
        // 带 data-buff，供点击弹效果说明（main.js 事件委托读取 defId）
        chip = document.createElement('span');
        chip.className = 'st-chip';
        chip.setAttribute('data-buff', defId);
        chip.innerHTML = '<span class="st-txt"></span><i class="st-bar"></i>';
        // 双保险：chip 节点自身直接绑定（元素复用时依然稳定触发，不依赖 document 事件委托）
        chip.onpointerdown = function () {
          try { if (typeof showBuffTip === 'function') showBuffTip(chip); } catch (e) { /* 忽略 */ }
        };
        box.appendChild(chip);
        sb._chips.set(defId, chip);
      }
      const cur = chip.style.getPropertyValue('--c');
      const want = b.color || '#8be9ff';
      if (cur !== want) chip.style.setProperty('--c', want);
      const suf = (b.stacks > 1 ? '×' + b.stacks : '') + (b.extra != null ? ' ' + b.extra : '');
      const txt = (b.icon || '') + ' ' + (b.name || '') + suf + ' ' + Math.ceil(b.tLeft) + 's';
      const tEl = chip.firstElementChild;
      if (tEl && tEl.textContent !== txt) tEl.textContent = txt;
      // 需求16：chip 底部进度条（剩余 / 总时长）；时长以配置 duration 为基准近似
      const def0 = (window.BUFFS && BUFFS[defId]) || {};
      const dur0 = (def0.duration > 0) ? def0.duration : 1;
      const pct0 = Math.max(0, Math.min(100, b.tLeft / dur0 * 100));
      const bar = chip.querySelector('.st-bar');
      if (bar) bar.style.width = pct0.toFixed(1) + '%';
    });
    sb._chips.forEach((chip, id) => {
      if (!seen[id]) { if (chip.parentNode) chip.parentNode.removeChild(chip); sb._chips.delete(id); }
    });
  }
}
