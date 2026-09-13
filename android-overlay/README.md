# android-overlay — 安卓原生侧注入包

本目录是「P2P 弹幕对战」打包安卓 APP 所需的**全部原生侧源码**。构建脚本（GitHub Actions 内执行）
在 `npx cap add android && npx cap sync android` 生成 Gradle 工程后，把这里的文件注入进去，再 `assembleDebug` 出包。

本地无需 JDK / Android SDK，所有编译都在云端完成。

---

## 一、文件清单与职责

| 文件 | 职责 | 注入目标 |
|---|---|---|
| `SignalServer.java` | 内置信令服务：单端口同时托管 `assets/www` 静态站点 + `POST /create` + `GET /api/info` + `GET /health` + `WebSocket /ws` | `app/src/main/java/__PKG_PATH__/signal/SignalServer.java` |
| `LanAddress.java` | 局域网地址工具类：枚举网卡，按「热点 > Wi-Fi/以太网 > 其他」排序取 IPv4 | `app/src/main/java/__PKG_PATH__/signal/LanAddress.java` |
| `ServerService.java` | 前台 Service：启动并保活信令服务、常驻通知显示局域网地址、向 Activity 提供绑定查询 | `app/src/main/java/__PKG_PATH__/signal/ServerService.java` |
| `MainActivity.java` | 壳 Activity：拉起服务 → 轮询就绪 → WebView 打开 `http://127.0.0.1:<port>/landing/index.html?lan=<热点IP:端口>`（APP 首页：局域网地址 + 二维码 + 进入游戏），并屏显局域网地址 | **覆盖** `app/src/main/java/__PKG_PATH__/MainActivity.java` |
| `manifest-fragment.xml` | 权限 + Service 声明片段（非独立 manifest） | 合并进 `app/src/main/AndroidManifest.xml` |

`__PKG_PATH__` = appId 的点号换成斜杠，例如 appId `com.marvis.p2pbattle` → `com/marvis/p2pbattle`。

---

## 二、占位符替换（脚本必须做，否则编译不过）

| 占位符 | 替换值 | 出现位置 |
|---|---|---|
| `__APP_PKG__` | Capacitor `appId`（同时是 Gradle `namespace` / `applicationId`），如 `com.marvis.p2pbattle` | 4 个 `.java` 的 `package` / `import` 行 |
| `__APP_ID__` | 同 `appId` | `manifest-fragment.xml` 注释 |

> 说明：Java 代码内部**没有**任何依赖 appId 的字符串常量（通知 action 用的是与包名无关的固定串），
> 因此换 appId 只需做上述纯文本替换即可。

### 依赖注入（`app/build.gradle`）

```gradle
dependencies {
    implementation "org.nanohttpd:nanohttpd:2.3.1"
    implementation "org.nanohttpd:nanohttpd-websocket:2.3.1"
    // ... Capacitor 模板原有依赖保持不变
}

android {
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    packagingOptions {
        // NanoHTTPD 自带 META-INF 资源，避免打包冲突导致合并失败
        resources {
            excludes += ['META-INF/NOTICE', 'META-INF/LICENSE', 'META-INF/DEPENDENCIES']
        }
    }
}
```

版本要求：`compileSdk = 34`、`minSdk >= 22`（代码里所有 23/26/29/33/34 的新 API 都有 `SDK_INT` 分支保护）。

---

## 三、Manifest 注入（4 处）

1. **权限**：把 `manifest-fragment.xml` 里的 7 条 `<uses-permission>` 插到 `<application>` 之前。
2. **application 属性**：给 `<application>` 追加
   `android:usesCleartextTraffic="true"`、`android:networkSecurityConfig="@xml/network_security_config"`、`android:hardwareAccelerated="true"`。
   （局域网是纯 HTTP/WS，Android 9+ 默认禁明文，必须放行。）
3. **Service 节点**：把 `<service android:name=".signal.ServerService" ...>` 整段（含 `foregroundServiceType="specialUse"` 与
   `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`）插进 `<application>` 内。
4. **MainActivity**：沿用 Capacitor 模板原声明（launcher intent-filter 不动），Java 实现由 overlay 覆盖。

另需生成 `app/src/main/res/xml/network_security_config.xml`（内容见 `manifest-fragment.xml` 尾部注释）。

---

## 四、静态资源落点

`npx cap sync android` 会把 `capacitor.config.json` 里 `webDir` 指定的目录拷到
`app/src/main/assets/public/`。本服务读取的根目录是 **`assets/www`**，所以二者必须对齐，三种做法任选其一：

- 方案 A（推荐）：`capacitor.config.json` 中 `webDir` 指向同步产出目录，并在 `cap sync` 后把 `assets/public` 重命名为 `assets/www`；
- 方案 B：把 `capacitor.config.json` 的 `webDir` 设为 `p2p-battle/www`（已同步好补丁的目录），sync 后同样重命名 `public` → `www`；
- 方案 C：不改目录名，改本文件 `ASSETS_ROOT` 常量为 `"public"`（改一处即可，`SignalServer.java` 顶部常量）。

服务请求 `GET /` → `assets/www/index.html`，`GET /landing` → `assets/www/landing/index.html`，其余按相对路径直取。

---

## 五、协议对照（`SignalServer.java` ↔ `p2p-battle/server_local.py`）

| 项 | 约定 |
|---|---|
| 端口 | 8080（`SignalServer.DEFAULT_PORT`；前端 `config/runtime.json` 的 `SIGNAL_BASE` 已降级为 `http://127.0.0.1:8080`） |
| 监听 | `0.0.0.0`（NanoHTTPD 默认全网卡），手机开热点后其他设备可直连 |
| `POST /create` | body `{type:"single"|"multi", token?}` → `{ok:true, token, myId, members:[]}`；自定义 token 限 1–16 位 `[A-Za-z0-9_-]`，占用返回 **409** |
| 自动房间码 | `"R"` + 5 位，字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` |
| `GET /api/info`（别名 `/lan-info.json`） | `{ok, port, ip, httpBase, wsBase, base, lanIps[], rooms, clients}`，供 landing 页 `resolveBase()` 探测 |
| `GET /health` | `{ok:true}` 存活探针 |
| WS 入口 | `ws://<host>:8080/ws?token=&myId=&type=&name=&roleId=`（`type` 仅首次连接生效） |
| 下行 | `joined{myId,roleId,members[]}`、`members{members[]}`、`signal{from,payload}`、`relay{from,payload}`、`member_leave{myId}` |
| 上行 | `action=signal{to,payload}` / `relay{payload}` / `role{roleId}` / `leave{}` |
| 房间表 | `token -> {type, createdAt, conns(myId->ws)}`，**LinkedHashMap 保序（房主首位）**，`ROOM_TTL_MS = 24h` 且每分钟回收 |
| 同 myId | 新连接踢掉旧连接（旧连接收到 1008 PolicyViolation 关闭帧） |
| Boss 唯一 | 请求 `demon_lord` 而房内已有 Boss → 服务端降级为 `archer` |
| `type=member` 且房间不存在 | HTTP **404**（`{"ok":false,...}`），对齐 Python 版 |
| **人数上限** | **不校验**（`MAX_MEMBERS` / `room full` / 403 逻辑已整体移除，人数由前端 8 人软限制） |

### 与 Python 版的行为差异（有意为之）

1. Python 版 `MAX_MEMBERS = 5`（single 房 2）——新版按需求**取消服务端人数控制**，仅前端软限 8 人。
2. Python 版满员关闭码 1008 / HTTP 403 —— 已移除。
3. WS 握手拒绝改为**在 `serve()` 阶段提前返回 400/404**：NanoWSD 对 `isWebsocketRequested()` 的请求会直接回 101，
   没有「拒绝握手」的扩展点，所以房间校验必须前置到 `serve()`；`openWebSocket()` 用 `ThreadLocal` 取回已校验的 token。

### 关键实现注意（踩坑记录）

- **必须 `start(0, true)`**：NanoHTTPD 默认 `SOCKET_READ_TIMEOUT=5000ms`，会给 WS socket 设 `SO_TIMEOUT`，
  静默 5 秒即被 `doClose` 断开（对局中很常见）。传 `0` 可跳过 `setSoTimeout`，彻底关闭空闲超时。
- **首帧无竞争**：NanoWSD 的握手响应子类在 `send()` 中先写 101、再置 `state=OPEN`、最后回调 `onOpen()`，
  因此 `onOpen()` 里直接下发 `joined` 是安全的。
- **MIME 不要依赖默认表**：NanoHTTPD 默认 MIME 来自 jar 内 properties 资源，Android 上不保证命中；
  `.js` 一旦回退为 `application/octet-stream`，浏览器会拒绝执行。本实现自带完整 MIME 表。
- **JSON 手写**：只引入 NanoHTTPD/NanoWSD，没有 `org.json`。下行帧用字符串拼接；
  上行 `signal`/`relay` 的 `payload` 用「顶层字段原始片段提取」直接透传（不解析、不丢失结构），
  取字段值用于路由的是内置的极简 JSON 扫描器（正确处理转义与嵌套括号）。

---

## 六、运行期行为

1. `MainActivity.onStart` → `ServerService.start()`（`startForegroundService`）→ 服务 `onStartCommand` **先** `startForeground` 再启动服务（满足 Android 8+ 5 秒规则）。
2. 服务在后台线程 `new SignalServer(ctx, 8080).startServer()`，失败自动重试 8 次（端口占用/网络未就绪）。
3. Activity 绑定服务并每 250ms 轮询，最多 8 秒；就绪后：
   - 屏显 `http://<热点IP>:8080/`（其他手机浏览器扫码/手输地址即可游玩）；
   - WebView 加载 `http://127.0.0.1:<port>/landing/index.html?lan=<热点IP:端口>`（`<port>` 取自服务实际上报端口，默认 8080）：
     回环地址最稳（不依赖热点是否允许本机访问自身 IP），同端口同源，前端 `fetch` 配置与 WebSocket 都走本机服务；
     `?lan=` 把真实局域网地址交给 landing 页生成扫码二维码，`onPageStarted` / `onPageFinished` 还会注入
     `window.__LAN_BASE__` / `window.__SIGNAL_BASE__` 作双保险；
   - 若 landing 页返回 404（资源未同步），自动回退加载 `http://127.0.0.1:<port>/`（游戏首页），避免白屏。
4. 服务 `START_STICKY` + `stopWithTask=false`，划掉任务栈后仍在；通知栏提供「停止服务」按钮。
5. 通知权限（Android 13+）被拒不影响功能，仅通知不可见。

### 前端配合要点（已在前一阶段完成）

- `src/net.js` 已注入 `resolveSignalBase()`，**优先 `location.origin`**：WebView 内页面 origin 即 `http://127.0.0.1:<port>`（默认 8080），
  扫码进入的成员页 origin 即 `http://<热点IP>:8080`，双方自动连到同一台手机的服务，无需手填地址。
- `config/runtime.json` 的 `SIGNAL_BASE` 已降级为 `http://127.0.0.1:8080`，仅作兜底。
- `www/landing/` 的扫码地址解析优先级：`?lan=` 查询参数（原生注入，最优先）→ `window.__LAN_BASE__` → 当前访问 origin → `/api/info`（或 `/lan-info.json`）探测；
  二维码内容为「解析出的地址 + `/index.html`」。
- `index.html` 的「本地局域网」勾选已去掉默认 `checked`：默认走**令牌服务器在线房间**（真正经过本服务）；
  勾选则走 0 服务器的贴码星形直连（不经过 WebSocket）。

---

## 七、构建后自测

1. 安装 APK，打开 APP → 顶部遮罩显示「服务已就绪 + 局域网地址」，随后进入 **APP 首页（landing 页：地址 + 二维码）**，点「进入游戏」再进游戏菜单页。
2. 用另一台手机连到同一热点，扫 APP 首页二维码（等价于访问 `http://<热点IP>:8080/index.html`），页面应正常加载（验证静态托管 + MIME）。
3. 首页选「令牌服务器在线房间」建房 → 第二台手机贴同一房间码加入 → 双方进入房间（验证 `/create` 与 `/ws`）。
4. 静置 30 秒以上不断线（验证 `start(0, true)` 生效）。
5. 房间内切角色为 Boss（demon_lord）两次 → 第二人应被降级为 `archer`。
6. 同一房间码用同一 myId 重连 → 旧连接被踢（1008）。
