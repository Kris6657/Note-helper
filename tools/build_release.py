"""Portable bundle helpers. Standard library only; never read live courses/."""
import argparse
import hashlib
import importlib.metadata
import json
import platform
import re
import shutil
import sys
import zipfile
from pathlib import Path

from tools.prepare_vendor import check_vendor, load_manifest, target_path

WEB_SOURCE = ('index.html', 'style.css', 'selftest.html',
              'js/app.js', 'js/notes.js', 'js/pdfview.js')
DEMO = '\u6f14\u793a\u8bfe\u7a0b/Module 1'
GUIDE = '\u4fbf\u643a\u7248\u8bf4\u660e.md'


def copy_file(source_root, name, destination):
    source = target_path(source_root, name)
    if not source.is_file():
        raise ValueError('Missing public input: ' + name)
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FileExistsError('Refusing to overwrite: ' + str(target))
    shutil.copyfile(source, target)


def stage_sources(root, destination):
    root, destination = Path(root), Path(destination)
    if destination.exists():
        raise FileExistsError('Staging directory already exists')
    manifest = load_manifest(root / 'vendor-manifest.json')
    if any(check_vendor(manifest, root / 'web/vendor')):
        raise ValueError('Vendor validation failed; prepare dependencies first')
    files = ['server.py', 'tools/prepare_vendor.py', 'Note-helper.spec', 'vendor-manifest.json']
    files += ['web/' + name for name in WEB_SOURCE]
    files += ['web/vendor/' + item['target'] for p in manifest['packages'] for item in p['files']]
    for name in files:
        copy_file(root, name, destination / name)
    return len(files)


def finish_bundle(root, bundle, version):
    root, bundle = Path(root), Path(bundle)
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?', version):
        raise ValueError('Invalid version')
    if not (bundle / 'Note-helper.exe').is_file() or not (bundle / '_internal').is_dir():
        raise ValueError('Missing PyInstaller output')
    copy_file(root, GUIDE, bundle / 'README.md')
    for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
        copy_file(root, name, bundle / name)
    copy_file(root, 'tools/test_portable.ps1', bundle / 'Verify-portable.ps1')
    for name in ('notes.md', 'slides.pdf'):
        copy_file(root, 'examples/' + DEMO + '/' + name, bundle / 'courses' / DEMO / name)
    python_license = Path(sys.base_prefix) / 'LICENSE.txt'
    copy_file(python_license.parent, python_license.name, bundle / 'licenses/Python-LICENSE.txt')
    distribution = importlib.metadata.distribution('pyinstaller')
    licenses = [p for p in distribution.files if str(p).endswith('licenses/COPYING.txt')]
    if len(licenses) != 1:
        raise ValueError('Cannot locate PyInstaller license')
    pyinstaller_license = Path(distribution.locate_file(licenses[0]))
    copy_file(pyinstaller_license.parent, pyinstaller_license.name, bundle / 'licenses/PyInstaller-COPYING.txt')
    info = {'application': 'Note-helper', 'version': version,
            'platform': 'windows-x64', 'python': platform.python_version(),
            'pyinstaller': distribution.version, 'signed': False}
    with (bundle / 'build-info.json').open('x', encoding='utf-8', newline='\n') as out:
        json.dump(info, out, indent=2)
        out.write('\n')
    files = []
    for path in sorted(bundle.rglob('*')):
        if path.is_file():
            files.append({'path': path.relative_to(bundle).as_posix(), 'bytes': path.stat().st_size,
                          'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    with (bundle / 'package-manifest.json').open('x', encoding='utf-8', newline='\n') as out:
        json.dump({'version': version, 'files': files}, out, indent=2, ensure_ascii=True)
        out.write('\n')
    return info


def create_zip(bundle, destination):
    bundle, destination = Path(bundle), Path(destination)
    entries = list(bundle.rglob('*'))
    for path in entries:
        relative = path.relative_to(bundle)
        private_names = ('.git', '.venv-build', 'python-path.txt', 'annotations.json', 'project.md', 'agents.md')
        private_course = (path.is_file() and relative.parts[0].lower() == 'courses'
                          and relative.as_posix() not in {'courses/' + DEMO + '/' + n for n in ('notes.md', 'slides.pdf')})
        if path.is_symlink() or private_course or any(part.lower() in private_names
                                    or part.lower().startswith('.env') for part in relative.parts):
            raise ValueError('Unexpected private or linked package input')
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(entries):
            if path.is_file():
                archive.write(path, str(Path('Note-helper') / path.relative_to(bundle)))
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    with destination.with_suffix(destination.suffix + '.sha256').open('x', encoding='ascii') as out:
        out.write(digest + '  ' + destination.name + '\n')
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('stage', 'finish'))
    parser.add_argument('root', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--version')
    parser.add_argument('--zip', dest='zip_path', type=Path)
    args = parser.parse_args()
    if args.action == 'stage':
        print('Staged %d public input files.' % stage_sources(args.root, args.destination))
    else:
        if not args.version or args.zip_path is None:
            parser.error('finish requires --version and --zip')
        print(json.dumps(finish_bundle(args.root, args.destination, args.version)))
        print('ZIP SHA-256: ' + create_zip(args.destination, args.zip_path))


if __name__ == '__main__':
    main()
