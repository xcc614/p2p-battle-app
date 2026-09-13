/*
 * p2p-battle-app / android-overlay / ServerService.java
 *
 * 前台 Service：负责启动并保活内置信令服务（SignalServer），常驻通知显示
 * 当前局域网访问地址（http://<热点/局域网IP>:8080/），并给 Activity 提供绑定查询接口。
 *
 * 设计要点：
 *  - onStartCommand 里"先 startForeground 再干别的"，满足 Android 8+ 的 5 秒规则；
 *  - 服务是 LocalBinder 绑定式 + START_STICKY，Activity 重建后可直接复用已就绪的服务；
 *  - 端口固定 SignalServer.DEFAULT_PORT（8080），与前端 config/runtime.json 契约一致；
 *  - 无第三方依赖，仅用框架 API。
 *
 * 注入说明：包名占位符 __APP_PKG__ 由构建脚本替换（详见 android-overlay/README.md）。
 */

package __APP_PKG__.signal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

public class ServerService extends Service {

    private static final String TAG = "P2P.ServerService";

    /** java 包名硬编码为固定值（不随 appId 变化）：仅用于通知点击/停止的显式 Intent */
    private static final String ACTION_START = "com.p2pbattle.signal.action.START";
    private static final String ACTION_STOP = "com.p2pbattle.signal.action.STOP";
    public static final String EXTRA_PORT = "p2p_signal_port";

    private static final String CHANNEL_ID = "p2p_signal_service";
    private static final String CHANNEL_NAME = "局域网信令服务";
    private static final int NOTIFICATION_ID = 1001;

    private static final long BIND_POLL_INTERVAL_MS = 250L;

    private final IBinder binder = new LocalBinder();
    private final Object startLock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private SignalServer server;
    private Thread startThread;
    private int port = SignalServer.DEFAULT_PORT;
    private String lastError;

    /** 绑定回调拿到 Service 实例，用它查询 isReady()/getHttpBase() */
    public final class LocalBinder extends Binder {
        public ServerService getService() {
            return ServerService.this;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int requestedPort = 0;
        String action = null;
        if (intent != null) {
            action = intent.getAction();
            requestedPort = intent.getIntExtra(EXTRA_PORT, 0);
        }
        if (requestedPort > 0 && requestedPort < 65536) {
            port = requestedPort;
        }

        // 先满足前台服务约束（startForegroundService 后必须 5 秒内 startForeground）
        startForegroundSafely();

        if (ACTION_STOP.equals(action)) {
            stopEverything();
            stopSelf();
            return START_NOT_STICKY;
        }

        SignalServer current;
        synchronized (startLock) {
            current = server;
        }
        if (current != null && current.isRunning()) {
            refreshNotificationAsync();
        } else {
            startServerAsync();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopEverything();
        super.onDestroy();
    }

    // ==================================================================
    // 对外查询接口
    // ==================================================================

    public boolean isReady() {
        SignalServer s;
        synchronized (startLock) {
            s = server;
        }
        return s != null && s.isRunning();
    }

    public int getPort() {
        return port;
    }

    /** 当前局域网访问基址（热点/局域网 IP），未就绪时回落到 127.0.0.1 */
    public String getHttpBase() {
        String host = LanAddress.getPrimaryAddress();
        if (host == null || host.length() == 0) {
            host = "127.0.0.1";
        }
        return "http://" + host + ":" + port;
    }

    public String getPrimaryAddress() {
        return LanAddress.getPrimaryAddress();
    }

    public String getLastError() {
        return lastError;
    }

    // ==================================================================
    // 服务启停
    // ==================================================================

    /** 供 Activity 调用：启动（或复用）前台服务 */
    public static void start(Context context, int port) {
        if (context == null) {
            return;
        }
        Intent intent = new Intent(context, ServerService.class);
        intent.setAction(ACTION_START);
        if (port > 0 && port < 65536) {
            intent.putExtra(EXTRA_PORT, port);
        }
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Throwable t) {
            Log.w(TAG, "startForegroundService failed, fallback to startService: " + t);
            try {
                context.startService(intent);
            } catch (Throwable t2) {
                Log.e(TAG, "startService failed: " + t2);
            }
        }
    }

    /** 供 Activity / 通知调用：请求停止服务 */
    public static void requestStop(Context context) {
        if (context == null) {
            return;
        }
        Intent intent = new Intent(context, ServerService.class);
        intent.setAction(ACTION_STOP);
        try {
            context.startService(intent);
        } catch (Throwable t) {
            // 后台限制 / 服务未运行时直接 stopService
            try {
                context.stopService(new Intent(context, ServerService.class));
            } catch (Throwable t2) {
                Log.w(TAG, "stopService failed: " + t2);
            }
        }
    }

    private void startServerAsync() {
        synchronized (startLock) {
            if (server != null) {
                return;
            }
            if (startThread != null && startThread.isAlive()) {
                return;
            }
            startThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    // 端口占用/宿主网络尚未就绪时做有限重试
                    for (int attempt = 0; attempt < 8; attempt++) {
                        if (startOnce()) {
                            return;
                        }
                        try {
                            Thread.sleep(1000L);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            return;
                        }
                    }
                    Log.e(TAG, "signal server start failed after retries: " + lastError);
                    refreshNotificationAsync();
                }
            }, "p2p-signal-boot");
            startThread.setDaemon(true);
            startThread.start();
        }
    }

    private boolean startOnce() {
        SignalServer candidate = null;
        try {
            candidate = new SignalServer(getApplicationContext(), port);
            candidate.startServer();
        } catch (Throwable t) {
            lastError = String.valueOf(t);
            Log.e(TAG, "start signal server failed: " + t);
            if (candidate != null) {
                try {
                    candidate.stop();
                } catch (Throwable ignored) {
                    // ignore
                }
            }
            return false;
        }
        synchronized (startLock) {
            server = candidate;
        }
        lastError = null;
        Log.i(TAG, "signal server ready: " + getHttpBase());
        refreshNotificationAsync();
        return true;
    }

    private void stopEverything() {
        SignalServer current;
        synchronized (startLock) {
            current = server;
            server = null;
        }
        if (current != null) {
            try {
                current.stop();
            } catch (Throwable t) {
                Log.w(TAG, "stop signal server failed: " + t);
            }
        }
        try {
            stopForeground(true);
        } catch (Throwable ignored) {
            // ignore
        }
    }

    // ==================================================================
    // 通知
    // ==================================================================

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) {
                return;
            }
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(channel);
        } catch (Throwable t) {
            Log.w(TAG, "createChannel failed: " + t);
        }
    }

    private void startForegroundSafely() {
        Notification notification = buildNotification(statusText());
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Throwable t) {
            // 部分 ROM 限制后台启动前台服务时会抛异常，此处降级为普通后台服务，不中断信令服务
            Log.w(TAG, "startForeground failed: " + t);
        }
    }

    private void refreshNotificationAsync() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (nm != null) {
                        nm.notify(NOTIFICATION_ID, buildNotification(statusText()));
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "update notification failed: " + t);
                }
            }
        });
    }

    private String statusText() {
        SignalServer current;
        synchronized (startLock) {
            current = server;
        }
        if (current == null || !current.isRunning()) {
            if (lastError == null) {
                return "正在启动局域网信令服务…";
            }
            return "启动失败：" + lastError;
        }
        return "运行中 · " + getHttpBase() + "/";
    }

    private Notification buildNotification(String text) {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        builder.setSmallIcon(android.R.drawable.stat_notify_sync);
        builder.setContentTitle("P2P 弹幕对战 · 局域网服务");
        builder.setContentText(text);
        builder.setOngoing(true);
        builder.setOnlyAlertOnce(true);
        builder.setShowWhen(false);
        builder.setPriority(Notification.PRIORITY_LOW);

        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            builder.setContentIntent(PendingIntent.getActivity(this, 0, launch, pendingFlags()));
        }
        Intent stopIntent = new Intent(this, ServerService.class);
        stopIntent.setAction(ACTION_STOP);
        builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止服务",
                PendingIntent.getService(this, 1, stopIntent, pendingFlags()));

        return builder.build();
    }

    private static int pendingFlags() {
        if (Build.VERSION.SDK_INT >= 23) {
            return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.FLAG_UPDATE_CURRENT;
    }
}
