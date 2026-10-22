"""前端依赖准备（纯标准库；默认只读检查，--download 才联网）。

python tools/prepare_vendor.py --check
python tools/prepare_vendor.py --archive pdfjs-dist=路径.tgz --archive marked=路径.tgz
python tools/prepare_vendor.py --download

只补齐缺失文件；已有文件校验不符时停止，不覆盖、不安装 npm 或系统组件。
"""
import argparse
import hashlib
import json
import re
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
MAX_ARCHIVE_BYTES = 40 * 1024 * 1024
MAX_ASSET_BYTES = 8 * 1024 * 1024


def relative_name(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ValueError("清单路径不安全")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or value != path.as_posix() or path == PurePosixPath("."):
        raise ValueError("清单路径不安全")
    return value


def load_manifest(path=ROOT / "vendor-manifest.json"):
    manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("packages"), list):
        raise ValueError("依赖清单版本不支持")
    seen = set()
    names = set()
    for package in manifest["packages"]:
        name, version = package["name"], package["version"]
        if name in names or not re.fullmatch(r"[a-z0-9-]+", name) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError("依赖名称或版本不正确")
        names.add(name)
        expected = "https://registry.npmjs.org/%s/-/%s-%s.tgz" % (name, name, version)
        if package["archive"] != expected or not re.fullmatch(r"[0-9a-f]{64}", package["archiveSha256"]):
            raise ValueError("只允许清单固定的 npm 官方来源与 SHA-256")
        for item in package["files"]:
            target = relative_name(item["target"])
            source = relative_name(item["source"])
            if not source.startswith("package/") or target in seen or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]):
                raise ValueError("依赖文件路径、校验值或重复项不正确")
            seen.add(target)
    if not names or not seen:
        raise ValueError("依赖清单不能为空")
    return manifest


def target_path(destination, name):
    root = Path(destination).resolve()
    path = root / relative_name(name)
    try:
        path.resolve().relative_to(root)
    except ValueError as exc:
        raise ValueError("资源路径超出目标目录") from exc
    return path


def check_vendor(manifest, destination):
    missing, changed = [], []
    for package in manifest["packages"]:
        for item in package["files"]:
            path = target_path(destination, item["target"])
            if not path.exists():
                missing.append(item["target"])
            elif (not path.is_file() or path.stat().st_size > MAX_ASSET_BYTES
                  or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]):
                changed.append(item["target"])
    return missing, changed


def download_archive(package, destination):
    # URL 由 load_manifest 限定为固定版本的 npm 官方地址。
    with urllib.request.urlopen(package["archive"], timeout=40) as response:
        if response.geturl() != package["archive"]:
            raise ValueError("依赖下载发生重定向，已停止")
        raw = response.read(MAX_ARCHIVE_BYTES + 1)
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise ValueError("依赖包过大")
    Path(destination).write_bytes(raw)


def prepare(manifest, destination, archives=None, allow_download=False):
    archives = archives or {}
    missing, changed = check_vendor(manifest, destination)
    if changed:
        raise ValueError("已有资源校验不符，已停止且未覆盖：" + "、".join(changed[:8]))
    if not missing:
        return 0
    needed = set(missing)
    staged = {}
    # 先验证全部需要的包与资源，成功后才向目标目录补文件。
    with tempfile.TemporaryDirectory(prefix="note-helper-vendor-") as tmp:
        for package in manifest["packages"]:
            entries = [item for item in package["files"] if item["target"] in needed]
            if not entries:
                continue
            archive_path = archives.get(package["name"])
            if archive_path is None:
                if not allow_download:
                    raise ValueError("缺少本地依赖包 %s；提供 --archive，或明确使用 --download 联网。" % package["name"])
                archive_path = Path(tmp) / (package["name"] + ".tgz")
                download_archive(package, archive_path)
            archive_path = Path(archive_path)
            if archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
                raise ValueError("依赖包过大")
            if hashlib.sha256(archive_path.read_bytes()).hexdigest() != package["archiveSha256"]:
                raise ValueError("依赖包 SHA-256 不匹配：" + package["name"])
            with tarfile.open(str(archive_path), "r:gz") as archive:
                members = archive.getmembers()
                if len(members) > 1000 or len({m.name for m in members}) != len(members):
                    raise ValueError("依赖包文件数量异常或包含重复路径")
                for item in entries:
                    member = archive.getmember(item["source"])
                    if not member.isfile() or member.size > MAX_ASSET_BYTES:
                        raise ValueError("依赖包成员类型或大小不正确")
                    with archive.extractfile(member) as asset:
                        raw = asset.read(MAX_ASSET_BYTES + 1)
                    if hashlib.sha256(raw).hexdigest() != item["sha256"]:
                        raise ValueError("依赖文件 SHA-256 不匹配：" + item["target"])
                    staged[item["target"]] = raw
        for name, raw in staged.items():
            path = target_path(destination, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                with path.open("xb") as out:
                    out.write(raw)
            except FileExistsError:
                # 其他进程刚补齐时也不覆盖；内容必须一致。
                if not path.is_file() or path.read_bytes() != raw:
                    raise ValueError("资源在准备过程中发生变化，已停止：" + name)
    missing, changed = check_vendor(manifest, destination)
    if missing or changed:
        raise ValueError("准备后的依赖校验失败")
    return len(staged)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="只读检查，不联网、不写文件（默认）")
    mode.add_argument("--download", action="store_true", help="允许从 npm 官方仓库下载缺少的固定版本包")
    parser.add_argument("--archive", action="append", default=[], metavar="NAME=PATH", help="使用已下载的本地 tgz，可重复")
    parser.add_argument("--dest", type=Path, default=ROOT / "web/vendor", help="资源目标目录")
    args = parser.parse_args()
    if args.check and args.archive:
        parser.error("--check 不与 --archive 一起使用")
    try:
        manifest = load_manifest()
        archives = {}
        for entry in args.archive:
            name, path = entry.split("=", 1)
            if name in archives or name not in {p["name"] for p in manifest["packages"]}:
                raise ValueError("本地包名称重复或不在清单中")
            archives[name] = Path(path)
        if args.download or archives:
            count = prepare(manifest, args.dest, archives, args.download)
            print("依赖准备完成，补齐 %d 个资源。" % count)
        missing, changed = check_vendor(manifest, args.dest)
        if missing or changed:
            print("依赖检查失败：缺少 %d 个，校验不符 %d 个。" % (len(missing), len(changed)))
            for name in (missing + changed)[:8]:
                print("  " + name)
            return 1
        print("依赖检查通过：%d 个资源，全部 SHA-256 匹配。" % sum(len(p["files"]) for p in manifest["packages"]))
        return 0
    except (OSError, ValueError, KeyError, tarfile.TarError) as exc:
        print("依赖准备失败：%s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
