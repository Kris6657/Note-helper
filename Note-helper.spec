# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
import json

source = Path(SPECPATH)
manifest = json.loads((source / 'vendor-manifest.json').read_text(encoding='utf-8'))
public_web = ['index.html', 'style.css', 'selftest.html',
              'js/app.js', 'js/notes.js', 'js/pdfview.js']
public_web += ['vendor/' + item['target'] for package in manifest['packages'] for item in package['files']]
datas = [(str(source / 'web' / name), str(Path('web') / Path(name).parent)) for name in public_web]
datas += [(str(source / 'vendor-manifest.json'), '.')]

a = Analysis([str(source / 'server.py')], pathex=[str(source)],
             binaries=[], datas=datas, hiddenimports=[], hookspath=[],
             hooksconfig={}, runtime_hooks=[], excludes=['tkinter'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='Note-helper',
          debug=False, bootloader_ignore_signals=False, strip=False,
          upx=False, console=True, disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='Note-helper')
