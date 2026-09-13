// ===== Boss 辅助逻辑 =====
// Boss 由真人扮演，阶段切换判定在触发模块（data/triggers.js）+ Player.checkTriggers 已实现。
// 本文件只负责 Boss 对局相关的事件钩子（可换皮：加 Boss 专属特效/音效/镜头震动）。
// 当前阶段从简，仅做占位与扩展点。

const BossFx = {
  // 阶段切换时触发（world 广播 phase 后调用）
  onPhase(player) {
    // 预留：Boss 换阶段特效/提示（当前不做事）
    return player.skillPool;   // Boss 无出战位限制，候选池即全部可用技能
  },

  // Boss 被击杀时触发
  onDefeated(byName) {
    // 预留：胜利结算特效
    return byName;
  }
};
