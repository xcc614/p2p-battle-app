p2p-battle 资源目录
====================
图片元素统一放本目录，src 只按配置字段加载，缺图自动回退色块，不影响运行。

字段约定（填文件名即可，前缀 assets/ 自动补）：
  units.*.image     单位/角色实体贴图（英雄、Boss 换皮）
  bullets.*.image   子弹贴图（圆形弹/激光条均可替换外观）
  skills.*.fxImage  技能释放粒子图（火焰/冰霜/雷电等特效，后续纯配置接入）

命名建议：
  unit_hero.png / unit_demon_lord.png
  bullet_arrow.png / bullet_fireball.png / bullet_laser.png ...
  fx_fire.png / fx_ice.png / fx_lightning.png / fx_burst.png ...

加载流程：src/assets.js 的 preloadAll() 启动时自动收集
UNITS[].image / BULLETS[].image / SKILLS[].fxImage 预加载；
渲染层拿不到纹理时回退该配置的 color 色块，保证无图可玩。

接入示例（config/skills.json 给技能加火焰粒子）：
  "fireball": { "...": "...", "fxImage": "fx_fire.png" }

P3 表现扩展补充
====================
一、弹幕 shape 与 image 优先级（P3 起支持纯 shape 绘制，无需真实图片）
  bullets.*.shape 取值：
    circle   圆形色块（默认回退，可配 image 贴图）
    beam     光束（细长白条染色，length 控制长度，旋转朝向飞行方向）
    line     线条（同 beam 但更细、半透明，适合激光区分）
    arrow    三角箭头（尖头朝飞行方向）
    triangle 三角形（尖头朝飞行方向）
    diamond  菱形（尖头朝飞行方向）
    square   方块（可用 spin 自旋 / rot 静态角）
    star     五角星（可用 spin 自旋）
    ring     圆环（描边空心，适合 Boss 扩散环）
  优先级：配了 image 且图片加载成功 -> 用贴图；否则按 shape 绘制；
  未配置或未知 shape -> 回退既有圆形色块，不影响战斗逻辑。

二、P3 新增可配视觉字段（均在 bullets.* 条目下）
  glow: true          发光外圈（Boss/高威胁弹强调）
  glowColor           发光颜色，默认同 color
  glowScale           发光圈相对弹体倍数（默认 2.4）
  glowAlpha           发光透明度（默认 0.34）
  trail: true|秒数     弹道拖尾粒子（true=0.045s 一颗，数字=间隔秒）
  trailColor          拖尾颜色（默认同 color）
  trailSize           拖尾粒子大小（默认同弹体半径）
  spin: 弧度/秒       持续自旋（square/star 等非朝向形状动感）
  rot: 弧度           静态初始角度（一次生效）
  imgW / imgH         贴图尺寸覆盖（可选）

三、Boss/阶段演出差异建议（纯配置即可，已生效于 config/bullets.json）
  boss_orb / boss_ring     空心圆环 + 大范围发光（区别于玩家实心弹）
  boss_ray / boss_laser_bolt  光束/线条差异 + 霓虹发光
  boss_fireball             橙红 + 高亮光晕 + 火焰拖尾
  boss_meteor               五角星 + 尾焰拖尾 + 强发光（星形下落演出）
  boss_nova_orb            方块自旋 + 橙色光晕（爆散前兆）

