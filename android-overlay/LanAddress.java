/*
 * p2p-battle-app / android-overlay / LanAddress.java
 *
 * 局域网地址获取工具类：枚举本机网卡，取出可用于「手机热点 / 局域网」直连的 IPv4 地址，
 * 并给出优先级排序（热点接口优先，其次 Wi-Fi/以太网，最后其他私有网段）。
 *
 * 纯 java.net 实现，不依赖 WifiManager（避免 API 差异与权限问题），
 * Android 上 java.net.NetworkInterface 可用（与 Linux 网卡枚举等价）。
 *
 * 注入说明：包名占位符 __APP_PKG__ 由构建脚本替换（详见 android-overlay/README.md）。
 */

package __APP_PKG__.signal;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.TreeMap;

public final class LanAddress {

    private LanAddress() {
    }

    /**
     * 枚举所有可用 IPv4 私有地址（已排除回环、链路本地、蜂窝数据口），按"热点优先"排序。
     * 任何单个网卡异常都不会打断整体枚举，最坏情况返回空列表。
     */
    public static List<String> collectIPv4Addresses() {
        // rank -> 该优先级下的地址（rank 越小越优先），TreeMap 保证按 rank 升序输出
        TreeMap<Integer, List<String>> buckets = new TreeMap<Integer, List<String>>();
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces == null) {
                return new ArrayList<String>();
            }
            while (ifaces.hasMoreElements()) {
                NetworkInterface ni = ifaces.nextElement();
                if (ni == null) {
                    continue;
                }
                try {
                    if (ni.isLoopback() || !ni.isUp()) {
                        continue;
                    }
                    String ifaceName = ni.getName();
                    if (ifaceName == null) {
                        ifaceName = "";
                    }
                    String lower = ifaceName.toLowerCase(Locale.US);
                    // 蜂窝数据口不参与局域网直连
                    if (lower.startsWith("rmnet") || lower.startsWith("ccmni")
                            || lower.startsWith("pdp") || lower.startsWith("dummy")) {
                        continue;
                    }
                    int rank = rankOf(lower);
                    Enumeration<InetAddress> addrs = ni.getInetAddresses();
                    while (addrs.hasMoreElements()) {
                        InetAddress addr = addrs.nextElement();
                        if (!(addr instanceof Inet4Address)) {
                            continue;
                        }
                        if (addr.isLoopbackAddress() || addr.isLinkLocalAddress()) {
                            continue;
                        }
                        if (!addr.isSiteLocalAddress()) {
                            continue;
                        }
                        String ip = addr.getHostAddress();
                        if (ip == null || ip.length() == 0) {
                            continue;
                        }
                        Integer key = Integer.valueOf(rank);
                        List<String> bucket = buckets.get(key);
                        if (bucket == null) {
                            bucket = new ArrayList<String>();
                            buckets.put(key, bucket);
                        }
                        if (!bucket.contains(ip)) {
                            bucket.add(ip);
                        }
                    }
                } catch (Throwable ignored) {
                    // 单个网卡读失败不影响其它网卡
                }
            }
        } catch (Throwable ignored) {
            // 整体枚举失败时返回已收集到的部分（可能为空）
        }

        List<String> result = new ArrayList<String>();
        for (List<String> bucket : buckets.values()) {
            for (int i = 0; i < bucket.size(); i++) {
                String ip = bucket.get(i);
                if (!result.contains(ip)) {
                    result.add(ip);
                }
            }
        }
        return result;
    }

    /**
     * 取首选局域网地址：热点网段（192.168.43.x / 192.168.42.x 等）优先，
     * 其次 Wi-Fi/以太网，最后其他私有地址；无可用地址返回 null。
     */
    public static String getPrimaryAddress() {
        return pickPrimary(collectIPv4Addresses());
    }

    /** 从候选列表里挑首选地址（列表已按优先级排序，直接取第一个并做热点强化） */
    public static String pickPrimary(List<String> candidates) {
        if (candidates == null || candidates.isEmpty()) {
            return null;
        }
        for (int i = 0; i < candidates.size(); i++) {
            String ip = candidates.get(i);
            if (isHotspotLike(ip)) {
                return ip;
            }
        }
        return candidates.get(0);
    }

    /** 是否是典型 Android 热点网段（默认 192.168.43.1，部分 ROM 为 192.168.42.x / 192.168.44.x） */
    public static boolean isHotspotLike(String ip) {
        if (ip == null) {
            return false;
        }
        return ip.startsWith("192.168.43.") || ip.startsWith("192.168.42.")
                || ip.startsWith("192.168.44.") || ip.startsWith("192.168.137.");
    }

    private static int rankOf(String lowerIfaceName) {
        // 0：热点接口（软 AP）—— Android 上名为 ap0 / swlan0 / softap0 等
        if (lowerIfaceName.startsWith("ap") || lowerIfaceName.startsWith("swlan")
                || lowerIfaceName.contains("softap")) {
            return 0;
        }
        // 1：Wi-Fi / 以太网
        if (lowerIfaceName.startsWith("wlan") || lowerIfaceName.startsWith("eth")
                || lowerIfaceName.startsWith("en")) {
            return 1;
        }
        // 2：其他（如 p2p0、tun 等）
        return 2;
    }
}
