#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Note-helper 本地服务

设计约束（来自规格说明）：
  - 零第三方依赖，只用 Python 标准库，保证整包可直接拷到别的电脑运行
  - 对源文件零写入：notes.md 与 slides.pdf 全程只读
  - 唯一写入点是每个模块目录下的 annotations.json

目录约定：
  courses/<课程名>/Module N/notes.md
  courses/<课程名>/Module N/slides.pdf
  courses/<课程名>/Module N/annotations.json   ← 自动生成

启动：python server.py [端口]
"""

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from tools.prepare_vendor import check_vendor, load_manifest

def runtime_roots(source_file, executable, frozen=False):
    """资源随程序定位；便携版数据始终在 exe 旁，不跟随工作目录或解包目录。"""
    resources = Path(source_file).resolve().parent
    home = Path(executable).resolve().parent if frozen else resources
    return resources, home


ROOT, APP_HOME = runtime_roots(__file__, sys.executable, getattr(sys, "frozen", False))
COURSES = APP_HOME / "courses"
WEB = ROOT / "web"
HOST = "127.0.0.1"
DEFAULT_PORT = 8765

# 模块目录名规范化：Module 3 / Module_3 / Module3 / Module-3 都能认
MODULE_RE = re.compile(r"^Module[\s_\-]*(\d+)\b", re.IGNORECASE)
SLIDES_NAMES = ("slides.pdf", "slides.PDF")
ANNO_NAME = "annotations.json"
NOTES_NAME = "notes.md"
ANNO_LOCK = threading.RLock()
MAX_ANNO_BYTES = 8 * 1024 * 1024


class AnnotationError(ValueError):
    """批注无法安全读取或保存。"""


class AnnotationConflict(AnnotationError):
    pass


# --------------------------------------------------------------------------- #
# 磁盘层
# --------------------------------------------------------------------------- #

def find_slides(mod_dir: Path):
    for n in SLIDES_NAMES:
        p = mod_dir / n
        if p.is_file():
            return p
    pdfs = sorted(mod_dir.glob("*.pdf"))
    return pdfs[0] if pdfs else None


def module_sort_key(d: Path):
    m = MODULE_RE.match(d.name)
    return (0, int(m.group(1)), d.name) if m else (1, 0, d.name)


def discover():
    """扫描 courses/ 下全部课程与模块。"""
    out = []
    if not COURSES.is_dir():
        return out
    for course_dir in sorted([p for p in COURSES.iterdir() if p.is_dir()], key=lambda p: p.name):
        for mod_dir in sorted([p for p in course_dir.iterdir() if p.is_dir()], key=module_sort_key):
            m = MODULE_RE.match(mod_dir.name)
            if not m:
                continue
            notes = mod_dir / NOTES_NAME
            slides = find_slides(mod_dir)
            out.append({
                "course": course_dir.name,
                "module": mod_dir.name,
                "id": "%s/%s" % (course_dir.name, mod_dir.name),
                "label": "Module %s" % m.group(1),
                "num": int(m.group(1)),
                "hasNotes": notes.is_file(),
                "hasSlides": slides is not None,
            })
    return out


def resolve(course_name, module_name):
    """只在已发现的模块里找，借此天然挡掉路径穿越。"""
    for item in discover():
        if item["course"] == course_name and item["module"] == module_name:
            mod_dir = COURSES / course_name / module_name
            return {
                "dir": mod_dir,
                "notes": mod_dir / NOTES_NAME,
                "slides": find_slides(mod_dir),
                "anno": mod_dir / ANNO_NAME,
            }
    return None


def read_text(path: Path):
    if path is None or not path.is_file():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def validate_anno(data):
    if not isinstance(data, dict):
        raise AnnotationError("批注必须是 JSON 对象。")
    if type(data.get("version", 1)) is not int or data.get("version", 1) != 1:
        raise AnnotationError("不支持此批注版本，请保留原文件并使用对应版本的程序。")
    for key in ("blocks", "meta", "pages"):
        if not isinstance(data.get(key, {}), dict):
            raise AnnotationError("批注字段 %s 必须是对象。" % key)
    for record in data.get("blocks", {}).values():
        if not isinstance(record, dict):
            raise AnnotationError("批注块记录必须是对象。")
        for key, kind in (("note", str), ("mastered", bool), ("h", str)):
            if key in record and not isinstance(record[key], kind):
                raise AnnotationError("批注块字段 %s 类型不正确。" % key)
        if record.get("color") not in (None, "yellow", "blue", "red"):
            raise AnnotationError("批注颜色不正确。")
    for page, record in data.get("pages", {}).items():
        if not re.fullmatch(r"[1-9]\d*", page) or not isinstance(record, dict):
            raise AnnotationError("课件页标记格式不正确。")
        if any(key in record and type(record[key]) is not bool for key in ("star", "flag")):
            raise AnnotationError("课件页标记必须为布尔值。")
    orphans = data.get("meta", {}).get("orphans", [])
    if not isinstance(orphans, list) or any(not isinstance(item, dict) for item in orphans):
        raise AnnotationError("批注留档字段格式不正确。")
    return data


def reject_constant(value):
    raise AnnotationError("批注不能包含 %s。" % value)


def read_anno_snapshot(path: Path):
    """不存在与损坏必须区分；内容摘要用于检测其他窗口或外部修改。"""
    try:
        with path.open("rb") as source:
            raw = source.read(MAX_ANNO_BYTES + 1)
    except FileNotFoundError:
        return {"version": 1, "blocks": {}, "meta": {}}, '"missing"'
    except OSError as exc:
        raise AnnotationError("无法读取批注，请检查目录权限；原文件未修改。") from exc
    if len(raw) > MAX_ANNO_BYTES:
        raise AnnotationError("批注文件超过安全读取上限，已阻止覆盖；请保留原文件后检查。")
    try:
        data = validate_anno(json.loads(raw.decode("utf-8"), parse_constant=reject_constant))
    except (ValueError, UnicodeError) as exc:
        raise AnnotationError("批注文件损坏或格式不支持，已阻止覆盖；请保留原文件后检查。") from exc
    data.setdefault("version", 1)
    data.setdefault("blocks", {})
    data.setdefault("meta", {})
    return data, '"%s"' % hashlib.sha256(raw).hexdigest()


def read_anno(path: Path):
    return read_anno_snapshot(path)[0]


def write_anno(path: Path, payload, expected_revision):
    """串行检查版本 + 唯一临时文件 + 原子替换；失败不覆盖原批注。"""
    validate_anno(payload)
    raw = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    if len(raw) > MAX_ANNO_BYTES:
        raise AnnotationError("批注过大，无法安全保存。")
    with ANNO_LOCK:
        _, current = read_anno_snapshot(path)
        if expected_revision != current:
            raise AnnotationConflict("批注已被其他窗口或程序修改，已阻止覆盖。请先保留当前修改，再重新载入。")
        tmp = None
        try:
            with tempfile.NamedTemporaryFile(dir=str(path.parent), prefix=".annotations-", suffix=".tmp", delete=False) as f:
                tmp = Path(f.name)
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            os.replace(str(tmp), str(path))
        finally:
            if tmp is not None and tmp.exists():
                tmp.unlink()
    return '"%s"' % hashlib.sha256(raw).hexdigest()


# --------------------------------------------------------------------------- #
# HTTP 层
# --------------------------------------------------------------------------- #

CTYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".woff2": "font/woff2",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "NoteHelper/0.1"
    protocol_version = "HTTP/1.1"
    timeout = 60          # 空闲 keep-alive 连接自行超时，别永久挂着

    # 静默：按规格要求，后台日志不刷屏
    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # 禁止远程资源和动态求值；保留现有主题初始化与诊断页的内联脚本。
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; "
                         "style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; img-src 'self'; "
                         "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _valid_host(self):
        return self.headers.get("Host") in {"127.0.0.1:%d" % self.server.server_port,
                                           "localhost:%d" % self.server.server_port}

    def handle_one_request(self):
        """浏览器/客户端提前断开是常态，不该在控制台喷一堆 traceback。"""
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError,
                BrokenPipeError, TimeoutError):
            self.close_connection = True

    # ---------------- 基础输出 ---------------- #

    def _send(self, body: bytes, ctype: str, code=200, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _json(self, obj, code=200, extra=None):
        self._send(json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8", code, extra)

    def _err(self, code, msg):
        self._json({"error": msg}, code)

    def _serve_path(self, path: Path):
        """支持 Range 的文件输出，pdf.js 需要它来做分段加载。"""
        if not path.is_file():
            return self._err(404, "not found: %s" % path.name)
        size = path.stat().st_size
        ctype = CTYPES.get(path.suffix.lower(), "application/octet-stream")
        start, end, partial = 0, size - 1, False

        rng = self.headers.get("Range") or ""
        if rng.startswith("bytes="):
            m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if m:
                g1, g2 = m.group(1), m.group(2)
                if not g1 and g2:
                    # suffix range：bytes=-500 要的是"最后 500 字节"，
                    # 不是"从 0 到 500"。这里空着不写会把文件头当成答案返回，
                    # 结果是播放器/阅读器拿到一段完全不相干的数据。
                    n = int(g2)
                    if n <= 0:
                        start = size            # 交给下面的 416 分支
                    else:
                        start = max(0, size - n)
                        end = size - 1
                else:
                    if g1:
                        start = int(g1)
                    if g2:
                        end = int(g2)
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                end = min(end, size - 1)
                partial = True

        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(262144, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    return
                left -= len(chunk)

    # ---------------- 路由 ---------------- #

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._valid_host():
            return self._err(403, "请使用启动时显示的本机地址访问。")
        u = urlparse(self.path)
        path = unquote(u.path)
        if path.startswith("/api/"):
            return self._api_get(path)
        return self._static(path)

    def do_POST(self):
        # 拒绝网页跨站写入，并在拒绝正文时关闭连接，避免剩余正文被当成下一条请求。
        self.close_connection = True
        if not self._valid_host():
            return self._err(403, "请使用启动时显示的本机地址访问。")
        origin = self.headers.get("Origin")
        allowed_origins = {"http://127.0.0.1:%d" % self.server.server_port,
                           "http://localhost:%d" % self.server.server_port}
        if origin is not None and origin not in allowed_origins:
            return self._err(403, "拒绝跨站保存。")
        if self.headers.get_content_type() != "application/json":
            return self._err(415, "保存需要 application/json。")
        revision = self.headers.get("If-Match")
        if not revision:
            return self._err(428, "缺少批注版本，请刷新页面后重试。")
        u = urlparse(self.path)
        path = unquote(u.path)
        parts = [p for p in path.split("/") if p]
        # /api/module/<course>/<module>/annotations
        if len(parts) == 5 and parts[0] == "api" and parts[1] == "module" and parts[4] == "annotations":
            hit = resolve(parts[2], parts[3])
            if not hit:
                return self._err(404, "module not found")
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n < 1 or n > MAX_ANNO_BYTES or self.headers.get("Transfer-Encoding"):
                    return self._err(413, "批注正文为空、过大或传输格式不支持。")
                raw = self.rfile.read(n)
                if len(raw) != n:
                    return self._err(400, "批注正文不完整。")
                payload = json.loads(raw.decode("utf-8"), parse_constant=reject_constant)
                validate_anno(payload)
            except (ValueError, UnicodeError):
                return self._err(400, "批注 JSON 或字段格式不正确。")
            try:
                new_revision = write_anno(hit["anno"], payload, revision)
            except AnnotationConflict as exc:
                return self._err(409, str(exc))
            except AnnotationError as exc:
                return self._err(409, str(exc))
            except (OSError, ValueError):
                return self._err(500, "写入失败，原批注未替换。请检查磁盘空间及目录权限后重试。")
            return self._json({"ok": True, "savedAt": payload.get("savedAt")}, extra={"ETag": new_revision})
        return self._err(404, "no such endpoint")

    # ---------------- API ---------------- #

    def _api_get(self, path):
        parts = [p for p in path.split("/") if p]
        if parts == ["api", "modules"]:
            return self._json({"root": str(APP_HOME), "courses": str(COURSES), "modules": discover()})

        if len(parts) >= 5 and parts[0] == "api" and parts[1] == "module":
            course, module, action = parts[2], parts[3], parts[4]
            hit = resolve(course, module)
            if not hit:
                return self._err(404, "module not found")
            if action == "notes":
                return self._json({
                    "course": course, "module": module,
                    "markdown": read_text(hit["notes"]),
                    "hasNotes": hit["notes"].is_file(),
                })
            if action == "annotations":
                try:
                    with ANNO_LOCK:
                        data, revision = read_anno_snapshot(hit["anno"])
                except AnnotationError as exc:
                    return self._err(409, str(exc))
                return self._json(data, extra={"ETag": revision})
            if action == "pdf":
                if not hit["slides"]:
                    return self._err(404, "no slides.pdf in this module")
                return self._serve_path(hit["slides"])
        return self._err(404, "no such endpoint")

    # ---------------- 静态文件 ---------------- #

    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        target = (WEB / rel).resolve()
        try:
            target.relative_to(WEB.resolve())
        except ValueError:
            return self._err(403, "forbidden")
        if target.is_dir():
            target = target / "index.html"
        return self._serve_path(target)


# --------------------------------------------------------------------------- #
# 启动
# --------------------------------------------------------------------------- #

def check_environment():
    """启动前检查；只创建并自动清理一个目录写权限探针。"""
    if sys.version_info < (3, 8):
        raise RuntimeError("需要 Python 3.8 或更新版本。")
    required = ("index.html", "style.css", "js/app.js", "js/notes.js",
                "js/pdfview.js", "vendor/marked.min.js", "vendor/pdf.min.js",
                "vendor/pdf.worker.min.js")
    missing = [name for name in required if not (WEB / name).is_file()]
    if not (WEB / "vendor/cmaps").is_dir() or not any((WEB / "vendor/cmaps").glob("*.bcmap")):
        missing.append("vendor/cmaps/*.bcmap")
    if missing:
        raise RuntimeError("缺少前端资源：%s。请按依赖清单准备资源后重试。" % "、".join(missing))
    try:
        missing, changed = check_vendor(load_manifest(ROOT / "vendor-manifest.json"), WEB / "vendor")
        if missing or changed:
            raise ValueError("缺少 %d 个，校验不符 %d 个" % (len(missing), len(changed)))
    except (OSError, ValueError, KeyError) as exc:
        raise RuntimeError("前端依赖校验失败：%s。请运行 python tools/prepare_vendor.py --check；程序不会自动下载或覆盖资源。" % exc) from exc
    try:
        COURSES.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=str(COURSES)) as probe:
            probe.write(b"check")
            probe.flush()
    except OSError as exc:
        raise RuntimeError("课程目录不可写，请把项目放到有写权限的目录。") from exc


def create_server(preferred):
    """直接绑定实际服务端口，避免探测后再绑定的竞争窗口。"""
    last_error = None
    for port in range(preferred, min(preferred + 20, 65536)):
        try:
            return ThreadingHTTPServer((HOST, port), Handler)
        except OSError as exc:
            last_error = exc
    raise RuntimeError("端口 %d–%d 均无法绑定，请关闭占用程序或指定其他端口。" %
                       (preferred, min(preferred + 19, 65535))) from last_error


def main():
    parser = argparse.ArgumentParser(description="Note-helper 本地阅读服务")
    parser.add_argument("port", nargs="?", type=int, default=DEFAULT_PORT)
    parser.add_argument("--check", action="store_true", help="只检查运行条件，不启动浏览器或服务")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1–65535 之间")
    try:
        check_environment()
        if args.check:
            print("运行条件检查通过。")
            return 0
        httpd = create_server(args.port)
    except RuntimeError as exc:
        print("启动失败：%s" % exc, file=sys.stderr)
        return 1
    port = httpd.server_port
    mods = discover()

    url = "http://%s:%d/" % (HOST, port)
    print("=" * 52)
    print("  Note-helper")
    print("=" * 52)
    print("  课程目录 : %s" % COURSES)
    print("  已发现   : %d 个模块" % len(mods))
    for m in mods:
        flags = []
        if m["hasNotes"]:
            flags.append("笔记")
        if m["hasSlides"]:
            flags.append("课件")
        print("    - %-8s %-28s [%s]" % (m["label"], m["course"], "+".join(flags) or "空"))
    print("  地址     : %s" % url)
    print("  停止     : Ctrl+C")
    print("=" * 52)

    if os.environ.get("NOTE_HELPER_NO_OPEN") != "1":
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    result = main()
    # 双击便携 exe 启动失败时保留错误；命令行检查和重定向运行不等待输入。
    if result and getattr(sys, "frozen", False) and "--check" not in sys.argv and sys.stdin.isatty():
        try:
            input("按回车关闭窗口……")
        except (EOFError, KeyboardInterrupt):
            pass
    sys.exit(result)
