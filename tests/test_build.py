"""Packaging boundary checks; no PyInstaller import or build is required."""
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from tools import build_release


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='note-helper build tests ')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'source'
        self.root.mkdir()
        data = b'public asset'
        self.manifest = {'schemaVersion': 1, 'packages': [{
            'name': 'fixture', 'version': '1.0.0',
            'archive': 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
            'archiveSha256': '0' * 64,
            'files': [{'source': 'package/file.js', 'target': 'file.js',
                       'sha256': hashlib.sha256(data).hexdigest()}]}]}
        names = ['server.py', 'tools/prepare_vendor.py', 'Note-helper.spec']
        names += ['web/' + n for n in build_release.WEB_SOURCE]
        names += ['web/vendor/file.js']
        for name in names:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (self.root / 'vendor-manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')

    def test_only_explicit_public_inputs_are_staged(self):
        for name in ('.env', 'Project.md', 'web/vendor/private.txt', 'courses/private/Module 1/notes.md'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'not public')
        destination = self.root.parent / 'stage'
        build_release.stage_sources(self.root, destination)
        self.assertFalse((destination / 'courses').exists())
        self.assertFalse((destination / '.env').exists())
        self.assertFalse((destination / 'Project.md').exists())
        self.assertFalse((destination / 'web/vendor/private.txt').exists())
        self.assertEqual((destination / 'web/vendor/file.js').read_bytes(), b'public asset')

    def test_bad_vendor_stops_before_staging(self):
        (self.root / 'web/vendor/file.js').write_bytes(b'changed')
        destination = self.root.parent / 'stage'
        with self.assertRaisesRegex(ValueError, 'Vendor validation'):
            build_release.stage_sources(self.root, destination)
        self.assertFalse(destination.exists())

    def test_existing_staging_directory_is_not_overwritten(self):
        with self.assertRaises(FileExistsError):
            build_release.stage_sources(self.root, self.root)
        self.assertEqual((self.root / 'server.py').read_bytes(), b'public asset')

    def test_archive_has_root_folder_and_external_checksum(self):
        bundle = self.root.parent / 'bundle'
        bundle.mkdir()
        (bundle / 'Note-helper.exe').write_bytes(b'synthetic fixture')
        destination = self.root.parent / 'bundle.zip'
        digest = build_release.create_zip(bundle, destination)
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.namelist(), ['Note-helper/Note-helper.exe'])
        self.assertEqual(digest, hashlib.sha256(destination.read_bytes()).hexdigest())
        self.assertTrue(destination.with_suffix('.zip.sha256').read_text().startswith(digest))

    def test_private_files_and_non_demo_courses_are_rejected(self):
        for name in ('.env', '.ENV.secret', 'Project.md', 'annotations.json', 'courses/private/notes.md'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                bundle = Path(tmp) / 'bundle'
                path = bundle / name
                path.parent.mkdir(parents=True)
                path.write_bytes(b'private')
                destination = Path(tmp) / 'bundle.zip'
                with self.assertRaisesRegex(ValueError, 'private'):
                    build_release.create_zip(bundle, destination)
                self.assertFalse(destination.exists())

    def test_existing_zip_is_not_replaced(self):
        destination = self.root.parent / 'existing.zip'
        destination.write_bytes(b'keep existing output')
        with self.assertRaises(FileExistsError):
            build_release.create_zip(self.root / 'web', destination)
        self.assertEqual(destination.read_bytes(), b'keep existing output')


if __name__ == '__main__':
    unittest.main()
