// ===== 主入口：菜单 / 房间 / 主循环 / 消息分发 =====
// 去职业化：玩家 = 单位模板（config/units.json）。联机/单人统一按模板 id 出角色：
//   'hero'        默认勇者模板（多人同模板时按入场顺序自动配色）
//   'demon_lord'  Boss 模板（“当 Boss”勾选 / AI Boss / Boss 房主顺延）
// 玩法数值/技能全 JSON 配置，src 只留逻辑（不硬编码职业、技能、子弹参数）。

const App = {
  net: null,            // 延迟到 init() 中 loadGameConfig() 成功后再实例化（Net 构造器需读 GAME_CONFIG）
  world: null,
  renderer: null,
  canvas: null,
  state: 'menu',        // menu | battle
  name: '',            // 玩家昵称：默认值在 init() 读配置后由 defaultPlayerName() 生成（默认单位名 + 随机后缀），不写死名称
  unitId: 'hero',
  roleId: 'hero',       // 沿用 roleId 命名与网络层兼容，语义=单位模板 id
  token: '',
  tokenShare: '',       // 建房后生成的“对局令牌”（压缩服务器地址+房间码），可复制邀请
  lastPosAt: 0,
  lastFrame: 0,
  raf: 0,
  lobbyMode: false,      // 返回菜单后保留房间：true=菜单锁定为“房间大厅”态（不能二进宫）
  rematch: { phase: 'idle', wants: {} },   // 再来一局准备状态（idle | offer）
  _goShown: false,       // 本局是否已弹出结算面板（防重复弹窗）
  _snapReqSent: false,   // 本局是否已向房主请求过一次全量状态快照
  _pendingBots: [],      // world 就绪前到达的 bot_sync 缓存（开局后补建）
  // 需求4：战斗消息时间戳 / 过期丢弃 与「后台切回前台」处理
  _bgAt: 0,              // 最近一次被切到后台的时刻（performance.now）；0 = 当前在前台
  _resumeGateMs: 0,      // 切回前台的时间闸门：早于该时刻发出的战斗消息一律判为过期
  _tsSkewBy: {},         // 发送端 id -> 其时钟与本机时钟的偏移估计（跨端 performance.now 基准不同）
};

async function init() {
  App.canvas = document.getElementById('game');

  // 第一步先读 config/*.json -> window 全局，后续 Renderer/战斗逻辑才能取 GAME_CONFIG/UNITS/...
  try {
    await loadGameConfig();
  } catch (err) {
    console.error('配置加载失败(需通过本地 http 服务打开，如 python -m http.server):', err);
    alert('配置加载失败：' + (err && err.message ? err.message : err) + '\n\n请用本地 http 服务打开（如 python -m http.server 后访问 http://localhost:8000），不能直接双击 file:// 打开。');
    return;
  }

  // 配置就绪后再实例化网络层（Net 构造器同步读 GAME_CONFIG.SIGNAL_BASE，不能早于 loadGameConfig）
  App.net = new Net();

  // 玩家默认昵称：默认单位名（units.json 声明的 name）+ 随机后缀，配置就绪后才生成（原写死 '勇者'+随机数）
  if (!App.name) App.name = defaultPlayerName();

  App.renderer = new Renderer(App.canvas);
  await App.renderer.init();
  Input.init(App.canvas);

  document.getElementById('name').value = App.name;
  document.getElementById('btnChallenge').addEventListener('click', startChallenge);
  // 配置面板（原「技能配置」）：模块化拖拽配置（装备/宝石/铭文/技能…），本地保存为「自定义配置」档案。
  // 联机与单人共用同一份配置（同一个 localStorage 键 CFG_KEY，没有第二份存储）。
  const btnConfig = document.getElementById('btnConfig');
  if (btnConfig) btnConfig.addEventListener('click', openCfgPanel);
  document.getElementById('btnCfgSave').addEventListener('click', saveCfgPanel);
  document.getElementById('btnCfgClose').addEventListener('click', closeCfgPanel);
  const btnCfgPreset = document.getElementById('btnCfgPreset');
  if (btnCfgPreset) btnCfgPreset.addEventListener('click', () => {
    if (!cfgState.moduleId) return;
    cfgPresetModule(cfgState.moduleId);
    const tip = document.getElementById('cfgTip'); if (tip) tip.textContent = '';
    renderCfgPanel();
  });
  const btnCfgClear = document.getElementById('btnCfgClear');
  if (btnCfgClear) btnCfgClear.addEventListener('click', () => {
    if (!cfgState.moduleId) return;
    cfgState.draft[cfgState.moduleId] = [];
    const tip = document.getElementById('cfgTip'); if (tip) tip.textContent = '已清空「' + ((Profiles.defs()[cfgState.moduleId] || {}).name || cfgState.moduleId) + '」，点保存后生效。';
    renderCfgPanel();
  });
  const cfgProfSel = document.getElementById('cfgProfile');
  if (cfgProfSel) cfgProfSel.addEventListener('change', onCfgProfileChange);
  // 提前组房间：单输入框+单按钮（留空=创建房间，按「本地局域网」勾选分流；有值=加入）
  const btnQuickGo = document.getElementById('btnQuickGo');
  if (btnQuickGo) btnQuickGo.addEventListener('click', quickGo);
  const qTok = document.getElementById('quickTok');
  if (qTok) qTok.addEventListener('keydown', e => { if (e.key === 'Enter') quickGo(); });
  document.getElementById('name').addEventListener('keydown', e => { if (e.key === 'Enter') quickGo(); });
  // 挑战对象切换：你当 Boss 时隐藏队友选择
  document.getElementById('soloOpp').addEventListener('change', function () {
    document.getElementById('alliesRow').style.display = this.value === 'team' ? 'none' : '';
  });

  // 单机选人下拉由 units.json 驱动（selectable 模板自动进列表，默认值取 config/challenge.json）
  populateUnitSelectors();
  // AI 难度档位与 AI 数量下拉：档位数按 config/ai.json，数量上界按 config/runtime.json 的 ROOM_MAX 推算
  populateSoloAiSelectors();

  // ---- 联机对战：房间面板控件 ----
  // 房间面板：退出 / 随机 Boss / 开始游戏 / 成员行点击（设为 Boss、接受开局）
  const btnRpLeave = document.getElementById('btnRpLeave');
  if (btnRpLeave) btnRpLeave.addEventListener('click', leaveRoomToMenu);
  const btnRpStart = document.getElementById('btnRpStart');
  if (btnRpStart) btnRpStart.addEventListener('click', onRpStartClick);
  const btnRpDecline = document.getElementById('btnRpDecline');
  if (btnRpDecline) btnRpDecline.addEventListener('click', onRpDeclineClick);
  const btnRpRand = document.getElementById('btnRpRand');
  if (btnRpRand) btnRpRand.addEventListener('click', onRpRandClick);
  const rpM = document.getElementById('rpMembers');
  if (rpM) rpM.addEventListener('click', onRpMembersClick);
  ['rpAiCount', 'rpAiLevel', 'rpAiBoss'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { if (typeof refreshRoomAiUi === 'function') refreshRoomAiUi(); });
  });
  // 手动房悬浮条：复制 / 应答确认 / 刷新邀请码
  document.getElementById('btnInvCopy').addEventListener('click', () => copyText('invTok'));
  document.getElementById('btnAnsCopy').addEventListener('click', () => copyText('ansTokOut'));
  document.getElementById('btnAnsOk').addEventListener('click', onManualAnswer);
  document.getElementById('btnInvNext').addEventListener('click', onManualNextInvite);
  const sigEl = document.getElementById('signalHost');
  if (sigEl && !sigEl.value) sigEl.value = defaultSignalAddr();
  refreshRoomAiUi();

  // ---- P0 浮层控件绑定：结算面板 / 再来一局 / 成员面板 / 房间菜单条 ----
  document.getElementById('btnAgain').addEventListener('click', startRematch);
  document.getElementById('btnBackMenu').addEventListener('click', backToMenu);
  document.getElementById('btnRematchStart').addEventListener('click', hostStartRematch);
  document.getElementById('btnRematchCancel').addEventListener('click', hostCancelRematch);
  document.getElementById('btnLobbyAgain').addEventListener('click', startRematch);
  document.getElementById('btnLobbyLeave').addEventListener('click', leaveRoomToMenu);
  document.getElementById('membersFab').addEventListener('click', () => { toggleMembersPanel(true); });
  document.getElementById('mpClose').addEventListener('click', () => { toggleMembersPanel(false); });
  document.getElementById('rematchList').addEventListener('click', onRematchListClick);
  // 令牌分享条：点“复制”把当前展示的令牌复制到剪贴板（由 head 上的 jbCopyBtn 统一处理）
  document.getElementById('btnTokCopy').addEventListener('click', () => {
    const tokInput = document.getElementById('joinTok');
    if (!tokInput) return;
    tokInput.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { /* fallthrough */ }
    if (!copied && navigator.clipboard) {
      navigator.clipboard.writeText(tokInput.value).catch(() => {});
    }
    tokInput.focus();
  });

  // 悬浮令牌条：绑定 展开/收起、头部快捷复制、拖动 交互
  initJoinBar();

  // 网络回调
  App.net.onMembers = members => {
    // 房主开局投票期间成员变动：编成已失效，自动取消本轮投票并提示重新发起
    if (App.net && App.net.isHost && App._roomVote) {
      const nowIds = (members || []).map(m => m.id);
      const v = App._roomVote;
      if (v.expect.some(id => nowIds.indexOf(id) < 0) || nowIds.length !== v.expect.length + 1) {
        App._roomVote = null;
        App.net.broadcast({ t: 'room_cancel' });
        if (App.lobbyMode) { syncMembersPanel(); renderRoomPanel(); showLobbyBar(); }
        return;
      }
    }
    if (App.state !== 'battle') {
      // 手动星形成员首包名单：同步房主裁决的角色；联机统一停在大厅（房间面板），由房主点“开始游戏”后统一进房
      if (App.net.manual === 'member' && !App.lobbyMode) {
        const self = members.find(m => m.id === App.net.myId);
        if (self && self.roleId) App.roleId = self.roleId;
      }
      // 房间大厅（软回菜单 / 新建房间待开局大厅）或未开局：只刷新成员面板、房间面板与顶部条人数，不操作战斗世界
      syncMembersPanel();
      renderRoomPanel();
      if (App.lobbyMode) showLobbyBar();
      return;
    }
    // 大厅/再来一局准备态收到名单变动：仅刷新面板与重开列表（战斗世界已冻结或待重建）
    if (App.lobbyMode || App.rematch.phase !== 'idle') {
      syncMembersPanel();
      renderRematchPanel();
      return;
    }
    members.forEach(m => {
      if (!App.world.players.has(m.id)) {
        App.world.addPlayer(m.id, m.name || m.id, m.roleId || 'hero', m.id === members[0].id);
      }
    });
    // 移除离开的；记录离开者是否为 Boss（用于房主顺延转职判断）。
    // 注意：AI 房间单位（botKind）不属于信令成员名单，不能按“离开”清理，
    // 否则 AI Boss 会被误判为“离开的 Boss”触发房主顺延转职（真人 Boss 补位走 removeRoomBossBot）。
    let hostLeft = false;
    [...App.world.players.keys()].forEach(id => {
      if (id !== App.net.myId && !members.find(m => m.id === id)) {
        const lp = App.world.players.get(id);
        if (!lp || lp.botKind) return;   // bot 保留，真人 Boss 补位由 removeRoomBossBot 统一移除
        if (lp.isBoss) hostLeft = true;
        App.world.removePlayer(id);
      }
    });
    // 房主是勇者且预置了 AI Boss：真人 Boss 加入时移除 AI Boss（避免双 Boss）
    if (App.net.isHost && members.some(m => m.roleId === 'demon_lord' && m.id !== App.net.myId)) {
      removeRoomBossBot();
    }
    // 房主顺延：原 Boss 房主离开，本地成为新房主且不是 Boss → 自动转职为 Boss 并通知全员
    if (hostLeft && App.net.isHost && App.roleId !== 'demon_lord') {
      const me = App.world.players.get(App.net.myId);
      if (me) {
        App.roleId = 'demon_lord';
        applyRole(me, 'demon_lord', App.name);
        me.hp = me.statsTotal.hp;
        me.alive = true;
        me.respawnAt = 0;
        if (App.net.notifyRole) App.net.notifyRole('demon_lord');   // 服务端同步模板，裁决后续补位
        App.net.broadcast({ t: 'hello', name: App.name, roleId: App.roleId });
      }
    }
    // 成员进出后统一刷新常驻成员面板（含 AI 补位）
    syncMembersPanel();
  };
  App.net.onPeer = (id, connected) => {
    if (!connected) {
      // 手动星形成员：房主断开即无法继续（无服务器可重连）
      if (App.net.manual === 'member' && App.state === 'battle') {
        alert('与房主断开连接，本局结束');
        location.reload();
      }
      return;
    }
    App.net.sendTo(id, { t: 'hello', name: App.name, roleId: App.roleId });
    // 档案交换：与对端建连即互发当前玩家档案（房主据此汇总开局，成员端据此填充成员行）
    App.net.sendTo(id, {
      t: 'profile_cfg', profile: localProfileFor(App.roleId),
      profileId: (profileStore() && profileStore().currentId()) || ''
    });
    // host 侧把联机房间内本地 AI 单位名单同步给新成员，保证两端看到的单位一致
    if (App.net.isHost && App.world && App.world.bots && App.world.bots.length) {
      App.net.sendTo(id, { t: 'bot_sync', bots: App.world.bots.map(b => ({ id: b.id, name: b.name, roleId: b.roleId, botKind: b.botKind, aiLevel: b.aiLevel })) });
    }
    // host 在“大厅/再来一局准备/结算态”（上局已结束回菜单或正停在本局结算）接受新成员时，
    // 先行告知对方不要按成员首包自动开局，留在菜单等房主发起再来一局
    // （P3-4：补 rematch.offer 覆盖“软回大厅后停在角色重选准备界面”的窗口；
    //   服务器信令 joined 不含房间阶段字段，统一借 DC 建连时机下发 lobby_join 收敛“凭码加入即开局”）
    if (App.net.isHost && App.state === 'battle' && App.world && !(App.world.gameOver)) {
      // 战斗进行中接入的新成员：直接推送全量快照，令其立即加入本局（修复“中途加入停在登录/大厅页”）
      App.net.sendTo(id, {
        t: 'room_battle_join',
        members: (App.net.members || []).map(m => ({ ...m })),
        snap: App.world.buildSnapshot()
      });
      return;
    }
    if (App.net.isHost && (App.state === 'lobby' || App.lobbyMode || App.rematch.phase === 'offer' || (App.world && App.world.gameOver))) {
      App.net.sendTo(id, { t: 'again', act: 'lobby_join' });
    }
    // 成员侧：与房主直连建立后立即请求一次全量状态快照（P1-4：补齐角色/血量/位置/Boss 阶段/AI 名单基线）
    if (!App.net.isHost && App.state === 'battle' && App.world) {
      requestSnapshot();
    }
  };
  App.net.onData = handleData;
  // 信令服务器中转的子弹事件（TCP 可靠有序，杜绝 WebRTC UDP 丢包导致的“子弹两回事”）
  App.net.onRelay = (fromId, msg) => {
    if (App.state !== 'battle' || !App.world) return;
    if (msg && msg.t === 'shoot' && msg.from !== App.net.myId) {
      // 需求4：中继来的弹道若已过期（后台积压 / 网络滞留），直接丢弃，不生成、不计算、不渲染
      if (App.msgAgeSec(fromId, msg) > MSG_MAX_AGE) return;
      App.world.spawnSkillBullets(msg);
    }
  };

  // 预加载贴图 -> 开跑（config 已在 init 最前加载）
  Assets.preloadAll().then(() => requestAnimationFrame(loop));
}

// ---- 统一入口（提前组房间）----
// 单输入框 quickTok：留空 = 创建房间，有值 = 加入房间。
// 创建时按「本地局域网」lanMode 勾选分流：勾选 → 0 服务器手动星形房（默认）；取消 → 令牌服务器在线房间。
// 加入时 M2P 邀请码走手动成员流程，房间码/对局令牌走服务器（令牌内含服务器地址，自动切换）。
// 无论服务器还是手动，创建/加入成功后都停在「房间面板」待开局大厅：房主可随机/指定 Boss、加 AI 角色，
// 人齐后点“开始游戏”，其他成员收到通知点接受后统一进入战场。
function quickGo() {
  if (guardLobby()) return;
  const raw = (document.getElementById('quickTok').value || '').trim();
  const lan = document.getElementById('lanMode');
  const lanOn = !lan || lan.checked;
  if (!raw) {
    // 留空 = 创建房间：按「本地局域网」勾选分流
    //  - 勾选（默认）：0 服务器手动贴码星形房（房主生成邀请码，不需要房间码）
    //  - 取消勾选（需求7）：不再建房，直接连信令服务器 WebSocket 进房；
    //    房间码留空由服务端自动匹配可用房间（无可用则新建），房内成员自动互换信令
    if (lanOn) return startManualHub();
    if (GAME_CONFIG.SIGNAL_AUTO_JOIN === false) return startServerRoom('');   // 配置回退：按旧逻辑建房
    return startSignalAutoJoin();
  }
  // 有值 = 加入房间：M2P = 手动贴码成员；其余 = 服务器房间码 / 对局令牌
  if (raw.slice(0, 3).toUpperCase() === 'M2P') return startManualMember(raw);
  return startServerRoom(raw);
}

// ---- 服务器在线房间（创建/加入统一入口）：建房或加入成功后停在大厅房间面板，不自动开战 ----
async function startServerRoom(raw) {
  if (guardLobby()) return;
  App.name = document.getElementById('name').value || App.name;
  App.roleId = 'hero';   // Boss 归属在房间内配置（进房后再指定）

  const parsed = raw ? TokenCodec.parseInput(raw) : null;
  if (raw && parsed && parsed.kind === 'bad') {
    alert('无法识别的房间码/令牌，请检查后重试（可留空新建房间）');
    return;
  }
  // 令牌里压缩了信令服务器地址：先切过去再 join，实现局域网/自定义服务器互通
  if (parsed && parsed.kind === 'token') App.net.setSignalBase(parsed.join.httpBase);
  const token = parsed ? (parsed.kind === 'room' ? parsed.room : parsed.join.room) : '';

  const waiting = document.getElementById('waiting');
  const lock = (text) => { waiting.textContent = text || ''; };
  const unlock = () => { waiting.textContent = ''; };

  try {
    if (token) {
      lock('正在通过令牌/房间码加入 ' + token + ' …');
      App.token = token;
      await App.net.joinRoom(token, App.name, App.roleId);
    } else {
      lock('正在创建房间 …');
      App.token = await App.net.createRoom(App.name, App.roleId, null);
    }
  } catch (e) {
    if (token) {
      try {
        lock('房间不存在，正在为你创建 …');
        App.token = await App.net.createRoom(App.name, App.roleId, token);
      } catch (e2) {
        unlock();
        alert('加入失败且自动建房失败：' + e2.message);
        return;
      }
    } else {
      unlock();
      alert('创建房间失败：' + e.message);
      return;
    }
  }
  unlock();

  App.roleId = App.net.selfRole || App.roleId;
  // 房主：生成可分享令牌（悬浮条 + 输入框回填），随后进房间大厅组织成员；成员：留在大厅等房主发起开局
  if (App.net.isHost) {
    setupTokenShare();
    enterLobbyView();
  } else {
    enterMemberLobby();
  }
}

// ---- 需求7：取消「本地局域网」勾选且房间码留空 → 不建房，直接连信令服务器 WS 进房 ----
// 服务端按 type=auto 处理：自动匹配一个可用（未满员）房间加入，没有可用房间则新建并回传房间码；
// 进房后房内成员变动由服务端 members 广播驱动，新老成员自动创建并互换 WebRTC 信令（无需手动贴码），
// 信令服务器同时承担信令交换与 WebSocket 兜底中转（relay）。
async function startSignalAutoJoin() {
  if (guardLobby()) return;
  App.name = document.getElementById('name').value || App.name;
  App.roleId = 'hero';   // Boss 归属在房间内配置（进房后再指定）
  const waiting = document.getElementById('waiting');
  // 令牌服务器地址：优先用配置面板填写的地址（勾选局域网时该输入框禁用），留空则用默认地址
  App.net.setSignalBase(toSignalHttpBase((document.getElementById('signalHost').value || '').trim()));
  waiting.textContent = '正在连接信令服务器 …';
  try {
    App.token = await App.net.joinSignalAuto(App.name, App.roleId);
  } catch (e) {
    waiting.textContent = '';
    alert('连接信令服务器失败：' + e.message + '\n请确认信令服务已启动（server_local.py），且该地址可访问。');
    return;
  }
  waiting.textContent = '';
  App.roleId = App.net.selfRole || App.roleId;
  setupTokenShare();   // 房主/成员都展示当前房间码，便于把同一房间码发给其他人
  if (App.net.isHost) enterLobbyView(); else enterMemberLobby();
}

// 令牌服务器地址归一化：面板里可能填 host:port / http(s):// / ws(s)://，统一转成 http(s) 基址
function toSignalHttpBase(addr) {
  const a = String(addr || '').trim().replace(/\/+$/, '');
  if (!a) return 'http://' + defaultSignalAddr();
  if (/^https?:\/\//i.test(a)) return a;
  if (/^wss:\/\//i.test(a)) return 'https://' + a.slice(6);
  if (/^ws:\/\//i.test(a)) return 'http://' + a.slice(5);
  return 'http://' + a;
}

// 成员侧服务器加入：直接进入“等待房主组织开局”的大厅态（房主建连后还会补发 lobby_join，幂等）
function enterMemberLobby() {
  if (guardLobby()) return;
  App.state = 'lobby';
  App.lobbyMode = true;
  App.canvas.style.display = 'none';
  document.getElementById('menu').style.display = 'block';
  showLobbyBar();
  syncMembersPanel();
  renderRoomPanel();
}

// ---- 0 服务器手动贴码（星形直连）房主：创建手动房并进房间大厅 ----
async function startManualHub() {
  if (guardLobby()) return;
  App.name = document.getElementById('name').value || App.name;
  App.roleId = 'hero';
  const waiting = document.getElementById('waiting');
  waiting.textContent = '正在生成手动邀请码 …';
  try {
    const invite = await App.net.manualCreateRoom(App.name, App.roleId);
    App.token = 'manual';
    App.tokenShare = '手动房 · 0服务器';   // HUD 顶栏展示用（非令牌）
    setupManualHub(invite);      // 悬浮条展示邀请码（默认折叠，头部一键复制）
    enterLobbyView();            // 停在大厅房间面板：等朋友贴码加入，人齐后点“开始游戏”
  } catch (e) {
    waiting.textContent = '';
    alert('创建手动房失败：' + e.message);
  }
}

// ---- 0 服务器手动贴码成员：粘贴 M2P 邀请码 → 生成应答码发给房主，房主确认后进入房间大厅 ----
async function startManualMember(invRaw) {
  if (guardLobby()) return;
  const inv = ManualCodec.unpack(invRaw);
  if (!inv) {
    alert(manualWhyText(ManualCodec.diagnose(invRaw), '邀请码'));
    return;
  }
  App.name = document.getElementById('name').value || App.name;
  // 需求3收尾：已移除"开局当 Boss"勾选，加入方默认勇者；Boss 归属由房主在房间面板内指定
  App.roleId = 'hero';
  const waiting = document.getElementById('waiting');
  waiting.textContent = '正在解析邀请并生成应答码 …';
  try {
    const ans = await App.net.manualJoin(inv, App.name, App.roleId);
    showManualMember(ans);       // 悬浮条展示应答码，等房主确认
    // 尚未真正入房：先置“等待确认”大厅态，房主确认后成员首包名单到达 → 刷新房间面板
    App.state = 'lobby';
    App.lobbyMode = true;
    App.canvas.style.display = 'none';
    document.getElementById('menu').style.display = 'block';
    showLobbyBar();
  } catch (e) {
    waiting.textContent = '';
    alert('加入失败：' + e.message);
  }
}

// ---- 0 服务器手动贴码（星形链接）：全部贴码函数与 UI 控制 ----
// 流程：房主勾选手动模式并“进入对战”→ 生成邀请码(offer)；朋友把邀请码贴进
// “手动邀请码”框并“进入对战”→ 生成应答码(answer)发回房主；房主粘贴应答码点确认即连入。
// 星形拓扑：房主为唯一中心，全员只与房主一条 DataChannel，房主转发成员位置/子弹。

// 手动邀请/应答码解析失败原因的中文说明（区分“没复制全”与“前缀不对”）
function manualWhyText(why, what) {
  if (why === 'empty') return '请先粘贴' + what + '。';
  if (why === 'no-prefix') return '这不是有效的' + what + '（应以 M2P 开头），请确认复制的是完整那一串。';
  if (why === 'has-junk') return what + '前后混入了其它文字，请只粘贴 M2P 开头的那一整串。';
  if (why === 'truncated') return what + '没有复制完整（末尾校验不通过），请重新全选复制后再试。';
  return what + '无法解析，请重新复制完整内容。';
}

// 复制失败兜底：展开悬浮条并全选文本，提示用户长按手动复制
function manualCopyFallback(el) {
  const bar = document.getElementById('joinBar');
  if (bar) bar.classList.remove('jb-collapsed');
  if (el) { el.focus(); el.select(); }
  const st = document.getElementById('manualHubStatus') || document.getElementById('manualMemberStatus');
  if (st) st.textContent = '自动复制被浏览器拦截：请长按上方文本框内容“全选 → 复制”再发送。';
}

function copyText(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return false;
  el.focus();
  el.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
  if (copied) return true;
  // navigator.clipboard 仅在安全上下文可用（http 局域网页面常为 undefined），
  // 兜底失败必须明确提示，避免“以为复制成功、实际拿到空/旧内容”造成的邀请码失效
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(el.value).then(() => {}, () => manualCopyFallback(el));
    return true;
  }
  manualCopyFallback(el);
  return false;
}

async function enterManual() {
  // 旧入口已由 quickGo 统一接管（局域网建房 startManualHub / 贴码加入 startManualMember），此处仅兜底提示
  const raw = (document.getElementById('quickTok').value || '').trim();
  if (raw) return startManualMember(raw);
  return startManualHub();
}

// 手动房主：显示邀请码面板（大厅/战斗中右上角悬浮条）
function setupManualHub(invite) {
  const txt = ManualCodec.pack(invite);
  const inp = document.getElementById('invTok');
  if (!inp) return;
  if (!txt || !ManualCodec.unpack(txt)) {   // 生成即自检：编码异常时明确提示，不发坏码
    const st0 = document.getElementById('manualHubStatus');
    if (st0) st0.textContent = '邀请码生成异常（编码自检未通过），请点“刷新邀请码”重新生成。';
    return;
  }
  inp.value = txt;
  jbShow(false);   // 手动房主：右上角默认折叠成小条（头部保留“复制”一键），点开看应答区
  showJoinZone('manualHubZone', true);
  const st = document.getElementById('manualHubStatus');
  if (st) st.textContent = '把上方邀请码发给朋友；朋友粘贴邀请码后生成应答码，把应答码贴回下方并点“确认应答”。人齐后在下方房间面板配置角色并点「开始游戏」。';
}

// 手动成员：显示应答码面板，等待房主确认
function showManualMember(ans) {
  const txt = ManualCodec.pack(ans);
  const out = document.getElementById('ansTokOut');
  if (!out) return;
  if (!txt || !ManualCodec.unpack(txt)) {   // 生成即自检：编码异常时明确提示
    const st0 = document.getElementById('manualMemberStatus');
    if (st0) st0.textContent = '应答码生成异常（编码自检未通过），请重新粘贴邀请码再试。';
    return;
  }
  out.value = txt;
  jbShow(false);   // 手动成员：默认折叠成小条，头部“复制”可直接复制应答码发给房主
  showJoinZone('manualMemberZone', true);
  const st = document.getElementById('manualMemberStatus');
  if (st) st.textContent = '把上方应答码复制发给房主，房主确认后即加入房间（请勿关闭页面），房主发起开局并全员同意后统一进入战场。';
}

// 手动房主：确认应答码（建连 + 全员同步 + 展示结果）
async function onManualAnswer() {
  const raw = (document.getElementById('ansTok').value || '').trim();
  const st = document.getElementById('manualHubStatus');
  if (!raw) { if (st) st.textContent = '请先粘贴朋友发回的应答码。'; return; }
  const ans = ManualCodec.unpack(raw);
  if (!ans) { if (st) st.textContent = manualWhyText(ManualCodec.diagnose(raw), '应答码'); return; }
  if (st) st.textContent = '正在确认加入 …';
  try {
    const info = await App.net.manualAccept(ans);
    document.getElementById('ansTok').value = '';
    jbSetCollapsed(true);   // 应答确认完成：自动折叠收起，不挡主界面
    if (st) st.textContent = (info && info.name ? info.name : '新成员') + ' 已连入'
      + (info && info.roleId === 'demon_lord' ? '（Boss）' : '（勇者）')
      + '。继续邀请下一位朋友可点“刷新邀请码”。';
  } catch (e) {
    if (st) st.textContent = '加入失败：' + e.message;
  }
}

// 手动房主：为下一位朋友生成新邀请码（旧邀请作废）
async function onManualNextInvite() {
  const st = document.getElementById('manualHubStatus');
  try {
    const invite = await App.net.manualNextInvite();
    if (invite) {
      const txt = ManualCodec.pack(invite);
      const inp = document.getElementById('invTok');
      if (inp) inp.value = txt;
      jbShow(true);   // 刷新后保持展开，避免窗口回缩变短
      showJoinZone('manualHubZone', true);
      if (st) st.textContent = '已生成新邀请码（旧邀请作废）：复制发给下一位朋友。';
    }
  } catch (e) {
    if (st) st.textContent = '生成失败：' + e.message;
  }
}

// ==================== 右上角悬浮令牌条（折叠/展开/拖动） ====================
const JB_TEXT = {
  joinTokZone:     { title: '本局令牌',      sub: '复制发给朋友，粘贴到房间码框即加入' },
  manualHubZone:   { title: '手动房 · 房主', sub: '复制邀请码给朋友，应答码贴回确认' },
  manualMemberZone:{ title: '手动房 · 成员', sub: '应答码复制发给房主，确认后进入房间等待开局' }
};

function jbEl() { return document.getElementById('joinBar'); }
function jbFoldBtn() { return document.getElementById('jbFoldBtn'); }

// 折叠 / 展开切换：折叠后只剩头部一行（默认悬浮不挡主界面）
function jbSetCollapsed(collapsed) {
  const bar = jbEl();
  if (!bar) return;
  bar.classList.toggle('jb-collapsed', !!collapsed);
  const btn = jbFoldBtn();
  if (btn) btn.textContent = collapsed ? '展开 ▾' : '收起 ▴';
}

// 显示悬浮条并指定初始折叠态；默认折叠（建房后只留右上角小条，输入流程需要看码时传 true 展开）
function jbShow(expanded) {
  const bar = jbEl();
  if (!bar) return;
  bar.style.display = 'block';
  bar.classList.add('jb-on');
  jbSetCollapsed(!expanded);
}

function jbHide() {
  const bar = jbEl();
  if (!bar) return;
  bar.classList.remove('jb-on');
  bar.style.display = 'none';
}

// 头部「复制」：自动复制当前正在展示的区（手动房主/成员/本局令牌）
function jbCopyActive() {
  const map = [['manualHubZone', 'invTok'], ['manualMemberZone', 'ansTokOut'], ['joinTokZone', 'joinTok']];
  for (const [zoneId, inputId] of map) {
    const zone = document.getElementById(zoneId);
    if (zone && zone.style.display !== 'none') {
      const inp = document.getElementById(inputId);
      if (!inp || !inp.value) continue;
      inp.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (e) { /* fallthrough */ }
      if (!copied && navigator.clipboard) navigator.clipboard.writeText(inp.value).catch(() => {});
      inp.focus();
      return;
    }
  }
}

// 悬浮条拖拽：按住头部拖动，松手落位；拖动距离<4px 视为点按头部（折叠态点头部=展开）
function initJoinBar() {
  const bar = jbEl();
  if (!bar) return;
  const head = document.getElementById('jbHead');
  const foldBtn = document.getElementById('jbFoldBtn');
  const copyBtn = document.getElementById('jbCopyBtn');
  if (foldBtn) foldBtn.addEventListener('click', ev => { ev.stopPropagation(); jbSetCollapsed(!bar.classList.contains('jb-collapsed')); });
  if (copyBtn) copyBtn.addEventListener('click', ev => { ev.stopPropagation(); jbCopyActive(); });
  if (!head) return;

  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  function clampIntoView() {
    const r = bar.getBoundingClientRect();
    const maxL = Math.max(8, window.innerWidth - r.width - 8);
    const maxT = Math.max(8, window.innerHeight - r.height - 8);
    let L = parseInt(bar.style.left || '0', 10) || 0;
    let T = parseInt(bar.style.top || '0', 10) || 0;
    L = Math.min(Math.max(8, L), maxL);
    T = Math.min(Math.max(8, T), maxT);
    bar.style.right = 'auto';
    bar.style.left = L + 'px';
    bar.style.top = T + 'px';
  }
  // 固定右上角：不做拖拽；折叠态点头部 = 展开
  head.addEventListener('click', ev => {
    if (ev.target && ev.target.closest && ev.target.closest('button')) return;
    if (bar.classList.contains('jb-collapsed')) jbSetCollapsed(false);
  });
}

// 右上角分享面板：切换 服务器令牌 / 手动房主 / 手动成员 三种内容
function showJoinZone(zoneId, expand) {
  ['joinTokZone', 'manualHubZone', 'manualMemberZone'].forEach(z => {
    const el = document.getElementById(z);
    if (el) el.style.display = (z === zoneId) ? 'block' : 'none';
  });
  const meta = JB_TEXT[zoneId];
  if (meta) {
    const t = document.getElementById('jbTitle');
    const s = document.getElementById('jbSub');
    if (t) t.textContent = meta.title;
    if (s) s.textContent = meta.sub;
  }
  // 默认折叠：若已在显示状态则保持用户当前折叠/展开选择；首次进入按传入的 expand 决定
  jbShow(!!expand);
}

// ---- 房间面板（联机对战 · 当前创建的房间）：大厅期常驻菜单，房主配置角色 / AI，点“开始游戏”统一开局 ----
// 生命周期：建房/加入成功 → 大厅（lobbyMode=true）即显示；进入战斗隐藏；软回菜单（backToMenu）或成员名单变化再刷新。
function renderRoomPanel() {
  const panel = document.getElementById('rpPanel');
  if (!panel) return;
  const inRoom = !!(App.net && App.net.isMulti && App.net.members && App.net.members.length);
  const atLobby = App.lobbyMode || (App.state !== 'battle');
  if (!inRoom || !atLobby || App.state === 'battle') {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  const members = App.net.members || [];
  const host = !!App.net.isHost;
  const isManual = App.net.manual === 'hub' || App.net.manual === 'member';
  const tag = document.getElementById('rpTag');
  const info = document.getElementById('rpInfo');
  const sub = document.getElementById('rpSub');
  const listEl = document.getElementById('rpMembers');
  const aiRow = document.getElementById('rpAiRow');
  const startBtn = document.getElementById('btnRpStart');
  const leaveBtn = document.getElementById('btnRpLeave');
  const tipEl = document.getElementById('rpTip');
  const roomName = isManual ? '本地局域网房间' : ('房间码 ' + (App.token || '-'));
  if (tag) tag.textContent = host ? '房主' : '成员';
  if (info) info.textContent = roomName + ' · ' + members.length + ' 人';
  if (sub) sub.textContent = host ? '点成员右侧按钮指定 Boss，或「随机 Boss」；AI 角色在开局时生成' : '等待房主配置角色并发起开局';
  // 成员行：真人列表（含角色标记；房主视角行尾有「设为 Boss / 取消 Boss」）
  listEl.innerHTML = members.map((m, i) => {
    const boss = isBossUnit(m.roleId || 'hero');
    const cls = 'mp-row' + (boss ? ' boss' : '') + (m.id === App.net.myId ? ' me' : '');
    const hostMark = i === 0 ? '<span class="mp-tag host">房主</span>' : '';
    const bossMark = boss ? '<span class="mp-tag">Boss</span>' : '<span class="mp-tag">勇者</span>';
    let roleBtn = '';
    if (host) {
      roleBtn = boss
        ? '<button type="button" class="mp-rolebtn on" data-id="' + m.id + '" data-act="unsetboss">取消 Boss</button>'
        : '<button type="button" class="mp-rolebtn" data-id="' + m.id + '" data-act="setboss">设为 Boss</button>';
    }
    return '<div class="' + cls + '"><span class="mp-name">' + esc(m.name || m.id) + (m.id === App.net.myId ? '（你）' : '') + '</span>'
      + bossMark + hostMark + roleBtn + '</div>';
  }).join('');
  // AI 配置行 / 开始按钮：房主可见；成员端收到开局邀请时“同意 / 拒绝”可见
  if (aiRow) aiRow.style.display = host ? 'flex' : 'none';
  const offerOn = !host && !!(App._roomOffer && App._roomOffer.length);
  const declineBtn = document.getElementById('btnRpDecline');
  if (startBtn) {
    if (host) {
      startBtn.style.display = 'block';
      if (App._roomVote) {
        const v = App._roomVote;
        startBtn.textContent = '取消发起（已同意 ' + Object.keys(v.ok).length + '/' + v.expect.length + '）';
      } else {
        startBtn.textContent = '开始游戏';
      }
      startBtn.disabled = false;
    } else if (offerOn) {
      startBtn.style.display = 'block';
      if (App._roomVoted === true) {
        startBtn.textContent = '已同意，等待房主发起…';
        startBtn.disabled = true;
      } else if (App._roomVoted === false) {
        startBtn.textContent = '改为同意';
        startBtn.disabled = false;
      } else {
        startBtn.textContent = '同意并开始';
        startBtn.disabled = false;
      }
    } else {
      startBtn.style.display = 'none';
      startBtn.disabled = false;
    }
  }
  if (declineBtn) {
    if (!host && offerOn) {
      declineBtn.style.display = 'block';
      if (App._roomVoted === false) {
        declineBtn.textContent = '已拒绝本局';
        declineBtn.disabled = true;
      } else {
        declineBtn.textContent = '拒绝本局';
        declineBtn.disabled = false;
      }
    } else {
      declineBtn.style.display = 'none';
      declineBtn.disabled = false;
    }
  }
  if (leaveBtn) leaveBtn.style.display = 'inline-block';
  const bossNames = members.filter(m => isBossUnit(m.roleId || 'hero')).map(m => m.name || m.id);
  if (tipEl) {
    if (host && App._roomVote) {
      const v = App._roomVote;
      const waitIds = v.expect.filter(id => !v.ok[id]);
      const refuseIds = waitIds.filter(id => v.refused[id]);
      const pendIds = waitIds.filter(id => !v.refused[id]);
      const who = ids => (ids && ids.length ? (App.net.members || []).filter(x => ids.indexOf(x.id) >= 0).map(x => x.name || x.id).join('、') : '');
      const parts = [];
      if (refuseIds.length) parts.push('已拒绝：' + who(refuseIds));
      if (pendIds.length) parts.push('待确认：' + who(pendIds));
      tipEl.textContent = '等待成员确认开局（' + Object.keys(v.ok).length + '/' + v.expect.length + '）。' + (parts.join('；') || '全员已同意，即将开局…') + '。全员同意后自动开局，点「取消发起」可重新配置。';
    } else if (offerOn) {
      if (App._roomVoted === false) {
        tipEl.textContent = '你已拒绝本局，仍留在房间：可点「改为同意」重新加入，或等房主取消后重新发起。';
      } else if (App._roomVoted === true) {
        tipEl.textContent = '已发送同意，等待房主确认全员后统一开局…';
      } else {
        tipEl.textContent = '房主发起开局，角色已安排：' + summarizeRoles(App._roomOffer) + '。点「同意并开始」进入，或点「拒绝本局」留在房间。';
      }
    } else if (host) {
      tipEl.textContent = bossNames.length
        ? '当前 Boss：' + bossNames.join('、') + '。人齐后点「开始游戏」发起开局，全员同意后统一进入。'
        : '尚未指定 Boss：点成员行「设为 Boss」或「随机 Boss」，也可勾选 AI Boss 由 AI 充当。人齐后点「开始游戏」。';
    } else {
      tipEl.textContent = '等待房主发起开局：房主点「开始游戏」后，这里会出现「同意并开始」。';
    }
  }
  refreshRoomAiUi();
}

function summarizeRoles(roles) {
  return (roles || []).filter(r => !r.isBot).map(r => (isBossUnit(r.roleId) ? 'Boss·' : '') + (r.name || r.id)).join('、') || '仅 AI';
}

// 房主：把某成员设为 Boss（其余成员降为勇者）；id 为空 = 全员勇者（Boss 交给 AI）
function assignRoomBoss(id) {
  if (!App.net.isHost) return;
  (App.net.members || []).forEach(m => { m.roleId = (m.id === id) ? 'demon_lord' : 'hero'; });
  syncMembersPanel();
  renderRoomPanel();
  // 广播当前角色预览，成员端房间面板同步显示 Boss 归属
  const roles = (App.net.members || []).map((m, i) => ({ id: m.id, name: m.name || m.id, roleId: m.roleId || 'hero', isHost: i === 0 }));
  App.net.broadcast({ t: 'room_roles', roles });
}

// 房间面板成员行按钮（事件委托）：设为 Boss / 取消 Boss
function onRpMembersClick(ev) {
  const btn = ev.target && ev.target.closest ? ev.target.closest('.mp-rolebtn') : null;
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (btn.getAttribute('data-act') === 'setboss') assignRoomBoss(id);
  else if (btn.getAttribute('data-act') === 'unsetboss') assignRoomBoss('');
}

// 随机 Boss：从当前非 Boss 成员中随机挑一人当 Boss（无人可选则保持现状）
function onRpRandClick() {
  if (!App.net || !App.net.isHost) return;
  const members = App.net.members || [];
  const pool = members.filter(m => !isBossUnit(m.roleId || 'hero'));
  if (!pool.length) return;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  assignRoomBoss(pick.id);
}

// 房主开始游戏：编成全员角色（真人 + 按面板配置的 AI）→ 发起「全员同意」投票，
// 广播 room_start 邀请，全部真人成员 ack 同意后才广播 room_go 统一开局（需求18）
async function hostStartRoomGame() {
  if (!App.net || !App.net.isHost) return;
  if (App._roomVote) return;   // 投票进行中，按钮承担「取消」语义（见 onRpStartClick）
  // 开局前强制重读最新配置（modules.json / skills.json / profiles.json / skillbar.json 等）：
  // 保证配置里改了分组、新增了条目或改了槽位数后，本局编成与实战表现都按新配置生效
  await refreshGameCfg();
  const roles = buildRoomRoles();
  if (!roles.some(r => isBossUnit(r.roleId))) {
    alert('请先指定 Boss：点某位成员的「设为 Boss」/「随机 Boss」，或勾选 AI Boss。');
    return;
  }
  const expect = (App.net.members || []).filter(m => m.id !== App.net.myId).map(m => m.id);
  // 无真人成员可确认（仅房主 + AI）：直接开局，维持旧行为
  if (!expect.length) {
    App.net.broadcast({ t: 'room_start', roles });
    doRoomStart(roles);
    return;
  }
  // 有成员尚未完成直连时禁止发起，避免永远等不齐确认
  const pending = expect.filter(id => {
    const e = App.net.peers.get(id);
    return !e || !e.connected || !(e.dc && e.dc.readyState === 'open');
  });
  if (pending.length) {
    const names = (App.net.members || []).filter(m => pending.indexOf(m.id) >= 0).map(m => m.name || m.id).join('、');
    alert('仍有成员未连接完成：' + names + '。请等待对方进入房间后重试。');
    return;
  }
  App._roomVote = { roles, expect, ok: {}, refused: {} };
  App.net.broadcast({ t: 'room_start', roles });
  renderRoomPanel();
}

// 房主取消本轮开局投票：广播 room_cancel，成员回到等待发起状态（可再点「开始游戏」重邀）
function hostCancelRoomVote() {
  if (!App.net || !App.net.isHost) return;
  if (!App._roomVote) return;
  App._roomVote = null;
  App.net.broadcast({ t: 'room_cancel' });
  renderRoomPanel();
}

// 成员 → 房主：发送开局同意/拒绝（房主恒为成员列表首位）
// 附带本机档案：房主在 room_go 前收集齐全部玩家档案，随 roles 统一下发各端重建
function sendAckToHost(ok) {
  const hostId = App.net.members && App.net.members.length ? App.net.members[0].id : '';
  if (hostId && hostId !== App.net.myId) {
    App.net.sendTo(hostId, {
      t: 'room_ack', ok: !!ok,
      profile: localProfileFor(App.roleId),
      profileId: (profileStore() && profileStore().currentId()) || ''
    });
  }
}

// 开始 / 同意并开始 / 取消发起 按钮（房主投票中=取消；成员投票=同意/改为同意）
function onRpStartClick() {
  if (!App.net || !App.net.isMulti) return;
  if (App.net.isHost) {
    if (App._roomVote) return hostCancelRoomVote();
    return hostStartRoomGame();
  }
  if (!App._roomOffer || !App._roomOffer.length) {
    alert('房主尚未发起开局，请等待通知。');
    return;
  }
  if (App._roomVoted === true) return;   // 已同意，等房主统一开局
  App._roomVoted = true;
  sendAckToHost(true);
  renderRoomPanel();
}

// 成员拒绝本局：留在房间，可改同意；房主收到后不开局（需求19）
function onRpDeclineClick() {
  if (!App.net || !App.net.isMulti || App.net.isHost) return;
  if (!App._roomOffer || !App._roomOffer.length) return;
  if (App._roomVoted === false) return;  // 已拒绝
  App._roomVoted = false;
  sendAckToHost(false);
  renderRoomPanel();
}

// 房主收到成员 ack：全员同意 → 广播 room_go 统一开局；有人拒绝 → 等待其改意或房主取消
function handleRoomAckMsg(fromId, msg) {
  if (!App.net || !App.net.isMulti || !App.net.isHost) return;
  const v = App._roomVote;
  if (!v) return;
  if (v.expect.indexOf(fromId) < 0) return;   // 非本轮发起对象（投票后才加入者）忽略
  // 汇总该成员档案：写入成员行并覆盖其编成行，供 room_go 随 roles 下发各端重建
  const ackProf = sanitizeProfile(msg && msg.profile, fromId);
  if (ackProf) {
    rememberProfile(fromId, ackProf, msg && msg.profileId);
    const row = (v.roles || []).find(r => r.id === fromId);
    if (row) row.profile = ackProf;
  }
  delete v.ok[fromId];
  delete v.refused[fromId];
  (msg && msg.ok ? v.ok : v.refused)[fromId] = true;
  const allAgreed = v.expect.every(id => !!v.ok[id]);
  if (allAgreed) {
    App._roomVote = null;
    App.net.broadcast({ t: 'room_go', roles: v.roles });
    doRoomStart(v.roles);
    return;
  }
  renderRoomPanel();
}

// 成员端收到房主开局邀请：在大厅态记录预案并显示「同意/拒绝」；
// 不在大厅（战斗/结算/重开准备中）则自动同意，等待房主全员确认后 room_go 统一开局
function handleRoomStartMsg(msg) {
  if (!App.net || !App.net.isMulti) return;
  if (App.net.isHost) return;   // 房主本地以投票流程控制，忽略自己的广播回声
  App._roomOffer = msg.roles || [];
  App._roomVoted = null;        // 新一轮邀请重置本人意愿
  if (App.lobbyMode) { renderRoomPanel(); return; }
  App._roomVoted = true;
  sendAckToHost(true);
}

// 成员端收到房主 room_go（全员同意达成）：统一开局
function handleRoomGoMsg(msg) {
  if (!App.net || !App.net.isMulti) return;
  if (App.net.isHost) return;
  App._roomVoted = null;
  if (!msg || !msg.roles || !msg.roles.length) return;
  doRoomStart(msg.roles);
}

// 房主取消本轮发起：成员清空预案与意愿，回到等待发起状态
function handleRoomCancelMsg() {
  if (!App.net || !App.net.isMulti) return;
  if (App.net.isHost) return;   // 房主本端取消已由 hostCancelRoomVote 处理
  const had = !!(App._roomOffer && App._roomOffer.length);
  App._roomOffer = [];
  App._roomVoted = null;
  if (had && App.lobbyMode) { renderRoomPanel(); showLobbyBar(); }
}

// 成员端收到房主角色预览广播：同步本地成员角色标记
function applyRoomRolesMsg(msg) {
  if (!App.net || !App.net.isMulti) return;
  const list = (msg.roles || []).map((x, i) => ({ id: x.id, name: x.name || x.id, roleId: x.roleId || 'hero', isHost: i === 0 }));
  App.net.members = list;
  syncMembersPanel();
  renderRoomPanel();
}

// 战斗中段新成员接入：房主在 DC 建连时推送 room_battle_join（含全量快照），
// 成员端若还停在菜单/大厅则按快照编成直接开战，已在本局则仅做覆盖式对齐，
// 修复“战斗中途加入的人卡在登录/大厅页进不来”问题。
function handleRoomBattleJoinMsg(fromId, msg) {
  if (!App.net || !App.net.isMulti || App.net.isHost) return;
  const snap = (msg && msg.snap) || null;
  if (!snap || !snap.players || !snap.players.length) return;
  App._roomOffer = [];
  App._roomVoted = null;
  if (snap.members && Array.isArray(snap.members) && snap.members.length && App.net.members) {
    App.net.members = snap.members;
    if (snap.members[0]) App.net.hostId = snap.members[0].id;
  }
  // 尚未进入本局（菜单/大厅停驻中）：以快照编成开局，随后 applySnapshot 铺满全量状态
  if (!App.world || App.state !== 'battle') {
    const roles = (snap.players || []).map(p => ({
      id: p.id, name: p.name || p.id, roleId: p.roleId || 'hero',
      isHost: !!p.isHost, isBot: !!p.isBot,
      botKind: p.botKind, aiLevel: p.aiLevel || aiLevelDefault()
    }));
    doRematchStart(roles);
  }
  if (!App.world) return;
  applySnapshot(snap);
}

// ===== 玩家档案 / 模块化配置（设计文档《原子属性与模块化配置设计_v1》第八、十一章）=====
// 档案（config/profiles.json）= 单位底座 unitId + 基础属性覆写 base + 挂载模块条目 modules[];
// 模块上限与条目来源库由 config/modules.json 声明（maxSlots / source / allowDuplicate）。
// 链路：本机选择（localStorage）→ 广播 profile_cfg / 随 room_ack 上报 → 房主汇总校验 → 随 room_start(room_go)
// 的 roles[].profile 与全量快照下发 → 各端按档案重建属性与技能栏（数值合成仍全部由 Combat.calcStats 完成）。
function profileStore() { return (typeof Profiles !== 'undefined') ? Profiles : null; }

// 本机在指定单位模板下应使用的档案（显式选择优先，否则按 unitId 自动匹配；Boss 不挂档案）
function localProfileFor(unitId) {
  const ps = profileStore();
  if (!ps) return null;
  const hit = ps.resolveFor(unitId || App.roleId || 'hero');
  return hit ? hit.profile : null;
}

// 取某成员档案：本人读本地实时选择，他人读同步缓存（m.profile）
function memberProfileOf(m, roleId) {
  const ps = profileStore();
  if (!ps || !m || m.isBot) return null;
  if (m.id === App.net.myId) return localProfileFor(roleId || m.roleId || App.roleId);
  return m.profile || null;
}

// 取某角色编成行应使用的档案（房主汇总 + 本端自用）：本人以本地实时选择为准，其余用房主/同步下发版本
function profileForRoleRow(r) {
  if (!r || r.isBot) return null;
  if (r.id === App.net.myId) return localProfileFor(r.roleId || 'hero') || r.profile || null;
  return r.profile || null;
}

// 档案校验（房主汇总 / 本地装配共用）：超上限截断 / 未知模块与条目剔除 / 不允许重复时去重
function sanitizeProfile(raw, label) {
  const ps = profileStore();
  if (!ps || !raw) return null;
  const res = ps.sanitize(raw);
  if (res.issues && res.issues.length) console.warn('[profile] ' + (label || '') + ' 校验调整：', res.issues);
  return res.profile;
}

// 档案落库到成员行（成员名单全量广播会被重建，故单独 remember，避免同步缓存被冲掉）
function rememberProfile(id, profile, profileId) {
  if (!App.net || !App.net.members) return;
  const m = App.net.members.find(x => x.id === id);
  if (!m) return;
  m.profile = profile || null;
  m.profileId = profileId || '';
}

// 其他端广播来的档案（房主据此汇总开局；成员端据此填充成员行）
function handleProfileCfgMsg(fromId, msg) {
  rememberProfile(fromId, sanitizeProfile(msg && msg.profile, fromId), msg && msg.profileId);
}

// 本机档案选择变更：落 localStorage + 同步成员行 + 广播房间（战斗中不重建本局实体，下一局生效）
function applyLocalProfileChoice(profileId) {
  const ps = profileStore();
  if (!ps) return;
  ps.setCurrentId(profileId || '');
  const prof = localProfileFor(App.roleId);
  rememberProfile(App.net.myId, prof, profileId || '');
  if (App.net.isMulti) App.net.broadcast({ t: 'profile_cfg', profile: prof, profileId: profileId || '' });
  const w = App.world;
  const me = w && w.players.get(App.net.myId);
  if (me && !me.isBoss && App.state !== 'battle') me.applyProfile(prof);   // 大厅态热更新，战斗中下一局生效
  syncMembersPanel();
}

// 档案下拉（配置面板内）：自定义配置 + profiles.json 全部档案，按单位底座标注
function renderProfileSelector() {
  const sel = document.getElementById('cfgProfile');
  const ps = profileStore();
  if (!sel || !ps) return;
  const arr = ps.list();
  const cur = ps.currentId();
  const custom = ps.custom();
  if (cur === ps.CUSTOM_ID) { if (!custom) ps.setCurrentId(''); }        // 自定义配置被清空时回退
  else if (cur && !ps.get(cur)) ps.setCurrentId('');                     // 档案被删除 / 改名时回退自动匹配
  const opts = ['<option value="">不使用档案（按角色模板默认装配）</option>'];
  if (custom) opts.push('<option value="' + ps.CUSTOM_ID + '">自定义配置（面板拖拽结果）</option>');
  arr.forEach(x => {
    const u = (typeof UNITS !== 'undefined' && UNITS[x.profile.unitId]) || {};
    opts.push('<option value="' + x.id + '">' + (u.name ? (u.name + ' · ') : '') + (x.profile.name || x.id) + '</option>');
  });
  sel.innerHTML = opts.join('');
  const now = ps.currentId();
  sel.value = (now === ps.CUSTOM_ID && custom) ? ps.CUSTOM_ID : (ps.get(now) ? now : '');
  updateProfileDesc();
}

// 切换档案：以该档案的模块条目重新装载草稿（面板所见即所选档案，改完保存即写成「自定义配置」）
function onCfgProfileChange() {
  const ps = profileStore();
  const sel = document.getElementById('cfgProfile');
  if (!ps || !sel) return;
  const id = sel.value;
  ps.setCurrentId(id);
  const prof = (id === ps.CUSTOM_ID) ? ps.custom() : ps.get(id);
  cfgState.draft = prof ? cfgDraftFromProfile(prof) : {};
  const tip = document.getElementById('cfgTip');
  if (tip) tip.textContent = id ? '' : '已切换为「不使用档案」：各模块为空，开局按角色模板默认装配。';
  updateProfileDesc();
  renderCfgPanel();
}

// 档案摘要提示（当前选了哪条 / 自动匹配到哪条 / 挂载了几个模块）
function updateProfileDesc() {
  const ps = profileStore();
  const sel = document.getElementById('cfgProfile');
  const tip = document.getElementById('cfgProfileDesc');
  if (!ps || !sel || !tip) return;
  const auto = ps.resolveFor(App.roleId || 'hero');
  const isCustom = sel.value === ps.CUSTOM_ID;
  const picked = isCustom ? ps.custom() : ps.get(sel.value);
  const p = picked || (auto && auto.profile) || null;
  if (!p) { tip.textContent = '暂无可用档案：config/profiles.json 未配置，或当前角色为 Boss（Boss 不挂玩家档案）。'; return; }
  const how = isCustom ? '已选择自定义配置' : (picked ? '已选择' : '未显式选择，按角色自动匹配');
  tip.textContent = how + '：' + (p.name || '') + '（' + ps.describe(p) + '）';
}

// 按当前房间面板配置编成开局全员角色（真人按成员行 roleId；AI 按数量/难度/AI Boss 勾选）
function buildRoomRoles() {
  const members = App.net.members || [];
  const cntSel = document.getElementById('rpAiCount');
  const lvlSel = document.getElementById('rpAiLevel');
  const aiBossChk = document.getElementById('rpAiBoss');
  const cnt = cntSel ? Math.max(0, parseInt(cntSel.value, 10) || 0) : 0;
  const lvl = lvlSel
    ? Math.min(Math.max(parseInt(lvlSel.value, 10) || aiLevelDefault(), 1), aiLevelCount())
    : aiLevelDefault();
  const aiBossOn = !aiBossChk || aiBossChk.checked;
  const roles = members.map((m, i) => ({
    id: m.id, name: m.name || m.id, isHost: i === 0, isBot: false,
    roleId: isBossUnit(m.roleId || 'hero') ? 'demon_lord' : 'hero',
    loadout: (m.loadout && m.loadout.length) ? m.loadout.slice(0, skillLoadoutCap()) : null,
    // 档案随编成下发：房主在此汇总校验（超上限截断 / 未知条目剔除），成员端按 roles[].profile 重建
    profile: sanitizeProfile(memberProfileOf(m, m.roleId || 'hero'), m.id)
  }));
  const hasHumanBoss = roles.some(r => isBossUnit(r.roleId));
  const hostBoss = roles.length ? isBossUnit(roles[0].roleId) : false;
  // 勇者方 AI 队友（房主当 Boss 时是可选的 AI 勇者陪练）；档位上界按 ROOM_MAX 推算，不写死
  const n = Math.min(cnt, aiCountCap(hostBoss ? 'roomFighter' : 'roomAlly'));
  for (let i = 0; i < n; i++) {
    roles.push({
      id: 'ai_' + i, name: hostBoss ? aiBotName('roomFighter', i + 1) : aiBotName('ally', i + 1),
      isHost: false, isBot: true, roleId: 'hero', botKind: 'fighter', aiLevel: lvl
    });
  }
  // 无真人 Boss 且勾选 AI Boss 时额外生成 AI Boss（防双 Boss）
  if (!hasHumanBoss && aiBossOn) {
    // 名称按该 Boss 单位在 units.json 声明的 name + _aiNames.bossSuffix 生成（roleId 为房间协议约定的 Boss 模板 id）
    roles.push({ id: 'boss_bot', name: aiBotName('boss', 1, 'demon_lord'), isHost: false, isBot: true, roleId: 'demon_lord', botKind: 'boss', aiLevel: lvl });
  }
  return roles;
}

// 开局：复用再来一局的权威开局函数（全员复用现有连接，角色以 roles 为准）
function doRoomStart(roles) {
  if (!roles || !roles.length) return;   // 无有效编成不动作（防异常空包）
  App._roomOffer = [];          // 消费掉开局预案，避免回大厅后残留“同意并开始”
  App._roomVoted = null;        // 同步清除成员同意/拒绝标记
  doRematchStart(roles);
}

// ===== AI 配置读取区（难度档位 / 默认档位 / AI 数量上限，全部读配置，不写死）=====
// 数据来源：config/ai.json（全局 BOT_LEVELS：档位参数表 + 档位数量）
//           config/challenge.json（全局 CHALLENGE：默认档位 aiLevel、单人 AI 勇者队人数 soloTeamAi、可选数量封顶字段）
//           config/runtime.json（全局 GAME_CONFIG.ROOM_MAX：房间总座位）
// 约定：配置缺字段时一律退回原有默认行为，不报错、不阻塞界面。
// AI 难度档位表：兼容 { defaultLevel, levels: [...] } 与纯数组 [...] 两种写法；配置缺失返回 null
function aiLevelTable() {
  const raw = (typeof BOT_LEVELS !== 'undefined' && BOT_LEVELS) ? BOT_LEVELS : null;
  const arr = Array.isArray(raw) ? raw : ((raw && Array.isArray(raw.levels)) ? raw.levels : null);
  return (arr && arr.length) ? arr : null;
}
// 档位总数：ai.json 数组长度；缺失时用 bot.js 内置兜底表（5 档），再兜底 5
function aiLevelCount() {
  const t = aiLevelTable();
  if (t) return t.length;
  if (typeof BotAI !== 'undefined' && BotAI && BotAI.levelCount) return BotAI.levelCount();
  return 5;
}
// 单档定义（仅取下拉文案用的 name）
function aiLevelEntry(n) {
  const t = aiLevelTable() || ((typeof BotAI !== 'undefined' && BotAI && BotAI._table) ? BotAI._table() : null);
  return (t && t[n - 1]) ? t[n - 1] : null;
}
// 下拉文案：Lv3 · 普通（配置没写 name 时只显示 Lv3）
function aiLevelLabel(n) {
  const e = aiLevelEntry(n);
  const nm = (e && e.name) || '';
  return 'Lv' + n + (nm ? ' · ' + nm : '');
}
// 默认档位：ai.json.defaultLevel → challenge.json.aiLevel → 兜底 2；并夹到 1 ~ 档位数
function aiLevelDefault() {
  const raw = (typeof BOT_LEVELS !== 'undefined' && BOT_LEVELS) ? BOT_LEVELS : null;
  const ch = (typeof CHALLENGE !== 'undefined' && CHALLENGE) ? CHALLENGE : null;
  const want = (raw && !Array.isArray(raw) && raw.defaultLevel) || (ch && ch.aiLevel) || 2;
  return Math.max(1, Math.min(aiLevelCount(), parseInt(want, 10) || 2));
}
// 房间总座位：runtime.json 的 ROOM_MAX；缺失返回 0（由调用方退回原有默认上限）
function roomMaxSeats() {
  const m = parseInt((typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG && GAME_CONFIG.ROOM_MAX), 10);
  return (m > 0) ? m : 0;
}
// AI 数量档位上限（由 ROOM_MAX 扣除必要席位推算）：
//   roomFighter  房间内 AI 勇者（房主当 Boss）：ROOM_MAX - 真人席位
//   roomAlly     房间内 AI 队友（勇者方）：ROOM_MAX - 真人席位 - 1（留 1 个 Boss 席）
//   soloFighter  单人「你当 Boss」的 AI 勇者队：ROOM_MAX - 1（自己占 1 席）
//   soloAlly     单人「你当勇者」的 AI 队友：ROOM_MAX - 2（自己 + AI Boss）
// ROOM_MAX 缺失 → 退回原有写死上限（AI 勇者 4 / AI 队友 3）；challenge.json 同名封顶字段存在时再取小
function aiCountCap(kind) {
  const ch = (typeof CHALLENGE !== 'undefined' && CHALLENGE) ? CHALLENGE : {};
  const seats = roomMaxSeats();
  const inRoom = !!(App.net && App.net.isMulti);
  const humans = inRoom ? Math.max(1, (((App.net.members || []).length) || 1)) : 1;
  const legacy = (kind === 'roomFighter' || kind === 'soloFighter') ? 4 : 3;   // 原写死上限：AI 勇者 4 / AI 队友 3
  let cap;
  if (!seats) cap = legacy;
  else if (kind === 'roomFighter') cap = seats - humans;
  else if (kind === 'roomAlly') cap = seats - humans - 1;
  else if (kind === 'soloFighter') cap = seats - 1;
  else cap = seats - 2;
  const key = {
    roomFighter: 'maxAiFighters', roomAlly: 'maxAiAllies',
    soloFighter: 'maxSoloFighters', soloAlly: 'maxSoloAllies',
  }[kind];
  const ov = parseInt(ch && ch[key], 10);
  if (Number.isFinite(ov) && ov >= 0) cap = Math.min(cap, ov);   // 可选显式封顶
  return Math.max(0, Math.min(cap, 32));   // 32 项防御上限：异常配置（如 ROOM_MAX 误填 1000）不至于生成上千下拉项
}
// 单人「你当 Boss」时 AI 勇者队人数预设：challenge.json.soloTeamAi → 兜底 3，且不超过档位上限
function soloTeamAiDefault() {
  const ch = (typeof CHALLENGE !== 'undefined' && CHALLENGE) ? CHALLENGE : {};
  const n = parseInt(ch.soloTeamAi, 10);
  return Math.min((Number.isFinite(n) && n >= 0) ? n : 3, aiCountCap('soloFighter'));
}
// 单人挑战下拉：难度档位（按 ai.json 档位数）与 AI 队友数量（按 ROOM_MAX 推算上限）全部运行时生成
function populateSoloAiSelectors() {
  const diffSel = document.getElementById('soloDiff');
  if (diffSel) {
    const n = aiLevelCount();
    const key = 'L' + n;
    const cur = parseInt(diffSel.value, 10);
    const keep = (cur >= 1 && cur <= n) ? cur : aiLevelDefault();
    if (diffSel._optsKey !== key) {
      diffSel.innerHTML = '';
      for (let v = 1; v <= n; v++) {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = aiLevelLabel(v);
        diffSel.appendChild(o);
      }
      diffSel._optsKey = key;
    }
    diffSel.value = String(keep);
  }
  const allySel = document.getElementById('soloAllies');
  if (allySel) {
    const allyName = aiLabel('allyLabel');   // 标题文案读 units.json 的 _aiNames，不写死在 HTML；缺配置时保留 HTML 兜底 title
    if (allyName) allySel.title = allyName + '数量';
    const cap = aiCountCap('soloAlly');
    const key = 'A' + cap;
    if (allySel._optsKey !== key) {
      const cur = parseInt(allySel.value, 10);
      allySel.innerHTML = '';
      for (let v = 0; v <= cap; v++) {
        const o = document.createElement('option');
        o.value = String(v);
        const al = aiLabel('allyLabel');   // 称谓读 units.json 的 _aiNames；缺配置时只显示数字，不写死文案
        o.textContent = al ? (v === 0 ? ('不带 ' + al) : ('带 ' + v + ' 个 ' + al)) : String(v);
        allySel.appendChild(o);
      }
      allySel._optsKey = key;
      allySel.value = (cur >= 0 && cur <= cap) ? String(cur) : '0';
    }
  }
}
// 配置刷新后统一重建 AI 相关下拉（单人 + 房间）：refreshGameCfg 内调用
function syncAiCfgUi() {
  populateSoloAiSelectors();
  syncSoloOppText();
  if (typeof refreshRoomAiUi === 'function') refreshRoomAiUi();
}
// 单人挑战「挑战对象」下拉文案：按配置生成（默认单位名 + units.json 的 _aiNames 称谓），不写死在 HTML
function syncSoloOppText() {
  const sel = document.getElementById('soloOpp');
  if (!sel || sel.options.length < 2) return;
  const you = unitDisplayName(defaultPlayerUnitId());
  if (you) sel.options[0].textContent = '挑战 AI Boss（你当' + you + '）';
  const fighter = aiLabel('fighterLabel');   // 称谓读 units.json 的 _aiNames；缺配置时保留 HTML 里的兜底文案
  if (fighter) sel.options[1].textContent = '挑战 ' + fighter + '队（你当 Boss）';
}
// ===== AI 配置读取区结束 =====

// 房间面板 AI 配置行联动（常驻不隐藏；自己已是 Boss / 房内已有真人 Boss 时 AI Boss 选项禁用）
function refreshRoomAiUi() {
  const cntSel = document.getElementById('rpAiCount');
  const lvlSel = document.getElementById('rpAiLevel');
  const aiBossChk = document.getElementById('rpAiBoss');
  if (!cntSel) return;
  // 房间内以房主/成员角色为准：房主是 Boss 时可带更多 AI 勇者
  const hasHumanBoss = !!(App.net && App.net.members && App.net.members.length
    && App.net.members.some(m => isBossUnit(m.roleId || 'hero')));
  const selfBoss = hasHumanBoss && App.net && App.net.members && App.net.members[0]
    && isBossUnit(App.net.members[0].roleId || 'hero');
  const bossLike = !!(App.net && App.net.isMulti && !!selfBoss);
  // 数量下拉：档位上界按 runtime.json ROOM_MAX 扣除必要席位推算（房主当 Boss = AI 勇者；勇者方 = AI 队友）
  const cap = aiCountCap(bossLike ? 'roomFighter' : 'roomAlly');
  const cntName = bossLike ? aiLabel('fighterLabel') : aiLabel('allyLabel');   // 标题称谓读 units.json 的 _aiNames，不写死在 HTML
  if (cntName) cntSel.title = cntName + '数量';
  const optsKey = (bossLike ? 'F' : 'A') + cap;
  if (cntSel._optsKey !== optsKey) {
    const cur = cntSel.value;
    cntSel.innerHTML = '';
    for (let v = 0; v <= cap; v++) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = String(v);
      cntSel.appendChild(o);
    }
    cntSel._optsKey = optsKey;
    cntSel.value = (cur !== '' && parseInt(cur, 10) >= 0 && parseInt(cur, 10) <= cap) ? cur : '0';
  }
  // 难度下拉：档位按 config/ai.json 实际档位数生成，默认档位取配置里的默认档位
  if (lvlSel) {
    const lvlN = aiLevelCount();
    const lvlKey = 'L' + lvlN;
    if (lvlSel._optsKey !== lvlKey) {
      const cur = parseInt(lvlSel.value, 10);
      lvlSel.innerHTML = '';
      for (let v = 1; v <= lvlN; v++) {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = aiLevelLabel(v);
        lvlSel.appendChild(o);
      }
      lvlSel._optsKey = lvlKey;
      lvlSel.value = (cur >= 1 && cur <= lvlN) ? String(cur) : String(aiLevelDefault());
    }
  }
  if (aiBossChk) {
    // 房内已有真人 Boss / 自己当 Boss：AI Boss 不生成 → 取消勾选并禁用（选项常驻不隐藏）
    if (hasHumanBoss) {
      aiBossChk.checked = false;
      aiBossChk.disabled = true;
    } else {
      aiBossChk.disabled = false;
    }
  }
}

// 默认令牌服务器地址：优先当前页面的局域网 IP，否则取 config 的信令服务器
function defaultSignalAddr() {
  const hn = location.hostname || '';
  const ipRe = /^(\d{1,3}\.){3}\d{1,3}$/;
  const base = (GAME_CONFIG && GAME_CONFIG.SIGNAL_BASE) || 'http://127.0.0.1:8080';
  if (ipRe.test(hn) && hn !== '127.0.0.1' && hn !== '0.0.0.0') {
    try {
      const u = new URL(base);
      return hn + ':' + (u.port || '80');
    } catch (e) { /* fallthrough */ }
  }
  try {
    const u = new URL(base);
    return u.hostname + ':' + (u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch (e) {
    return '127.0.0.1:8080';
  }
}

// 生成“对局令牌”：提取信令地址关键参数 + 房间码，压缩成短字符串并展示在右上角分享条
function setupTokenShare() {
  const token = App.token;
  if (!token) return;
  const addr = (document.getElementById('signalHost').value || '').trim() || defaultSignalAddr();
  let host = addr, port = 8080;
  const m = /^(.*?):(\d+)$/.exec(addr);
  if (m) { host = m[1]; port = parseInt(m[2], 10); }
  host = String(host).replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').trim();
  App.tokenShare = TokenCodec.encode({ host, port, room: token });
  const tokInput = document.getElementById('joinTok');
  if (tokInput && jbEl()) {
    tokInput.value = App.tokenShare || ('房间码: ' + token);
    jbShow(false);   // 建房后默认折叠成右上角小条，不再挡屏
    showJoinZone('joinTokZone', false);
  }
}

// 联机房间 AI 由 buildRoomRoles() 在房主点“开始游戏”时统一编成（含真人角色 + AI 队友 / AI Boss），
// 不再在建房瞬间预生成；全员（含 AI）经 doRoomStart → doRematchStart 权威开局，成员端接受后同局同步。
// 真人 Boss 加入勇者房时，移除房主预置的 AI Boss（避免双 Boss）
function removeRoomBossBot() {
  const w = App.world;
  if (!w || !App.net.isHost) return;
  for (const p of w.players.values()) {
    if (p.isBoss && p.botKind === 'boss') {
      w.removePlayer(p.id);
      App.net.broadcast({ t: 'bot_remove', id: p.id });
      syncMembersPanel();   // AI Boss 移除后刷新成员面板
      break;
    }
  }
}

function startBattle() {
  App.world = new World(App.net);
  // 单人开房时信令 joined 可能尚未到达，先以自己兜底建房主玩家
  const members = App.net.members.length
    ? App.net.members
    : [{ id: App.net.myId, name: App.name, roleId: App.roleId, isHost: true }];
  members.forEach(m => {
    const role = m.id === App.net.myId ? App.roleId : (m.roleId || 'hero');
    const p = App.world.addPlayer(m.id, m.id === App.net.myId ? App.name : (m.name || m.id), role, m.id === members[0].id,
      sanitizeProfile(memberProfileOf(m, role), m.id));
    if (m.id === App.net.myId) applyLocalSkillCfg(p, role);
    else if (m.loadout && m.loadout.length) p.loadout = m.loadout.slice(0, skillLoadoutCap());
  });
  enterBattleView();               // 隐藏菜单/显示画布/清理结算与重开浮层（与再来一局共用）
  if (App.net.isMulti) {
    flushPendingBots();            // 补建 world 就绪前缓存到的房主 AI 名单（P1-4）
    if (!App.net.isHost) requestSnapshot();   // 成员端开局后主动要一次全量快照
  }
  syncMembersPanel();              // 开局后即显示常驻成员面板
}

// ===== 名称 / 默认角色读取区：全部来自配置，src 零写死 =====
// 默认玩家侧单位模板 id：config/challenge.json 的 player → Profiles.defaultUnitId()（profiles.json → units.json → challenge.json → 兜底）
function defaultPlayerUnitId() {
  const ch = (typeof CHALLENGE !== 'undefined' && CHALLENGE) ? CHALLENGE : null;
  const id = (ch && typeof ch.player === 'string') ? ch.player.trim() : '';
  if (id && typeof UNITS !== 'undefined' && UNITS && UNITS[id] && !UNITS[id].isBoss) return id;
  return (typeof Profiles !== 'undefined' && Profiles.defaultUnitId) ? Profiles.defaultUnitId() : 'hero';
}
// 默认 Boss 单位模板 id：config/challenge.json 的 boss → units.json 首个 isBoss 模板 → 兜底
function defaultBossUnitId() {
  return (typeof Profiles !== 'undefined' && Profiles.defaultBossUnitId) ? Profiles.defaultBossUnitId() : 'demon_lord';
}
// 单位显示名：读 config/units.json 的 name；缺字段退回单位 id，不写死名称文案
function unitDisplayName(unitId) {
  return (typeof Profiles !== 'undefined' && Profiles.unitDisplayName) ? Profiles.unitDisplayName(unitId) : '';
}
// 玩家默认昵称：默认单位名 + 随机后缀（原写死 '勇者' + 随机数）
function defaultPlayerName() {
  return unitDisplayName(defaultPlayerUnitId()) + Math.floor(Math.random() * 900 + 100);
}
// AI 名称：模板读 config/units.json 的 _aiNames（实现在 bot.js BotAI.botName），缺配置退回内置文案
function aiBotName(kind, idx, unitId) {
  return (typeof BotAI !== 'undefined' && BotAI.botName) ? BotAI.botName(kind, idx, unitId) : '';
}
// 界面 AI 称谓（数量下拉文案 / 标题）：读 config/units.json 的 _aiNames
function aiLabel(key) {
  return (typeof BotAI !== 'undefined' && BotAI.nameCfg) ? BotAI.nameCfg(key) : '';
}

// 填充单机选人下拉：由 units.json 配置驱动（selectable 模板自动进列表，src 零改动）
// 默认角色取 config/challenge.json（CHALLENGE.player / CHALLENGE.boss），可随时改默认值
function populateUnitSelectors() {
  const unitSel = document.getElementById('soloUnit');
  const bossSel = document.getElementById('soloBoss');
  if (!unitSel || !bossSel || !UNITS) return;
  const defP = defaultPlayerUnitId();
  const defB = defaultBossUnitId();
  const unitOpts = [];
  const bossOpts = [];
  for (const id in UNITS) {
    const u = UNITS[id];
    if (!u || !u.name) continue;
    if (u.selectable === false) continue;   // 显式关闭才不进下拉（隐藏单位仍可被代码引用）
    // （默认）标记按配置给出的默认角色动态加，不写死在 HTML
    const mark = (id === defP || id === defB) ? '（默认）' : '';
    if (u.isBoss) {
      bossOpts.push('<option value="' + id + '">敌方 Boss：' + u.name + mark + '</option>');
    } else {
      unitOpts.push('<option value="' + id + '">你：' + u.name + mark + '</option>');
    }
  }
  if (unitOpts.length) unitSel.innerHTML = unitOpts.join('');
  if (bossOpts.length) bossSel.innerHTML = bossOpts.join('');
  if (UNITS[defP] && !UNITS[defP].isBoss) unitSel.value = defP;
  if (UNITS[defB] && UNITS[defB].isBoss) bossSel.value = defB;
}

// ---- 单人挑战（离线 AI，档位数由 config/ai.json 决定）----
async function startChallenge() {
  if (guardLobby()) return;
  await refreshGameCfg();   // 开局前重读最新配置：技能栏槽位数 / 分组 / 候选条目均以磁盘配置为准
  const opp = document.getElementById('soloOpp').value;   // boss | team
  const level = parseInt(document.getElementById('soloDiff').value, 10) || aiLevelDefault();
  const unit = document.getElementById('soloUnit');
  const boss = document.getElementById('soloBoss');
  const unitId = unit && unit.value ? unit.value : defaultPlayerUnitId();
  const bossId = boss && boss.value ? boss.value : defaultBossUnitId();
  const unitName = unitDisplayName(unitId);
  const bossName = unitDisplayName(bossId);
  if (opp === 'team') {
    // 你当 Boss，挑战一队 AI 勇者（AI 假装玩家：锁定/释放/闪避/拉扯）
    startSoloGame({
      mode: 'team',
      playerRole: bossId,      // 你扮演所选 Boss 模板
      fighterRole: unitId,     // AI 勇者队 = 所选勇者模板
      level,
      allies: soloTeamAiDefault(),   // AI 勇者队人数：challenge.json 的 soloTeamAi（缺省 3），并按 ROOM_MAX 推算上限收口
      desc: '单人挑战 · 你当' + bossName + ' VS ' + aiLabel('fighterLabel') + '队(Lv' + level + ')',
    });
  } else {
    // 你当勇者（可选模板），挑战 AI Boss（可选模板）；可带 0~3 个 AI 队友
    const allies = parseInt(document.getElementById('soloAllies').value, 10) || 0;
    startSoloGame({
      mode: 'boss',
      playerRole: unitId,
      bossRole: bossId,
      level,
      allies,
      desc: '单人挑战 · ' + unitName + ' VS ' + aiBotName('boss', 1, bossId) + '(Lv' + level + ')' + (allies ? ' + ' + aiLabel('allyLabel') + 'x' + allies : ''),
    });
  }
}

// 通用单人开局：mode='boss' 你当勇者挑战 AI Boss；mode='team' 你当 Boss 打 AI 勇者队
function startSoloGame(opt) {
  App.name = document.getElementById('name').value || App.name;
  App.lastSoloOpt = JSON.parse(JSON.stringify(opt || {}));   // 记忆上一局配置，“再来一局”本地复用
  const myId = 'solo_' + Math.floor(Math.random() * 9000 + 1000);
  const playerUnit = opt.playerRole || defaultPlayerUnitId();
  // 本地权威 stub：isHost=true 让 World 走房主结算，broadcast 无人接收
  App.net = buildSoloNet(myId, playerUnit);
  App.token = '';
  const w = new World(App.net);
  w.solo = true;
  w.challenge = true;          // 挑战规则：AI 死亡不复活，勇者全灭即 Boss 胜（玩家扮演 Boss 对称生效）
  w.soloInfo = opt.desc;
  // 玩家档案（config/profiles.json）：单机同样按本机选择的档案装配属性与技能（Boss 模板不挂档案）
  const me = w.addPlayer(myId, App.name, playerUnit, true, localProfileFor(playerUnit));
  if (opt.playerHpMul && opt.playerHpMul !== 1) {
    // 快速试玩专用：玩家生命按比例放大，降低新手挫败
    const pm = Math.max(1, Math.min(3, opt.playerHpMul));
    me.statsTotal.hp = Math.round(me.statsTotal.hp * pm);
    me.hp = me.statsTotal.hp;
  }
  if (opt.mode === 'team') {
    // 你扮演 Boss；AI 勇者队（可选勇者模板，视觉位自动配色区分）
    const fighterRole = opt.fighterRole || defaultPlayerUnitId();
    const n = Math.min(opt.allies || soloTeamAiDefault(), aiCountCap('soloFighter'));
    for (let i = 0; i < n; i++) {
      const p = w.addPlayer('bot_h' + i, aiBotName('soloFighter', i + 1, fighterRole), fighterRole, false);
      w.addSoloBot(p, 'fighter', opt.level);
    }
  } else {
    // 你扮演勇者（可选模板）；AI Boss（可选模板）+ 可选 AI 队友
    const bossRole = opt.bossRole || defaultBossUnitId();
    const boss = w.addPlayer('boss_bot', aiBotName('boss', 1, bossRole), bossRole, false);
    w.addSoloBot(boss, 'boss', opt.level);
    if (opt.bossHpMul && opt.bossHpMul !== 1) {
      // 快速试玩专用：按比例削弱 Boss 生命，保持 _statsBase 引用一致
      // （_hpScaleMul 为持久因子：条件型模块重算会重跑 calcStats，由 Player 在该路径重新套用，削弱不被抹掉）
      const mul = Math.max(0.2, Math.min(1, opt.bossHpMul));
      boss._hpScaleMul = mul;
      boss._applyHpScale(boss.statsTotal);
      boss._statsBase = boss.statsTotal;
      boss._statsBaseNoCond = boss.statsTotal;
      boss.hp = boss.statsTotal.hp;
    }
    const n = Math.min(Math.max(0, opt.allies || 0), aiCountCap('soloAlly'));
    const allyRole = opt.fighterRole || opt.playerRole || defaultPlayerUnitId();
    for (let i = 0; i < n; i++) {
      const p = w.addPlayer('ally_' + i, aiBotName('ally', i + 1, allyRole), allyRole, false);
      w.addSoloBot(p, 'fighter', Math.max(1, opt.level - 1));   // 队友略弱于挑战难度，突出“你”
    }
  }
  App.world = w;
  // 单人配置（需求4/9）：应用本地保存的自选 loadout 与自动普攻开关（仅对玩家自己生效）
  applyLocalSkillCfg(me, opt.playerRole);
  enterBattleView();   // 单人无房间：仅清理结算/重开浮层并显示画布
  hideMembersUI();
}

// 应用本地技能配置（配置面板保存的出战技能与自动普攻开关；cfg.loadout 含技能 id 数组，按格子顺序）
// 可选范围放宽到三处来源：角色模板技能 + 技能模块候选池（面板可拖入的条目）+ 当前已解锁技能池
function applyLocalSkillCfg(me, unitId) {
  App.autoAttack = true;   // 默认开启自动普攻，未保存过配置时保持原玩法
  if (!me) return;
  const cfg = loadSkillCfg();
  if (cfg && typeof cfg.autoAttack === 'boolean') App.autoAttack = cfg.autoAttack;
  if (!cfg || !cfg.loadout || !cfg.loadout.length || !UNITS[unitId]) return;
  const unitPool = (UNITS[unitId].skills || []).slice();
  // 技能模块候选池：模块 id 由 config/modules.json 按用途（source=skills 的模块）反查，不写死模块 id
  const modPool = (typeof Profiles !== 'undefined') ? Profiles.candidates(skillModuleId()) : [];
  const unlocked = me.skillPool || [];
  const chosen = cfg.loadout
    .filter(id => SKILLS[id] && (unitPool.indexOf(id) >= 0 || modPool.indexOf(id) >= 0 || unlocked.indexOf(id) >= 0))
    .slice(0, skillLoadoutCap());
  if (chosen.length) me.loadout = chosen;   // 覆盖默认按优先级排序，完全以面板格子顺序出战
}

// 本地权威 stub（单人离线）
function buildSoloNet(myId, role) {
  return {
    myId,
    members: [{ id: myId, name: App.name, roleId: role, isHost: true }],
    peers: new Map(),
    isHost: true,
    selfRole: role,
    isMulti: false,
    broadcast() {},
    sendTo() {},
    removePeer() {},
    relayShoot() {},
    notifyRole() {}
  };
}

// 将单位模板应用到玩家实体（本地转职与远端 hello 换模板共用）
function applyRole(p, unitId, name) {
  if (!p || !UNITS[unitId]) return;
  p.name = name || p.name;
  p.unitId = unitId;
  p.roleId = unitId;
  p.classId = unitId;
  p.cfg = UNITS[unitId];
  p.image = p.cfg.image || null;          // 换皮字段随模板刷新
  const wasBoss = p.isBoss;
  p.isBoss = !!p.cfg.isBoss;
  p.team = p.isBoss ? 'boss' : 'players';
  // 转为 Boss：出生校正到场中央
  if (p.isBoss && !wasBoss) {
    const sp = Player.spawnPos(4, GAME_CONFIG.ARENA);
    p.x = sp.x; p.y = sp.y;
  }
  // 模板切换后重建模块化状态（装备/触发/合成数值/可用技能）
  p.equipment = (p.cfg.equipment || []).slice();
  p.triggerUnlocked = [];
  p._triggers = {};                 // 阶段触发标记随模板重置（换角色/转 Boss 后血线与时间阶段可重新走一遍）
  p.statsTotal = Combat.calcStats(p);
  BuffSystem.clearAll(p);                 // P2：切角色丢弃旧 buff（含护盾），避免跨模板残留
  p._statsBase = p.statsTotal;            // P2：buff 合成基准引用（无 buff 时合成即基准）
  p._statsBaseNoCond = p.statsTotal;      // 方案 C：条件重算基线随模板切换重置
  p._condKey = null;                      // 条件签名失效，下帧按新模板重算条件型模块
  if (p._refreshBuffStats) p._refreshBuffStats();
  p.radius = p.statsTotal.radius;         // 半径/碰撞/贴图尺寸随模板刷新
  p.setSlot(p.slot);                      // 观感色随模板刷新
  if (p.hp > p.statsTotal.hp) p.hp = p.statsTotal.hp;
  p.rebuildSkillBar();
}

// ---- 应用层消息分发（DataChannel）----
// ================= 需求4：战斗消息时间戳 / 过期丢弃 =================
// 设计：发送端（net.js）给每条战斗消息打 ts = performance.now()（单调时钟）。
// 各端 performance.now() 基准不同（不同页面的 timeOrigin），因此接收端按发送端分别估计时钟偏移 skew：
// 单向延迟 ≥ 0 → (本机now - ts) 必然 ≥ 真实偏移，取历史最小值即逼近真实偏移（最小延迟样本法）。
const MSG_MAX_AGE = 0.9;     // 战斗消息（shoot / pos / damage 表现）过期阈值（秒）：超过视为过期
function noteTs(fromId, ts) {
  if (!fromId || typeof ts !== 'number') return null;
  const d = performance.now() - ts;
  const cur = App._tsSkewBy[fromId];
  if (cur == null) App._tsSkewBy[fromId] = d;                       // 首包直接建立基准
  else if (d < cur) App._tsSkewBy[fromId] = cur + (d - cur) * 0.5;  // 仅向"更小延迟"方向收敛一半，抗抖动
  return App._tsSkewBy[fromId];
}
// 返回消息年龄（秒）；无法判定（无时间戳/无发送端）返回 -1 → 按"不过期"处理，保证老流程不被打断
function msgAgeSec(fromId, msg) {
  if (!msg || typeof msg.ts !== 'number') return -1;
  if (fromId && fromId === App.net.myId) return 0;                  // 本机自己发出的消息
  const skew = noteTs(fromId, msg.ts);
  if (skew == null) return -1;
  const localTs = msg.ts + skew;                                    // 换算到本机时间轴
  // 后台切回前台的闸门：早于闸门的消息一律判为过期（后台期间积压的消息不再参与计算/渲染）
  if (App._resumeGateMs && localTs < App._resumeGateMs) return 99;
  return Math.max(0, (performance.now() - localTs) / 1000);
}
App.msgAgeSec = msgAgeSec;

function handleData(fromId, msg) {
  if (!msg || typeof msg !== 'object') return;
  // members 是连接/房间层名单消息，不依赖战斗世界：手动星形成员在菜单页等待房主确认时
  // App.world 尚未创建，必须独立于世界先分发（据此 startBattle 开局），否则首包名单会被
  // 下方“未开局即丢弃”的世界前置检查吞掉，成员端永远卡在菜单页。
  if (msg.t === 'members') { handleMembersMsg(msg); return; }
  // 再来一局 / 全量快照 / AI 名单是房间层消息：即使战斗世界尚未就绪（新成员菜单等待开局时
  // App.world 为空）也须先处理，与 members 同理放在世界前置检查之前，避免被提前丢弃。
  if (msg.t === 'again') { handleAgainMsg(fromId, msg); return; }
  if (msg.t === 'snap') { applySnapshot(msg); return; }
  if (msg.t === 'bot_sync' && !App.world) { App._pendingBots.push(msg); return; }
  // 房间大厅协议：房主广播角色预案（room_roles）与开局邀请（room_start），与战斗世界无关，须先于世界检查
  if (msg.t === 'room_start') { handleRoomStartMsg(msg); return; }
  if (msg.t === 'room_go') { handleRoomGoMsg(msg); return; }
  if (msg.t === 'room_ack') { handleRoomAckMsg(fromId, msg); return; }
  if (msg.t === 'room_cancel') { handleRoomCancelMsg(); return; }
  if (msg.t === 'room_roles') { applyRoomRolesMsg(msg); return; }
  if (msg.t === 'room_battle_join') { handleRoomBattleJoinMsg(fromId, msg); return; }
  if (msg.t === 'skills_cfg') { handleSkillsCfgMsg(fromId, msg); return; }
  if (msg.t === 'profile_cfg') { handleProfileCfgMsg(fromId, msg); return; }   // 玩家档案（模块化配置）同步
  const w = App.world;
  if (!w) return;
  switch (msg.t) {
    case 'hello': {
      const p = w.players.get(fromId);
      applyRole(p, msg.roleId, msg.name);
      App.net.sendTo(fromId, { t: 'hello', name: App.name, roleId: App.roleId });
      break;
    }
    case 'pos': {
      const p = w.players.get(msg.id);
      if (p && p.id !== App.net.myId && p.alive) {
        // 需求4：过期位置直接丢弃（后台积压/网络滞留的历史坐标不回退覆盖当前位置）
        if (msgAgeSec(fromId, msg) > MSG_MAX_AGE) break;
        w._posDirectAt[msg.id] = performance.now();   // 直连位置新鲜度标记（state 兜底用）
        p.tx = msg.x; p.ty = msg.y;
        if (!p._hasTarget) { p.x = msg.x; p.y = msg.y; p._hasTarget = true; }
        p.dir = msg.dir;
      }
      break;
    }
    case 'shoot':
      // 需求4：过期弹道直接丢弃——不生成子弹（不参与计算）、不渲染
      if (msgAgeSec(fromId, msg) > MSG_MAX_AGE) break;
      w.spawnSkillBullets(msg);
      break;
    case 'cast':
      // 需求1~4：远端读条（Boss / 队友的蓄力 / 禁咒 / 吟唱）——纯表现层，不参与判定与结算
      if (typeof CastSystem !== 'undefined' && CastSystem.showRemote) CastSystem.showRemote(w, msg);
      break;
    // 本轮新增（撕裂 DoT 双链路）：远端命中上报——非房主端 checkCollisions/_settleLanding 命中后把载荷
    //   （含 skillId / tear）发到房主，这里补上入站分支让信令真正抵达房主结算入口。
    //   房主：w.handleHit(fromId, msg) 统一权威结算（伤害 + 撕裂应用）；非房主收到该信令直接忽略，避免重复结算。
    case 'hit': {
      if (App.net.isHost) w.handleHit(fromId, msg);
      break;
    }
    // 本轮新增（需求④ 环绕飞刃拦截两端一致）：房主权威拦截结果的镜像信令——
    //   房主端自己已结算，忽略即可；远端只按广播执行表现（摘掉被抵消的来袭弹 + 对齐格挡计数），
    //   不自行判定、不结算伤害，避免双端各算一次。
    case 'orbit_block': {
      if (!App.net.isHost && w.applyOrbitBlock) w.applyOrbitBlock(msg);
      break;
    }
    // 本轮新增（撕裂 DoT）：房主撕裂应用广播——远端仅镜像表现（红环 + 状态条 chip），血量以 damage 广播为准
    case 'dot_add': {
      const p = w.players.get(msg.id);
      if (p) {
        BuffSystem.mirrorDot(p, { defId: 'tear', skillId: msg.skillId || null, color: msg.color || null,
                                  stacks: msg.stacks || 1, tLeft: (typeof msg.tLeft === 'number' ? msg.tLeft : undefined) });
        w.pushFx('buff', p.x, p.y, msg.color || '#c04bff', { buffId: 'tear' });
      }
      break;
    }
    case 'charge_bar':
      // 需求1：远端蓄力进度刷新（约 10Hz，由 world.chargeBarTick 发出）→ 驱动远端蓄力读条
      if (w.onChargeBar) w.onChargeBar(msg);
      break;
    case 'damage': {
      const p = w.players.get(msg.targetId);
      if (p) {
        p.hp = msg.hp;   // 血量始终以房主裁决为准（即使消息偏旧也要对齐权威值）
        if (typeof msg.sh === 'number') p.setShieldLeft(msg.sh);   // P2：护盾剩余随伤害广播权威同步
        // 伤害浮动数字：命中 Boss / 玩家后从目标身上弹出（-dmg），护盾全额吸收(0)不弹
        // 需求4：过期伤害只对齐数值，不再补弹历史飘字（不渲染后台期间积压的表现）
        // msg.crit：房主按攻击者属性掷出的暴击标记，与 dmg 同一条广播 -> 飘字/扣血数值一致
        if (msg.dmg > 0 && w.pushFx && msgAgeSec(fromId, msg) <= MSG_MAX_AGE) {
          w.pushFx('dmg', p.x, p.y - (p.radius || 26) - 10, p.isBoss ? '#ff6b4a' : '#e63b3b', { val: Math.round(msg.dmg), crit: !!msg.crit });
        }
      }
      // P2：吸血回血：damage 附带攻击者真实回血量（房主结算后广播）
      if (msg.healById && msg.healBy > 0) {
        const he = w.players.get(msg.healById);
        if (he && he.alive) he.hp = Math.min(he.statsTotal.hp, he.hp + msg.healBy);
      }
      break;
    }
    case 'die': {
      const p = w.players.get(msg.id);
      if (p) p.alive = false;
      break;
    }
    case 'respawn': {
      const p = w.players.get(msg.id);
      if (p) {
        p.x = msg.x; p.y = msg.y; p.hp = msg.hp;
        p.alive = true; p.respawnAt = 0; p._hasTarget = false;
      }
      break;
    }
    case 'phase': {
      const p = w.players.get(msg.id);
      if (p) {
        p.loadout = msg.skills;
        BossFx.onPhase(p);
        if (msg.text) w.pushFx('banner', 0, 0, '#ff2d55', { text: msg.text });
      }
      break;
    }
    // P2：场地 buff 掉落物（房主权威生成，各端渲染拾取物）
    case 'buff_drop': {
      if (msg.drop && !w.buffDrops.some(d => d.id === msg.drop.id)) {
        w.buffDrops.push(msg.drop);
      }
      break;
    }
    // P2：某玩家拾取 buff（掉落物移除 + 本地实体挂上 buff + 拾取彩圈）
    case 'buff_pickup': {
      if (msg.dropId) w.buffDrops = w.buffDrops.filter(d => d.id !== msg.dropId);
      const p = w.players.get(msg.id);
      if (p && msg.buff) {
        BuffSystem.addBuff(p, msg.buff);
        w.pushFx('buff', msg.x, msg.y, msg.color || '#ffffff', { buffId: msg.buff });
      }
      break;
    }
    // P2：房主授予 buff（阶段/Boss 自授等，权威广播）
    case 'buff_add': {
      const p = w.players.get(msg.id);
      if (p && msg.buff) {
        // 需求2：selfGrant——Boss 阶段自授 buff 在客户端同样放行（与房主端一致）
        BuffSystem.addBuff(p, msg.buff, { selfGrant: true });
        w.pushFx('buff', msg.x, msg.y, msg.color || '#ffffff', { buffId: msg.buff });
      }
      break;
    }
    case 'gameover':
      w.gameOver = { winner: msg.winner, by: msg.by };
      break;
    case 'snap_req': {
      // 新成员请求全量状态快照（P1-4：角色/血量/位置/Boss 阶段技能/AI 名单/是否已结算）
      if (App.net.isHost) App.net.sendTo(fromId, w.buildSnapshot());
      break;
    }
    case 'bot_sync': {
      // 房主把联机房间 AI 单位名单同步过来：本地补建实体（非 host 不驱动 AI，位置由 host 广播）
      (msg.bots || []).forEach(b => {
        if (!w.players.has(b.id)) {
          const p = w.addPlayer(b.id, b.name || b.id, b.roleId || 'hero', false);
          if (b.botKind) w.addSoloBot(p, b.botKind, b.aiLevel || aiLevelDefault());   // 成员端只登记 AI 类型，不驱动
        }
      });
      syncMembersPanel();
      break;
    }
    case 'bot_remove': {
      if (w.players.has(msg.id)) w.removePlayer(msg.id);
      break;
    }
    case 'state': {
      if (typeof msg.time === 'number') w.time = msg.time;   // 同步房主对局时间（HUD 倒计时两端一致）
      const nowMs = performance.now();
      (msg.players || []).forEach(sp => {
        const p = w.players.get(sp.id);
        if (p) {
          p.hp = sp.hp;
          p.alive = sp.alive;
          if (sp.skills) p.loadout = sp.skills;
          // 方案 C：判定计数以房主权威值同步（kills/hits/hitTaken/combo），
          // 使条件型模块在各端按同一份计数重算 -> 数值一致（远端这些写点不跑 applyDamage，必须靠同步）
          if (p.stats) {
            if (typeof sp.k === 'number') p.stats.kills = sp.k;
            if (typeof sp.h === 'number') p.stats.hits = sp.h;
            if (typeof sp.ht === 'number') p.stats.hitTaken = sp.ht;
            if (typeof sp.cb === 'number') p.stats.combo = sp.cb;
          }
          if (sp.id !== App.net.myId && typeof sp.x === 'number'
              && nowMs - (w._posDirectAt[sp.id] || 0) > 200) {
            p.tx = sp.x; p.ty = sp.y;
            if (!p._hasTarget) { p.x = sp.x; p.y = sp.y; p._hasTarget = true; }
            p.dir = sp.dir || p.dir;
          }
        }
      });
      break;
    }
  }
}

// 需求2：成员技能配置广播（每人配置自己的出战技能并同步房间；登记名单 + 覆盖对应玩家出战栏）
function handleSkillsCfgMsg(fromId, msg) {
  if (App.net && App.net.members) {
    const m = App.net.members.find(x => x.id === fromId);
    if (m) {
      m.loadout = Array.isArray(msg.loadout) ? msg.loadout.slice(0, skillLoadoutCap()) : [];
      m.autoAttack = !!msg.autoAttack;
    }
  }
  const w = App.world;
  if (w && fromId !== App.net.myId) {
    const p = w.players.get(fromId);
    if (p && Array.isArray(msg.loadout) && msg.loadout.length) p.loadout = msg.loadout.slice(0, skillLoadoutCap());
  }
}

// ---- members 名单独立分发（不依赖 App.world）----
// 手动星形：房主广播全量成员（含角色裁决结果）。成员在菜单页等待房主确认时 App.world 尚未创建，
// 若沿用 handleData 内的世界前置检查会被提前丢弃（App.world 为空直接 return），导致永远卡在菜单页。
// 单独在此分发：菜单页首包 → onMembers 按裁决角色 startBattle() 开局；战斗中收到（成员进出/幂等同步）
// → 交 onMembers 增删实体。服务器联机模式下同样走此通道（语义一致，均只更新名单与触发 onMembers）。
function handleMembersMsg(msg) {
  if (!App.net) return;
  const prevList = App.net.members || [];
  const list = (msg.members || []).map((x, i) => {
    // 名单为房主全量广播：保留本端已缓存的技能配置与档案（否则会被重建冲掉）
    const prev = prevList.find(y => y.id === x.id) || {};
    const row = { id: x.id, name: x.name, roleId: x.roleId || 'hero', isHost: i === 0 };
    if (prev.loadout) row.loadout = prev.loadout;
    if (prev.autoAttack != null) row.autoAttack = prev.autoAttack;
    if (prev.profile) row.profile = prev.profile;
    if (prev.profileId) row.profileId = prev.profileId;
    if (x.profile) row.profile = x.profile;      // 服务端/房主直发的档案优先
    return row;
  });
  App.net.members = list;
  const self = list.find(x => x.id === App.net.myId);
  if (self && self.roleId) App.net.selfRole = self.roleId;
  App.net.isHost = !!(self && self.isHost);
  if (App.net.onMembers) App.net.onMembers(list);
}

// ---- 主循环 ----
function loop(now) {
  App.raf = requestAnimationFrame(loop);
  if (!App.lastFrame) App.lastFrame = now;
  const dt = Math.min(0.05, (now - App.lastFrame) / 1000);
  App.lastFrame = now;

  if (App.state === 'battle' && App.world) {
    // P0-1：本局结束后冻结玩家输入与 AI 驱动（结算面板接管操作），子弹表现继续由 world.tick 收尾
    if (!App.world.gameOver) {
      updateLocal(dt, now);
      BotAI.update(App.world, dt);   // 离线 AI（solo）与联机房间 AI（roomBots）每帧驱动
    }
    App.world.tick(dt);            // 房主权威 state 每 tick 广播含 bot 位置，远端平滑跟随
    // 需求1~4：释放方式表现层每帧刷新——屏幕中下读条（自身 / BOSS）+ 禁咒打点 / 吟唱描摹浮层
    //   只画表现与采集输入，判定与结算在 CastSystem / world.finishCast；非施法态浮层自动 display:none
    if (typeof UiCast !== 'undefined' && UiCast.frame) UiCast.frame(App.world);
    // 本局结束（本地结算或收到 gameover 广播）：弹出 DOM 结算面板（不再 location.reload）
    if (App.world.gameOver && !App._goShown) {
      App._goShown = true;
      showGameoverPanel();
    }
    // 远端位置插值
    App.world.players.forEach(p => {
      if (p._hasTarget && p.id !== App.net.myId) {
        const k = GAME_CONFIG.INTERP_SMOOTH;
        p.x += (p.tx - p.x) * k;
        p.y += (p.ty - p.y) * k;
      }
    });
    const me = App.world.players.get(App.net.myId);
    App.renderer.render(App.world, me, {
      hud: {
        token: App.world.soloInfo || (App.world.solo ? '单人试玩' : (App.tokenShare || App.token)),
        count: App.world.solo ? (App.world.players.size + ' 单位') : (App.net.members.length + '/' + ((GAME_CONFIG && GAME_CONFIG.ROOM_MAX) || 8)),
        myBullets: me ? (App.world.bulletCount[me.id] || 0) : 0
      }
    }, dt);
  }
}

function updateLocal(dt, now) {
  const me = App.world.players.get(App.net.myId);
  if (!me || !me.alive) return;
  me.update(dt);

  // 自瞄注入（需求5）：先记录本地位置并自瞄最近敌方，aim() 才能取到方向
  Input.updateSelf(me, App.world);
  // 需求4：施法中"禁止移动"开关——禁咒 / 吟唱默认开启，蓄力按 castConfig.lockMove 配置；
  // 锁定期忽略方向输入（仍保留朝向更新与位移广播），避免打点/描摹时被摇杆拖出判定区
  const moveLocked = (typeof CastSystem !== 'undefined' && CastSystem.locksMove) ? CastSystem.locksMove(me.id) : false;
  const mv = moveLocked ? { x: 0, y: 0 } : Input.moveDir();
  me.x += mv.x * me.statsTotal.speed * dt;
  me.y += mv.y * me.statsTotal.speed * dt;
  me.x = Math.max(me.radius, Math.min(GAME_CONFIG.ARENA.w - me.radius, me.x));
  me.y = Math.max(me.radius, Math.min(GAME_CONFIG.ARENA.h - me.radius, me.y));
  me.dir = Input.aim();

  // 技能（出战位：战斗模块从技能栏候选池选出的 loadout）
  const skill = Input.consumeSkill();
  if (skill) {
    const sid = me.loadout[skill.slot];
    if (sid) App.world.fireSkill(me, sid, skill.dir);
  }

  // 自动普攻（需求9）：配置开启且自动普攻技能在出战位、有敌方目标时，冷却好自动对最近敌人释放。
  // 技能 id 以 config/skills.json 的 auto:true 标记判定（不写死具体 id，改 id / 换自动普攻技能后依旧生效）
  const autoId = autoAttackSkillId();
  if (App.autoAttack && me.loadout.indexOf(autoId) >= 0 && Input._autoAim) {
    App.world.fireSkill(me, autoId, Input._autoAim);
  }

  // 触屏/PC 共用：每帧更新技能按钮 CD 视觉（触屏模式额外更新自瞄方向）
  if (typeof Touch !== 'undefined') Touch.frame(me, App.world);

  // 位置广播：直连全网状广播 + 非房主上报房主（房主经 state 转播给全员，兜底无直连节点）
  // 手动星形：member 的 broadcast 已直发房主（peers 仅房主），无需再额外上报
  if (now - App.lastPosAt >= 1000 / GAME_CONFIG.POSITION_RATE) {
    App.lastPosAt = now;
    const posMsg = { t: 'pos', id: App.net.myId, x: me.x, y: me.y, dir: me.dir };
    App.net.broadcast(posMsg);
    if (!App.net.isHost && App.net.manual !== 'member') {
      const hostId = App.net.members.length ? App.net.members[0].id : '';
      if (hostId && hostId !== App.net.myId) App.net.sendTo(hostId, posMsg);
    }
  }
}

// 动态脚本链加载时 DOMContentLoaded 可能已触发，需 readyState 兜底
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
window.addEventListener('keydown', e => {
  if (e.key === 'r' || e.key === 'R') {
    // P0-1：对局结束不再无脑 reload。结算/再来一局面板提供显式操作；
    // R 键仅作为“再次弹出结算面板”的兼容入口，无任何刷新副作用。
    if (App.state === 'battle' && App.world && App.world.gameOver && !App._goShown) {
      showGameoverPanel();
    }
  }
});

// ===== P0/P1：结算面板 / 再来一局 / 成员面板 / 全量快照 / 房间大厅 =====

function isBossUnit(roleId) {
  return !!(UNITS && UNITS[roleId] && UNITS[roleId].isBoss);
}
// HTML 转义（成员/房主昵称进 innerHTML，防注入/破版）
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 房间大厅守卫：仍在原房间（软回菜单）时禁止再次建房/加入/单机开局，避免二进宫
function guardLobby() {
  if (App.lobbyMode) {
    alert('你仍在本局房间中（已返回菜单，连接保留）。请先点房间面板 / 顶部栏的「退出房间」断开，再创建/加入其他房间或开始单人挑战。');
    return true;
  }
  return false;
}

// ---- P0-3：成员面板（菜单大厅与战斗中常驻/可展开）----
function syncMembersPanel() {
  const listEl = document.getElementById('mpList');
  if (!App.net || !App.net.isMulti || !App.net.members || !App.net.members.length) {
    hideMembersUI();
    return;
  }
  if (!listEl) return;
  const rows = [];
  (App.net.members || []).forEach(m => {
    const wp = App.world ? App.world.players.get(m.id) : null;
    rows.push({
      id: m.id, name: m.name || m.id, isHost: !!m.isHost, isBot: false,
      roleId: (wp && wp.roleId) || m.roleId || 'hero',
      me: m.id === App.net.myId, inWorld: !!wp
    });
  });
  // 房主本地 / 已同步到本端的 AI 补位也列出，让成员端看到的单位与房主一致
  if (App.world && App.world.players) {
    App.world.players.forEach(p => {
      if (p.botKind) rows.push({ id: p.id, name: p.name || p.id, isHost: false, isBot: true, roleId: p.roleId, me: false, inWorld: true });
    });
  }
  listEl.innerHTML = rows.map(r => {
    const boss = isBossUnit(r.roleId);
    const tagText = r.isBot ? (boss ? 'AI Boss' : 'AI 勇者') : (boss ? 'Boss' : '勇者');
    const cls = 'mp-row' + (boss ? ' boss' : '') + (r.isBot ? ' bot' : '') + (r.me ? ' me' : '');
    const hostMark = r.isHost ? '<span class="mp-tag host">房主</span>' : '';
    const tag = '<span class="mp-tag">' + tagText + '</span>';
    return '<div class="' + cls + '"><span class="mp-name">' + esc(r.name) + (r.me ? '（你）' : '') + '</span>' + tag + hostMark + '</div>';
  }).join('');
}

function toggleMembersPanel(show) {
  const panel = document.getElementById('membersPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
}
function hideMembersUI() {
  const fab = document.getElementById('membersFab');
  const panel = document.getElementById('membersPanel');
  if (fab) fab.style.display = 'none';
  if (panel) panel.style.display = 'none';
}

// ---- P1-4：全量状态快照 ----
// world 就绪前到达的 bot_sync 缓存补建（startBattle 后统一执行）
function flushPendingBots() {
  if (!App.world) return;
  const pending = (App._pendingBots || []).splice(0);
  pending.forEach(msg => {
    (msg.bots || []).forEach(b => {
      if (!App.world.players.has(b.id)) {
        const p = App.world.addPlayer(b.id, b.name || b.id, b.roleId || 'hero', false);
        if (b.botKind) App.world.addSoloBot(p, b.botKind, b.aiLevel || aiLevelDefault());
      }
    });
  });
}
// 成员端：向房主请求一次全量快照（有直连且可发才置位；否则等 onPeer connected 再次触发）
function requestSnapshot() {
  if (App._snapReqSent) return;
  const host = App.net.members && App.net.members.length ? App.net.members[0].id : '';
  if (!host || host === App.net.myId) return;
  const dc = App.net.peers && App.net.peers.get ? App.net.peers.get(host) : null;
  if (dc && dc.readyState && dc.readyState !== 'open') return;   // DC 未开，等 onPeer connected
  App._snapReqSent = true;
  App.net.sendTo(host, { t: 'snap_req' });
}
// 成员端：应用房主发来的全量状态快照（覆盖式基线校准）
function applySnapshot(msg) {
  const w = App.world;
  if (!w) return;
  const nowMs = performance.now();
  // 1) 实体对齐：快照有而本地无 → 补建（真人或 AI 都建，带类型）
  (msg.players || []).forEach(sp => {
    if (w.players.has(sp.id)) return;
    const p = w.addPlayer(sp.id, sp.name || sp.id, sp.roleId || 'hero', !!sp.isHost, sp.profile || null);
    if (sp.isBot) w.addSoloBot(p, sp.botKind || 'fighter', sp.aiLevel || aiLevelDefault());
  });
  // 2) 缺失侧清理：仅清理本地由房主补建但快照已移除的 AI/远端实体（自己的本体绝不删）
  const keep = new Set((msg.players || []).map(sp => sp.id));
  [...w.players.keys()].forEach(id => {
    if (id === App.net.myId) return;
    if (!keep.has(id)) w.removePlayer(id);
  });
  // 3) 状态覆盖：hp/存活/技能阶段/位置基线（含角色模板若裁决与本端不一致）
  (msg.players || []).forEach(sp => {
    const p = w.players.get(sp.id);
    if (!p) return;
    if (sp.roleId && sp.roleId !== p.roleId) applyRole(p, sp.roleId, p.name);
    // 档案对齐：房主权威档案随快照下发；本端按档案重建属性与技能栏（自己以本地实时选择为准）
    if (sp.id !== App.net.myId && !sp.isBot && !p.isBoss) {
      const prof = sp.profile || null;
      if (JSON.stringify(prof) !== JSON.stringify(p.profile || null)) p.applyProfile(prof);
    }
    p.hp = sp.hp;
    p.alive = sp.alive;
    p.respawnAt = 0;
    // 方案 C：判定计数按房主快照对齐（中途加入者也要拿到与房主一致的计数，条件型模块才能算出同一结果）
    if (p.stats) {
      if (typeof sp.k === 'number') p.stats.kills = sp.k;
      if (typeof sp.h === 'number') p.stats.hits = sp.h;
      if (typeof sp.ht === 'number') p.stats.hitTaken = sp.ht;
      if (typeof sp.cb === 'number') p.stats.combo = sp.cb;
      p._condKey = null;   // 计数/血量基线变更 -> 下一帧强制重算条件型模块
    }
    // P2：buff 状态随快照对齐（host 快照以 tLeft=剩余秒传输，避免跨端时钟基准不同导致立即过期/无限期）
    if (sp.buffs) {
      const nowS = performance.now() / 1000;
      p.buffs = (sp.buffs || []).map(x => {
        const o = { ...x, at: performance.now() };
        const def = (window.BUFFS && BUFFS[o.defId]) || {};
        const fallback = (def && def.duration) || 0;
        o.end = nowS + (typeof o.tLeft === 'number' ? o.tLeft : fallback);
        delete o.tLeft;
        return o;
      });
      if (p._refreshBuffStats) p._refreshBuffStats();
    }
    // 本轮新增（撕裂 DoT）：撕裂状态随快照对齐——中途加入 / 重连者据此重建红环与状态条 chip。
    //   与 buffs 同口径：快照传剩余秒 tLeft，落到本地绝对时钟 end；仅表现，扣血仍以房主 damage 广播为准。
    if (sp.dots) {
      p.dots = [];
      (sp.dots || []).forEach(d => {
        if (!d) return;
        BuffSystem.mirrorDot(p, { defId: d.defId || 'tear', skillId: d.skillId || null,
                                  color: d.color || null, stacks: d.stacks || 1,
                                  tLeft: (typeof d.tLeft === 'number' ? d.tLeft : undefined) });
      });
    }
    if (sp.skills) p.loadout = sp.skills;
    if (sp.id !== App.net.myId && typeof sp.x === 'number'
        && nowMs - (w._posDirectAt[sp.id] || 0) > 200) {
      p.x = sp.x; p.y = sp.y; p.tx = sp.x; p.ty = sp.y;
      p._hasTarget = true;
      p.dir = sp.dir || p.dir;
    }
  });
  // 4) Boss 阶段横幅对齐（若 Boss 已触发过阶段，房主快照带 bossPhaseId，覆盖本地 loadout 后重放横幅）
  if (msg.bossPhaseId && w.players.get(msg.bossPhaseId)) BossFx.onPhase(w.players.get(msg.bossPhaseId));
  // 4.1) 场地 buff 掉落物对齐（新成员/快照重放时渲染层以 world.buffDrops 为准）
  if (msg.buffDrops) w.buffDrops = (msg.buffDrops || []).map(d => ({ ...d }));
  // 5) 对局时间与结算态对齐
  if (typeof msg.time === 'number') w.time = msg.time;
  if (msg.gameOver) {
    w.gameOver = { winner: msg.gameOver.winner, by: msg.gameOver.by };
    if (!App._goShown) { App._goShown = true; showGameoverPanel(); }
  }
  syncMembersPanel();
}

// ---- P0-1：结算面板 ----
function showGameoverPanel() {
  const w = App.world;
  if (!w || !w.gameOver) return;
  if (typeof Touch !== 'undefined') Touch.setVisible(false);   // 结算面板接管操作：先隐藏触控键，避免遮挡点击
  const me = w.players.get(App.net.myId);
  const meBoss = !!(me && me.isBoss);
  const playersWin = w.gameOver.winner === 'players';
  const titleEl = document.getElementById('goTitle');
  const subEl = document.getElementById('goSub');
  if (!titleEl || !subEl) return;
  titleEl.textContent = playersWin === !meBoss
    ? (meBoss ? 'Boss 阵营胜利！' : '勇者阵营胜利！')
    : (meBoss ? '勇者队获胜，你守护失败' : '你被击败了…');
  let parts = [];
  if (w.gameOver.by === 'timeout') parts.push('超时未击败 Boss');
  else if (w.gameOver.by) {
    const killer = w.players.get(w.gameOver.by);
    if (killer) parts.push('终结者：' + killer.name);
  }
  const stat = [];
  w.players.forEach(p => { if (p.kills) stat.push((p.isBoss ? '[Boss] ' : '') + p.name + ' 击杀x' + p.kills); });
  parts.push(stat.length ? stat.join(' · ') : '本局无人头');
  if (App.net.isMulti && !App.net.isHost) parts.push('等待房主发起再来一局');
  subEl.textContent = parts.join('；');
  document.getElementById('panelRematch').style.display = 'none';
  document.getElementById('panelGameover').style.display = 'flex';
  const canAgain = !App.net.isMulti || App.net.isHost;
  document.getElementById('btnAgain').style.display = canAgain ? 'block' : 'none';
  document.getElementById('btnBackMenu').style.display = 'block';
  syncMembersPanel();
}

// 进入战斗视图：清空菜单/大厅/全部浮层并显示画布，重置单局状态标记（再来一局与开局共用）
// 移动端触屏：进入战斗自动请求横屏（浏览器安全限制下失败静默，用户可手动旋转）
function tryAutoLandscape() {
  if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return;
  try {
    const o = screen.orientation;
    if (o && o.lock) {
      const pr = o.lock('landscape');
      if (pr && pr.catch) pr.catch(() => {});
    }
  } catch (e) { /* 忽略锁定失败 */ }
}

// 需求（移动端体验）：检测到触屏/移动端时自动进入全屏模式，桌面端完全不受影响。
// 浏览器限制：元素全屏必须由用户手势触发 → 绑定首次点击/触摸时请求；iOS Safari 不支持元素全屏，
// 请求方法缺失时静默跳过（仍由 rotateHint 提示手动旋转）。用户主动退出全屏后本页不再自动强拉，避免反复打扰。
function isTouchDevice() {
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    return /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i.test(navigator.userAgent || '');
  } catch (e) { return false; }
}
function fullscreenEl() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
}
function tryAutoFullscreen() {
  if (!isTouchDevice()) return;         // 桌面端：不做任何事
  if (fullscreenEl()) return;           // 已全屏
  if (App._fsUserExited) return;        // 用户主动退出过：不再自动拉全屏
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (!req) return;                     // 不支持元素全屏（iOS Safari）：静默跳过
  try {
    const pr = req.call(el, { navigationUI: 'hide' });
    if (pr && pr.catch) pr.catch(() => {});
  } catch (e) { /* 忽略：非手势上下文等失败 */ }
}
if (!window._p2pFullscreenBound) {
  window._p2pFullscreenBound = true;
  const onFirstGesture = () => { tryAutoFullscreen(); };
  document.addEventListener('pointerdown', onFirstGesture, true);
  document.addEventListener('touchend', onFirstGesture, true);
  document.addEventListener('fullscreenchange', () => {
    if (fullscreenEl()) { App._fsAuto = true; }
    else if (App._fsAuto) { App._fsAuto = false; App._fsUserExited = true; }   // 用户主动退出 → 本页不再自动
    // 全屏切换会改变可视尺寸：等一帧后同步画布与竖屏提示
    setTimeout(() => { fitCanvas(); syncRotateHint(); }, 80);
  });
}

// 需求5：移动端竖屏战斗提示 —— 浏览器普遍不允许脚本强制横屏，锁屏失败时明确提示用户手动旋转；
// 仅触屏 + 竖屏 + 战斗态显示，菜单/结算/桌面端不出现。
function syncRotateHint() {
  const el = document.getElementById('rotateHint');
  if (!el) return;
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const portrait = (window.innerHeight || 0) > (window.innerWidth || 0);
  el.style.display = (coarse && portrait && App.state === 'battle') ? 'flex' : 'none';
}
if (!window._p2pRotateBound) {
  window._p2pRotateBound = true;
  window.addEventListener('orientationchange', () => setTimeout(syncRotateHint, 260));
  window.addEventListener('resize', syncRotateHint);
}

// ---- 房间大厅（提前组房成功后停在此页）：建房/加入后停在菜单，房间面板展示成员与角色配置，房主发起开局 ----
function enterLobbyView() {
  App.state = 'lobby';
  App.lobbyMode = true;
  // 需求1~4：离开战斗回到大厅时收走读条 / 小游戏浮层，避免遮挡菜单操作
  if (typeof UiCast !== 'undefined' && UiCast.hide) UiCast.hide();
  App.lobbyFresh = true;           // 待开局（尚未打过本局）：成员加入只刷新人数不开战，开局一律等房主「开始游戏」
  App.canvas.style.display = 'none';
  document.getElementById('menu').style.display = 'block';
  // 仅服务器房有令牌：同步进首页底部输入框方便复制分享；局域网房令牌不进框（避免误当房间码粘贴）
  if (!App.net.manual) echoQuickToken(App.tokenShare || App.token);
  showLobbyBar();
  syncMembersPanel();
  renderRoomPanel();
}

// 把快速开局产生的令牌塞回首页快捷输入框（便于直接复制分享；仅服务器房有令牌）
function echoQuickToken(tok) {
  const qTok = document.getElementById('quickTok');
  if (qTok && tok) {
    qTok.value = tok;
    qTok.placeholder = '房间已创建：把此令牌发给朋友，粘贴后点「创建 / 加入」';
  }
}

// 需求6/8：画布自适应窗口尺寸（100% 撑满，不保留右侧空白；窗口变化实时跟随）
// 关键修复：必须调用 PIXI 渲染器的 resize（同步 drawingBuffer + gl.viewport + screen），
// 只改 canvas.width/height 会让渲染器仍按旧的 1600x1000 出图 → 右/下侧网格未铺满、左上出现错位区域。
function fitCanvas() {
  const c = App.canvas;
  if (!c) return;
  const w = window.innerWidth || document.documentElement.clientWidth || (GAME_CONFIG && GAME_CONFIG.ARENA.w);
  const h = window.innerHeight || document.documentElement.clientHeight || (GAME_CONFIG && GAME_CONFIG.ARENA.h);
  const pixi = App.renderer && App.renderer.app;
  const rend = pixi && pixi.renderer;
  if (rend) {
    const sw = (rend.screen && rend.screen.width) || rend.width;
    const sh = (rend.screen && rend.screen.height) || rend.height;
    if (sw !== w || sh !== h) rend.resize(w, h);
  } else if (c.width !== w || c.height !== h) {
    // 渲染器尚未就绪时的兜底（init 完成、进入战斗时会再次校正）
    c.width = w;
    c.height = h;
  }
  // 需求2：视口变化后按需扩大场外空白缓冲铺底（仅在需要更大范围时才重建一次）
  if (App.renderer && App.renderer.ensureOuterArea) App.renderer.ensureOuterArea();
}
if (!window._p2pFitBound) {
  window._p2pFitBound = true;
  window.addEventListener('resize', fitCanvas);
}

// ================= 需求4：页面从后台切回前台 =================
// 目标：不逐个补渲染后台期间积压的历史弹道，直接呈现"当前结算结果"。
// 做法：① 记录切后台时刻；② 切回时设时间闸门（早于此刻的战斗消息一律判过期，
//       配合 msgAgeSec / world.spawnSkillBullets 从源头丢弃）；③ 清空屏幕上残留的
//       子弹与在途特效表现；④ 成员端向房主重新要一次全量快照，直接对齐 Boss 剩余血量/
//       存活/阶段/掉落等当前结算态（房主本机即权威，无需请求）。
function onVisibilityChange() {
  if (document.hidden) {
    App._bgAt = performance.now();
    return;
  }
  const now = performance.now();
  const gap = App._bgAt ? (now - App._bgAt) / 1000 : 0;
  App._bgAt = 0;
  if (gap < 0.3) return;                       // 瞬时切换（复制粘贴等）不做处理
  if (App.state !== 'battle' || !App.world) return;
  App._resumeGateMs = now;                     // 时间闸门：此前发出的战斗消息全部判过期
  clearTimeout(App._gateTimer);
  App._gateTimer = setTimeout(() => { App._resumeGateMs = 0; }, 10000);   // 10s 后自动解除，避免误伤后续新消息
  const w = App.world;
  // 表现层清空：不补渲染历史弹道/特效（子弹清空后由后续新消息按"当前有效"重建）
  if (w.bullets && typeof w.bullets.clear === 'function') {
    w.bullets.clear();
    w.bulletCount = {};
  }
  if (w.fxQueue) w.fxQueue.length = 0;
  if (App.renderer) {
    if (typeof App.renderer.clearBullets === 'function') App.renderer.clearBullets();
    if (typeof App.renderer.clearFx === 'function') App.renderer.clearFx();
  }
  // 直接呈现当前结算：成员端重新拉取房主全量快照（Boss 血量/存活/阶段/掉落一次对齐）
  App._snapReqSent = false;
  if (App.net && !App.net.isHost) requestSnapshot();
}
if (!window._p2pVisBound) {
  window._p2pVisBound = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function enterBattleView() {
  fitCanvas();
  App.lobbyFresh = false;          // 真正开局后“待开局”标记失效（见 enterLobbyView）
  tryAutoLandscape();
  tryAutoFullscreen();             // 移动端：进入战斗时（点在“开始游戏”的手势上下文中）再尝试一次全屏
  document.getElementById('menu').style.display = 'none';
  document.getElementById('lobbyBar').style.display = 'none';
  document.getElementById('panelGameover').style.display = 'none';
  document.getElementById('panelRematch').style.display = 'none';
  App.canvas.style.display = 'block';
  App.state = 'battle';
  App.lobbyMode = false;
  App._goShown = false;
  // 需求1~4：清掉上一局可能残留的读条 / 小游戏浮层，保证新一局从干净状态开始
  if (typeof UiCast !== 'undefined' && UiCast.hide) UiCast.hide();
  App._snapReqSent = false;
  App._resumeGateMs = 0;              // 需求4：进入新一局，清空"后台切回"时间闸门
  App._bgAt = 0;
  // 需求2：战斗场景内隐藏右上角房间信息浮条（那正是房主进入战斗后右上角出现的彩色浮块），
  // 彻底不显示（display:none），返回大厅/菜单时恢复。
  if (typeof jbHide === 'function') jbHide();
  App.rematch = { phase: 'idle', wants: {} };
  if (typeof Touch !== 'undefined') {
    if (Touch.refreshSkillKeys) Touch.refreshSkillKeys();     // 技能键数量/槽位按最新 skillbar.json 重建（不再写死 8 键）
    Touch.setVisible(true);                                   // 触屏设备：进入战斗显示摇杆/技能键
  }
  syncRotateHint();                                           // 需求5：竖屏未旋转成功时提示用户横屏
}

// 本轮改动：开局操作提示 / 操作方式说明（ctlTip）已整体移除——进入战斗不再弹任何说明文本与提示条。

// ---- 点击底部状态栏的 buff 图标 → 屏幕中上纵向滚动提示区插入一条说明（FxFeed）----
// 文案优先取配置 desc（config/buffs.json），缺失时由 BuffSystem.describe 按 kind/stats 自动兜底。
// 展示走 FxFeed（多槽滚动 / 上挤 / 渐隐渐出），与 Boss 阶段横幅共用同一提示区。
let _buffTipTimer = 0;
function showBuffTip(chip) {
  const defId = (chip && chip.dataset) ? chip.dataset.buff : '';
  if (!defId) return;
  const desc = (typeof BuffSystem !== 'undefined' && BuffSystem.describe) ? BuffSystem.describe(defId) : '';
  const text = desc || ('当前状态：' + defId);            // 配置缺描述也给兜底文案，不再静默无反应
  const def = (typeof BuffSystem !== 'undefined' && BuffSystem.getDef) ? BuffSystem.getDef(defId) : null;
  const color = (def && def.color) || '#8be9ff';
  // 本轮改动（需求1）：统一走 FxFeed —— 屏幕中上纵向滚动提示区。
  // 连续点击多条按时间差依次加入：新消息贴底，已有消息整体向上挤，逐条渐隐渐出；
  // 字号 / 停留时长 / 上挤速度按 buff 强度自动分档（护盾、无敌这类强增益更大更慢）。
  const tier = (typeof FxFeed !== 'undefined' && FxFeed.tierOfBuff) ? FxFeed.tierOfBuff(def) : 2;
  if (typeof FxFeed !== 'undefined' && FxFeed && FxFeed.push) {
    FxFeed.push(text, color, tier);
    return;
  }
  // 兜底（FxFeed 不可用时）：DOM 单条气泡 + 画布横幅
  try {
    let tip = document.getElementById('buffTip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'buffTip';
      document.body.appendChild(tip);
    }
    tip.style.setProperty('--c', color);
    tip.textContent = text;
    tip.classList.add('show');
    clearTimeout(_buffTipTimer);
    _buffTipTimer = setTimeout(function () { tip.classList.remove('show'); }, 2400);
  } catch (e) { /* 忽略：DOM 提示异常不影响下面的画布横幅 */ }
  const r = App.renderer;
  if (r && typeof r.fxBanner === 'function') r.fxBanner(text, color);
}

// 事件委托：点 buff chip 弹中上横幅提示（chip 在 CSS 里单独开了 pointer-events:auto）。
// 本轮修复：同时挂 pointerdown 与 click（捕获阶段），并做 400ms 去重——
// 此前只挂 click，移动端 tap/连点或元素重绘都会漏事件，表现为"点了没反应"。
function onBuffChipPointer(e) {
  const t = e.target;
  // 需求2：底部状态栏 buff（.st-chip）与 Boss 血条下方 buff（.hb-buffs .bb，节点可能被重绘替换，必须走委托）
  const chip = (t && t.closest) ? t.closest('.st-chip[data-buff], .hb-buffs .bb[data-buff]') : null;
  if (!chip) return;
  const now = Date.now();
  if (chip === onBuffChipPointer._last && now - onBuffChipPointer._at < 400) return;
  onBuffChipPointer._last = chip;
  onBuffChipPointer._at = now;
  showBuffTip(chip);
}
document.addEventListener('pointerdown', onBuffChipPointer, true);
document.addEventListener('click', onBuffChipPointer, true);

// 需求4：战斗 DOM HUD 清理（顶部 Boss 血条 / 左上队伍血条 / 底部状态栏）。
// 返回菜单后主循环停止、render._syncDomHud 不再被调用，若不清空这些浮层会一直挂在菜单上。
function hideBattleDomHud() {
  ['hudTop', 'hudTeam'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = 'none';
    el.innerHTML = '';
    el._k = '';   // 清内容缓存键：下一局内容与上局相同也能重绘
  });
  const sb = document.getElementById('statusBar');
  // 本轮：同时清掉 chip 复用缓存，否则下一局 buff 复现时因缓存仍指向已移除的节点而不再创建
  if (sb) { sb.innerHTML = ''; sb._k = ''; sb._chips = null; }
  const bt = document.getElementById('buffTip');
  if (bt) { bt.classList.remove('show'); bt.textContent = ''; }   // 收起 buff 说明气泡（兜底通道）
  if (typeof FxFeed !== 'undefined' && FxFeed && FxFeed.clear) FxFeed.clear();   // 需求1：清空中上滚动提示区
}

// ---- P0-1：返回菜单（软回房间大厅 / 单机直接回菜单）----
function backToMenu() {
  const w = App.world;
  if (typeof Touch !== 'undefined') Touch.setVisible(false);   // 触屏设备：离开战斗隐藏摇杆/技能键
  if (typeof UiCast !== 'undefined' && UiCast.hide) UiCast.hide();   // 需求1~4：收走读条 + 禁咒/吟唱浮层
  hideBattleDomHud();                                          // 需求4：返回菜单必须隐藏 Boss 血条等战斗 HUD
  syncRotateHint();                                            // 需求5：非战斗态不显示横屏提示
  document.getElementById('panelGameover').style.display = 'none';
  document.getElementById('panelRematch').style.display = 'none';
  if (App.net.isMulti && App.net.members.length) {
    // 多人房间：连接保留，进入“房间大厅”态（房主在房间面板组织下一局；成员等房主发起）
    App.state = 'lobby';
    App.lobbyMode = true;
    App.canvas.style.display = 'none';
    document.getElementById('menu').style.display = 'block';
    showLobbyBar();
    syncMembersPanel();
    renderRoomPanel();   // 重新展示房间成员 / 角色配置（房主可再来一局）
    // 需求2：回到大厅恢复右上角房间信息浮条（战斗中已隐藏）
    if (typeof jbShow === 'function') jbShow(false);
    return;
  }
  // 单机：没有连接需要保留，回到初始菜单
  App.state = 'menu';
  App.lobbyMode = false;
  App.world = null;
  App.canvas.style.display = 'none';
  document.getElementById('menu').style.display = 'block';
  hideMembersUI();
}

// 房间大厅条（软回菜单 / 建房加入后显示在菜单顶部）：待开局提示 / 再来一局（房主）/ 退出房间
// 首次开局入口 = 联机对战模块里的房间面板「开始游戏」（房主），顶部条不再重复放“开始对战”按钮。
function showLobbyBar() {
  const bar = document.getElementById('lobbyBar');
  if (!bar) return;
  bar.style.display = 'none';   // 顶部“房间已就绪”小弹窗不再显示：房间信息/退出入口统一在联机区房间面板
  const cnt = (App.net.members || []).length;
  const roomTag = (App.net.manual === 'member' || App.net.manual === 'hub') ? '手动房' : ('房间码 ' + (App.token || '-'));
  const host = !!App.net.isHost;
  const fresh = !!(host && App.lobbyFresh);
  const offerOn = !host && !!App._roomOffer && App._roomOffer.length;
  const againBtn = document.getElementById('btnLobbyAgain');
  document.getElementById('lbTag').textContent = host ? '房主' : '成员';
  document.getElementById('lbInfo').textContent = fresh
    ? '房间已就绪 · ' + cnt + ' 人：请在下方「房间成员」里指定 / 随机 Boss、加 AI，人齐后点「开始游戏」'
    : (host
      ? '房间：' + roomTag + ' · ' + cnt + ' 人（上局已结束，可在下方房间面板配置后点「开始游戏」再来一局）'
      : (offerOn
        ? '房间：' + roomTag + ' · ' + cnt + ' 人（房主已发起开局：点下方「同意并开始」等待全员确认）'
        : '房间：' + roomTag + ' · ' + cnt + ' 人（等待房主发起开局，收到邀请后点「同意并开始」进入）'));
  if (againBtn) {
    // 开局/再来一局统一走房间面板「开始游戏」（首局与第二局一致），顶部条不再放重复入口
    againBtn.style.display = 'none';
  }
  document.getElementById('btnLobbyLeave').style.display = 'inline-block';
}

// 退出房间：断开连接并回到全新菜单（此处允许刷新清理连接与画布状态）
function leaveRoomToMenu() {
  location.reload();
}

// ---- P0-2：再来一局 ----
// 入口：房主从结算面板 / 房间大厅发起；单机直接按记忆配置本地重开
function startRematch() {
  if (App.lobbyMode && !App.net.isMulti) return;
  if (!App.net.isMulti) {
    refreshGameCfg().then(() => {   // 单机再来一局：同样先读最新配置再开局
      if (App.lastSoloOpt) startSoloGame(JSON.parse(JSON.stringify(App.lastSoloOpt)));
      else location.reload();
    });
    return;
  }
  if (!App.net.isHost) { alert('只有房主可以发起再来一局'); return; }
  if (App.rematch.phase === 'offer') { enterRematchView(); return; }
  App.rematch = { phase: 'offer', wants: {}, _fresh: !!App.lobbyFresh };
  App.net.broadcast({ t: 'again', act: 'offer', fresh: !!App.lobbyFresh });   // 全员进入角色重选准备界面
  enterRematchView();
}

// 再来一局准备界面：全员可在“想当 Boss / 勇者”之间重选，房主确认后开局
function enterRematchView() {
  document.getElementById('menu').style.display = 'none';
  document.getElementById('lobbyBar').style.display = 'none';
  document.getElementById('panelGameover').style.display = 'none';
  document.getElementById('panelRematch').style.display = 'flex';
  App.canvas.style.display = 'block';
  App.state = 'battle';
  App.lobbyMode = false;
  renderRematchPanel();
}

// 房主/成员收到再来一局房间消息（独立于战斗世界，见 handleData 前置分发）
function handleAgainMsg(fromId, msg) {
  if (!App.net || !App.net.isMulti) return;
  const act = msg.act;
  if (act === 'offer') {
    App.rematch = { phase: 'offer', wants: {} };
    App.rematch._fresh = !!msg.fresh;   // 房主是否处于“待开局大厅”首次开局（区分第二局文案）
    enterRematchView();
  } else if (act === 'want') {
    if (!App.net.isHost) return;
    if (App.rematch.phase !== 'offer') return;
    App.rematch.wants[fromId] = (msg.roleId === 'demon_lord') ? 'demon_lord' : 'hero';
    renderRematchPanel();
  } else if (act === 'cancel') {
    App.rematch = { phase: 'idle', wants: {} };
    if (App.world && App.world.gameOver) {
      enterBattleView();
      App._goShown = true;
      showGameoverPanel();
    } else {
      backToMenu();
    }
  } else if (act === 'go') {
    App.rematch = { phase: 'idle', wants: {} };
    doRematchStart(msg.roles || []);
  } else if (act === 'lobby_join') {
    // 房主在房间大厅/结算态接受了本成员：不自动开局，留在菜单等待房主从房间面板发起开局
    App.lobbyMode = true;
    App.state = 'lobby';
    App._pendingBots = [];
    App._roomOffer = [];
    if (App.canvas) App.canvas.style.display = 'none';
    showLobbyBar();
    syncMembersPanel();
    renderRoomPanel();
  }
}

function renderRematchPanel() {
  const listEl = document.getElementById('rematchList');
  const tipEl = document.getElementById('rematchTip');
  const startBtn = document.getElementById('btnRematchStart');
  const cancelBtn = document.getElementById('btnRematchCancel');
  if (!listEl || !tipEl) return;
  const members = App.net.members || [];
  const w = App.world;
  const wantOf = id => (App.rematch.wants && App.rematch.wants[id])
    || ((w && w.players.get(id)) ? w.players.get(id).roleId : 'hero')
    || 'hero';
  const rows = [];
  members.forEach((m, i) => {
    rows.push({ id: m.id, name: m.name || m.id, isHost: i === 0, isBot: false, roleId: wantOf(m.id), me: m.id === App.net.myId });
  });
  if (w && w.players) {
    w.players.forEach(p => {
      if (p.botKind) rows.push({ id: p.id, name: p.name || p.id, isHost: false, isBot: true, roleId: p.roleId, me: false });
    });
  }
  const inOffer = App.rematch.phase === 'offer';
  // “待开局”标记：房主取首次快速开局态，成员取 offer 广播携带值（区分第一局 vs 第二局文案）
  const fresh = App.net.isHost ? !!App.lobbyFresh : !!App.rematch._fresh;
  listEl.innerHTML = rows.map(r => {
    const boss = isBossUnit(r.roleId);
    const tagText = r.isBot ? (boss ? 'AI Boss' : 'AI 勇者') : (boss ? '想当 Boss' : '勇者');
    const cls = 'mp-row' + (boss ? ' boss' : '') + (r.isBot ? ' bot' : '') + (r.me ? ' me' : '');
    const hostMark = r.isHost ? '<span class="mp-tag host">房主</span>' : '';
    let btns = '';
    if (!r.isBot && r.me && inOffer) {
      btns = '<span class="mp-rolebtns">'
        + '<button type="button" class="mp-rolebtn' + (!boss ? ' on' : '') + '" data-id="' + r.id + '" data-role="hero">勇者</button>'
        + '<button type="button" class="mp-rolebtn' + (boss ? ' on' : '') + '" data-id="' + r.id + '" data-role="demon_lord">Boss</button>'
        + '</span>';
    }
    return '<div class="' + cls + '"><span class="mp-name">' + esc(r.name) + (r.me ? '（你）' : '') + '</span>'
      + '<span class="mp-tag">' + tagText + '</span>' + hostMark + btns + '</div>';
  }).join('');
  if (startBtn) startBtn.textContent = fresh ? '开始对战' : '开始第二局';
  startBtn.style.display = (App.net.isHost && inOffer) ? 'block' : 'none';
  cancelBtn.style.display = (App.net.isHost && inOffer) ? 'block' : 'none';
  const hostTip = fresh
    ? '选择/确认各成员角色后点「开始对战」开启本局（多人想当 Boss 时按入房顺序只保留一人；房主本地 AI 固定不可选）。'
    : '选择/确认各成员角色后点「开始第二局」（多人想当 Boss 时按入房顺序只保留一人；房主本地 AI 固定不可选）。';
  const memberTip = fresh
    ? '房主正在组织开局：选择你想当的角色，等待房主点「开始对战」后自动进入（沿用当前连接，无需重新贴码）。'
    : '房主正在组织第二局：选择你想当的角色，等待房主点「开始第二局」后自动进入（沿用当前连接，无需重新贴码）。';
  tipEl.textContent = !inOffer
    ? '房间成员已同步，等待房主发起对局。'
    : (App.net.isHost ? hostTip : memberTip);
}

// 成员面板/重开列表里的角色切换按钮（事件委托）
function onRematchListClick(ev) {
  const btn = ev.target && ev.target.closest ? ev.target.closest('.mp-rolebtn') : null;
  if (!btn) return;
  const roleId = btn.getAttribute('data-role');
  if (roleId !== 'demon_lord' && roleId !== 'hero') return;
  if (App.rematch.phase !== 'offer') return;
  App.rematch.wants[App.net.myId] = roleId;
  if (App.net.isHost) { renderRematchPanel(); return; }
  const host = App.net.members && App.net.members.length ? App.net.members[0].id : '';
  if (host && host !== App.net.myId) App.net.sendTo(host, { t: 'again', act: 'want', roleId });
  renderRematchPanel();   // 本地即时反馈选中态
}

// 房主：开始第二局（房主权威裁决全员角色 → 广播 + 本地重建）
async function hostStartRematch() {
  if (!App.net.isHost) return;
  if (App.rematch.phase !== 'offer') return;
  await refreshGameCfg();   // 第二局同样读最新配置（分组 / 新增条目 / 槽位数改动一并生效）
  const roles = resolveRematchRoles();
  App.net.broadcast({ t: 'again', act: 'go', roles });
  doRematchStart(roles);
}
function hostCancelRematch() {
  if (!App.net.isHost) return;
  App.rematch = { phase: 'idle', wants: {} };
  App.net.broadcast({ t: 'again', act: 'cancel' });
  if (App.world && App.world.gameOver) {
    enterBattleView();
    App._goShown = true;
    showGameoverPanel();
  } else {
    backToMenu();
  }
}

// 房主权威裁决：真人想当 Boss 的按入房顺序保留一人，其余全员勇者；AI 固定保留（防双 Boss 逻辑同开局）
function resolveRematchRoles() {
  const members = App.net.members || [];
  const w = App.world;
  const wantOf = id => (App.rematch.wants && App.rematch.wants[id])
    || ((w && w.players.get(id)) ? w.players.get(id).roleId : 'hero')
    || 'hero';
  const humanBoss = members.find(m => wantOf(m.id) === 'demon_lord') || null;
  // AI 名单：沿用上局挂载的本地 AI；真人接班 Boss 时剔除 AI Boss 防双 Boss
  let bots = [];
  if (w) w.players.forEach(p => { if (p.botKind) bots.push(p); });
  if (humanBoss) bots = bots.filter(b => !(isBossUnit(b.roleId) && b.botKind === 'boss'));
  // 无人当 Boss 且无 AI Boss 时保底补一个 AI Boss，保证每局都有 Boss
  if (!humanBoss && !bots.some(b => isBossUnit(b.roleId) && b.botKind === 'boss')) {
    bots.push({ id: 'boss_bot', name: aiBotName('boss', 1, 'demon_lord'), roleId: 'demon_lord', isHost: false, isBot: true, botKind: 'boss', aiLevel: aiLevelDefault() });
  }
  const roles = members.map((m, i) => ({
    id: m.id, name: m.name || m.id, isHost: i === 0, isBot: false,
    roleId: (humanBoss && humanBoss.id === m.id) ? 'demon_lord' : 'hero'
  }));
  bots.forEach(b => {
    roles.push({
      id: b.id, name: b.name || b.id, isHost: false, isBot: true,
      roleId: b.roleId || 'hero', botKind: b.botKind || 'fighter', aiLevel: b.aiLevel || aiLevelDefault()
    });
  });
  return roles;
}

// 重建第二局世界（全员复用现有连接，房主权威广播照常）
function doRematchStart(roles) {
  const w = new World(App.net);
  w.solo = false;
  (roles || []).forEach((r, i) => {
    // 档案随编成下发：本端各玩家按 roles[].profile 重建属性与技能栏（房主已汇总校验，这里二次校验兜底）
    const p = w.addPlayer(r.id, r.name || r.id, r.roleId || 'hero', r.isHost === true, sanitizeProfile(profileForRoleRow(r), r.id));
    if (r.isBot) w.addSoloBot(p, r.botKind || 'fighter', r.aiLevel || aiLevelDefault());
    else if (r.id === App.net.myId) applyLocalSkillCfg(p, r.roleId || 'hero');
    else if (r.loadout && r.loadout.length) p.loadout = r.loadout.slice(0, skillLoadoutCap());
  });
  if (App.net.isHost && (roles || []).some(r => r.isBot)) {
    w.roomBots = true;   // 联机房间 AI 照常由房主驱动
    w.challenge = true;
  }
  App.world = w;
  enterBattleView();                    // 重置全部状态标记/浮层
  // 同步本地房间名单角色为房主裁决结果
  App.net.members.forEach(m => {
    const r = (roles || []).find(x => x.id === m.id);
    if (r) {
      m.roleId = r.roleId;
      if (m.id === App.net.myId) { App.net.selfRole = r.roleId; App.roleId = r.roleId; }
    }
  });
  syncMembersPanel();
}

// 需求3：切换"持续技能（普攻开关，技能 id 取 config/skills.json 里 auto:true 的条目）"状态。
// 由 touch.js 技能键点击调用（App.setAutoAttack）。关闭瞬间登记收招 CD 起点，
// CD 走完前 Touch.toggleSustain 会拦截再次开启；同时把开关状态持久化到技能配置。
function setAutoAttack(on) {
  on = !!on;
  if (App.autoAttack === on) return on;
  App.autoAttack = on;
  const me = (App.world && App.net) ? App.world.players.get(App.net.myId) : null;
  const cur = loadSkillCfg();
  const lo = (me && me.loadout) || (cur && cur.loadout) || [];
  saveSkillCfg(lo, on);
  const cb = document.getElementById('cfgAuto');
  if (cb) cb.checked = on;
  if (me) {
    me._sustainOn = on;
    me._sustainOffAt = me._sustainOffAt || {};
    if (!on) me._sustainOffAt[autoAttackSkillId()] = performance.now();   // 关闭 → 收招 CD 起点（按配置判定的自动普攻 id）
  }
  return on;
}
App.setAutoAttack = setAutoAttack;
// 供 touch.js 复用：自动普攻技能 id / 显示名的配置判定口径统一走这里
App.autoAttackSkillId = autoAttackSkillId;
App.autoAttackSkillName = autoAttackSkillName;

// ===== 技能配置面板（需求4/9）：localStorage 存取 + 勾选渲染（单机开局生效） =====
const CFG_KEY = 'p2p_battle_skill_cfg_v1';
function loadSkillCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && Array.isArray(o.loadout)) ? o : null;
  } catch (e) { return null; }
}
function saveSkillCfg(loadout, autoAttack) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify({ loadout: loadout || [], autoAttack: !!autoAttack })); } catch (e) {}
}
// 出战技能上限 / 技能栏槽位数：一律以 config/skillbar.json 为准（loadout = 出战场上阵槽位数，capacity = 技能栏总格数兜底），
// 代码里不再出现固定数字；并强制 loadout ≤ capacity，保证出战槽位与界面槽位一一对应（两者都缺字段时才退回下限 1）。
const SKILLBAR_MIN_LOADOUT = 1;   // 原写死的兜底值：出战技能数下限（改名避免与 combat.js 顶层同名常量重复声明）
// 技能模块 id：按模块用途（config/modules.json 中 source=skills 的模块）反查，代码不写死模块 id，
// 改 modules.json 里的技能模块 id 后依旧命中；配置缺声明时退回旧的 'skill'（不报错）。
function skillModuleId() {
  return (typeof Profiles !== 'undefined' && Profiles && Profiles.moduleIdBySource)
    ? Profiles.moduleIdBySource('skills', 'skill')
    : '';
}
// 自动普攻技能 id：按 config/skills.json 的 auto:true 标记判定，改技能 id / 换自动普攻技能后依旧生效；
// 配置缺标记时退回旧 id（见 Profiles.autoSkillId），保持原默认行为
function autoAttackSkillId() {
  return (typeof Profiles !== 'undefined' && Profiles && Profiles.autoSkillId)
    ? Profiles.autoSkillId()
    : 'auto_attack';
}
// 自动普攻显示名：取 skills.json 的技能 name（界面不再写死「普攻」）
function autoAttackSkillName() {
  return (typeof Profiles !== 'undefined' && Profiles && Profiles.autoSkillName)
    ? Profiles.autoSkillName()
    : '普攻';
}
// 出战技能位上阵数：读 skillbar.json 的 loadout，并强制不超过 capacity（loadout ≤ capacity）；
// 单个字段缺失时按 present 的那个兜底，两者都缺才退回 SKILLBAR_MIN_LOADOUT（默认 1）。
function skillLoadoutCap() {
  const sb = (typeof SKILLBAR !== 'undefined' && SKILLBAR) || (typeof window !== 'undefined' && window.SKILLBAR) || {};
  const lo = Math.floor(Number(sb.loadout)) || 0;
  const cap = Math.floor(Number(sb.capacity)) || 0;
  if (cap > 0 && lo > 0) return Math.min(lo, cap);
  if (cap > 0) return cap;
  return lo > 0 ? lo : SKILLBAR_MIN_LOADOUT;
}
// 配置面板说明文案里的技能上限：按 config/modules.json 技能模块 maxSlots 动态填充（缺字段退回默认 8）
function syncSkillMaxSlotsText() {
  const el = document.getElementById('cfgSkillMaxSlots');
  if (!el) return;
  const defs = (typeof MODULE_DEFS !== 'undefined' && MODULE_DEFS) || {};
  const md = (defs && defs[skillModuleId()]) || {};   // 技能模块 id 按用途反查，不写死
  const n = Math.floor(Number(md.maxSlots)) || 8;
  el.textContent = String(n);
}
// 配置面板里自动普攻文案的技能名：取 config/skills.json 的 name（界面不再写死「普攻」/ auto_attack）
function syncAutoAttackText() {
  const nm = autoAttackSkillName();
  const span = document.getElementById('cfgAutoText');
  if (span) span.textContent = '自动普攻（释放「' + nm + '」，无需按键，冷却好自动打最近敌人）';
  const lab = document.getElementById('cfgAutoLabel');
  if (lab) lab.title = '开启后你的角色会自动对最近敌人释放' + nm + '（技能由 config/skills.json 的 auto:true 标记判定），无需按技能键';
}
function defaultLoadoutFor(pool) {
  const cap = skillLoadoutCap();
  return pool.slice().sort((a, b) => ((SKILLS[b] || {}).priority || 0) - ((SKILLS[a] || {}).priority || 0)).slice(0, cap);
}
function currentSoloUnitId() {
  const el = document.getElementById('soloUnit');
  return (el && el.value) || 'hero';
}
// 当前技能配置面板所属单位：联机按房间裁决角色（自己可能被房主设为 Boss），单机按下拉选择
function currentUnitIdForCfg() {
  if (App.net && App.net.isMulti && App.net.myId) {
    const me = (App.net.members || []).find(m => m.id === App.net.myId);
    if (me && me.roleId) return me.roleId;
    if (App.roleId) return App.roleId;
    return 'hero';
  }
  return currentSoloUnitId();
}
// ===== 配置面板（原「技能配置」）：模块化拖拽配置 =====
// 数据分工：
//   config/modules.json    模块 → 分组 groups（独立槽位上限 + 候选范围），条目 group 标签定归属
//   条目库（equipment/mods/skills.json）候选条目（Profiles.candidates 按分组过滤）
//   本机 localStorage      CFG_KEY（出战技能顺序 + 自动普攻，沿用原房间同步链路）
//                          Profiles.CUSTOM_KEY（面板拖拽结果写成「自定义配置」档案，随 profile_cfg 同步）
// 交互：左侧候选池（按模块 / 分组折叠）→ 拖拽或点击 → 右侧分组格子区（组内独立上限）；
//       格子可拖到别的格子替换、可点 × 卸下、可拖回左侧候选池卸下；「一键预设」按分组上限自动填满。
const CFG_STAT_CN = {
  hp: '生命', speed: '速度', radius: '半径', damageMul: '伤害倍率', critChance: '暴击率',
  critMul: '暴击倍率', bulletLimit: '弹量上限', armor: '护甲', atkSpeedMul: '攻速', lifesteal: '吸血'
};
const cfgState = { moduleId: '', draft: {}, drag: null };

// 模块 id 列表（modules.json 去掉 _doc 之类的说明键）
function cfgModuleIds() {
  const defs = (typeof MODULE_DEFS !== 'undefined' && MODULE_DEFS) || {};
  return Object.keys(defs).filter(k => !k.startsWith('_') && defs[k] && typeof defs[k] === 'object');
}
// 配置面板入口按钮的模块名清单：按 config/modules.json 声明的 name 拼接（原写死「装备 / 宝石 / 铭文 / 技能」）
function syncCfgModuleNames() {
  const btn = document.getElementById('btnConfig');
  if (!btn) return;
  const defs = (typeof MODULE_DEFS !== 'undefined' && MODULE_DEFS) || {};
  const names = cfgModuleIds().map(id => (defs[id] && defs[id].name) || id).filter(Boolean);
  if (!names.length) return;   // 配置缺模块声明：保留 HTML 里的兜底文案，不报错
  btn.title = '模块化配置：' + names.join(' / ') + ' 等模块，把候选拖进格子自由搭配（联机与单人共用同一份，联机会同步到房间）';
}
// 条目摘要（悬停提示用）：属性加成 + 解锁技能 + 冷却
function cfgEntryBrief(mid, id) {
  const d = (typeof Profiles !== 'undefined' && Profiles.entryDef(mid, id)) || {};
  const out = [];
  const add = d.add || {};
  Object.keys(add).forEach(k => {
    const v = Number(add[k]) || 0;
    const pct = (k === 'damageMul' || k === 'critChance' || k === 'critMul' || k === 'atkSpeedMul');
    out.push((CFG_STAT_CN[k] || k) + ' ' + (v > 0 ? '+' : '') + (pct ? Math.round(v * 100) + '%' : v));
  });
  if (Array.isArray(d.unlockSkills) && d.unlockSkills.length) {
    out.push('解锁 ' + d.unlockSkills.map(s => ((typeof SKILLS !== 'undefined' && SKILLS[s] && SKILLS[s].name) || s)).join('/'));
  }
  if (d.cd) out.push('冷却 ' + d.cd + 's');
  if (d.notes) out.push(d.notes);
  return out.join(' · ');
}
function cfgEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
// 从档案生成草稿：{ 模块 id: [条目 id...] }（按档案内顺序，顺序即格子顺序）
function cfgDraftFromProfile(prof) {
  const draft = {};
  if (!prof) return draft;
  (prof.modules || []).forEach(m => {
    draft[m.moduleId] = (m.entries || []).map(e => (typeof e === 'string') ? e : e.id);
  });
  return draft;
}
// 未分组哨兵：与引擎 Profiles.UNGROUPED 同值；group 为空 / 未知 / 不属于本模块任何已声明组的条目都归这里
const CFG_UNGROUPED = (typeof Profiles !== 'undefined' && Profiles.UNGROUPED) ? Profiles.UNGROUPED : '__other';
// 按分组拆条目：分组归属与引擎同一口径（Profiles.groupKeyOf 实时解析）——命中本模块已声明分组进对应分组，
// 其余（group 为空 / 未知 / 不属于本模块任何已声明组）一律进 CFG_UNGROUPED 区，不丢弃
function cfgGroupMap(mid, arr) {
  const map = {};
  (arr || []).forEach(id => {
    const key = Profiles.groupKeyOf(mid, id);
    (map[key] = map[key] || []).push(id);
  });
  return map;
}
// 攤平回数组：分组顺序 = modules.json 声明顺序，未分组的条目统一排到末尾（「未分组」区）
function cfgFlatten(mid, map) {
  const out = [];
  Profiles.groups(mid).forEach(g => (map[g.id] || []).forEach(id => out.push(id)));
  (map[CFG_UNGROUPED] || []).forEach(id => out.push(id));
  return out;
}
// 装载条目：groupId 目标分组（未分组区传 CFG_UNGROUPED）、slotIndex 目标格（null = 自动补该组第一个空位）
// 返回 'ok' | 'full'（该组已满）| 'cross'（跨分组装载）| 'badgroup'（未知分组）
function cfgPlace(mid, id, groupId, slotIndex) {
  if (!id || !Profiles.entryDef(mid, id)) return 'badgroup';
  const gs = Profiles.groups(mid);
  const md = Profiles.defs()[mid] || {};
  if (gs.length) {
    const isOther = (groupId === CFG_UNGROUPED);
    const grp = isOther ? null : gs.find(g => g.id === groupId);
    if (!grp && !isOther) return 'badgroup';
    // 归属按引擎实时解析：group 为空 / 未知 / 不属于本模块任何已声明组 → 归「未分组」区，照常可装载
    if (Profiles.groupKeyOf(mid, id) !== groupId) return 'cross';   // 条目只能落进自己分组（或未分组区）的格子
    const map = cfgGroupMap(mid, cfgState.draft[mid]);
    let list = (map[groupId] || []).slice();
    // 未分组区：占模块剩余格数（未分组 + 已声明分组总占用 ≤ 模块上限）；已声明分组按组独立上限
    const cap = isOther ? Profiles.ungroupedRoom(mid, cfgState.draft[mid]) : grp.maxSlots;
    // 分组未声明 allowDuplicate 时回落到模块级开关（缺省不允许重复）；未分组区只有模块级开关
    const allowDup = isOther ? !!md.allowDuplicate
      : ((grp.allowDuplicate != null) ? !!grp.allowDuplicate : !!md.allowDuplicate);
    if (!allowDup) {
      // 同组不允许重复：先在组内去掉同一条目（等价于把它挪到目标格）
      list = list.filter(x => x !== id);
    }
    if (slotIndex != null && slotIndex >= 0 && slotIndex < list.length) list[slotIndex] = id;
    else if (list.length >= cap) return 'full';
    else list.push(id);
    map[groupId] = list;
    cfgState.draft[mid] = cfgFlatten(mid, map);
    return 'ok';
  }
  // 未声明分组（relic 等）：单池共享 maxSlots
  const cap = Math.max(0, Number(md.maxSlots) || 0);
  const map = cfgGroupMap(mid, cfgState.draft[mid]);
  let list = (map[CFG_UNGROUPED] || []).slice();
  if (!md.allowDuplicate) list = list.filter(x => x !== id);
  if (slotIndex != null && slotIndex >= 0 && slotIndex < list.length) list[slotIndex] = id;
  else if (list.length >= cap) return 'full';
  else list.push(id);
  map[CFG_UNGROUPED] = list;
  cfgState.draft[mid] = cfgFlatten(mid, map);
  return 'ok';
}
// 卸下指定分组（未分组区传 CFG_UNGROUPED）的第 slotIndex 格
function cfgRemoveAt(mid, groupId, slotIndex) {
  const map = cfgGroupMap(mid, cfgState.draft[mid]);
  const key = map[groupId] ? groupId : CFG_UNGROUPED;
  const list = (map[key] || []).slice();
  if (slotIndex >= 0 && slotIndex < list.length) list.splice(slotIndex, 1);
  map[key] = list;
  cfgState.draft[mid] = cfgFlatten(mid, map);
}
// 一键预设：按分组上限从候选池顺序（技能按 priority）自动填满本模块
function cfgPresetModule(mid) {
  const md = Profiles.defs()[mid] || {};
  const gs = Profiles.groups(mid);
  const map = {};
  if (gs.length) {
    gs.forEach(g => {
      let cand = Profiles.candidates(mid, g.id);
      if (Profiles.sourceOf(mid) === 'skills') cand = defaultLoadoutFor(cand).concat(cand.filter(x => defaultLoadoutFor(cand).indexOf(x) < 0));
      map[g.id] = cand.slice(0, g.maxSlots);
    });
  } else {
    let cand = Profiles.candidates(mid);
    if (Profiles.sourceOf(mid) === 'skills') cand = defaultLoadoutFor(cand).concat(cand.filter(x => defaultLoadoutFor(cand).indexOf(x) < 0));
    map[CFG_UNGROUPED] = cand.slice(0, Math.max(0, Number(md.maxSlots) || 0));
  }
  cfgState.draft[mid] = cfgFlatten(mid, map);
}
// 落格 / 点选装载（含提示）
function cfgDrop(id, grp, slot) {
  const tip = document.getElementById('cfgTip');
  const r = cfgPlace(cfgState.moduleId, id, grp, slot);
  if (r === 'ok') { if (tip) tip.textContent = ''; renderCfgModule(); return; }
  if (!tip) return;
  const gname = Profiles.groupName(cfgState.moduleId, grp) || '该分组';
  if (r === 'full') tip.textContent = '「' + gname + '」已满，请先点格子上的 × 卸下一个，或把候选拖到某个格子替换。';
  else if (r === 'cross') {
    // 提示条目真实归属（未分组条目提示直接点击装载，不再显示空组名）
    const gk = Profiles.groupKeyOf(cfgState.moduleId, id);
    const gcn = (gk === CFG_UNGROUPED) ? '未分组' : (Profiles.groupName(cfgState.moduleId, gk) || gk);
    tip.textContent = '不能跨分组装载：该条目属于「' + gcn + '」，请放进对应分组的格子' + (gk === CFG_UNGROUPED ? '（未分组条目直接点击候选池中的条目即可装载）' : '') + '。';
  }
  else tip.textContent = '该条目不可装载到当前模块。';
}

// 拖拽 / 点击事件：委托绑定一次（候选池 #cfgPool / 格子区 #cfgGrid / 模块页签 #cfgTabs）
function bindCfgPanelEvents() {
  const pool = document.getElementById('cfgPool');
  const grid = document.getElementById('cfgGrid');
  const tabs = document.getElementById('cfgTabs');
  if (!pool || !grid || pool.dataset.bound) return;
  pool.dataset.bound = '1';
  const clearMarks = () => {
    Array.prototype.forEach.call(document.querySelectorAll('.cg-cell.over, .cg-cell.dragging'), x => x.classList.remove('over', 'dragging'));
    pool.classList.remove('over');
  };
  if (tabs) tabs.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('.cfg-tab') : null;
    if (!b) return;
    cfgState.moduleId = b.dataset.mod;
    const tip = document.getElementById('cfgTip'); if (tip) tip.textContent = '';
    renderCfgPanel();
  });
  // 候选池：单击 = 装载（自动补该分组第一个空位）/ 再次单击同一候选 = 卸下（无需到右侧点 ×）；
  //   拖拽 = 精确落格。判定「已装载」以草稿中该分组下的实际列表为准——
  //   分组 key 与引擎同一口径：条目 data-grp 只有在草稿里确有该分组时才认，否则回落到未分组区
  //   （单池模块如技能 / 遗物的分组 id 为空串，装载结果统一记在未分组区，避免二次单击判不到已装载而取消失败）。
  pool.addEventListener('click', e => {
    const it = e.target.closest ? e.target.closest('.cfg-item') : null;
    if (!it) return;
    const tip = document.getElementById('cfgTip');
    const mid = cfgState.moduleId;
    const id = it.dataset.pool;
    const map = cfgGroupMap(mid, cfgState.draft[mid]);
    const key = map[it.dataset.grp] ? it.dataset.grp : CFG_UNGROUPED;
    const at = (map[key] || []).indexOf(id);
    if (at >= 0) {                                  // 再次单击已装载条目 → 取消装载
      cfgRemoveAt(mid, key, at);
      if (tip) tip.textContent = '';
      renderCfgModule();
      return;
    }
    cfgDrop(id, it.dataset.grp, null);
  });
  pool.addEventListener('dragstart', e => {
    const it = e.target.closest ? e.target.closest('.cfg-item') : null;
    if (!it) return;
    cfgState.drag = { from: 'pool', id: it.dataset.pool, grp: it.dataset.grp, slot: null };
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', it.dataset.pool); }
  });
  // 格子区：拖动已装载条目（换格 / 替换 / 拖回左侧卸下）
  grid.addEventListener('dragstart', e => {
    const c = e.target.closest ? e.target.closest('.cg-cell.filled') : null;
    if (!c) return;
    const grp = c.dataset.grp;
    const slot = parseInt(c.dataset.slot, 10) || 0;
    const list = cfgGroupMap(cfgState.moduleId, cfgState.draft[cfgState.moduleId])[grp] || [];
    const id = list[slot];
    if (!id) return;
    cfgState.drag = { from: 'grid', id, grp, slot };
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }
    c.classList.add('dragging');
  });
  grid.addEventListener('dragover', e => {
    const c = e.target.closest ? e.target.closest('.cg-cell') : null;
    if (!c || !cfgState.drag) return;
    e.preventDefault();
    c.classList.add('over');
  });
  grid.addEventListener('dragleave', e => {
    const c = e.target.closest ? e.target.closest('.cg-cell') : null;
    if (c) c.classList.remove('over');
  });
  grid.addEventListener('drop', e => {
    const c = e.target.closest ? e.target.closest('.cg-cell') : null;
    if (!c) return;
    e.preventDefault();
    const d = cfgState.drag;
    cfgState.drag = null;
    clearMarks();
    if (!d) return;
    const slot = parseInt(c.dataset.slot, 10) || 0;
    if (d.from === 'grid' && d.grp === c.dataset.grp && d.slot === slot) return;   // 拖回自己：无操作
    if (d.from === 'grid') cfgRemoveAt(cfgState.moduleId, d.grp, d.slot);        // 先腾出源格，再落目标格
    cfgDrop(d.id, c.dataset.grp, slot);
  });
  grid.addEventListener('click', e => {
    const x = e.target.closest ? e.target.closest('.cg-x') : null;
    if (!x) return;
    cfgRemoveAt(cfgState.moduleId, x.dataset.grp, parseInt(x.dataset.slot, 10) || 0);
    const tip = document.getElementById('cfgTip'); if (tip) tip.textContent = '';
    renderCfgModule();
  });
  // 拖回左侧候选池 = 卸下
  pool.addEventListener('dragover', e => {
    if (cfgState.drag && cfgState.drag.from === 'grid') { e.preventDefault(); pool.classList.add('over'); }
  });
  pool.addEventListener('dragleave', () => pool.classList.remove('over'));
  pool.addEventListener('drop', e => {
    const d = cfgState.drag;
    cfgState.drag = null;
    clearMarks();
    if (!d) return;
    e.preventDefault();
    if (d.from === 'grid') {
      cfgRemoveAt(cfgState.moduleId, d.grp, d.slot);
      const tip = document.getElementById('cfgTip'); if (tip) tip.textContent = '';
      renderCfgModule();
    }
  });
  document.addEventListener('dragend', () => { cfgState.drag = null; clearMarks(); });
}

// 渲染模块页签（每个模块显示 已装载/总格数）
function renderCfgTabs() {
  const tabs = document.getElementById('cfgTabs');
  if (!tabs) return;
  const defs = Profiles.defs();
  tabs.innerHTML = cfgModuleIds().map(id => {
    const md = defs[id] || {};
    const total = Profiles.slotCount(id) || Math.max(0, Number(md.maxSlots) || 0);
    const used = (cfgState.draft[id] || []).length;
    return '<button type="button" class="cfg-tab' + (id === cfgState.moduleId ? ' on' : '') + '" data-mod="' + cfgEsc(id) + '">'
      + cfgEsc(md.name || id) + '<em>' + used + '/' + total + '</em></button>';
  }).join('');
}

// 渲染当前模块：左侧候选池（按分组折叠）+ 右侧格子区
function renderCfgPanel() {
  const ids = cfgModuleIds();
  if (!cfgState.moduleId || ids.indexOf(cfgState.moduleId) < 0) cfgState.moduleId = ids[0] || '';
  renderCfgTabs();
  renderCfgModule();
}

function renderCfgModule() {
  const mid = cfgState.moduleId;
  const md = Profiles.defs()[mid] || {};
  const gs = Profiles.groups(mid);
  const arr = cfgState.draft[mid] || [];
  const map = cfgGroupMap(mid, arr);
  // ---- 左侧：候选池 ----
  const poolEl = document.getElementById('cfgPool');
  if (poolEl) {
    const secs = gs.length
      ? gs.map(g => ({ id: g.id, name: g.name, cap: g.maxSlots, notes: g.notes, cands: Profiles.candidates(mid, g.id) }))
      : [{ id: '', name: md.name || mid, cap: Math.max(0, Number(md.maxSlots) || 0), notes: md.notes || '', cands: Profiles.candidates(mid) }];
    // 未分组区：group 为空 / 未知 / 不属于本模块任何已声明组的条目收进底部折叠区，照常展示并可装载（不丢弃）
    if (gs.length) {
      secs.push({
        id: CFG_UNGROUPED, name: '未分组', ungrouped: true,
        cap: Profiles.ungroupedRoom(mid, arr),
        notes: 'group 为空 / 未知 / 未被任何模块声明的条目：占本模块剩余格数',
        cands: Profiles.candidates(mid, CFG_UNGROUPED),
      });
    }
    poolEl.innerHTML = secs.map(s => {
      const used = (map[s.id] || []).length;
      const items = s.cands.map(id => {
        const cnt = arr.filter(x => x === id).length;
        const full = used >= s.cap && s.cap > 0;
        const cls = 'cfg-item' + (cnt ? ' picked' : '') + ((full && !cnt) ? ' dim' : '');
        // 单击即可切换装载状态：已装载的候选显示「已装载 N · 单击取消」；未装载的不加额外行，靠 title 提示「单击装载」
        const hint = cnt ? '已装载 ' + cnt + ' · 单击取消' : '单击装载';
        return '<div class="' + cls + '" draggable="true" data-pool="' + cfgEsc(id) + '" data-grp="' + cfgEsc(s.id) + '" title="' + cfgEsc(cfgEntryBrief(mid, id) + ' · ' + hint) + '">'
          + '<span class="ci-n">' + cfgEsc(Profiles.candidateName(mid, id)) + '</span>'
          + '<span class="ci-d">' + cfgEsc(cfgEntryBrief(mid, id)) + '</span>'
          + (cnt ? '<span class="ci-c">' + cfgEsc(hint) + '</span>' : '')
          + '</div>';
      }).join('') || ('<div class="cfg-empty">' + (s.ungrouped ? '暂无未分组条目' : '该分组暂无候选条目') + '</div>');
      return '<div class="cfg-sec' + (full0(used, s.cap) ? ' full' : '') + '" data-grp="' + cfgEsc(s.id) + '">'
        + '<div class="cs-head"><span class="cs-n">' + cfgEsc(s.name) + '</span><span class="cs-c">' + used + '/' + s.cap + '</span></div>'
        + (s.notes ? '<div class="cs-note">' + cfgEsc(s.notes) + '</div>' : '')
        + '<div class="cs-body">' + items + '</div></div>';
    }).join('');
  }
  // ---- 右侧：格子区（Profiles.grid 按分组铺格，空位为 null）----
  const gridEl = document.getElementById('cfgGrid');
  if (gridEl) {
    gridEl.innerHTML = Profiles.grid(mid, arr).map(g => {
      const cells = g.slots.map((e, i) => {
        const grp = cfgEsc(g.id);
        if (!e) return '<div class="cg-cell empty" data-grp="' + grp + '" data-slot="' + i + '"><span class="cg-plus">+</span></div>';
        const id = (typeof e === 'string') ? e : e.id;
        return '<div class="cg-cell filled" draggable="true" data-grp="' + grp + '" data-slot="' + i + '" title="' + cfgEsc(cfgEntryBrief(mid, id)) + '">'
          + '<span class="cg-n">' + cfgEsc(Profiles.candidateName(mid, id)) + '</span>'
          + '<span class="cg-d">' + cfgEsc(cfgEntryBrief(mid, id)) + '</span>'
          + '<button type="button" class="cg-x" data-grp="' + grp + '" data-slot="' + i + '" title="卸下">×</button></div>';
      }).join('');
      const used = g.slots.filter(Boolean).length;
      return '<div class="cg-group' + (g.unknownGroup ? ' unknown' : '') + '">'
        + '<div class="cg-head"><span>' + cfgEsc(g.name || md.name || mid) + '</span><em>' + used + '/' + g.maxSlots + '</em></div>'
        + '<div class="cg-cells">' + cells + '</div></div>';
    }).join('');
  }
  const tipEl = document.getElementById('cfgModTip');
  if (tipEl) {
    const total = Profiles.slotCount(mid) || Math.max(0, Number(md.maxSlots) || 0);
    tipEl.textContent = (md.name || mid) + '：' + arr.length + '/' + total + ' 格已装载'
      + (md.notes ? ' · ' + md.notes : '');
  }
}
// 分组是否已满（左栏折叠头标色用）
function full0(used, cap) { return cap > 0 && used >= cap; }

// 配置面板 / 候选池直接依赖的全局配置表（打开面板前强制读盘刷新这几张；
// 引擎运行表如 GAME_CONFIG / BULLETS / TRIGGERS 不在其中，避免临场改动手感；
// AI 档位相关的 BOT_LEVELS / CHALLENGE / GAME_CONFIG 由 refreshGameCfg 单独刷新，只影响 AI 下拉与默认档位）
const CFG_PANEL_KEYS = ['MODULE_DEFS', 'SKILLS', 'EQUIPMENT', 'MODS', 'BUFFS', 'UNITS', 'PROFILES', 'SKILLBAR'];

// AI 档位 / 默认档位 / AI 数量上限所依赖的全局配置表：ai.json（BOT_LEVELS 档位表）、
// challenge.json（CHALLENGE 默认档位与单人对局人数）、runtime.json（GAME_CONFIG.ROOM_MAX 房间座位）
const AI_CFG_KEYS = ['BOT_LEVELS', 'CHALLENGE', 'GAME_CONFIG'];

// 开局 / 打开面板前的统一配置刷新入口：重读受管配置表进 window 全局，并按最新 skillbar.json 重建技能键
// 供所有「用配置」的时机复用（配置界面、单机挑战、联机房主发起开局、再来一局），保证配置改动处处生效
async function refreshGameCfg() {
  if (typeof ensureFreshCfg === 'function') {
    // 一并重读 AI 档位相关表；取不到时沿用内存里的旧配置，同样不阻塞开局
    try { await ensureFreshCfg('config/', CFG_PANEL_KEYS.concat(AI_CFG_KEYS)); } catch (e) { /* 拉取失败保留现有全局，不阻塞开局 */ }
  }
  if (typeof Touch !== 'undefined' && Touch.refreshSkillKeys) Touch.refreshSkillKeys();
  if (typeof Input !== 'undefined' && Input.rebuildSkillKeys) Input.rebuildSkillKeys();   // PC 技能键位数按最新 skillbar.json capacity 重建
  syncSkillMaxSlotsText();   // 面板说明文案里的技能上限按 modules.json 技能模块 maxSlots 刷新
  syncCfgModuleNames();      // 配置入口按钮提示里的模块名清单按 modules.json 声明的 name 刷新
  syncAutoAttackText();      // 面板里自动普攻文案的技能名按 skills.json 的 name 刷新（不写死「普攻」）
  syncAiCfgUi();             // AI 难度档位数 / 默认档位 / AI 数量档位按最新配置重建
  return true;
}

async function openCfgPanel() {
  const panel = document.getElementById('panelCfg');
  if (!panel) return;
  if (!document.getElementById('cfgPool')) return;
  // 候选池与面板数据全部取自启动时读盘一次的 window 全局配置表；这里在打开面板前强制重读这几张表，
  // 保证外部改过 config/skills.json（新增 / 改名 / 删除条目）后，候选池立刻反映磁盘最新内容。
  await refreshGameCfg();
  renderProfileSelector();          // 档案下拉（角色档案 / 自定义配置；Boss 角色不挂档案）
  bindCfgPanelEvents();
  const unitId = currentUnitIdForCfg();
  const unit = UNITS[unitId] || {};
  const ps = profileStore();
  const cur = ps ? ps.currentId() : '';
  const prof = (cur === (ps && ps.CUSTOM_ID)) ? (ps && ps.custom()) : (ps ? ps.get(cur) : null);
  // 草稿来源：显式选中的档案 > 已有的自定义配置 > 本机自动匹配档案（Boss 无档案则空手，只需勾技能）
  // 注意：custom()/get() 返回的是「档案对象」（modules:[{moduleId,entries:[...]}]），必须先经
  // cfgDraftFromProfile 转成草稿映射 { 模块 id: [条目 id...] } 才能进面板；否则二次打开时把档案对象
  // 直接当草稿用，界面按空草稿渲染（上一次的装载全部看不到），再保存还会把档案清空。
  const draftOf = p => (p ? cfgDraftFromProfile(p) : {});
  const customDraft = draftOf(ps && ps.custom());
  const hasDraft = d => Object.keys(d).some(k => (d[k] || []).length > 0);
  let seed = null;
  if (ps) {
    if (cur === ps.CUSTOM_ID) seed = hasDraft(customDraft) ? customDraft : draftOf(localProfileFor(unitId));
    else if (prof) seed = draftOf(prof);
    else seed = hasDraft(customDraft) ? customDraft : draftOf(localProfileFor(unitId));
  }
  cfgState.draft = seed || {};
  cfgState.moduleId = cfgModuleIds().indexOf(cfgState.moduleId) >= 0 ? cfgState.moduleId : (cfgModuleIds()[0] || '');
  const cfg = loadSkillCfg();
  const autoEl = document.getElementById('cfgAuto');
  if (autoEl) autoEl.checked = cfg ? !!cfg.autoAttack : true;
  const tip = document.getElementById('cfgTip');
  if (tip) {
    tip.textContent = unit.isBoss
      ? '当前是 Boss 角色：Boss 不挂玩家档案（属性由 units.json 与阶段规则决定），这里的配置仅对勇者方生效。'
      : '';
  }
  renderCfgPanel();
  panel.style.display = 'flex';
}
function closeCfgPanel() { document.getElementById('panelCfg').style.display = 'none'; }
function saveCfgPanel() {
  const ps = profileStore();
  const auto = !!document.getElementById('cfgAuto').checked;
  const draft = cfgState.draft || {};
  // 草稿 → 档案模块列表（空模块不写，避免污染）
  const modules = cfgModuleIds()
    .filter(mid => (draft[mid] || []).length)
    .map(mid => ({ moduleId: mid, entries: (draft[mid] || []).slice() }));
  // ① 模块选择落盘为「自定义配置」档案（本机 localStorage；超分组上限 / 未知条目由 Profiles.sanitize 截断剔除）
  let prof = null;
  if (ps) {
    prof = ps.setCustom({ name: '自定义配置', unitId: '', base: {}, modules: modules, notes: '配置面板拖拽生成' });
    ps.setCurrentId(prof ? ps.CUSTOM_ID : '');
  }
  // ② 技能模块格子顺序 = 出战技能表（沿用 skills_cfg 房间同步链路；未配技能则保持角色模板默认）
  const sel = (draft[skillModuleId()] || []).slice(0, skillLoadoutCap());
  saveSkillCfg(sel, auto);
  applyLocalProfileChoice(ps ? (ps.currentId() || '') : '');
  // 需求2：联机房间内配置同样保存并广播同步房间（每人配置自己的出战技能）
  if (App.net && App.net.isMulti) {
    App.net.broadcast({ t: 'skills_cfg', loadout: sel, autoAttack: auto });
  }
  // 已在本局战斗中：热更新本地角色（换档案重算属性/技能池 + 立即刷新出战表）
  if (App.world) {
    const me = App.world.players.get(App.net.myId);
    if (me && !me.isBot) {
      const cur = localProfileFor(App.roleId);
      if (cur && !me.isBoss) me.applyProfile(cur);
      if (sel.length) me.loadout = sel.slice();
      App.autoAttack = auto;
    }
  }
  const inRoom = !!(App.net && App.net.isMulti);
  const parts = modules.map(m => {
    const md = Profiles.defs()[m.moduleId] || {};
    return (md.name || m.moduleId) + ' ' + m.entries.length + '/' + (Profiles.slotCount(m.moduleId) || 0);
  });
  document.getElementById('cfgTip').textContent = '已保存' + (inRoom ? '并同步房间' : '') + '：'
    + (prof ? '已存为「自定义配置」档案' : '模块为空，回退角色模板默认装配')
    + '（' + (parts.length ? parts.join(' · ') : '未装载任何模块') + '）；出战技能 ' + sel.length + ' 个'
    + (auto ? '，自动普攻开启' : '，自动普攻关闭')
    + (inRoom ? '。本局立即生效，下一局开局沿用。' : '。开始单人游戏后生效。');
}
