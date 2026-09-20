/*
 * p2p-battle-app / android-overlay / SignalServer.java
 *
 * 内置信令服务：单端口同时提供
 *   1) 静态资源托管（从 APK assets/www 读取，供 WebView 与局域网浏览器访问）
 *   2) POST /create        建房
 *   3) GET  /api/info      局域网地址/房间统计（landing 页探测用，兼容 /lan-info.json）
 *   4) GET  /health        存活探针
 *   5) WebSocket /ws       信令（joined / members / signal / relay / member_leave）
 *
 * 协议逐条对齐 C:\Workspace\Marvis\p2p-battle\server_local.py，差异只有一处：
 *   服务端不做人数上限校验（MAX_MEMBERS / room full 逻辑已按新版要求移除）。
 *
 * 依赖：仅 NanoHTTPD 2.3.1 + NanoWSD 2.3.1（org.nanohttpd），无其他第三方库。
 *       /proxy 接口使用 Android 平台内置 org.json（非第三方依赖）。
 *
 * 注入说明：包名占位符 __APP_PKG__ 由构建脚本替换为 Capacitor appId（namespace），
 *          例如 appId=com.marvis.p2pbattle → package com.marvis.p2pbattle.signal;
 *          详见 android-overlay/README.md。
 */

package __APP_PKG__.signal;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Timer;
import java.util.TimerTask;
import java.util.regex.Pattern;

import org.json.JSONException;
import org.json.JSONObject;

import fi.iki.elonen.NanoHTTPD;
import fi.iki.elonen.NanoWSD;

public class SignalServer extends NanoWSD {

    private static final String TAG = "P2P.SignalServer";

    /** 端口契约：前端 config/runtime.json 的 SIGNAL_BASE 与 P2B 令牌均按 8080 拼接 */
    public static final int DEFAULT_PORT = 8080;

    /** 房间空闲回收窗口，对齐 server_local.py: ROOM_TTL_MS = 24h */
    private static final long ROOM_TTL_MS = 24L * 60L * 60L * 1000L;

    /** 自动房间码：'R' + 5 位（字符集去易混字符），对齐 server_local.py */
    private static final int AUTO_TOKEN_LEN = 5;
    private static final String TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    /** 自定义房间码：1-16 位 [A-Za-z0-9_-]，占用返回 409 */
    private static final Pattern CUSTOM_TOKEN_PATTERN = Pattern.compile("^[A-Za-z0-9_-]{1,16}$");

    /** /proxy 转发响应体上限，防内存放大 */
    private static final int MAX_PROXY_BODY = 16 * 1024 * 1024;

    /** APK 内静态站点根目录（cap sync 产出：assets/www） */
    private static final String ASSETS_ROOT = "www";
    private static final String INDEX_FILE = "index.html";

    private static final String MIME_JSON = "application/json; charset=utf-8";

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private final AssetManager assets;
    private final Random random = new Random();
    private final int port;

    /** token -> Room；所有读写都在 roomLock 临界区内完成 */
    private final Map<String, Room> rooms = new LinkedHashMap<String, Room>();
    private final Object roomLock = new Object();

    /** serve() 校验通过后把房间 token 交给"同一条连接线程"上的 openWebSocket() */
    private final ThreadLocal<String> pendingRoomToken = new ThreadLocal<String>();

    private Timer roomCleaner;

    public SignalServer(Context context) {
        this(context, DEFAULT_PORT);
    }

    public SignalServer(Context context, int port) {
        super(port);
        this.port = port;
        Context app = null;
        if (context != null) {
            app = context.getApplicationContext();
            if (app == null) {
                app = context;
            }
        }
        this.assets = (app == null) ? null : app.getAssets();
    }

    public int getPort() {
        return port;
    }

    public boolean isRunning() {
        return wasStarted();
    }

    // ==================================================================
    // 生命周期
    // ==================================================================

    /**
     * 启动服务。
     * 关键：必须用 start(0, true)。
     * NanoHTTPD 默认 SOCKET_READ_TIMEOUT=5000ms，会在 accept 后对 socket 设置 SO_TIMEOUT，
     * NanoWSD 读到 SocketTimeoutException 后按 IOException 处理并 doClose，静默 5 秒的 WS 会被强杀。
     * 传 0 可让 ServerRunnable 跳过 setSoTimeout，从而彻底关闭空闲超时。
     */
    public void startServer() throws IOException {
        start(0, true);
        startRoomCleaner();
        Log.i(TAG, "signal server started, port=" + port);
    }

    @Override
    public void stop() {
        if (roomCleaner != null) {
            roomCleaner.cancel();
            roomCleaner = null;
        }
        List<ClientSocket> alive = new ArrayList<ClientSocket>();
        synchronized (roomLock) {
            for (Room room : rooms.values()) {
                alive.addAll(room.conns.values());
            }
            rooms.clear();
        }
        for (int i = 0; i < alive.size(); i++) {
            try {
                alive.get(i).close(NanoWSD.WebSocketFrame.CloseCode.GoingAway, "server stopped", false);
            } catch (Throwable t) {
                Log.w(TAG, "close on stop failed: " + t);
            }
        }
        try {
            super.stop();
        } catch (Throwable t) {
            Log.w(TAG, "super.stop failed: " + t);
        }
        Log.i(TAG, "signal server stopped");
    }

    private void startRoomCleaner() {
        if (roomCleaner != null) {
            return;
        }
        roomCleaner = new Timer("p2p-room-cleaner", true);
        roomCleaner.schedule(new TimerTask() {
            @Override
            public void run() {
                cleanupExpiredRooms();
            }
        }, 60L * 1000L, 60L * 1000L);
    }

    private void cleanupExpiredRooms() {
        List<ClientSocket> stale = new ArrayList<ClientSocket>();
        long now = System.currentTimeMillis();
        synchronized (roomLock) {
            Iterator<Map.Entry<String, Room>> it = rooms.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Room> entry = it.next();
                Room room = entry.getValue();
                if (now - room.createdAt > ROOM_TTL_MS) {
                    stale.addAll(room.conns.values());
                    it.remove();
                    Log.i(TAG, "room expired: " + entry.getKey());
                }
            }
        }
        for (int i = 0; i < stale.size(); i++) {
            try {
                stale.get(i).close(NanoWSD.WebSocketFrame.CloseCode.GoingAway, "room expired", false);
            } catch (Throwable t) {
                Log.w(TAG, "close expired conn failed: " + t);
            }
        }
    }

    // ==================================================================
    // 请求入口：WebSocket 握手前置校验 + HTTP 路由
    // ==================================================================

    /**
     * WebSocket 升级前置校验。
     * NanoWSD.serve() 对 isWebsocketRequested() 的请求会调用 openWebSocket() 并直接返回 101，
     * 没有任何"拒绝握手"的钩子，所以房间不存在的 404 / 参数缺失的 400 必须在这里提前拦下。
     */
    @Override
    public Response serve(IHTTPSession session) {
        if (isWebsocketRequested(session)) {
            Response denied = validateWebSocketRequest(session);
            if (denied != null) {
                return denied;
            }
        }
        return super.serve(session);
    }

    private Response validateWebSocketRequest(IHTTPSession session) {
        String token = param(session, "token");
        String myId = param(session, "myId");
        if (isBlank(token) || isBlank(myId)) {
            return jsonResponse(Response.Status.BAD_REQUEST, errorJson("token and myId required"));
        }
        String type = param(session, "type");
        String effectiveType = isBlank(type) ? "multi" : type.trim();
        String roomToken;
        synchronized (roomLock) {
            if ("member".equals(effectiveType)) {
                // 成员加入必须先有房间（房主已建房），对齐 server_local.py 的 404 行为
                if (!rooms.containsKey(token)) {
                    Log.w(TAG, "ws join rejected, room not found: " + token);
                    return jsonResponse(Response.Status.NOT_FOUND, errorJson("room not found"));
                }
                roomToken = token;
            } else {
                // host / single / 其他：首次连接自动建房（沿用已有房间则不重建）
                roomToken = ensureRoomLocked(token, effectiveType);
            }
        }
        pendingRoomToken.set(roomToken);
        return null;
    }

    /** 调用方需持有 roomLock */
    private String ensureRoomLocked(String token, String type) {
        String roomToken = token;
        if (isBlank(roomToken)) {
            roomToken = generateTokenLocked();
        }
        if (!rooms.containsKey(roomToken)) {
            rooms.put(roomToken, new Room(type));
            Log.i(TAG, "room created by ws: " + roomToken + " type=" + type);
        }
        return roomToken;
    }

    @Override
    protected Response serveHttp(IHTTPSession session) {
        Method method = session.getMethod();
        String uri = session.getUri();
        if (uri == null || uri.length() == 0) {
            uri = "/";
        }

        if (Method.OPTIONS.equals(method)) {
            return handlePreflight(session);
        }

        if (Method.POST.equals(method) || Method.PUT.equals(method)) {
            if ("/create".equals(uri)) {
                return handleCreate(session);
            }
            if ("/proxy".equals(uri)) {
                return handleProxy(session);
            }
            return jsonResponse(Response.Status.NOT_FOUND, errorJson("not found"));
        }

        if (!Method.GET.equals(method) && !Method.HEAD.equals(method)) {
            return jsonResponse(Response.Status.METHOD_NOT_ALLOWED, errorJson("method not allowed"));
        }

        if ("/create".equals(uri)) {
            return jsonResponse(Response.Status.METHOD_NOT_ALLOWED, errorJson("use POST"));
        }
        if ("/proxy".equals(uri)) {
            return jsonResponse(Response.Status.METHOD_NOT_ALLOWED, errorJson("use POST"));
        }
        if ("/api/info".equals(uri) || "/lan-info.json".equals(uri)) {
            return handleInfo();
        }
        if ("/health".equals(uri)) {
            return jsonResponse(Response.Status.OK, "{\"ok\":true}");
        }
        if ("/ws".equals(uri)) {
            // 非升级请求直接落到这里，提示需要 WebSocket 握手
            return jsonResponse(Response.Status.BAD_REQUEST, errorJson("websocket upgrade required"));
        }
        return serveStatic(uri, Method.HEAD == method);
    }

    // ==================================================================
    // HTTP 接口
    // ==================================================================

    /** POST /create：body {type:"single"|"multi", token?:"自定义房间码"} → {ok,token,myId,members} */
    private Response handleCreate(IHTTPSession session) {
        String body = readBody(session);
        String type = jsonField(body, "type");
        String custom = jsonField(body, "token");
        String roomType = "single".equalsIgnoreCase(trim(type)) ? "single" : "multi";

        String token;
        synchronized (roomLock) {
            if (!isBlank(custom)) {
                if (!CUSTOM_TOKEN_PATTERN.matcher(custom).matches()) {
                    return jsonResponse(Response.Status.BAD_REQUEST, errorJson("invalid token"));
                }
                if (rooms.containsKey(custom)) {
                    return jsonResponse(Response.Status.CONFLICT, errorJson("token in use"));
                }
                token = custom;
            } else {
                token = generateTokenLocked();
            }
            rooms.put(token, new Room(roomType));
        }
        Log.i(TAG, "room created: " + token + " type=" + roomType);

        String myId = generateId();
        StringBuilder sb = new StringBuilder(96);
        sb.append("{\"ok\":true,\"token\":").append(q(token));
        sb.append(",\"myId\":").append(q(myId));
        sb.append(",\"members\":[]}");
        return jsonResponse(Response.Status.OK, sb.toString());
    }

    /** OPTIONS 预检：放行跨域调用（/proxy、/create 等全部接口），回显请求头白名单 */
    private Response handlePreflight(IHTTPSession session) {
        Map<String, String> headers = session.getHeaders();
        String reqHeaders = (headers == null) ? null : headers.get("access-control-request-headers");
        Response response = NanoHTTPD.newFixedLengthResponse(Response.Status.NO_CONTENT, "text/plain", "");
        response.addHeader("Access-Control-Allow-Origin", "*");
        response.addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
        if (!isBlank(reqHeaders)) {
            response.addHeader("Access-Control-Allow-Headers", reqHeaders);
        }
        response.addHeader("Access-Control-Max-Age", "86400");
        return response;
    }

    /** POST /proxy：服务端代转发，解决前端跨域。
     *  body {url, method?, params?, headers?, timeout?}
     *   - url      必填，http(s) 目标地址
     *   - method   可选，默认 GET；GET/HEAD/DELETE 时 params 编码进 query，其余作为 JSON body 发送
     *   - params   可选，目标参数对象
     *   - headers  可选，附加请求头（键需为合法 HTTP token，值不允许换行）
     *   - timeout  可选，毫秒，默认 10000，范围 1000-60000
     *  响应透传目标服务器状态码 / Content-Type / 原始 body；参数错误 400，上游失败 502。
     */
    private Response handleProxy(IHTTPSession session) {
        String body = readBody(session);
        if (isBlank(body)) {
            return jsonResponse(Response.Status.BAD_REQUEST, errorJson("body required"));
        }
        JSONObject req;
        try {
            req = new JSONObject(body);
        } catch (JSONException je) {
            return jsonResponse(Response.Status.BAD_REQUEST, errorJson("invalid json body"));
        }
        String target = trim(req.optString("url"));
        if (isBlank(target)
                || !(target.startsWith("http://") || target.startsWith("https://"))) {
            return jsonResponse(Response.Status.BAD_REQUEST, errorJson("url must be http(s)"));
        }
        String method = trim(req.optString("method", "GET")).toUpperCase(Locale.US);
        if (!"GET".equals(method) && !"HEAD".equals(method) && !"DELETE".equals(method)
                && !"POST".equals(method) && !"PUT".equals(method) && !"PATCH".equals(method)) {
            return jsonResponse(Response.Status.BAD_REQUEST, errorJson("unsupported method"));
        }
        int timeout = req.optInt("timeout", 10000);
        if (timeout < 1000 || timeout > 60000) {
            timeout = 10000;
        }
        JSONObject params = req.optJSONObject("params");
        JSONObject headers = req.optJSONObject("headers");
        try {
            return doProxy(target, method, params, headers, timeout);
        } catch (Throwable t) {
            Log.w(TAG, "proxy upstream failed: " + t);
            return jsonResponse(Response.Status.BAD_GATEWAY,
                    errorJson("upstream error: " + t.getMessage()));
        }
    }

    /** 执行转发并透传目标响应（状态码 / Content-Type / 原始字节） */
    private static Response doProxy(String target, String method, JSONObject params,
                                    JSONObject headers, int timeout) throws Exception {
        String finalUrl = buildProxyUrl(target, method, params);
        HttpURLConnection conn = (HttpURLConnection) new URL(finalUrl).openConnection();
        try {
            conn.setConnectTimeout(timeout);
            conn.setReadTimeout(timeout);
            conn.setRequestMethod(method);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Accept-Encoding", "identity");
            conn.setRequestProperty("User-Agent", "p2p-proxy/1.0");
            if (headers != null) {
                for (Iterator<?> it = headers.keys(); it.hasNext();) {
                    String key = String.valueOf(it.next());
                    String value = String.valueOf(headers.opt(String.valueOf(key)));
                    if (!isTokenHeaderName(key)
                            || value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0) {
                        throw new IllegalArgumentException("invalid header: " + key);
                    }
                    conn.setRequestProperty(key, value);
                }
            }
            if (!"GET".equals(method) && !"HEAD".equals(method) && !"DELETE".equals(method)) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] payload = (params == null) ? new byte[0]
                        : params.toString().getBytes("UTF-8");
                java.io.OutputStream out = conn.getOutputStream();
                try {
                    out.write(payload);
                } finally {
                    out.close();
                }
            }
            int status = conn.getResponseCode();
            if (status == 101) {
                throw new IOException("upstream returned 101, unsupported");
            }
            InputStream in = (status >= 400) ? conn.getErrorStream() : conn.getInputStream();
            byte[] data = (in == null) ? new byte[0] : readProxyBody(in);
            String contentType = conn.getContentType();
            NanoHTTPD.Response.IStatus st = NanoHTTPD.Response.Status.lookup(status);
            if (st == null) {
                throw new IOException("unsupported upstream status " + status);
            }
            Response response = NanoHTTPD.newFixedLengthResponse(st,
                    (contentType == null || contentType.length() == 0)
                            ? "application/octet-stream" : contentType, data);
            response.addHeader("Cache-Control", "no-store");
            response.addHeader("Access-Control-Allow-Origin", "*");
            return response;
        } finally {
            conn.disconnect();
        }
    }

    /** GET/HEAD/DELETE 把 params 编码进 query，其余方法原样返回 target */
    private static String buildProxyUrl(String target, String method, JSONObject params)
            throws java.io.UnsupportedEncodingException {
        if (params == null
                || "POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method)) {
            return target;
        }
        StringBuilder sb = new StringBuilder(target);
        boolean hasQuery = target.indexOf('?') >= 0;
        Iterator<?> keys = params.keys();
        while (keys.hasNext()) {
            String key = String.valueOf(keys.next());
            Object value = params.opt(String.valueOf(key));
            sb.append(hasQuery ? '&' : '?');
            hasQuery = true;
            sb.append(URLEncoder.encode(key, "UTF-8"));
            sb.append('=');
            if (value != null) {
                sb.append(URLEncoder.encode(String.valueOf(value), "UTF-8"));
            }
        }
        return sb.toString();
    }

    /** 读取转发响应体，上限 16MB 防内存放大 */
    private static byte[] readProxyBody(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(8192);
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > MAX_PROXY_BODY) {
                throw new IOException("upstream body too large");
            }
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    /** 合法 HTTP 头名（RFC 7230 token：字母数字 + !#$%&'*+-.^_`|~），仅防换行注入 */
    private static boolean isTokenHeaderName(String s) {
        if (s == null || s.length() == 0) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x21 || c > 0x7E || "()<>@,;:\\\"/[]?={} \t".indexOf(c) >= 0) {
                return false;
            }
        }
        return true;
    }

    /** GET /api/info：给 landing 页解析局域网基址用，字段与 server_local.py 对齐 */
    private Response handleInfo() {
        List<String> ips = LanAddress.collectIPv4Addresses();
        String primary = LanAddress.pickPrimary(ips);
        String host = isBlank(primary) ? "127.0.0.1" : primary;

        int roomCount;
        int clientCount;
        synchronized (roomLock) {
            roomCount = rooms.size();
            clientCount = 0;
            for (Room room : rooms.values()) {
                clientCount += room.conns.size();
            }
        }

        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"ok\":true");
        sb.append(",\"port\":").append(port);
        sb.append(",\"ip\":").append(q(host));
        sb.append(",\"httpBase\":").append(q("http://" + host + ":" + port));
        sb.append(",\"wsBase\":").append(q("ws://" + host + ":" + port));
        sb.append(",\"base\":").append(q(host + ":" + port));
        sb.append(",\"lanIps\":[");
        for (int i = 0; ips != null && i < ips.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(q(ips.get(i)));
        }
        sb.append(']');
        sb.append(",\"rooms\":").append(roomCount);
        sb.append(",\"clients\":").append(clientCount);
        sb.append('}');
        return jsonResponse(Response.Status.OK, sb.toString());
    }

    /** 静态资源：/ → www/index.html，/landing → www/landing/index.html，其余按路径取 assets */
    private Response serveStatic(String uri, boolean headOnly) {
        String assetPath = toAssetPath(uri);
        if (assetPath == null) {
            return jsonResponse(Response.Status.FORBIDDEN, errorJson("forbidden"));
        }
        byte[] data = readAsset(assetPath);
        if (data == null) {
            // 目录形态回退：/landing → /landing/index.html
            String indexPath = assetPath + "/" + INDEX_FILE;
            data = readAsset(indexPath);
            if (data != null) {
                assetPath = indexPath;
            }
        }
        if (data == null) {
            return jsonResponse(Response.Status.NOT_FOUND, errorJson("not found"));
        }
        // HEAD 请求只回响应头：正文留空但 Content-Length 仍为真实长度
        InputStream body = headOnly ? new ByteArrayInputStream(new byte[0]) : new ByteArrayInputStream(data);
        Response response = NanoHTTPD.newFixedLengthResponse(Response.Status.OK, mimeTypeOf(assetPath),
                body, data.length);
        response.addHeader("Cache-Control", "no-cache");
        response.addHeader("Access-Control-Allow-Origin", "*");
        return response;
    }

    /** uri → assets 内相对路径（www/xxx）；越权或非法路径返回 null */
    private static String toAssetPath(String uri) {
        String path = uri;
        int qm = path.indexOf('?');
        if (qm >= 0) {
            path = path.substring(0, qm);
        }
        int hash = path.indexOf('#');
        if (hash >= 0) {
            path = path.substring(0, hash);
        }
        while (path.startsWith("/")) {
            path = path.substring(1);
        }
        if (path.length() == 0) {
            path = INDEX_FILE;
        }
        if (path.indexOf('\\') >= 0 || path.indexOf(':') >= 0) {
            return null;
        }
        if (path.contains("..")) {
            return null;
        }
        while (path.startsWith("./")) {
            path = path.substring(2);
        }
        return ASSETS_ROOT + "/" + path;
    }

    private byte[] readAsset(String assetPath) {
        if (assets == null) {
            return null;
        }
        InputStream in = null;
        try {
            in = assets.open(assetPath, AssetManager.ACCESS_STREAMING);
            return readAll(in);
        } catch (Throwable t) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // ignore
                }
            }
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(16384);
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    /**
     * 自带 MIME 表：NanoHTTPD 的默认表来自 jar 内 properties 资源，Android 上不保证命中，
     * 一旦 .js 被回退成 application/octet-stream，浏览器会拒绝执行脚本。
     */
    private static String mimeTypeOf(String path) {
        String p = path.toLowerCase(Locale.US);
        if (p.endsWith(".html") || p.endsWith(".htm")) {
            return "text/html; charset=utf-8";
        }
        if (p.endsWith(".js") || p.endsWith(".mjs")) {
            return "application/javascript; charset=utf-8";
        }
        if (p.endsWith(".css")) {
            return "text/css; charset=utf-8";
        }
        if (p.endsWith(".json") || p.endsWith(".map")) {
            return MIME_JSON;
        }
        if (p.endsWith(".svg")) {
            return "image/svg+xml";
        }
        if (p.endsWith(".png")) {
            return "image/png";
        }
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (p.endsWith(".gif")) {
            return "image/gif";
        }
        if (p.endsWith(".webp")) {
            return "image/webp";
        }
        if (p.endsWith(".ico")) {
            return "image/x-icon";
        }
        if (p.endsWith(".woff")) {
            return "font/woff";
        }
        if (p.endsWith(".woff2")) {
            return "font/woff2";
        }
        if (p.endsWith(".ttf")) {
            return "font/ttf";
        }
        if (p.endsWith(".otf")) {
            return "font/otf";
        }
        if (p.endsWith(".mp3")) {
            return "audio/mpeg";
        }
        if (p.endsWith(".ogg") || p.endsWith(".oga")) {
            return "audio/ogg";
        }
        if (p.endsWith(".wav")) {
            return "audio/wav";
        }
        if (p.endsWith(".m4a")) {
            return "audio/mp4";
        }
        if (p.endsWith(".mp4")) {
            return "video/mp4";
        }
        if (p.endsWith(".webm")) {
            return "video/webm";
        }
        if (p.endsWith(".wasm")) {
            return "application/wasm";
        }
        if (p.endsWith(".xml")) {
            return "text/xml; charset=utf-8";
        }
        if (p.endsWith(".txt") || p.endsWith(".md") || p.endsWith(".csv")) {
            return "text/plain; charset=utf-8";
        }
        String guess = NanoHTTPD.getMimeTypeForFile(path);
        return (guess == null || guess.length() == 0) ? "application/octet-stream" : guess;
    }

    // ==================================================================
    // WebSocket
    // ==================================================================

    @Override
    protected WebSocket openWebSocket(IHTTPSession handshake) {
        String token = param(handshake, "token");
        String myId = param(handshake, "myId");
        String type = param(handshake, "type");
        String name = param(handshake, "name");
        String roleId = param(handshake, "roleId");
        String roomToken = pendingRoomToken.get();
        pendingRoomToken.remove();
        if (isBlank(roomToken)) {
            // 兜底：serve() 已校验过，正常不会走到这里
            roomToken = isBlank(token) ? "" : token;
        }
        return new ClientSocket(this, handshake, roomToken, isBlank(myId) ? "" : myId,
                isBlank(type) ? "multi" : type, name, roleId);
    }

    // ==================================================================
    // 房间模型
    // ==================================================================

    static final class Room {
        final String type;
        final long createdAt = System.currentTimeMillis();
        /** myId -> 连接，LinkedHashMap 保证广播顺序 = 加入顺序（房主恒为首位） */
        final Map<String, ClientSocket> conns = new LinkedHashMap<String, ClientSocket>();

        Room(String type) {
            this.type = type;
        }
    }

    /** 单条 WebSocket 会话：一个实例对应一个 myId 的房间成员 */
    static final class ClientSocket extends NanoWSD.WebSocket {

        private final SignalServer server;
        private final String roomToken;
        private final String myId;
        private final String connectType;
        private final String name;
        private String roleId;
        private boolean registered;

        ClientSocket(SignalServer server, IHTTPSession handshake, String roomToken, String myId,
                     String connectType, String name, String roleId) {
            super(handshake);
            this.server = server;
            this.roomToken = roomToken;
            this.myId = myId;
            this.connectType = connectType;
            this.name = (name == null) ? "" : name;
            this.roleId = isBlank(roleId) ? "hero" : roleId.trim();
        }

        String getMyId() {
            return myId;
        }

        String getRoomToken() {
            return roomToken;
        }

        @Override
        public void onOpen() {
            Room room;
            String joinedPayload;
            ClientSocket evicted = null;
            synchronized (server.roomLock) {
                room = server.rooms.get(roomToken);
                if (room == null) {
                    Log.w(TAG, "onOpen but room gone: " + roomToken);
                    try {
                        close(NanoWSD.WebSocketFrame.CloseCode.PolicyViolation, "room not found", false);
                    } catch (Throwable t) {
                        Log.w(TAG, "close failed: " + t);
                    }
                    return;
                }
                // 同 myId 重连：踢掉旧连接，对齐 server_local.py
                ClientSocket old = room.conns.get(myId);
                if (old != null && old != this) {
                    room.conns.remove(myId);
                    evicted = old;
                }
                room.conns.put(myId, this);
                registered = true;
                // Boss 唯一裁决：房内已有 demon_lord 则降级为 archer（对齐 server_local.py）
                if ("demon_lord".equals(roleId) && server.hasDemonLordLocked(room, this)) {
                    roleId = "archer";
                }
                joinedPayload = server.joinedFrameLocked(room, this);
            }
            if (evicted != null) {
                evicted.dropByNewConnection();
            }
            Log.i(TAG, "member joined: room=" + roomToken + " myId=" + myId
                    + " type=" + connectType + " name=" + name + " roleId=" + roleId);
            // onOpen() 在 101 响应写出之后被调用（NanoWSD 保证），此处发送首帧无帧序竞争
            sendRaw(joinedPayload);
            server.broadcastMembers(roomToken);
        }

        @Override
        public void onClose(NanoWSD.WebSocketFrame.CloseCode code, String reason, boolean initiatedByRemote) {
            server.handleClosed(this);
        }

        @Override
        public void onMessage(NanoWSD.WebSocketFrame frame) {
            if (frame == null) {
                return;
            }
            if (frame.getOpCode() != NanoWSD.WebSocketFrame.OpCode.Text) {
                return;
            }
            String text = frame.getTextPayload();
            if (text == null || text.length() == 0) {
                return;
            }
            server.handleClientMessage(this, text);
        }

        @Override
        public void onPong(NanoWSD.WebSocketFrame pong) {
            // NanoWSD 已自动回复 Ping，这里无需处理
        }

        @Override
        public void onException(IOException exception) {
            // 读异常（对端断开/RST）后 NanoWSD 会走 finally → doClose → onClose 做清理，
            // 这里只记日志，清理逻辑统一放在 handleClosed（幂等）。
            Log.w(TAG, "ws exception, myId=" + myId + ": " + exception);
        }

        void sendRaw(String json) {
            if (json == null || !isOpen()) {
                return;
            }
            try {
                send(json);
            } catch (IOException e) {
                Log.w(TAG, "send to " + myId + " failed: " + e);
            }
        }

        /** 同一 myId 被新连接顶替时，关闭旧连接 */
        void dropByNewConnection() {
            try {
                close(NanoWSD.WebSocketFrame.CloseCode.PolicyViolation,
                        "replaced by a new connection with the same id", false);
            } catch (Throwable t) {
                Log.w(TAG, "evict old connection failed: " + t);
            }
        }

        boolean isRegistered() {
            return registered;
        }
    }

    // ==================================================================
    // 上行消息处理（signal / relay / role / leave）
    // ==================================================================

    void handleClientMessage(ClientSocket from, String text) {
        String action = jsonField(text, "action");
        if (isBlank(action)) {
            return;
        }

        if ("signal".equals(action)) {
            String to = jsonField(text, "to");
            if (isBlank(to)) {
                return;
            }
            String payload = topLevelRaw(text, "payload");
            ClientSocket dst = findConn(from.roomToken, to);
            if (dst != null) {
                dst.sendRaw(signalFrame(from.myId, payload));
            }
            return;
        }

        if ("relay".equals(action)) {
            String payload = topLevelRaw(text, "payload");
            broadcastExcept(from.roomToken, from.myId, relayFrame(from.myId, payload));
            return;
        }

        if ("role".equals(action)) {
            String newRole = jsonField(text, "roleId");
            if (isBlank(newRole)) {
                return;
            }
            synchronized (roomLock) {
                Room room = rooms.get(from.roomToken);
                if (room == null) {
                    return;
                }
                if ("demon_lord".equals(newRole) && hasDemonLordLocked(room, from)) {
                    newRole = "archer";
                }
                from.roleId = newRole;
            }
            broadcastMembers(from.roomToken);
            return;
        }

        if ("leave".equals(action)) {
            handleClosed(from);
            try {
                from.close(NanoWSD.WebSocketFrame.CloseCode.NormalClosure, "leave", false);
            } catch (Throwable t) {
                Log.w(TAG, "close on leave failed: " + t);
            }
        }
    }

    /** 断线清理（幂等）：只有"当前登记的就是这条连接"时才移除并广播 */
    void handleClosed(ClientSocket conn) {
        List<ClientSocket> remaining = new ArrayList<ClientSocket>();
        boolean removed = false;
        synchronized (roomLock) {
            Room room = rooms.get(conn.roomToken);
            if (room != null) {
                ClientSocket current = room.conns.get(conn.myId);
                if (current == conn) {
                    room.conns.remove(conn.myId);
                    removed = true;
                    remaining.addAll(room.conns.values());
                }
            }
        }
        if (!removed) {
            return;
        }
        Log.i(TAG, "member left: room=" + conn.roomToken + " myId=" + conn.myId);
        String leaveFrame = "{\"type\":\"member_leave\",\"myId\":" + q(conn.myId) + "}";
        for (int i = 0; i < remaining.size(); i++) {
            remaining.get(i).sendRaw(leaveFrame);
        }
        broadcastMembers(conn.roomToken);
    }

    ClientSocket findConn(String roomToken, String myId) {
        synchronized (roomLock) {
            Room room = rooms.get(roomToken);
            if (room == null) {
                return null;
            }
            return room.conns.get(myId);
        }
    }

    void broadcastMembers(String roomToken) {
        List<ClientSocket> targets = new ArrayList<ClientSocket>();
        String payload;
        synchronized (roomLock) {
            Room room = rooms.get(roomToken);
            if (room == null || room.conns.isEmpty()) {
                return;
            }
            payload = membersFrameLocked(room);
            targets.addAll(room.conns.values());
        }
        for (int i = 0; i < targets.size(); i++) {
            targets.get(i).sendRaw(payload);
        }
    }

    void broadcastExcept(String roomToken, String exceptMyId, String payload) {
        if (payload == null) {
            return;
        }
        List<ClientSocket> targets = new ArrayList<ClientSocket>();
        synchronized (roomLock) {
            Room room = rooms.get(roomToken);
            if (room == null) {
                return;
            }
            for (ClientSocket c : room.conns.values()) {
                if (!c.myId.equals(exceptMyId)) {
                    targets.add(c);
                }
            }
        }
        for (int i = 0; i < targets.size(); i++) {
            targets.get(i).sendRaw(payload);
        }
    }

    /** 调用方需持有 roomLock */
    private boolean hasDemonLordLocked(Room room, ClientSocket except) {
        for (ClientSocket c : room.conns.values()) {
            if (c == except) {
                continue;
            }
            if ("demon_lord".equals(c.roleId)) {
                return true;
            }
        }
        return false;
    }

    // ==================================================================
    // 下行帧构造（字段名与 server_local.py 完全一致）
    // ==================================================================

    /** 调用方需持有 roomLock：joined 只给本人，members 为"除自己外"的当前成员 */
    private String joinedFrameLocked(Room room, ClientSocket self) {
        StringBuilder sb = new StringBuilder(128);
        sb.append("{\"type\":\"joined\",\"myId\":").append(q(self.myId));
        sb.append(",\"roleId\":").append(q(self.roleId));
        sb.append(",\"members\":[");
        boolean first = true;
        for (ClientSocket c : room.conns.values()) {
            if (c == self) {
                continue;
            }
            if (!first) {
                sb.append(',');
            }
            first = false;
            sb.append(memberJson(c));
        }
        sb.append("]}");
        return sb.toString();
    }

    /** 调用方需持有 roomLock：全量成员，顺序 = 加入顺序（房主首位） */
    private String membersFrameLocked(Room room) {
        StringBuilder sb = new StringBuilder(128);
        sb.append("{\"type\":\"members\",\"members\":[");
        boolean first = true;
        for (ClientSocket c : room.conns.values()) {
            if (!first) {
                sb.append(',');
            }
            first = false;
            sb.append(memberJson(c));
        }
        sb.append("]}");
        return sb.toString();
    }

    private static String memberJson(ClientSocket c) {
        return "{\"id\":" + q(c.myId) + ",\"name\":" + q(c.name) + ",\"roleId\":" + q(c.roleId) + "}";
    }

    private static String signalFrame(String fromId, String rawPayload) {
        return "{\"type\":\"signal\",\"from\":" + q(fromId) + ",\"payload\":"
                + (rawPayload == null ? "null" : rawPayload) + "}";
    }

    private static String relayFrame(String fromId, String rawPayload) {
        return "{\"type\":\"relay\",\"from\":" + q(fromId) + ",\"payload\":"
                + (rawPayload == null ? "null" : rawPayload) + "}";
    }

    // ==================================================================
    // 工具方法
    // ==================================================================

    /** 调用方需持有 roomLock */
    private String generateTokenLocked() {
        String token;
        do {
            StringBuilder sb = new StringBuilder(AUTO_TOKEN_LEN + 1);
            sb.append('R');
            for (int i = 0; i < AUTO_TOKEN_LEN; i++) {
                sb.append(TOKEN_CHARS.charAt(random.nextInt(TOKEN_CHARS.length())));
            }
            token = sb.toString();
        } while (rooms.containsKey(token));
        return token;
    }

    private String generateId() {
        StringBuilder sb = new StringBuilder(16);
        sb.append('u');
        sb.append(Long.toHexString(System.currentTimeMillis()));
        sb.append(Integer.toHexString(random.nextInt(0xFFFF) + 0x1000));
        return sb.toString();
    }

    /** 读取 POST body（按 Content-Length 精确读取，避免 NanoHTTPD parseBody 落临时文件） */
    private static String readBody(IHTTPSession session) {
        try {
            Map<String, String> headers = session.getHeaders();
            String lenHeader = (headers == null) ? null : headers.get("content-length");
            int len = 0;
            if (lenHeader != null) {
                try {
                    len = Integer.parseInt(lenHeader.trim());
                } catch (NumberFormatException nfe) {
                    len = 0;
                }
            }
            if (len <= 0) {
                return "";
            }
            if (len > 65536) {
                len = 65536;
            }
            InputStream in = session.getInputStream();
            if (in == null) {
                return "";
            }
            byte[] buf = new byte[len];
            int read = 0;
            while (read < len) {
                int n = in.read(buf, read, len - read);
                if (n <= 0) {
                    break;
                }
                read += n;
            }
            return new String(buf, 0, read, java.nio.charset.Charset.forName("UTF-8"));
        } catch (Throwable t) {
            Log.w(TAG, "readBody failed: " + t);
            return "";
        }
    }

    /** 查询参数：优先 NanoHTTPD 已解码的 parms，兜底自行解析原始 query（避免二次解码） */
    private static String param(IHTTPSession session, String name) {
        try {
            Map<String, String> parms = session.getParms();
            if (parms != null) {
                String value = parms.get(name);
                if (value != null && value.length() > 0) {
                    return value;
                }
            }
        } catch (Throwable ignored) {
            // 忽略，走兜底解析
        }
        return rawQueryParam(session.getQueryParameterString(), name);
    }

    private static String rawQueryParam(String query, String name) {
        if (query == null || query.length() == 0) {
            return null;
        }
        String q = query;
        if (q.charAt(0) == '?') {
            q = q.substring(1);
        }
        String[] parts = q.split("&");
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (part == null || part.length() == 0) {
                continue;
            }
            int eq = part.indexOf('=');
            String key = (eq >= 0) ? part.substring(0, eq) : part;
            if (name.equals(urlDecode(key))) {
                return urlDecode(eq >= 0 ? part.substring(eq + 1) : "");
            }
        }
        return null;
    }

    private static String urlDecode(String s) {
        if (s == null) {
            return null;
        }
        try {
            return URLDecoder.decode(s, "UTF-8");
        } catch (Throwable t) {
            return s;
        }
    }

    private static Response jsonResponse(Response.IStatus status, String body) {
        Response response = NanoHTTPD.newFixedLengthResponse(status, MIME_JSON, body);
        response.addHeader("Cache-Control", "no-store");
        response.addHeader("Access-Control-Allow-Origin", "*");
        return response;
    }

    private static String errorJson(String message) {
        return "{\"ok\":false,\"error\":" + q(message) + "}";
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().length() == 0;
    }

    private static String trim(String s) {
        return (s == null) ? "" : s.trim();
    }

    /** JSON 字符串字面量（含转义） */
    private static String q(String s) {
        return "\"" + jsonEscape(s) + "\"";
    }

    private static String jsonEscape(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append("\\u00").append(HEX[(c >> 4) & 0xF]).append(HEX[c & 0xF]);
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }

    /** 取顶层字符串字段值（只认字符串，非字符串/不存在返回 null） */
    private static String jsonField(String json, String key) {
        String raw = topLevelRaw(json, key);
        if (raw == null) {
            return null;
        }
        if (raw.length() >= 2 && raw.charAt(0) == '"' && raw.charAt(raw.length() - 1) == '"') {
            return unescape(raw.substring(1, raw.length() - 1));
        }
        return null;
    }

    /** 取顶层字段的原始 JSON 片段（字符串含引号、对象/数组原样），用于 signal/relay 的 payload 透传 */
    private static String topLevelRaw(String json, String key) {
        if (json == null || key == null) {
            return null;
        }
        int n = json.length();
        int i = 0;
        while (i < n && json.charAt(i) != '{') {
            i++;
        }
        if (i >= n) {
            return null;
        }
        i++;
        int depth = 1;
        while (i < n) {
            char c = json.charAt(i);
            if (c == '"') {
                int end = skipString(json, i);
                if (end < 0) {
                    return null;
                }
                int j = end;
                while (j < n && isWs(json.charAt(j))) {
                    j++;
                }
                if (depth == 1 && j < n && json.charAt(j) == ':') {
                    if (key.equals(unescape(json.substring(i + 1, end - 1)))) {
                        return readJsonValue(json, j + 1);
                    }
                }
                i = end;
                continue;
            }
            if (c == '{' || c == '[') {
                depth++;
            } else if (c == '}' || c == ']') {
                depth--;
                if (depth <= 0) {
                    return null;
                }
            }
            i++;
        }
        return null;
    }

    /** 返回 s 中下标 i 处字符串的"闭引号下标 + 1"；非法返回 -1 */
    private static int skipString(String s, int i) {
        int n = s.length();
        int j = i + 1;
        while (j < n) {
            char c = s.charAt(j);
            if (c == '\\') {
                j += 2;
                continue;
            }
            if (c == '"') {
                return j + 1;
            }
            j++;
        }
        return -1;
    }

    private static String readJsonValue(String s, int start) {
        int n = s.length();
        int i = start;
        while (i < n && isWs(s.charAt(i))) {
            i++;
        }
        if (i >= n) {
            return null;
        }
        char c = s.charAt(i);
        if (c == '"') {
            int end = skipString(s, i);
            return (end < 0) ? null : s.substring(i, end);
        }
        if (c == '{' || c == '[') {
            int depth = 0;
            int j = i;
            while (j < n) {
                char ch = s.charAt(j);
                if (ch == '"') {
                    int e = skipString(s, j);
                    if (e < 0) {
                        return null;
                    }
                    j = e;
                    continue;
                }
                if (ch == '{' || ch == '[') {
                    depth++;
                } else if (ch == '}' || ch == ']') {
                    depth--;
                    if (depth == 0) {
                        return s.substring(i, j + 1);
                    }
                }
                j++;
            }
            return null;
        }
        int j = i;
        while (j < n) {
            char ch = s.charAt(j);
            if (ch == ',' || ch == '}' || ch == ']') {
                break;
            }
            j++;
        }
        String raw = s.substring(i, j).trim();
        return (raw.length() == 0) ? null : raw;
    }

    private static boolean isWs(char c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r';
    }

    private static String unescape(String s) {
        if (s.indexOf('\\') < 0) {
            return s;
        }
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i + 1 >= s.length()) {
                sb.append(c);
                continue;
            }
            i++;
            char e = s.charAt(i);
            switch (e) {
                case 'n':
                    sb.append('\n');
                    break;
                case 'r':
                    sb.append('\r');
                    break;
                case 't':
                    sb.append('\t');
                    break;
                case 'b':
                    sb.append('\b');
                    break;
                case 'f':
                    sb.append('\f');
                    break;
                case '/':
                    sb.append('/');
                    break;
                case '\\':
                    sb.append('\\');
                    break;
                case '"':
                    sb.append('"');
                    break;
                case 'u':
                    if (i + 4 < s.length()) {
                        try {
                            sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                            i += 4;
                        } catch (NumberFormatException nfe) {
                            sb.append(e);
                        }
                    } else {
                        sb.append(e);
                    }
                    break;
                default:
                    sb.append(e);
            }
        }
        return sb.toString();
    }
}
