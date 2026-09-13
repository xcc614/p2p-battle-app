# P2P 弹幕对战 · 安卓 APP 打包工程（p2p-battle-app）

> 本工程只负责「把网页版游戏装进安卓 APP」，不维护游戏逻辑。
> 游戏本体仍然在 `C:\Workspace\Marvis\p2p-battle` 维护，前端改完后用 `sync.ps1` 同步到本工程的 `www\`。
> **本地不安装 JDK / Android SDK / Gradle**，APK 全部由 GitHub Actions 云端构建。

---

## 一、成品形态与工作原理

1. APP 内置 **Java 实现的服务器**（NanoHTTPD + NanoWSD，见 `android-overlay\SignalServer.java`），单端口 `8080` 同时提供：
   - **静态站点托管**：读取 APK 内的 `assets\www`（游戏页面 + landing 首页）；
   - **信令服务**：`POST /create`（建房/加入）、`WebSocket /ws`（信令转发）、`GET /api/info`、`GET /health`。
2. 手机开启热点后，这台手机就是局域网临时服务器（服务监听 `0.0.0.0:8080`）。
3. APP 打开后进的是**APP 首页（landing 页）**：显示局域网访问地址 + 二维码 + 「进入游戏」按钮。
   WebView 实际加载的是 `http://127.0.0.1:<端口>/landing/index.html?lan=<热点IP:端口>`（回环地址最稳，同端口同源）。
4. 其他手机连到**同一个热点**，扫二维码（或手输 `http://<热点IP>:8080/`）用浏览器打开即可游玩，**不需要装 APP**。
5. 服务端**不做人数控制**，人数由前端软限制 8 人。

流程：

```
p2p-battle（游戏本体） --sync.ps1--> p2p-battle-app\www --> git push --> GitHub Actions 云构建 --> app-debug.apk --> 手机安装
```

---

## 二、目录结构

```
p2p-battle-app\
├─ README.md                        ← 本文件（整体流程说明）
├─ sync.ps1                         ← 本地同步脚本：p2p-battle → www（唯一需要本地执行的脚本）
├─ www\                             ← ★同步产物，云构建的实际 webDir（会被 sync.ps1 整体覆盖，禁止手改）
│  ├─ index.html  style.css  feed.css
│  ├─ src\      （游戏运行时 JS，19 个文件）
│  ├─ config\   （游戏配置 JSON，14 个文件）
│  ├─ lib\      （pixi.min.js）
│  ├─ assets\   （素材说明等）
│  └─ landing\  （APP 首页发布副本：index.html + landing.js + qrcode.js）
├─ landing\                         ← APP 首页源码（二维码页 / 进入游戏），由 sync.ps1 发布到 www\landing
├─ android-overlay\                 ← 安卓原生侧源码（构建时注入 Capacitor 工程）
│  ├─ SignalServer.java             （内置信令 + 静态托管服务）
│  ├─ LanAddress.java               （局域网地址探测，热点优先级最高）
│  ├─ ServerService.java            （前台 Service，保活 + 常驻通知）
│  ├─ MainActivity.java             （壳 Activity，覆盖 Capacitor 模板）
│  ├─ manifest-fragment.xml         （权限 + Service 声明片段）
│  └─ README.md                     （原生侧细节说明）
├─ build\                           ← Capacitor 壳工程 = 云端构建的根目录
│  ├─ package.json                  （@capacitor/core、cli、android）
│  ├─ capacitor.config.json         （appId=com.marvis.p2pbattle、webDir=../www）
│  └─ inject.ps1                    （注入原生代码 / Manifest / 依赖 / 目录对齐）
└─ .github\workflows\build-apk.yml  ← 云构建流水线（不需要本地任何编译环境）
```

各目录职责一览：

| 目录 / 文件 | 是否人工维护 | 说明 |
|---|---|---|
| `www\` | **否（生成物）** | 由 `sync.ps1` 从 `p2p-battle` 同步 + 打补丁生成，手改会被下次同步覆盖 |
| `landing\` | 是（源码） | APP 首页源码，改这里，再由 `sync.ps1` 发布进 `www\landing` |
| `android-overlay\` | 是（源码） | 安卓原生侧 Java / Manifest 片段 |
| `build\` | 是（源码） | Capacitor 配置与注入脚本；`build\android`、`build\node_modules` 属于本地生成物，不要上传 |
| `.github\workflows\` | 是（源码） | 云构建流水线，**必须上传**，否则没有 Actions 可跑 |
| `sync.ps1` | 是（源码） | 本地同步脚本 |

---

## 三、本地唯一要做的事：同步前端到 www

前端改动一律在 `C:\Workspace\Marvis\p2p-battle` 里做，做完执行：

```powershell
cd C:\Workspace\Marvis\p2p-battle-app
powershell -ExecutionPolicy Bypass -File .\sync.ps1
```

`sync.ps1` 只依赖系统自带的 PowerShell（**不需要 Node / JDK / Android SDK**），它做 4 件事：

1. **镜像同步**：`p2p-battle` → `www`，并清理 `www` 里的残留文件（保证 `www` 与游戏本体一致）；
2. **发布 landing**：`landing\` → `www\landing\`；
3. **重打适配补丁**（幂等，只改 `www`，不动游戏本体）：
   - `www\src\net.js`：信令基址优先取 `location.origin`（手机浏览器同源直连本机服务）；
   - `www\config\runtime.json`：`SIGNAL_BASE` 降级为兜底地址；
   - `www\index.html`：「本地局域网」勾选默认取消（默认走令牌服务器在线房间）；
4. **校验并打印统计**（补丁是否生效、同步文件数）。

常用参数：

| 参数 | 作用 |
|---|---|
| `-NoMirror` | 只复制、不删除 `www` 中的残留文件 |
| `-DryRun` | 预演，只打印不落盘 |
| `-SkipPatch` / `-SkipLanding` | 跳过补丁 / 跳过 landing 发布 |
| `-Source` / `-AppRoot` / `-Dest` | 自定义游戏本体目录 / 工程根 / 目标目录 |
| `-Port` | 目标端口（默认 8080，与 APP 内置服务一致，一般不用改） |

同步时会被排除、不进入 `www` 的内容：`server_local.py`、游戏本体的 `README.md`、`config-editor.*`、`tools\`、`docs\`、`config\_backup\`、隐藏文件、`~` 结尾的临时文件。

> 注意：`www\` 是**构建输入**而非常规源码目录，请勿直接编辑；改了也会在下次 `sync.ps1` 时被覆盖。

---

## 四、上传到 GitHub

### 4.1 必须先有的内容（云构建会逐个校验，缺一个就失败）

| 相对路径 | 说明 |
|---|---|
| `www\index.html`、`www\landing\index.html` | 静态资源必须已同步（先跑 `sync.ps1`） |
| `android-overlay\SignalServer.java`、`LanAddress.java`、`ServerService.java`、`MainActivity.java`、`manifest-fragment.xml` | 原生侧源码 |
| `build\package.json`、`build\capacitor.config.json`、`build\inject.ps1` | Capacitor 工程与注入脚本 |
| `.github\workflows\build-apk.yml` | 流水线本体（漏传则 Actions 里空空如也） |
| `sync.ps1`、`landing\`、`README.md` | 同步脚本、首页源码、本文档 |

### 4.2 不需要上传的内容

| 内容 | 原因 |
|---|---|
| `build\node_modules\` | 云端 `npm ci` 自行安装（本地本就不需要装 Node 环境） |
| `build\android\` | 云端 `npx cap add android` 自动生成（Gradle 工程，体积大） |
| `build\package-lock.json`（当前不存在） | 可选：上传可获得确定性安装；不上传时流水线会自动生成后再 `npm ci`，不影响构建 |
| 任何 `*.apk` / 构建产物 / 日志 / 中间文件 | 无需入库 |
| `.gitignore`（当前不存在） | 如需可后续自行添加；不影响构建 |

> 本工程当前总大小约 2 MB（`www` 里 `pixi.min.js` 占大头），远低于 GitHub 单文件 100 MB 限制，可放心整包上传。

### 4.3 三种上传方式（任选其一）

**方式 A：GitHub 网页上传（零工具，最省事）**

1. GitHub 新建仓库（例如 `p2p-battle-app`），**不要**勾选 "Add a README file"（避免冲突）；
2. 进入仓库 → `Add file` → `Upload files`；
3. 打开 `C:\Workspace\Marvis\p2p-battle-app`，把 `.github`、`android-overlay`、`build`、`landing`、`www`、`sync.ps1`、`README.md` 一起拖入上传区（文件夹拖拽会保留目录结构）；
4. 底部 `Commit changes`。
   - 提示：系统默认可能隐藏以 `.` 开头的文件夹，需先在资源管理器里开启「显示隐藏的项目」，确认 `.github` 已被选中，否则不会触发云构建。

**方式 B：本机 Git 命令行（需要在本地装 Git，不需要 JDK/SDK）**

```powershell
cd C:\Workspace\Marvis\p2p-battle-app
git init
git add .
git commit -m "init: p2p-battle-app（内置信令服务 + 云构建）"
git branch -M main
git remote add origin https://github.com/<你的用户名>/p2p-battle-app.git
git push -u origin main
```

- 若本目录**已经是**一个 Git 仓库，跳过 `git init`，只执行 `git add . / commit / remote add / push` 即可；
- 推送时 GitHub 不再接受账号密码，请使用 **Personal Access Token**（在 GitHub `Settings → Developer settings → Personal access tokens` 生成，勾选 `repo` 权限）作为密码，或改用 GitHub Desktop / 网页上传。

**方式 C：GitHub Desktop**：`Add local repository` 选择本目录 → `Publish repository`（或 `Push origin`）。

---

## 五、触发云构建并下载 APK

1. **触发方式**（`build-apk.yml` 已配置两者）：
   - **自动**：向仓库任一分支 `push`（网页上传提交也算一次 push）；
   - **手动**：仓库页 `Actions` → 左侧 `build-apk` → `Run workflow` 选择分支执行。
2. **看进度**：`Actions` → 点进本次运行记录，可看到逐步日志：
   `checkout → 前置检查 → 固定预装 JDK 17 / Android SDK → 安装 Node 20 → build/ 安装依赖（npm ci）→ npx cap add android + cap sync → inject.ps1 注入原生代码 → ./gradlew assembleDebug → 校验 APK → 上传产物`。
   - 单次约 **5～10 分钟**（视依赖下载速度），超时上限 40 分钟；同一分支的新构建会**自动取消**上一次未完成的构建。
   - 首次运行会打印一条 warning「缺少 `build\package-lock.json`，先生成锁文件」，属正常现象，无需处理。
3. **下载 APK**：运行记录页面底部 **Artifacts** → `p2p-battle-app-debug-apk` → 下载得到 zip，解压后即 `app-debug.apk`。
   - 页面上方 `Summary` 会显示该次 APK 的**大小、SHA256、ABI**；
   - Artifacts **保留 30 天**，过期后重新跑一次构建即可；
   - 下载需登录 GitHub（私有仓库需有权限的账号）。
4. **产物说明**：`assembleDebug` 的 **debug 签名**包，单 ABI 瘦身（**仅 arm64-v8a**），可直接侧载安装测试（非上架包）。

---

## 六、安装到手机

1. **传到手机**：数据线拷贝 / 微信「文件传输助手」/ 网盘均可，然后在手机上点击 `app-debug.apk` 安装。
2. **允许未知来源安装**：Android 8.0+ 是按「来源应用」授权——安装时按提示进入
   `设置 → 应用 → 特殊应用权限 → 安装未知应用`，为当前来源（文件管理器 / 浏览器 / 微信）打开开关；
   部分机型（华为、小米、OPPO、vivo 等）还会弹「未经安全检测 / 纯净模式」，选择「继续安装 / 允许本次安装」即可。
3. **机型要求**：单 ABI `arm64-v8a`，**仅 64 位 ARM 机型**可安装（2016 年后的主流机型基本都满足）；系统建议 Android 8.0 及以上（最低支持到 Android 5.1 / minSdk 22）。
4. **首次打开**：Android 13+ 会询问通知权限，**建议允许**（前台服务常驻通知用于保活；拒绝也能用，只是通知不可见）。
   随后顶部遮罩显示「服务已就绪 + 局域网地址」，自动进入 **APP 首页**（地址 + 二维码 + 「进入游戏」）。
5. **开热点**：`设置 → 个人热点 / 便携式热点` 打开（密码自定），并尽量保持热点不被系统自动关闭。
6. **其他手机加入**：连接该热点 Wi-Fi（Android 若提示「无法访问互联网，是否保持连接」，选**保持连接**，否则会悄悄切回移动数据）→
   扫 APP 首页二维码（或手输 `http://<热点IP>:8080/`，常见为 `http://192.168.43.1:8080/`）→ 浏览器打开即进入游戏。
   iPhone 同样可用：连上热点后用 Safari 扫码打开。
7. **开打**：首页选「**令牌服务器在线房间**」建房，其他手机贴房间码加入；服务端不限人数，前端 8 人软限制。
8. **保持 APP 存活**：APP 可切后台（前台服务保活），但**不要点通知里的「停止服务」**（会断开所有玩家）。
9. 若首页提示「当前显示的是本机回环地址（127.0.0.1）」，说明没取到热点网段 IP：先确认热点已开，重开 APP；
   仍不行就用页面下方「手动指定局域网地址」填写 `192.168.43.1:8080` 之类的地址再生成二维码。

---

## 七、常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| Actions 报 `仓库缺少必要文件: xxx` | 上传漏了文件（最常见是 `.github` 未传，或 `www` 还没同步就上传） | 按 §4.1 补齐后重新 push / 上传 |
| 日志 warning：缺少 `build/package-lock.json` | 首次运行的正常提示 | 无需处理；想要确定性安装与缓存，可在本地 `build\` 执行 `npm install` 生成锁文件后提交（可选） |
| 构建因网络超时 / npm、Gradle 下载失败 | 云端网络抖动 | 在 Actions 页 `Re-run failed jobs` 重跑；同分支并发会自动取消旧构建，不会互相排队 |
| Artifacts 里没有产物 | 未登录 GitHub / 私有仓库无权限 / 超过 30 天被清理 | 用有权限的账号登录后查看，或重新触发一次构建 |
| 手机提示「解析包错误 / 无法打开文件」 | APK 在传输或解压过程中损坏（多为传输中断） | 重新下载完整 zip，解压后再传一次 |
| 安装提示「应用未安装 / 签名冲突」 | 之前装过同包名但签名不同的版本（每次云构建的 debug 签名可能不同） | 先卸载旧版本再安装 |
| 安装提示「不支持的设备 / 无法安装」 | 手机不是 arm64-v8a（老款 32 位机型或模拟器） | 换 64 位真机测试 |
| APP 一直停在遮罩「正在启动服务…」 | 8080 端口被同机其他应用占用，或系统限制后台服务 | 重启 APP；仍不行重启手机后再试 |
| 首页显示 127.0.0.1、二维码提示仅本机可访问 | 未开热点 / 未取到局域网网段 IP | 先开热点再打开 APP；或用页内「手动指定局域网地址」生成二维码 |
| 其他手机扫码打不开、一直转圈 | 未连热点；或连上后被系统切回移动数据；或热点开了客户端隔离；或地址写成了 `https://` | 选「保持连接」；确认与服务器手机在同一热点；用 `http://<热点IP>:8080/` 重试 |
| 页面能打开但建房/加入失败 | 游戏首页没选「令牌服务器在线房间」（勾了「本地局域网」会走 0 服务器直连） | 选「令牌服务器在线房间」后重新建房 |
| 对局中偶发掉线 | APP 被系统省电策略清理，前台服务被杀 | 把本 APP 的电池策略设为「不受限制 / 允许后台活动」，并保持 APP 不被手动清掉 |
| 改了前端但 APP 里没变化 | 忘了跑 `sync.ps1`、忘了 push，或装的是旧 APK | 跑 `sync.ps1` → push → 等新构建完成 → 重装新 APK |
| 游戏页面样式/资源 404 | `www` 同步不完整（用了 `-SkipPatch` 等参数，或游戏本体有新增目录未同步） | 不带参数完整跑一次 `sync.ps1`，再 push |

---

## 八、日常改动流程与约束

- **改游戏逻辑 / 前端**：在 `C:\Workspace\Marvis\p2p-battle` 改 → 跑 `sync.ps1` → `git push` → 等云构建 → 重装 APK。
- **改 APP 首页（二维码页）**：改 `landing\`（源码）→ 跑 `sync.ps1`（会自动发布到 `www\landing`）→ push。
- **改 APP 名称 / 包名**：改 `build\capacitor.config.json` 的 `appName` / `appId`（`appId` 改为新值后，`inject.ps1` 会自动完成所有占位符替换）。
- **不要手改** `www\`（生成物）与 `.github\workflows\build-apk.yml` 里的产物名（客户端下载地址依赖它）。
- 本工程**不引入**本地编译环境：不需要 Node、JDK、Android SDK，也不需要 Android Studio。

---

## 九、相关文档

| 文档 | 内容 |
|---|---|
| [android-overlay\README.md](<C:\Workspace\Marvis\p2p-battle-app\android-overlay\README.md>) | 原生侧源码职责、注入规则、协议对照、实现踩坑、构建后自测清单 |
| [.github\workflows\build-apk.yml](<C:\Workspace\Marvis\p2p-battle-app\.github\workflows\build-apk.yml>) | 云构建流水线（可直接阅读注释了解每一步） |
| `C:\Workspace\Marvis\p2p-battle` | 游戏本体工程（前端源码与 `server_local.py` 参考实现） |
