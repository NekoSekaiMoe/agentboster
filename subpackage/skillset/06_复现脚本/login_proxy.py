#!/usr/bin/env python3
"""豆包登录 Cookie 捕获代理
反向代理 http://localhost:8899 -> https://www.doubao.com
- 捕获所有 Set-Cookie / 请求 Cookie 到 /tmp/doubao_skills/cookies_captured.log
- 重写 Cookie Domain/Secure 使浏览器在 localhost 保存会话
- 重写页面里的绝对 URL 让请求继续走代理
"""
import http.server, socketserver, urllib.request, urllib.error, ssl, re, time, sys, os

PORT = 8899
_BASE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(_BASE, "cookies_captured.log")
BODYLOG = os.path.join(_BASE, "api_bodies.log")
LOCAL = f"http://localhost:{PORT}"
ctx = ssl.create_default_context()

SUBDOMAINS = ["accounts", "passport", "api-normal", "beta", "browser", "samantha"]

def rewrite_body(data: bytes) -> bytes:
    data = data.replace(b"https://www.doubao.com", LOCAL.encode())
    for s in SUBDOMAINS:
        data = data.replace(f"https://{s}.doubao.com".encode(),
                            f"{LOCAL}/__via/{s}".encode())
    return data

def rewrite_url_back(val: str) -> str:
    val = val.replace(LOCAL, "https://www.doubao.com")
    m = re.match(rf"{re.escape(LOCAL)}/__via/([a-z0-9-]+)/?(.*)", val)
    if m:
        host = m.group(1)
        rest = m.group(2)
        val = f"https://{host}.doubao.com/{rest}"
    return val

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path[:120]))

    def do_ANY(self):
        target_host = "www.doubao.com"
        path = self.path
        if path.startswith("/__via/"):
            parts = path[len("/__via/"):].split("/", 1)
            target_host = parts[0] + ".doubao.com"
            path = "/" + (parts[1] if len(parts) > 1 else "")

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        url = f"https://{target_host}{path}"
        req = urllib.request.Request(url, data=body, method=self.command)
        skip = {"host", "accept-encoding", "connection", "x-target-host",
                "referer", "origin", "content-length"}
        for k, v in self.headers.items():
            if k.lower() in skip:
                continue
            req.add_header(k, v)
        req.add_header("Host", target_host)
        if self.headers.get("Origin"):
            req.add_header("Origin", f"https://{target_host}")
        if self.headers.get("Referer"):
            req.add_header("Referer", f"https://{target_host}/")

        try:
            resp = urllib.request.urlopen(req, context=ctx, timeout=30)
        except urllib.error.HTTPError as e:
            resp = e
        except Exception as e:
            self.send_error(502, str(e))
            return

        data = resp.read()

        # 记录 cookie + alice/samantha 接口报文
        try:
            with open(LOG, "a") as f:
                ts = time.strftime("%H:%M:%S")
                for hdr, val in resp.getheaders():
                    if hdr.lower() == "set-cookie":
                        f.write(f"[{ts}] SET {target_host} | {val}\n")
                ck = self.headers.get("Cookie")
                if ck and ("sessionid" in ck or "sid_guard" in ck):
                    f.write(f"[{ts}] REQ {target_host} | {ck}\n")
                if "/alice/" in path or "/samantha/" in path:
                    with open(BODYLOG, "a") as bf:
                        bf.write(f"\n[{ts}] {self.command} {target_host}{path[:200]}\n")
                        if body:
                            bf.write(f"REQ-BODY: {body[:2000].decode('utf-8', errors='replace')}\n")
                        bf.write(f"RESP({resp.status if hasattr(resp,'status') else resp.code}): {data[:3000].decode('utf-8', errors='replace')}\n")
        except Exception:
            pass

        ctype = resp.headers.get("Content-Type", "") or ""
        if any(t in ctype for t in ("text/", "javascript", "json", "html")):
            data = rewrite_body(data)

        self.send_response(resp.status if hasattr(resp, "status") else resp.code)
        for hdr, val in resp.getheaders():
            l = hdr.lower()
            if l in ("content-length", "transfer-encoding", "content-encoding",
                     "content-security-policy", "x-frame-options",
                     "strict-transport-security", "connection"):
                continue
            if l == "set-cookie":
                val = re.sub(r";\s*Domain=[^;]+", "", val, flags=re.I)
                val = re.sub(r";\s*Secure(?=[;\s]|$)", "", val, flags=re.I)
                val = re.sub(r";\s*SameSite=[^;]+", "", val, flags=re.I)
            if l == "location":
                val = rewrite_body(val.encode()).decode()
            self.send_header(hdr, val)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = do_OPTIONS = do_PATCH = do_ANY


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    print(f"代理已启动: {LOCAL}  ->  https://www.doubao.com")
    print(f"Cookie 日志: 脚本同目录 cookies_captured.log")
    Server(("0.0.0.0", PORT), Handler).serve_forever()
