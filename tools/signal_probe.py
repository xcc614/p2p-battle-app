#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
p2p-battle APK 内置信令服务三层自检探针（纯标准库，无需 pip 安装）

用途：APK 已装到手机上后，在电脑端（需与手机同一局域网/同一热点）验证
      Java 侧「HTTP 服务 + 信令接口 + WebSocket 服务」是否真的正常，
      完全不依赖任何 HTML / 游戏前端页面。

用法：
    python signal_probe.py --host 192.168.43.1
    python signal_probe.py --host 192.168.1.23 --port 8080
    python signal_probe.py --host 192.168.43.1 --token R1A2B3C

判定层次：
    L1 HTTP 层 ：GET  /health      → {"ok":true}                    服务进程 + NanoHTTPD 存活
    L2 信令接口：POST /create      → {"ok":true,"token":"R...","myId":"u..."}   房间/令牌管理正常
    L3 WS 层   ：GET  /ws 升级 101 → 首帧 {"type":"joined",...}      NanoWSD + 信令会话正常
    辅助证据   ：GET  /api/info    → rooms / clients 计数随连接变化

退出码：0=三层全通；1=L3 失败；2=L2 失败；3=L1 失败
"""
import argparse
import base64
import json
import os
import socket
import struct
import sys
import time
import urllib.error
import urllib.request

OK, BAD, WARN = "[ OK ]", "[FAIL]", "[WARN]"
results = []


def log(tag, msg):
    line = "%s %s" % (tag, msg)
    print(line, flush=True)
    results.append((tag, msg))


def http(base, path, method="GET", body=None, timeout=5):
    """返回 (status|None, text, ms)"""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), (time.time() - t0) * 1000
    except Exception as e:  # 连接被拒 / 超时 / DNS 失败
        return None, "%s: %s" % (type(e).__name__, e), (time.time() - t0) * 1000


# ----------------------------------------------------------------------
# 最小 WebSocket 客户端（RFC6455 握手 + 帧收发，无第三方依赖）
# ----------------------------------------------------------------------
def ws_connect(host, port, path, timeout=6):
    s = socket.create_connection((host, port), timeout=timeout)
    s.settimeout(timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        "GET %s HTTP/1.1\r\n"
        "Host: %s:%d\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Origin: http://%s:%d\r\n"
        "\r\n"
    ) % (path, host, port, key, host, port)
    s.sendall(req.encode("ascii"))
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(1)
        if not chunk:
            break
        buf += chunk
        if len(buf) > 8192:
            break
    head = buf.decode("latin-1", "replace")
    status_line = head.split("\r\n")[0].strip() if head else "(服务端无响应)"
    return s, status_line, head


def _read_exact(s, n):
    d = b""
    while len(d) < n:
        c = s.recv(n - len(d))
        if not c:
            raise ConnectionError("连接被服务端关闭")
        d += c
    return d


def ws_recv(s):
    """读一个帧：返回 (opcode, payload_bytes)"""
    b1 = _read_exact(s, 1)[0]
    b2 = _read_exact(s, 1)[0]
    opcode = b1 & 0x0F
    masked = b2 >> 7
    ln = b2 & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", _read_exact(s, 2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", _read_exact(s, 8))[0]
    mask = _read_exact(s, 4) if masked else None
    payload = _read_exact(s, ln) if ln else b""
    if mask:
        payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
    return opcode, payload


def ws_send_text(s, text):
    payload = text.encode("utf-8")
    mask = os.urandom(4)
    masked = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
    n = len(payload)
    if n < 126:
        hdr = bytes([0x81, 0x80 | n])
    elif n < 65536:
        hdr = bytes([0x81, 0x80 | 126]) + struct.pack(">H", n)
    else:
        hdr = bytes([0x81, 0x80 | 127]) + struct.pack(">Q", n)
    s.sendall(hdr + mask + masked)


def ws_wait_text(s, budget=6.0, label="首帧"):
    """在时间预算内等待一个文本帧，自动回 pong；返回 payload 文本或 None"""
    deadline = time.time() + budget
    while time.time() < deadline:
        s.settimeout(max(0.3, deadline - time.time()))
        try:
            opcode, payload = ws_recv(s)
        except socket.timeout:
            return None
        except Exception as e:
            log(WARN, "%s 读取中断：%s" % (label, e))
            return None
        if opcode == 0x1:
            return payload.decode("utf-8", "replace")
        if opcode == 0x9:  # ping → pong
            s.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
            continue
        if opcode == 0x8:
            log(WARN, "%s 收到 CLOSE 帧（服务端主动关闭）" % label)
            return None
    return None


# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="APK 内置信令服务三层探针")
    ap.add_argument("--host", required=True, help="手机的局域网 IP（如 192.168.43.1）；或 127.0.0.1（配合 adb forward）")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--token", default="", help="已有房间码，跳过 /create 直接测 WS")
    ap.add_argument("--role", default="host", choices=["host", "member"], help="ws 连接类型，默认 host")
    ap.add_argument("--quiet-http", action="store_true", help="跳过 /api/info 前后对比")
    args = ap.parse_args()

    base = "http://%s:%d" % (args.host, args.port)
    print("=" * 62)
    print("目标：%s   （手机需与电脑同网；127.0.0.1 仅在本机+端口转发时有效）" % base)
    print("=" * 62)

    # ---------------- L1: HTTP 层 ----------------
    print("\n--- L1  HTTP 层 (NanoHTTPD) ---")
    status, text, ms = http(base, "/health")
    if status == 200 and '"ok"' in text and "true" in text:
        log(OK, "GET /health  -> 200 %s  (%.0f ms)" % (text.strip(), ms))
        l1 = True
    elif status is None:
        log(BAD, "GET /health 失败：%s  —— 服务未启动 / 端口未监听 / 不在同一网络" % text)
        l1 = False
    else:
        log(BAD, "GET /health  -> HTTP %s %s" % (status, text.strip()[:120]))
        l1 = False

    if not l1:
        print("\n结论：L1 未通过，后续层无法验证。请先看手机通知栏是否有「P2P 弹幕对战 · 局域网服务」常驻通知；")
        print("      无通知 = ServerService 没起来（或被系统杀掉）；有通知但地址为 127.0.0.1 = 网卡未拿到局域网 IP。")
        return 3

    info_before = None
    if not args.quiet_http:
        status, text, ms = http(base, "/api/info")
        if status == 200:
            try:
                info_before = json.loads(text)
                log(OK, "GET /api/info -> ip=%s port=%s rooms=%s clients=%s lanIps=%s"
                    % (info_before.get("ip"), info_before.get("port"),
                       info_before.get("rooms"), info_before.get("clients"),
                       info_before.get("lanIps")))
                if info_before.get("ip") == "127.0.0.1":
                    log(WARN, "服务端报的 ip 是 127.0.0.1：手机当前没有 Wi-Fi/热点局域网地址，别人连不上（服务本身没坏）")
            except Exception as e:
                log(WARN, "/api/info 返回非 JSON：%s" % e)
        else:
            log(WARN, "GET /api/info -> %s %s" % (status, str(text)[:120]))

    # ---------------- L2: 信令 HTTP 接口 ----------------
    print("\n--- L2  信令接口 (POST /create) ---")
    token = args.token
    if token:
        log(OK, "使用命令行指定房间码 token=%s，跳过 /create" % token)
        l2 = True
    else:
        status, text, ms = http(base, "/create", method="POST", body={"name": "probe", "token": None})
        l2 = False
        if status == 200:
            try:
                data = json.loads(text)
                if data.get("ok") and data.get("token"):
                    token = data["token"]
                    log(OK, "POST /create -> 200 token=%s myId=%s  (%.0f ms)" % (token, data.get("myId"), ms))
                    l2 = True
                else:
                    log(BAD, "POST /create -> ok=false：%s" % text.strip()[:160])
            except Exception as e:
                log(BAD, "POST /create 返回非 JSON：%s 原文=%s" % (e, text.strip()[:160]))
        elif status == 405:
            log(BAD, "POST /create -> 405 method not allowed（路由只收 POST/PUT；若为跨源调用还需服务端支持 OPTIONS 预检）")
        elif status == 409:
            log(BAD, "POST /create -> 409 token in use（该自定义房间码已占用）")
        elif status is None:
            log(BAD, "POST /create 连接失败：%s" % text)
        else:
            log(BAD, "POST /create -> HTTP %s %s" % (status, text.strip()[:160]))
        if not l2:
            print("\n结论：L2 未通过 —— HTTP 服务活着，但建房接口不可用，信令链路不成立。")
            return 2

    # ---------------- L3: WebSocket 层 ----------------
    print("\n--- L3  WebSocket 层 (/ws, NanoWSD) ---")
    path = "/ws?token=%s&myId=uprobe%s&type=%s&name=probe&roleId=hero" % (token, int(time.time()) % 100000, args.role)
    try:
        sock, status_line, head = ws_connect(args.host, args.port, path)
    except Exception as e:
        log(BAD, "WS 握手发起失败：%s: %s" % (type(e).__name__, e))
        print("\n结论：L3 未通过 —— TCP 连上了但握手异常，检查 /ws 路由与 token 是否有效。")
        return 1

    if "101" in status_line:
        log(OK, "WS 握手成功：%s" % status_line)
    else:
        log(BAD, "WS 握手未升级：%s" % status_line)
        for ln in head.split("\r\n")[1:8]:
            if ln.strip():
                print("        %s" % ln.strip())
        sock.close()
        print("\n结论：L3 未通过 —— NanoWSD 未完成升级（token 不存在 / 路由未匹配 / 被拒）。")
        return 1

    first = ws_wait_text(sock, budget=6.0, label="joined 首帧")
    l3 = False
    if first:
        log(OK, "收到首帧：%s" % first[:220])
        if '"joined"' in first:
            l3 = True
        else:
            log(WARN, "首帧不是 joined（可能服务端先推别的帧），已建立会话但需人工确认内容")
            l3 = True
    else:
        log(BAD, "6 秒内未收到任何文本帧（NanoWSD 空闲 5 秒会被 SO_TIMEOUT 强杀，见 SignalServer L116 注释）")

    if l3:
        probe = json.dumps({"t": "probe", "ts": int(time.time() * 1000)})
        try:
            ws_send_text(sock, probe)
            log(OK, "已发送应用帧：%s" % probe)
            echo = ws_wait_text(sock, budget=4.0, label="回帧")
            if echo:
                log(OK, "收到服务端回帧：%s" % echo[:220])
            else:
                log(WARN, "未收到回帧（音信令帧本就可能是单向广播，不一定是故障）")
        except Exception as e:
            log(WARN, "发送失败：%s" % e)

        if not args.quiet_http:
            status, text, ms = http(base, "/api/info")
            if status == 200:
                try:
                    info_after = json.loads(text)
                    b, a = info_before or {}, info_after
                    log(OK, "连接后 /api/info -> rooms=%s clients=%s（连接前 rooms=%s clients=%s）"
                        % (a.get("rooms"), a.get("clients"), b.get("rooms"), b.get("clients")))
                    if b and a.get("clients") is not None and b.get("clients") is not None:
                        if a["clients"] > b["clients"]:
                            log(OK, "clients 计数上升 —— 服务端确实注册了本 WS 会话")
                        else:
                            log(WARN, "clients 未上升 —— 可能是握手后被立刻关闭，或多实例统计口径问题")
                except Exception as e:
                    log(WARN, "/api/info 解析失败：%s" % e)

    try:
        sock.close()
    except Exception:
        pass

    # ---------------- 汇总 ----------------
    print("\n" + "=" * 62)
    fails = [m for t, m in results if t == BAD]
    warns = [m for t, m in results if t == WARN]
    if not fails:
        print("结论：三层全通 —— HTTP 服务 / 信令接口 / WebSocket 服务均正常。")
        if warns:
            print("注意：%d 条警告（见上方 [WARN]），多为地址或单向帧导致，不影响服务可用性。" % len(warns))
        return 0
    print("结论：存在失败项 %d 条：" % len(fails))
    for m in fails:
        print("  - %s" % m)
    return 1


if __name__ == "__main__":
    sys.exit(main())
