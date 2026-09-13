// ===== 网络层：WebRTC 全网状拓扑 =====
// 信令复用 p2p-chat 的 ws 服务（server-local / server-cf 均可）。
// 连接规则：id 小者为 offerer，避免 glare。
// 单人开房：仅 ws 连接信令，无 peer 也正常运行（本地模式）。

// 邀请码/应答码里携带的 ICE 候选条数上限：读 config/runtime.json 的 INVITE_CANDS_MAX
// （缺字段时读 challenge.json 的 inviteCandsMax，再缺则保持原行为 8）；压缩码长，降低粘贴/传输截断风险
function inviteCandsMax() {
  const g = (typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG) || {};
  const ch = (typeof window !== 'undefined' && window.CHALLENGE) || (typeof CHALLENGE !== 'undefined' ? CHALLENGE : null) || {};
  // 依次尝试 runtime.json.INVITE_CANDS_MAX → challenge.json.inviteCandsMax；都缺失/非法则保持原行为 8
  const list = [g.INVITE_CANDS_MAX, ch.inviteCandsMax];
  for (let i = 0; i < list.length; i++) {
    const n = parseInt(list[i], 10);
    if (n > 0) return n;
  }
  return 8;
}

// ===== 信令基址解析（APP 打包版适配，由 sync.ps1 注入）=====
// 优先级：① window.__SIGNAL_BASE__ / URL ?signal=  显式注入（APP 原生侧可传局域网地址）
//         ② location.origin                       同源环境：页面由内置服务托管时直接复用当前 origin
//         ③ GAME_CONFIG.SIGNAL_BASE               降级兜底（离线/自定义部署）
function resolveSignalBase() {
  try {
    if (typeof window !== 'undefined') {
      var inj = window.__SIGNAL_BASE__;
      if (!inj && window.location && window.location.search) {
        var m = /[?&]signal=([^&#]+)/.exec(window.location.search);
        if (m) inj = decodeURIComponent(m[1]);
      }
      if (inj && typeof inj === 'string') return inj.replace(/\/+$/, '');
    }
    var loc = (typeof location !== 'undefined') ? location : null;
    if (loc && /^https?:$/i.test(loc.protocol) && loc.host) {
      return loc.origin || (loc.protocol + '//' + loc.host);
    }
  } catch (e) { /* 忽略：降级到配置兜底 */ }
  return (typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG && GAME_CONFIG.SIGNAL_BASE) || '';
}
class Net {
  constructor() {
    this.ws = null;
    this.myId = null;
    this.members = [];        // [{id,name,roleId,isHost}]
    this.peers = new Map();   // memberId -> { pc, dc, connected }
    this.token = null;
    // 信令服务器基址：优先取 location.origin（APP 内置服务同源托管），
    // 令牌 / URL 参数可显式覆盖（setSignalBase），配置值仅作离线兜底。
    this.signalBase = resolveSignalBase();
    this.onMembers = null;    // (members) => void
    this.onSignal = null;     // (fromId, payload) => void
    this.onData = null;       // (fromId, msg) => void
    this.onPeer = null;       // (memberId, connected) => void
    this.onRelay = null;      // (fromId, msg) => void  信令中转的应用消息（TCP）
    this.isHost = false;
    this.isMulti = false;
    this.selfRole = 'hero';
    this._joinWaiter = null;  // joined 等待器（createRoom/joinRoom 返回前等服务端确认）
    // ---- 0 服务器手动贴码（星形）状态 ----
    this.manual = '';          // ''=服务器信令 | 'hub'=手动房主 | 'member'=手动成员
    this._hubInfo = null;      // 手动成员端：房主信息 {id,name,roleId}
    this._hubOffers = [];      // 手动房主端：待确认邀请 [{key,pc,dc,memberId,name,roleId}]
    this._offerSeq = 0;
  }

  genId() { return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // 覆盖信令服务器基址（令牌加入/局域网直连时使用）
  setSignalBase(base) {
    if (base && typeof base === 'string') this.signalBase = base;
  }

  async createRoom(name, roleId, customToken) {
    const url = this.signalBase.replace(/\/ws.*$/, '');
    const res = await fetch(url + '/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || 'battle', token: customToken || null })
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || ('创建失败 HTTP ' + res.status));
    }
    this.token = data.token;
    this.myId = this.genId();
    this.selfName = name;
    this.selfRole = roleId;
    this.isHost = true;               // 创建者=房主（权威），joined/members 后仍以首位校正
    this.isMulti = true;
    await this.connectWs('host');
    await this._waitJoined();
    return this.token;
  }

  async joinRoom(token, name, roleId) {
    this.token = token;
    this.myId = this.genId();
    this.selfName = name;
    this.selfRole = roleId;
    this.isHost = false;              // 加入者非房主，joined 后以 members[0] 校正
    this.isMulti = true;
    await this.connectWs('member');
    await this._waitJoined();
  }

  // 等待服务端 joined 确认（返回服务端裁决后的角色；超时兜底返回当前值）
  _waitJoined() {
    return new Promise(resolve => {
      if (this._joinedDone) return resolve(this.selfRole);
      const done = (role) => { this._joinWaiter = null; resolve(role); };
      this._joinWaiter = done;
      setTimeout(() => { if (this._joinWaiter) done(this.selfRole); }, 4000);
    });
  }

  connectWs(type) {
    return new Promise((resolve, reject) => {
      // config 里允许填 http(s) 地址（本地 python 信令 / CF 域名），前端统一转 ws(s)；
      // 令牌加入时 this.signalBase 已指向令牌内的信令地址
      const base = this.signalBase.replace(/\/+$/, '').replace(/^http/i, 'ws');
      const url = base + '/ws?token=' + this.token + '&myId=' + this.myId + '&type=' + type
        + '&name=' + encodeURIComponent(this.selfName || '')
        + '&roleId=' + encodeURIComponent(this.selfRole || 'hero');
      this.ws = new WebSocket(url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('信令连接失败'));
      this.ws.onmessage = e => {
        let m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        this.handleSignalMsg(m);
      };
      this.ws.onclose = () => { /* 断线重连由上层处理 */ };
    });
  }

  handleSignalMsg(m) {
    if (m.type === 'joined') {
      // 服务端可能分配 myId；joined 携带服务端裁决后的角色（Boss 冲突会降级为勇者）
      if (m.myId) this.myId = m.myId;
      if (m.roleId) this.selfRole = m.roleId;
      this._joinedDone = true;
      if (this._joinWaiter) this._joinWaiter(this.selfRole);
      this.members = this._normalizeMembers(m.members || [], false);
      if (this.members.length) this.isHost = this.members[0].id === this.myId;
      this.syncMembers();
      if (this.onMembers) this.onMembers(this.members);
    } else if (m.type === 'members') {
      // 服务端广播：房间有新成员加入 / 成员角色变化（全量对象，顺序=加入顺序，房主恒为首位）
      this.members = this._normalizeMembers(m.members || [], true);
      if (this.members.length) this.isHost = this.members[0].id === this.myId;
      const self = this.members.find(x => x.id === this.myId);
      if (self && self.roleId) this.selfRole = self.roleId;
      this.syncMembers();
      if (this.onMembers) this.onMembers(this.members);
    } else if (m.type === 'signal') {
      // 转发 WebRTC 信令
      if (m.payload && m.payload.kind === 'member') {
        this.handleMemberSignal(m.from, m.payload);
      } else if (this.onSignal) {
        this.onSignal(m.from, m.payload);
      }
    } else if (m.type === 'relay') {
      // 信令服务器中转的应用消息（如 shoot）：TCP 可靠有序
      if (this.onRelay) this.onRelay(m.from || '', m.payload || {});
    } else if (m.type === 'member_leave') {
      this.removePeer(m.myId);
      this.members = this.members.filter(x => x.id !== m.myId);
      // 房主顺延：首位离开后，剩余成员首位即新房主（isHost 随之校正）
      if (this.members.length) this.isHost = this.members[0].id === this.myId;
      if (this.onMembers) this.onMembers(this.members);
    }
  }

  // 规范化成员列表：服务端对象数组 [{id,name,roleId}]（兼容纯 id 字符串）
  _normalizeMembers(raw, withSelf) {
    const prev = new Map(this.members.map(x => [x.id, x]));
    let list = raw.map((x, i) => {
      const obj = typeof x === 'object' && x ? x : null;
      const id = obj ? (obj.id || '') : String(x);
      const old = prev.get(id);
      return {
        id,
        name: (obj && obj.name) || (old && old.name) || '?',
        roleId: (obj && obj.roleId) || (old && old.roleId) || 'hero',
      };
    });
    // joined 不含自己：把自己以本地信息补到末尾（保证后续能对上 isHost/渲染）
    if (!withSelf && !list.some(x => x.id === this.myId) && this.myId) {
      list = list.concat([{ id: this.myId, name: this.selfName || '?', roleId: this.selfRole || 'hero' }]);
    }
    return list.map((x, i) => ({ ...x, isHost: i === 0 }));
  }

  // ---- 成员管理 ----
  syncMembers() {
    // 与所有成员建连（幂等）
    this.members.forEach(m => {
      if (m.id === this.myId) return;
      if (this.peers.has(m.id)) return;
      this.createPeer(m.id);
    });
  }

  // ---- WebRTC 握手 ----
  createPeer(memberId) {
    const pc = new RTCPeerConnection({ iceServers: GAME_CONFIG.ICE_SERVERS });
    const entry = { pc, dc: null, connected: false };
    this.peers.set(memberId, entry);

    pc.onicecandidate = e => {
      if (e.candidate) {
        this.sendSignal(memberId, { kind: 'member', desc: null, candidate: e.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected' && !entry.connected) {
        entry.connected = true;
        if (this.onPeer) this.onPeer(memberId, true);
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(memberId);
      }
    };

    // id 小者为 offerer
    if (this.myId < memberId) {
      const dc = pc.createDataChannel('battle');
      this.setupDc(memberId, dc);
      pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => {
        this.sendSignal(memberId, { kind: 'member', desc: pc.localDescription, candidate: null });
      });
    } else {
      pc.ondatachannel = e => this.setupDc(memberId, e.channel);
    }
    return pc;
  }

  handleMemberSignal(fromId, payload) {
    let entry = this.peers.get(fromId);
    if (!entry) {
      this.createPeer(fromId);
      entry = this.peers.get(fromId);
    }
    const pc = entry.pc;
    if (payload.candidate) {
      pc.addIceCandidate(payload.candidate).catch(() => {});
      return;
    }
    if (payload.desc) {
      if (payload.desc.type === 'offer') {
        pc.setRemoteDescription(payload.desc).then(() => pc.createAnswer()).then(a => pc.setLocalDescription(a)).then(() => {
          this.sendSignal(fromId, { kind: 'member', desc: pc.localDescription, candidate: null });
        });
      } else if (payload.desc.type === 'answer') {
        pc.setRemoteDescription(payload.desc);
      }
    }
  }

  setupDc(memberId, dc) {
    const entry = this.peers.get(memberId);
    if (entry) entry.dc = dc;
    dc.onopen = () => {
      if (entry) entry.connected = true;
      if (this.onPeer) this.onPeer(memberId, true);
    };
    dc.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (this.onData) this.onData(memberId, m);
    };
  }

  removePeer(memberId) {
    const entry = this.peers.get(memberId);
    if (entry) {
      try { entry.pc.close(); } catch (err) { /* ignore */ }
      this.peers.delete(memberId);
      if (this.onPeer) this.onPeer(memberId, false);
    }
  }

  // ---- 消息收发 ----
  sendSignal(toId, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'signal', to: toId, payload }));
    }
  }

  // 需求4：所有应用层战斗消息统一补时间戳（performance.now 单调时钟），
  // 接收端据此判定"是否过期"，过期消息直接丢弃（不参与计算、不参与渲染）。
  _stamp(msg) {
    if (msg && typeof msg === 'object' && typeof msg.ts !== 'number') msg.ts = performance.now();
    return msg;
  }

  broadcast(msg) {
    this._stamp(msg);
    const s = JSON.stringify(msg);
    this.peers.forEach(e => {
      if (e.dc && e.dc.readyState === 'open') e.dc.send(s);
    });
  }

  sendTo(id, msg) {
    this._stamp(msg);
    const e = this.peers.get(id);
    if (e && e.dc && e.dc.readyState === 'open') e.dc.send(JSON.stringify(msg));
  }

  // ---- 信令中转：WebRTC 直连为 UDP 可能丢包，关键事件（shoot 等）改走 TCP 中继 ----
  // 手动星形：成员只把 shoot 发给房主（房主消费 + 星形转发其他成员），房主广播全员
  relayShoot(msg) {
    this._stamp(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'relay', payload: msg }));
      return;
    }
    if (this.manual === 'hub') {
      this.broadcast(msg);
    } else if (this.manual === 'member' && this._hubInfo && this._hubInfo.id !== this.myId) {
      this.sendTo(this._hubInfo.id, msg);
    }
  }

  // 通知信令服务器我的角色变化（房主顺延转职 Boss 等），服务端据此裁决后续 Boss 补位
  notifyRole(roleId) {
    this.selfRole = roleId || this.selfRole;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'role', roleId: this.selfRole }));
    }
  }

  // 房主视角：等待 member 完成握手后，把成员名单补发给新成员（含角色）
  announceMember(member) {
    this.broadcast({ t: 'member_join', member });
  }

  // ==================== 0 服务器手动贴码（星形链接）====================
  // 无信令服务器：房主(hub)作为星形中心，全员只与房主建立一条 DataChannel。
  // 手动流程：房主生成邀请码(offer) -> 成员贴入生成应答码(answer) -> 房主确认建连。
  // 数据面：成员消息只发房主；房主消费后把 pos/shoot 转发给其他成员（星形转发）。

  // 等待本地 ICE 候选收集完成：保证随邀请码/应答码下发的 SDP 候选完整。
  // 只在收集真正 complete 后放行；兜底时限放宽到 6s（正常局域网 host 候选在
  // setLocalDescription 后数百 ms 内即 complete，一般不会触发兜底），
  // 修复此前 1.5s 硬截断导致“首次生成的邀请码候选不全、刷新后才可用”。
  // 有效条件：收集状态 complete 且至少收到 1 条候选 —— 只有“状态 complete”不够，
  // 候选为空时邀请码/应答码里的 SDP 缺连接信息，对端表现为“能解析但连不上/前几次失效”。
  // 上限 6s 兜底，失败返回 false 交由调用方重试。
  _iceComplete(pc, cands) {
    return new Promise(resolve => {
      const t0 = Date.now();
      const check = () => (pc.iceGatheringState === 'complete' && cands && cands.length > 0);
      if (check()) return resolve(true);
      let done = false;
      const finish = ok => { if (!done) { done = true; clearInterval(iv); resolve(ok); } };
      const iv = setInterval(() => {
        if (check()) finish(true);
        else if (Date.now() - t0 > 6000) finish(false);
      }, 150);
      pc.onicegatheringstatechange = () => { if (check()) finish(true); };
    });
  }

  // 手动房主建房：初始化自身为 hub，并生成第一个邀请码
  async manualCreateRoom(name, roleId) {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } this.ws = null; }
    this.token = 'manual';
    this.myId = this.genId();
    this.selfName = name || 'host';
    this.selfRole = roleId || 'hero';
    this.manual = 'hub';
    this.isHost = true;
    this.isMulti = true;
    this.members = [{ id: this.myId, name: this.selfName, roleId: this.selfRole, isHost: true }];
    const res = await this._hubMakeOffer();
    return res.payload;
  }

  // 手动房主：为下一位成员生成新邀请码（旧邀请未使用时作废，防 pc 泄漏）
  async manualNextInvite() {
    if (this.manual !== 'hub') return null;
    while (this._hubOffers.length > 5) {
      const old = this._hubOffers.shift();
      if (!old.memberId) { try { old.pc.close(); } catch (e) { /* ignore */ } }
    }
    const res = await this._hubMakeOffer();
    return res.payload;
  }

  // 房主端生成 offer（邀请码）：返回 {key,pc,dc,payload}
  async _hubMakeOffer() {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
    const pc = new RTCPeerConnection({ iceServers: GAME_CONFIG.ICE_SERVERS });
    const dc = pc.createDataChannel('battle');
    const cands = [];
    pc.onicecandidate = e => { if (e.candidate) cands.push(e.candidate.toJSON()); };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if ((st === 'failed' || st === 'closed') && this.manual === 'hub') {
        const of = this._hubOffers.find(o => o.pc === pc);
        if (of && of.memberId) this._hubMemberLeft(of.memberId);
      }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const ok = await this._iceComplete(pc, cands);
      if (!ok) throw new Error('候选收集为空');
      const key = 'k' + (++this._offerSeq);
      this._hubOffers.push({ key, pc, dc, memberId: null, name: '', roleId: '' });
      return {
        key, pc, dc,
        payload: {
          v: 1,
          hub: { id: this.myId, name: this.selfName, roleId: this.selfRole },
          key,
          sd: pc.localDescription,
          cands: cands.slice(0, inviteCandsMax())   // 只带走配置条数候选（runtime.json.INVITE_CANDS_MAX）：压缩邀请码长度，降低粘贴/传输截断风险
        }
      };
    } catch (e) {
      lastErr = e;
      try { pc.close(); } catch (err) { /* ignore */ }
      await new Promise(r => setTimeout(r, 250));
    }
  }
  throw new Error('本机网络候选收集失败（' + ((lastErr && lastErr.message) || '未知原因') + '），请检查网络后重试');
}

  // 手动成员加入：解析邀请 -> 生成应答码（answer），返回应答对象交给 UI 展示
  async manualJoin(invObj, name, roleId) {
    if (!invObj || !invObj.hub || !invObj.sd || !invObj.key) throw new Error('邀请码内容不完整');
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } this.ws = null; }
    this.token = 'manual';
    this.myId = this.genId();
    this.selfName = name || 'member';
    this.selfRole = roleId || 'hero';
    this.manual = 'member';
    this._hubInfo = invObj.hub;
    this.isHost = false;
    this.isMulti = true;
    this.members = [];          // 成员名单由房主 members 广播同步
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const pc = new RTCPeerConnection({ iceServers: GAME_CONFIG.ICE_SERVERS });
      const cands = [];
      let live = false;
      pc.onicecandidate = e => { if (e.candidate) cands.push(e.candidate.toJSON()); };
      pc.onconnectionstatechange = () => {
        if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && this._hubInfo) {
          this.removePeer(this._hubInfo.id);
        }
      };
      pc.ondatachannel = e => {
        if (!live) return;      // 已被重试废弃的 pc：不再登记
        this.peers.set(invObj.hub.id, { pc, dc: e.channel, connected: false });
        this._wireMemberDc(invObj.hub.id, e.channel);
      };
      try {
        await pc.setRemoteDescription(invObj.sd);
      } catch (e) {
        throw new Error('邀请码 SDP 无法解析');
      }
      // 显式补加房主随邀请码下发的 ICE 候选：即使房主 SDP 快照因收集未完成而不全，
      // 成员端也能通过候选清单补齐，避免“首次生成的邀请码连不上”必须刷新才能用
      for (const c of (invObj.cands || [])) {
        try { await pc.addIceCandidate(c); } catch (e) { /* ignore */ }
      }
      try {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        const ok = await this._iceComplete(pc, cands);
        if (!ok) throw new Error('候选收集为空');
        live = true;
        return {
          v: 1,
          key: invObj.key,
          member: { id: this.myId, name: this.selfName, roleId: this.selfRole },
          sd: pc.localDescription,
          cands: cands.slice(0, inviteCandsMax())
        };
      } catch (e) {
        lastErr = e;
      }
      try { pc.close(); } catch (e) { /* ignore */ }
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('生成应答码失败（' + ((lastErr && lastErr.message) || '未知原因') + '），请重试');
  }

  // 手动房主确认应答：登记成员、同步全员；返回裁决后的成员信息
  async manualAccept(ansObj) {
    if (!ansObj || this.manual !== 'hub') throw new Error('仅房主可确认应答码');
    const of = this._hubOffers.find(o => o.key === ansObj.key);
    if (!of) throw new Error('邀请已失效或不匹配（房主刷新过邀请码，或对方用的是更早的邀请码），请让房主点“刷新邀请码”后重新发给对方');
    if (of.memberId) throw new Error('该邀请码已被使用，请刷新邀请码');
    const mId = (ansObj.member && ansObj.member.id) || '';
    if (!mId) throw new Error('应答码缺少成员标识');
    if (this.members.some(m => m.id === mId)) throw new Error('该成员已在房间中');
    // 手动房沿用房间人数上限（ROOM_MAX 默认 8，与服务器房一致）
    const roomMax = (typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG.ROOM_MAX) || 8;
    if (this.members.length >= roomMax) throw new Error('房间已满（上限 ' + roomMax + ' 人），请让新成员刷新后等待空位');
    const hostMe = this.members.find(m => m.id === this.myId) || { roleId: this.selfRole };
    const hostIsBoss = hostMe.roleId === 'demon_lord';
    const wantBoss = ansObj.member.roleId === 'demon_lord';
    const role = (wantBoss && !hostIsBoss) ? 'demon_lord' : 'hero';  // Boss 冲突时降级为勇者
    of.memberId = mId;
    of.name = ansObj.member.name || mId;
    of.roleId = role;
    const pc = of.pc;
    try {
      await pc.setRemoteDescription(ansObj.sd);
    } catch (e) {
      of.memberId = null;
      throw new Error('应答码 SDP 无法解析');
    }
    for (const c of (ansObj.cands || [])) { try { pc.addIceCandidate(c); } catch (e) { /* ignore */ } }
    this.peers.set(mId, { pc, dc: of.dc, connected: false });
    this._wireHubDc(mId, of.dc);
    this.members = this.members.concat([{ id: mId, name: of.name, roleId: role, isHost: false }]);
    if (this.onMembers) this.onMembers(this.members);
    this._broadcastMembers();
    return { id: mId, name: of.name, roleId: role };
  }

  // 手动成员端：房主广播全量名单（含裁决角色）的本地登记（供 main 直接使用）
  _broadcastMembers() {
    const list = this.members.map(m => ({ id: m.id, name: m.name, roleId: m.roleId }));
    this.broadcast({ t: 'members', members: list });
  }

  _wireHubDc(memberId, dc) {
    const entry = this.peers.get(memberId);
    if (entry) entry.dc = dc;
    dc.onopen = () => {
      if (entry) entry.connected = true;
      if (this.onPeer) this.onPeer(memberId, true);
      // accept 时 dc 尚未 open，早期广播会被丢弃；channel 真正可用后补发全量名单，
      // 新成员据此按裁决角色开局，老成员幂等同步
      this._broadcastMembers();
    };
    dc.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      this._hubOnMessage(memberId, m);
    };
    dc.onclose = () => this._hubMemberLeft(memberId);
  }

  // 手动星形转发核心：房主消费成员消息后，把高频表现消息转发给其他成员
  _hubOnMessage(fromId, m) {
    if (this.onData) this.onData(fromId, m);
    if (!m || typeof m !== 'object') return;
    const t = m.t;
    if (t === 'pos' || t === 'shoot') {
      const s = JSON.stringify(m);
      this.peers.forEach((e, id) => {
        if (id === fromId) return;
        if (e.dc && e.dc.readyState === 'open') e.dc.send(s);
      });
    }
  }

  // 手动房主：成员断开清理（offer 槽重置、成员列表同步全员）
  _hubMemberLeft(memberId) {
    if (this.manual !== 'hub' || !memberId) return;
    this.peers.delete(memberId);
    const before = this.members.length;
    this.members = this.members.filter(x => x.id !== memberId);
    if (this.members.length !== before) {
      if (this.onPeer) this.onPeer(memberId, false);
      if (this.onMembers) this.onMembers(this.members);
      this._broadcastMembers();
    }
    const of = this._hubOffers.find(o => o.memberId === memberId);
    if (of) { of.memberId = null; of.name = ''; of.roleId = ''; }
  }

  _wireMemberDc(hubId, dc) {
    const entry = this.peers.get(hubId);
    if (entry) entry.dc = dc;
    dc.onopen = () => {
      if (entry) entry.connected = true;
      if (this.onPeer) this.onPeer(hubId, true);
    };
    dc.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (this.onData) this.onData(hubId, m);
    };
    dc.onclose = () => {
      if (this.onPeer) this.onPeer(hubId, false);
    };
  }
}
