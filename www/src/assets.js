// ===== 美术资源管理器（PixiJS 版）=====
// 配置驱动换皮：units/bullets/skills 配置里带 image / fxImage 字段即用图片渲染，
// 缺省自动回退色块。图片统一放 assets/ 目录。
//   - units.*.image / bullets.*.image / skills.*.image  → 实体贴图
//   - skills.*.fxImage                                 → 技能释放粒子图（火焰/冰霜等后续可配）
// preloadAll() 启动时预加载，Assets.get() 同步取纹理。

const Assets = {
  basePath: 'assets/',

  // 加载贴图（Pixi 自带缓存与并发去重），返回 Promise<Texture|null>
  async load(url) {
    if (!url) return null;
    try {
      return await PIXI.Assets.load(this.basePath + url);
    } catch (err) {
      console.warn('图片加载失败:', url, err);
      return null;
    }
  },

  // 同步取贴图：已加载返回 Texture，未加载返回 null（渲染层回退色块）
  spriteOf(entity) {
    if (!entity || !entity.image) return null;
    return PIXI.Assets.get(this.basePath + entity.image) || null;
  },

  // 预加载配置里所有带 image 的实体（角色/子弹/技能粒子）
  async preloadAll() {
    const urls = [];
    Object.values(UNITS || {}).forEach(r => { if (r.image) urls.push(this.basePath + r.image); });
    Object.values(BULLETS || {}).forEach(b => { if (b.image) urls.push(this.basePath + b.image); });
    Object.values(SKILLS || {}).forEach(s => { if (s.fxImage) urls.push(this.basePath + s.fxImage); });
    if (!urls.length) return;
    try { await PIXI.Assets.load(urls); } catch (err) { /* 单图失败不影响启动 */ }
  }
};
