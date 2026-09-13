/*
 * p2p-battle-app / android-overlay / MainActivity.java
 *
 * 壳 Activity（覆盖 Capacitor 模板生成的 MainActivity，继承 Capacitor 的 BridgeActivity）：
 *   1) onStart 拉起前台服务 ServerService（内置信令服务 + 静态托管）并绑定；
 *   2) 每 250ms 轮询服务就绪状态（最多约 10 秒），等待期间显示遮罩：状态 + 局域网地址 + 重试按钮；
 *   3) 服务就绪 → 取到局域网地址 → 把 WebView 指向
 *        http://127.0.0.1:<port>/landing/index.html?lan=<热点IP:端口>
 *      · WebView 自身走回环地址最稳（不依赖热点是否允许本机访问自身 IP），同端口同源，
 *        页面内的 fetch / WebSocket / 相对路径资源全部落到本机内置服务；
 *      · ?lan= 参数把真实局域网地址交给 landing 页，用于生成「其他手机扫码」的二维码；
 *   4) 每次页面开始加载 / 加载完成时注入 window.__LAN_BASE__ 与 window.__SIGNAL_BASE__（双保险，
 *      ?lan= 为确定性通道，注入为补充；两者格式与前端解析逻辑一致）。
 *
 * 与 Capacitor 的关系：
 *   - 继承 BridgeActivity 复用模板创建的 WebView（getBridge().getWebView()）；取不到时退回遍历视图树
 *     查找 WebView，再兜底自建一个，保证页面一定能展示；
 *   - WebViewClient 采用「包装 + 转发」：Capacitor 原客户端的回调照旧转发（shouldInterceptRequest /
 *     页面生命周期 / 错误回调），仅额外做两件事：
 *       ① 拦截「本机服务地址」，保证这类导航始终在 WebView 内加载（不被 Capacitor 当成外部链接丢给系统浏览器）；
 *       ② onPageStarted / onPageFinished 注入全局变量。
 *
 * 约定：本文件不依赖任何资源 id / layout 文件，UI 全部代码构建，避免与 Capacitor 生成的 res 冲突。
 * 注入说明：包名占位符 __APP_PKG__ 由构建脚本替换（详见 android-overlay/README.md）。
 */

package __APP_PKG__;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import __APP_PKG__.signal.ServerService;
import __APP_PKG__.signal.SignalServer;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "P2P.MainActivity";

    private static final int MATCH_PARENT = ViewGroup.LayoutParams.MATCH_PARENT;
    private static final int WRAP_CONTENT = ViewGroup.LayoutParams.WRAP_CONTENT;

    /** 等待信令服务就绪：每 250ms 轮询一次，最多 40 次（约 10 秒） */
    private static final long POLL_INTERVAL_MS = 250L;
    private static final int MAX_ATTEMPTS = 40;
    /** 页面加载超时兜底（只提示，不中断） */
    private static final long LOAD_TIMEOUT_MS = 12000L;

    private static final int REQ_POST_NOTIFICATIONS = 1001;

    /** 游戏首页（landing 页「进入游戏」按钮的落点）：相对路径 ../index.html */
    private static final String LANDING_PATH = "/landing/index.html";

    private final Handler handler = new Handler(Looper.getMainLooper());

    private LinearLayout overlay;
    private TextView statusView;
    private ProgressBar progressBar;
    private Button retryButton;

    private WebView webView;
    private boolean clientInstalled;

    private ServerService service;
    private boolean bound;

    private boolean loaded;        // 是否已向 WebView 下发目标 URL
    private boolean pageShown;     // 页面 onPageFinished 是否已触发
    private boolean fallbackDone;  // landing 页 404 时是否已回退到游戏首页
    private int attempts;

    private int port = SignalServer.DEFAULT_PORT;
    /** 扫码/手输用地址（不含协议），形如 192.168.43.1:8080 */
    private String lanHostPort = "127.0.0.1:" + SignalServer.DEFAULT_PORT;
    /** 页面内 WebView 实际使用的服务基址（环回） */
    private String signalBase = "http://127.0.0.1:" + SignalServer.DEFAULT_PORT;
    /** 本次加载的完整 URL */
    private String pageUrl;

    // ==================================================================
    // 生命周期
    // ==================================================================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 房主手机通常要长时间驻留页面，避免息屏
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        buildOverlay();
        requestNotificationPermission();
        // 便于 chrome://inspect 调试内置页面（仅调试用途，不影响功能）
        try {
            WebView.setWebContentsDebuggingEnabled(true);
        } catch (Throwable ignored) {
            // ignore
        }
    }

    // 注意：Capacitor 6 的 BridgeActivity 把 onStart/onStop/onDestroy 声明为 public，
    // 子类覆盖时权限只能放宽不能收紧，必须同样用 public，否则 javac 报
    // "attempting to assign weaker access privileges; was public"。
    @Override
    public void onStart() {
        super.onStart();
        // 先启动前台服务（常驻），再绑定查询状态
        ServerService.start(this, SignalServer.DEFAULT_PORT);
        try {
            bindService(new Intent(this, ServerService.class), connection, Context.BIND_AUTO_CREATE);
        } catch (Throwable t) {
            Log.w(TAG, "bindService failed: " + t);
        }
        startPolling();
    }

    @Override
    public void onStop() {
        super.onStop();
        handler.removeCallbacks(pollTask);
        handler.removeCallbacks(loadTimeoutTask);
        if (bound) {
            try {
                unbindService(connection);
            } catch (Throwable t) {
                Log.w(TAG, "unbindService failed: " + t);
            }
            bound = false;
        }
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(pollTask);
        handler.removeCallbacks(loadTimeoutTask);
        super.onDestroy();
    }

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            try {
                ServerService.LocalBinder local = (ServerService.LocalBinder) binder;
                service = local.getService();
                bound = true;
            } catch (Throwable t) {
                Log.w(TAG, "onServiceConnected cast failed: " + t);
                service = null;
            }
            startPolling();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            service = null;
            bound = false;
        }
    };

    // ==================================================================
    // 服务就绪 → 加载页面
    // ==================================================================

    private final Runnable pollTask = new Runnable() {
        @Override
        public void run() {
            if (isFinishing() || isDestroyed()) {
                return;
            }
            attempts++;
            if (loadPageIfReady()) {
                return;
            }
            if (attempts < MAX_ATTEMPTS) {
                handler.postDelayed(this, POLL_INTERVAL_MS);
            } else {
                showFailure();
            }
        }
    };

    private final Runnable loadTimeoutTask = new Runnable() {
        @Override
        public void run() {
            if (pageShown) {
                return;
            }
            Log.w(TAG, "page load timeout: " + pageUrl);
            showSlowHint();
        }
    };

    private void startPolling() {
        attempts = 0;
        handler.removeCallbacks(pollTask);
        if (loaded) {
            return; // 已加载过页面，不再重复轮询
        }
        ensureOverlayAttached();
        overlay.setVisibility(View.VISIBLE);
        handler.post(pollTask);
    }

    /** 服务就绪则加载页面；返回 true 表示本轮已处理（无论成功与否） */
    private boolean loadPageIfReady() {
        if (loaded) {
            return true;
        }
        if (service == null || !service.isReady()) {
            return false;
        }
        int reported = service.getPort();
        if (reported > 0 && reported < 65536) {
            port = reported;
        }
        String host = service.getPrimaryAddress();
        if (host == null || host.length() == 0) {
            host = "127.0.0.1"; // 无热点/局域网时降级：仅本机可用，页面会给出提示
        }
        lanHostPort = host + ":" + port;
        signalBase = "http://127.0.0.1:" + port;
        pageUrl = signalBase + LANDING_PATH + "?lan=" + Uri.encode(lanHostPort);

        Log.i(TAG, "signal server ready, page=" + pageUrl + " , lan=" + lanHostPort);
        statusView.setText("服务已就绪\n局域网地址（其他手机浏览器打开）：\nhttp://" + lanHostPort + "/");

        WebView view = ensureWebView();
        if (view == null) {
            showFailure();
            loaded = true;
            return true;
        }
        loaded = true;
        injectGlobals(view); // 先注入一次（新文档可能尚未建立，后续 onPageStarted/onPageFinished 再补）
        view.setVisibility(View.VISIBLE);
        view.loadUrl(pageUrl);
        view.requestFocus();
        handler.removeCallbacks(loadTimeoutTask);
        handler.postDelayed(loadTimeoutTask, LOAD_TIMEOUT_MS);
        return true;
    }

    // ==================================================================
    // WebView：复用 Capacitor 的 / 兜底自建
    // ==================================================================

    private WebView ensureWebView() {
        if (webView != null) {
            installClient(webView);
            return webView;
        }
        WebView found = findCapacitorWebView();
        if (found != null) {
            webView = found;
            applyWebSettings(webView);
            installClient(webView);
            return webView;
        }
        // 兜底：Capacitor 桥未暴露 WebView 时自建一个，仅作为页面容器，不影响桥自身
        try {
            WebView created = new WebView(this);
            created.setBackgroundColor(Color.BLACK);
            applyWebSettings(created);
            installClient(created);
            addContentView(created, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
            webView = created;
            Log.w(TAG, "capacitor webview not found, created fallback webview");
            return created;
        } catch (Throwable t) {
            Log.e(TAG, "create fallback webview failed: " + t);
            return null;
        }
    }

    private WebView findCapacitorWebView() {
        try {
            Bridge bridge = getBridge();
            if (bridge != null) {
                WebView view = bridge.getWebView();
                if (view != null) {
                    return view;
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "bridge.getWebView() unavailable: " + t);
        }
        try {
            return scanForWebView(findViewById(android.R.id.content));
        } catch (Throwable t) {
            Log.w(TAG, "scanForWebView failed: " + t);
            return null;
        }
    }

    private WebView scanForWebView(View root) {
        if (root == null) {
            return null;
        }
        if (root instanceof WebView) {
            return (WebView) root;
        }
        if (root instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) root;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView hit = scanForWebView(group.getChildAt(i));
                if (hit != null) {
                    return hit;
                }
            }
        }
        return null;
    }

    private void applyWebSettings(WebView view) {
        try {
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setUseWideViewPort(true);
            settings.setLoadWithOverviewMode(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
            if (Build.VERSION.SDK_INT >= 21) {
                settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            }
        } catch (Throwable t) {
            Log.w(TAG, "applyWebSettings failed: " + t);
        }
    }

    /** 安装「包装 + 转发」客户端：只在原客户端外再加一层，不改动 Capacitor 的行为 */
    private void installClient(WebView view) {
        if (view == null || clientInstalled) {
            return;
        }
        WebViewClient original = null;
        if (Build.VERSION.SDK_INT >= 26) {
            // WebView.getWebViewClient() 自 API 26 起可用；低版本拿不到原客户端（转发层为空实现）
            try {
                original = view.getWebViewClient();
            } catch (Throwable t) {
                original = null;
            }
        }
        clientInstalled = true;
        view.setWebViewClient(new HostWebViewClient(original));
    }

    // ==================================================================
    // 注入与页面回调
    // ==================================================================

    /** 注入 window.__LAN_BASE__（扫码用局域网地址 host:port）与 window.__SIGNAL_BASE__（页面实际使用的服务基址） */
    private void injectGlobals(WebView view) {
        if (view == null || pageUrl == null) {
            return;
        }
        String js = "(function(){try{"
                + "window.__LAN_BASE__=" + jsString(lanHostPort) + ";"
                + "window.__SIGNAL_BASE__=" + jsString(signalBase) + ";"
                + "}catch(e){}})();";
        try {
            view.evaluateJavascript(js, null);
        } catch (Throwable t) {
            Log.w(TAG, "inject globals failed: " + t);
        }
    }

    private static String jsString(String value) {
        if (value == null) {
            return "''";
        }
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'";
    }

    private void onPageReady() {
        if (pageShown) {
            return;
        }
        pageShown = true;
        handler.removeCallbacks(loadTimeoutTask);
        hideOverlay();
        if (webView != null) {
            webView.requestFocus();
        }
        Log.i(TAG, "page loaded: " + pageUrl);
    }

    /** 是否属于「本机内置服务」的地址（这类导航必须留在 WebView 内，不能被当成外部链接） */
    private boolean isOwnUrl(String url) {
        if (url == null || url.length() == 0) {
            return false;
        }
        String lower = url.toLowerCase();
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            return false;
        }
        String host = Uri.parse(url).getHost();
        if (host == null) {
            return false;
        }
        host = host.toLowerCase();
        if ("127.0.0.1".equals(host) || "localhost".equals(host) || "::1".equals(host)) {
            return true;
        }
        String lanHost = Uri.parse("http://" + lanHostPort).getHost();
        return lanHost != null && lanHost.equalsIgnoreCase(host);
    }

    private final class HostWebViewClient extends WebViewClient {

        private final WebViewClient delegate;

        HostWebViewClient(WebViewClient delegate) {
            this.delegate = delegate;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = (request != null && request.getUrl() != null) ? request.getUrl().toString() : null;
            if (isOwnUrl(url)) {
                return false; // 本机服务地址：交回 WebView 自己加载
            }
            return delegate != null && delegate.shouldOverrideUrlLoading(view, request);
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (isOwnUrl(url)) {
                return false;
            }
            return delegate != null && delegate.shouldOverrideUrlLoading(view, url);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return delegate != null ? delegate.shouldInterceptRequest(view, request) : null;
        }

        @SuppressWarnings("deprecation")
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            return delegate != null ? delegate.shouldInterceptRequest(view, url) : null;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (delegate != null) {
                delegate.onPageStarted(view, url, favicon);
            }
            injectGlobals(view);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (delegate != null) {
                delegate.onPageFinished(view, url);
            }
            injectGlobals(view);
            onPageReady();
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            if (delegate != null) {
                delegate.onReceivedError(view, errorCode, description, failingUrl);
            }
            Log.w(TAG, "webview error " + errorCode + " " + description + " @ " + failingUrl);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        WebResourceResponse errorResponse) {
            if (delegate != null) {
                delegate.onReceivedHttpError(view, request, errorResponse);
            }
            int code = (errorResponse != null) ? errorResponse.getStatusCode() : -1;
            boolean mainFrame = request != null && request.isForMainFrame();
            String url = (request != null && request.getUrl() != null) ? request.getUrl().toString() : "";
            Log.w(TAG, "webview http error " + code + " @ " + url);
            // 兜底：landing 页缺失时回退到游戏首页，避免白屏
            if (mainFrame && code == 404 && !fallbackDone && url != null && url.contains("/landing/")) {
                fallbackDone = true;
                String root = signalBase + "/";
                Log.w(TAG, "landing page missing, fallback to " + root);
                view.loadUrl(root);
            }
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            if (delegate != null) {
                delegate.onReceivedSslError(view, handler, error);
                return;
            }
            // 内置服务是纯 HTTP，出现 SSL 错误说明地址不对，直接取消
            handler.cancel();
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            if (delegate != null) {
                delegate.doUpdateVisitedHistory(view, url, isReload);
            }
        }
    }

    // ==================================================================
    // 遮罩 UI（纯代码构建，不依赖资源）
    // ==================================================================

    private void buildOverlay() {
        overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setBackgroundColor(0xF2101418);
        int pad = dp(24);
        overlay.setPadding(pad, pad, pad, pad);

        statusView = new TextView(this);
        statusView.setTextColor(Color.WHITE);
        statusView.setTextSize(15f);
        statusView.setGravity(Gravity.CENTER);
        statusView.setText("正在启动局域网信令服务…");
        overlay.addView(statusView, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        progressBar = new ProgressBar(this);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
        progressParams.topMargin = dp(20);
        overlay.addView(progressBar, progressParams);

        retryButton = new Button(this);
        retryButton.setText("重试");
        retryButton.setVisibility(View.GONE);
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
        retryParams.topMargin = dp(12);
        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loaded = false;
                pageShown = false;
                fallbackDone = false;
                handler.removeCallbacks(loadTimeoutTask);
                progressBar.setVisibility(View.VISIBLE);
                retryButton.setVisibility(View.GONE);
                statusView.setText("正在重新启动局域网信令服务…");
                ServerService.start(MainActivity.this, SignalServer.DEFAULT_PORT);
                startPolling();
            }
        });
        overlay.addView(retryButton, retryParams);

        ensureOverlayAttached();
    }

    /** 遮罩若被 Capacitor 的布局替换掉（父容器为空）则重新挂上，保证提示一定可见 */
    private void ensureOverlayAttached() {
        if (overlay == null) {
            return;
        }
        if (overlay.getParent() == null) {
            try {
                addContentView(overlay, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
            } catch (Throwable t) {
                Log.w(TAG, "attach overlay failed: " + t);
            }
        }
        try {
            overlay.bringToFront(); // 保证遮罩始终压在 Capacitor 的 WebView 之上
        } catch (Throwable t) {
            // ignore
        }
    }

    private void hideOverlay() {
        if (overlay != null && overlay.getVisibility() != View.GONE) {
            overlay.setVisibility(View.GONE);
        }
    }

    private void showFailure() {
        if (overlay == null) {
            return;
        }
        ensureOverlayAttached();
        String detail = (service == null) ? null : service.getLastError();
        StringBuilder text = new StringBuilder("局域网信令服务启动超时");
        if (detail != null && detail.length() > 0) {
            text.append("\n").append(detail);
        }
        text.append("\n请确认 ").append(port).append(" 端口未被占用，然后点击重试。");
        statusView.setText(text.toString());
        progressBar.setVisibility(View.GONE);
        retryButton.setVisibility(View.VISIBLE);
        overlay.setVisibility(View.VISIBLE);
    }

    private void showSlowHint() {
        if (overlay == null || pageShown) {
            return;
        }
        ensureOverlayAttached();
        statusView.setText("服务已就绪，页面加载较慢\n局域网地址（其他手机浏览器打开）：\nhttp://"
                + lanHostPort + "/\n若长时间无响应，可点击「重试」。");
        progressBar.setVisibility(View.GONE);
        retryButton.setVisibility(View.VISIBLE);
        overlay.setVisibility(View.VISIBLE);
    }

    // ==================================================================
    // 权限
    // ==================================================================

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) {
            return;
        }
        try {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS },
                        REQ_POST_NOTIFICATIONS);
            }
        } catch (Throwable t) {
            Log.w(TAG, "request notification permission failed: " + t);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_POST_NOTIFICATIONS) {
            // 拒绝也不影响信令服务运行：通知不可见，但服务与页面功能正常
            Log.i(TAG, "notification permission result: "
                    + (grantResults != null && grantResults.length > 0 ? grantResults[0] : -1));
        }
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }
}
