"""Check the Android WebView load order, archived protected bytes and APK assets."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
from zipfile import ZipFile


class Entrypoint(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.frames = []
        self.csp = ''

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == 'script':
            self.scripts.append(attrs.get('src'))
        elif tag == 'iframe':
            self.frames.append(attrs.get('src'))
        elif tag == 'meta' and attrs.get('http-equiv') == 'Content-Security-Policy':
            self.csp = attrs.get('content', '')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', type=Path)
    parser.add_argument('--archive-web', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2] / 'android-mvp3'
    web = root / 'app/src/main/assets/www'
    locked = (Path(__file__).parent / 'protected-assets.sha256').read_text(encoding='utf-8')
    protected = 0
    for line in locked.splitlines():
        digest, name = line.split(maxsplit=1)
        assert hashlib.sha256((web / name).read_bytes()).hexdigest() == digest, name
        protected += 1
    assert protected == 26

    entry = Entrypoint()
    entry.feed((web / 'index.html').read_text(encoding='utf-8'))
    order = [line.strip() for line in (web / 'runtime/LOAD_ORDER.txt').read_text().splitlines()
             if line.strip() and not line.startswith('#')]
    assert order == entry.scripts and len(set(order)) == len(order) == 68
    assert order[0] == 'runtime/webview-compat.js'
    core = [name for name in order if re.search(r'GFStorage.*gfstorage_core\.js$', name)]
    assert core == ['modules/GFStorage_v0.5.11/src/gfstorage_core.js']
    assert not any(token in name for name in order for token in ('ReplayLab', 'GFxDrip', 'GFNutrition_FALLBACK'))
    assert len(entry.frames) == 3 and all(name.startswith('approved/') for name in entry.frames)
    for resource in entry.scripts + entry.frames:
        url = urlsplit(resource)
        assert not url.scheme and not url.netloc and (web / resource).is_file(), resource
    for directive in ["script-src 'self'", "connect-src 'none'", "frame-src 'self'", "object-src 'none'"]:
        assert directive in entry.csp

    manifest = ET.parse(root / 'app/src/main/AndroidManifest.xml').getroot()
    assert not [child.tag for child in manifest if child.tag.startswith('uses-permission')]
    android = '{http://schemas.android.com/apk/res/android}'
    assert [p.get(android + 'authorities') for p in manifest.findall('queries/provider')] == [
        'com.eveningoutpost.dexdrip.contentprovider']
    app = manifest.find('application')
    assert app.get(android + 'allowBackup') == 'false'
    native = root / 'app/src/main/java'
    databases = re.findall(r'extends\s+SQLiteOpenHelper', '\n'.join(
        name.read_text(encoding='utf-8') for name in native.rglob('*.java')))
    assert len(databases) == 1

    files = {p.relative_to(web).as_posix(): p.read_bytes() for p in web.rglob('*') if p.is_file()}
    assert len(files) == 116
    unchanged = None
    changes = []
    if args.archive_web:
        archived = {p.relative_to(args.archive_web).as_posix(): p.read_bytes()
                    for p in args.archive_web.rglob('*') if p.is_file()}
        allowed_additions = {'runtime/webview-compat.js', 'integration/GFProviderCgm_v0.1.0.js',
                             'integration/GFJournalBackup_v0.1.0.js', 'integration/GFForecastReadout_v0.1.0.js',
                             'integration/GFCalculationEvidence_v0.1.0.js', 'integration/GFConsensusReview_v0.1.0.js',
                             'integration/GFLevemirReview_v0.1.0.js', core[0]}
        assert set(files) - set(archived) <= allowed_additions
        assert set(archived).issubset(files)
        changes = sorted(name for name in archived if files[name] != archived[name])
        assert set(changes) <= {
            'app.js', 'index.html', 'styles.css', 'runtime/LOAD_ORDER.txt', 'integration/GFCgmEvidencePolicy_v0.1.0.js',
            'integration/GFCOBAutoPanel_v0.2.0.js', 'integration/GFGraphEvidenceBridge_v0.1.0.js',
            'integration/GFModuleDirectory_v0.1.0.js', 'integration/GFModuleHub_v0.2.0.js',
            'integration/GFModuleUI_v0.2.1.js', 'integration/GPMvp3ResearchUI_v0.1.0.js',
        }, changes
        unchanged = len(archived) - len(changes)
    if args.apk:
        with ZipFile(args.apk) as apk:
            assert apk.testzip() is None
            assert files == {name.removeprefix('assets/www/'): apk.read(name) for name in apk.namelist()
                             if name.startswith('assets/www/') and not name.endswith('/')}
            assert not any(Path(name).name in ('webview-qa.js', 'stock-ui.js') for name in apk.namelist())

    print(json.dumps({'status': 'PASS', 'protected_assets': protected, 'load_order': len(order),
                      'active_storage': core[0], 'native_helpers': len(databases), 'web_assets': len(files),
                      'archive_verified': bool(args.archive_web), 'archive_unchanged_assets': unchanged, 'archive_changed_assets': changes, 'apk_mirror': bool(args.apk),
                      'frames': entry.frames}, indent=2))


if __name__ == '__main__':
    main()
