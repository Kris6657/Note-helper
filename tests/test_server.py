"""隔离回归：python -m unittest discover -s tests -v（不读写真实课程）。"""
import hashlib
import http.client
import io
import json
import socket
import tempfile
import tarfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import server
from tools import prepare_vendor


class RuntimePathTests(unittest.TestCase):
    def test_source_keeps_existing_courses_location(self):
        with tempfile.TemporaryDirectory(prefix="note-helper paths 中文 ") as tmp:
            root = Path(tmp)
            resources, home = server.runtime_roots(root / "server.py", root / "python/python.exe")
            self.assertEqual(resources, root.resolve())
            self.assertEqual(home, root.resolve())

    def test_frozen_resources_and_user_data_are_separate(self):
        with tempfile.TemporaryDirectory(prefix="note-helper portable 中文 ") as tmp:
            root = Path(tmp)
            resources, home = server.runtime_roots(root / "_internal/server.py", root / "Note-helper.exe", True)
            self.assertEqual(resources, root.resolve() / "_internal")
            self.assertEqual(home / "courses", root.resolve() / "courses")
            self.assertNotEqual(home, resources)


class AnnotationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="note-helper annotations 中文 ")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "annotations.json"
        self.payload = {"version": 1, "blocks": {"b0": {"note": "保留", "mastered": True}},
                        "meta": {"extra": [1]}, "pages": {"2": {"star": True, "flag": False}},
                        "extension": {"keep": True}}

    def test_missing_file_has_distinct_revision(self):
        data, tag = server.read_anno_snapshot(self.path)
        self.assertEqual(data["blocks"], {})
        self.assertEqual(tag, '"missing"')
        self.assertFalse(self.path.exists())

    def test_roundtrip_preserves_all_fields_and_revision(self):
        tag = server.write_anno(self.path, self.payload, '"missing"')
        self.assertEqual(server.read_anno_snapshot(self.path), (self.payload, tag))
        self.assertIn(hashlib.sha256(self.path.read_bytes()).hexdigest(), tag)

    def test_corrupt_or_unsupported_file_cannot_be_overwritten(self):
        for raw in (b'{"blocks":', b'[]', b'{"blocks":[]}', b'\xff',
                    b'{"version":2}', b'{"meta":{"orphans":{}}}', b'{"x":NaN}'):
            with self.subTest(raw=raw):
                self.path.write_bytes(raw)
                with self.assertRaises(server.AnnotationError):
                    server.read_anno_snapshot(self.path)
                with self.assertRaises(server.AnnotationError):
                    server.write_anno(self.path, self.payload, '"missing"')
                self.assertEqual(self.path.read_bytes(), raw)

    def test_stale_snapshot_rejected_and_latest_kept(self):
        tag = server.write_anno(self.path, self.payload, '"missing"')
        newer = {**self.payload, "savedAt": 2}
        server.write_anno(self.path, newer, tag)
        with self.assertRaises(server.AnnotationConflict):
            server.write_anno(self.path, self.payload, tag)
        self.assertEqual(server.read_anno(self.path), newer)

    def test_oversized_existing_file_is_not_treated_as_empty(self):
        self.path.write_bytes(b" " * 65)
        with patch.object(server, "MAX_ANNO_BYTES", 64):
            with self.assertRaisesRegex(server.AnnotationError, "安全读取上限"):
                server.read_anno_snapshot(self.path)
        self.assertEqual(len(self.path.read_bytes()), 65)

    def test_failed_atomic_replace_keeps_original_and_cleans_temp(self):
        tag = server.write_anno(self.path, self.payload, '"missing"')
        original = self.path.read_bytes()
        with patch.object(server.os, "replace", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError):
                server.write_anno(self.path, {**self.payload, "savedAt": 3}, tag)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.path.parent.glob(".annotations-*.tmp")), [])

    def test_concurrent_writers_cannot_both_replace_same_revision(self):
        def save(index):
            try:
                server.write_anno(self.path, {**self.payload, "savedAt": index}, '"missing"')
                return "saved"
            except server.AnnotationConflict:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(pool.map(save, (1, 2)), ("saved", "conflict"))
        self.assertIn(server.read_anno(self.path)["savedAt"], (1, 2))


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="note-helper HTTP 中文 ")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.mod = self.root / "courses" / "demo" / "Module 1"
        self.mod.mkdir(parents=True)
        (self.mod / "notes.md").write_text("# 示例（P1）", encoding="utf-8")
        self.patcher = patch.multiple(server, ROOT=self.root, COURSES=self.root / "courses", WEB=self.root / "web")
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.httpd = server.ThreadingHTTPServer((server.HOST, 0), server.Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.url = "/api/module/demo/Module%201/annotations"

    def close_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()

    def request(self, method="GET", body=None, headers=None, url=None):
        conn = http.client.HTTPConnection(server.HOST, self.httpd.server_port, timeout=3)
        try:
            conn.request(method, url or self.url, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            conn.close()

    def test_get_post_and_stale_post(self):
        status, headers, data = self.request()
        self.assertEqual(status, 200)
        body = json.dumps({**data, "extension": "kept"})
        h = {"Content-Type": "application/json", "If-Match": headers["ETag"]}
        status, headers, _ = self.request("POST", body, h)
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["ETag"], h["If-Match"])
        self.assertEqual(self.request("POST", body, h)[0], 409)
        self.assertEqual(self.request()[2]["extension"], "kept")

    def test_corrupt_get_is_error_and_post_does_not_change_file(self):
        path = self.mod / "annotations.json"
        path.write_bytes(b'{"unfinished":')
        self.assertEqual(self.request()[0], 409)
        h = {"Content-Type": "application/json", "If-Match": '"missing"'}
        self.assertEqual(self.request("POST", "{}", h)[0], 409)
        self.assertEqual(path.read_bytes(), b'{"unfinished":')

    def test_reject_unsafe_or_invalid_writes_without_creating_file(self):
        cases = [({"Content-Type": "text/plain"}, "{}", 415),
                 ({"Content-Type": "application/json"}, "{}", 428),
                 ({"Content-Type": "application/json", "If-Match": '"missing"',
                   "Origin": "https://example.invalid"}, "{}", 403),
                 ({"Content-Type": "application/json", "If-Match": '"missing"'}, "[]", 400),
                 ({"Content-Type": "application/json", "If-Match": '"missing"'}, '{"blocks":[]}', 400),
                 ({"Content-Type": "application/json", "If-Match": '"missing"',
                   "Content-Length": str(server.MAX_ANNO_BYTES + 1)}, "{}", 413)]
        for headers, body, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(self.request("POST", body, headers)[0], expected)
        self.assertFalse((self.mod / "annotations.json").exists())

    def test_same_origin_post_and_notes_stay_readonly(self):
        notes = (self.mod / "notes.md").read_bytes()
        headers = {"Content-Type": "application/json", "If-Match": '"missing"',
                   "Origin": "http://127.0.0.1:%d" % self.httpd.server_port}
        self.assertEqual(self.request("POST", '{"blocks":{}}', headers)[0], 200)
        self.assertEqual((self.mod / "notes.md").read_bytes(), notes)

    def test_reject_foreign_host_and_disable_dynamic_evaluation(self):
        self.assertEqual(self.request(headers={"Host": "example.invalid"})[0], 403)
        _, headers, _ = self.request()
        policy = headers["Content-Security-Policy"]
        self.assertNotIn("unsafe-eval", policy)
        self.assertIn("object-src 'none'", policy)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")


class StartupTests(unittest.TestCase):
    def test_occupied_port_uses_next_bound_port(self):
        with socket.socket() as occupied:
            occupied.bind((server.HOST, 0))
            occupied.listen()
            preferred = occupied.getsockname()[1]
            httpd = server.create_server(preferred)
            self.addCleanup(httpd.server_close)
            self.assertGreater(httpd.server_port, preferred)

    def test_all_bind_failures_have_actionable_error(self):
        with patch.object(server, "ThreadingHTTPServer", side_effect=OSError("busy")):
            with self.assertRaisesRegex(RuntimeError, "均无法绑定"):
                server.create_server(8765)

    def test_missing_resources_fail_before_creating_courses(self):
        with tempfile.TemporaryDirectory(prefix="note-helper tests 中文 ") as tmp:
            root = Path(tmp)
            with patch.object(server, "WEB", root / "web"), patch.object(server, "COURSES", root / "courses"):
                with self.assertRaisesRegex(RuntimeError, "缺少前端资源"):
                    server.check_environment()
            self.assertFalse((root / "courses").exists())

    def test_old_python_is_rejected(self):
        with patch.object(server.sys, "version_info", (3, 7)):
            with self.assertRaisesRegex(RuntimeError, "Python 3.8"):
                server.check_environment()

    def test_unwritable_courses_has_actionable_error(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(server, "COURSES", Path(tmp)), \
                patch.object(server, "check_vendor", return_value=([], [])), \
                patch.object(server.tempfile, "TemporaryFile", side_effect=PermissionError("denied")):
            with self.assertRaisesRegex(RuntimeError, "课程目录不可写"):
                server.check_environment()


class VendorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="note-helper vendor 中文 ")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.destination = self.root / "fresh vendor"
        self.asset = b"/* synthetic fixture, no real library */"
        self.archive = self.root / "fixture.tgz"
        self.make_archive()

    def make_archive(self, symlink=False):
        with tarfile.open(self.archive, "w:gz") as archive:
            info = tarfile.TarInfo("package/sample.js")
            info.size = len(self.asset)
            if symlink:
                info.type = tarfile.SYMTYPE
                info.linkname = "../../outside"
                info.size = 0
                archive.addfile(info)
            else:
                archive.addfile(info, io.BytesIO(self.asset))
        self.package = {"name": "fixture", "version": "1.0.0",
                        "archive": "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
                        "archiveSha256": hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                        "files": [{"source": "package/sample.js", "target": "sub/sample.js",
                                   "sha256": hashlib.sha256(self.asset).hexdigest()}]}
        self.manifest = {"schemaVersion": 1, "packages": [self.package]}

    def test_check_is_readonly_and_never_downloads(self):
        with patch.object(prepare_vendor.urllib.request, "urlopen", side_effect=AssertionError("network")):
            self.assertEqual(prepare_vendor.check_vendor(self.manifest, self.destination), (["sub/sample.js"], []))
        self.assertFalse(self.destination.exists())

    def test_prepare_without_explicit_download_stays_offline(self):
        with patch.object(prepare_vendor.urllib.request, "urlopen", side_effect=AssertionError("network")):
            with self.assertRaisesRegex(ValueError, "缺少本地依赖包"):
                prepare_vendor.prepare(self.manifest, self.destination)
        self.assertFalse(self.destination.exists())

    def test_offline_archive_prepares_and_second_run_is_noop(self):
        archives = {"fixture": self.archive}
        with patch.object(prepare_vendor.urllib.request, "urlopen", side_effect=AssertionError("network")):
            self.assertEqual(prepare_vendor.prepare(self.manifest, self.destination, archives), 1)
            self.assertEqual(prepare_vendor.prepare(self.manifest, self.destination, archives), 0)
        self.assertEqual((self.destination / "sub/sample.js").read_bytes(), self.asset)

    def test_changed_existing_resource_is_never_overwritten(self):
        path = self.destination / "sub/sample.js"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"local change")
        with self.assertRaisesRegex(ValueError, "未覆盖"):
            prepare_vendor.prepare(self.manifest, self.destination, {"fixture": self.archive})
        self.assertEqual(path.read_bytes(), b"local change")

    def test_bad_archive_checksum_writes_nothing(self):
        self.package["archiveSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "依赖包 SHA-256"):
            prepare_vendor.prepare(self.manifest, self.destination, {"fixture": self.archive})
        self.assertFalse(self.destination.exists())

    def test_bad_asset_checksum_writes_nothing(self):
        self.package["files"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "依赖文件 SHA-256"):
            prepare_vendor.prepare(self.manifest, self.destination, {"fixture": self.archive})
        self.assertFalse(self.destination.exists())

    def test_symlink_archive_member_is_rejected(self):
        self.make_archive(symlink=True)
        with self.assertRaisesRegex(ValueError, "成员类型"):
            prepare_vendor.prepare(self.manifest, self.destination, {"fixture": self.archive})
        self.assertFalse(self.destination.exists())

    def test_path_traversal_is_rejected(self):
        for value in ("../escape", "/absolute", "sub/../../escape", "C:/outside", "sub\\escape", "a//b"):
            with self.subTest(path=value), self.assertRaises(ValueError):
                prepare_vendor.target_path(self.destination, value)

    def test_manifest_rejects_foreign_download_source(self):
        self.package["archive"] = "https://example.invalid/fixture.tgz"
        path = self.root / "manifest.json"
        path.write_text(json.dumps(self.manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "npm 官方来源"):
            prepare_vendor.load_manifest(path)


if __name__ == "__main__":
    unittest.main()
