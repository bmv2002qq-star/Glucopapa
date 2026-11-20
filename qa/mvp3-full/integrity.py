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
    assert order == entry.scripts and len(set(order)) == len(order) >= 83
    assert order[0] == 'runtime/webview-compat.js'
    core = [name for name in order if re.search(r'GFStorage.*gfstorage_core\.js$', name)]
    assert core == ['modules/GFStorage_v0.5.12/src/gfstorage_core.js']
    assert not any(token in name for name in order for token in ('ReplayLab', 'GFxDrip', 'GFNutrition_FALLBACK'))
    assert len(entry.frames) == 6 and all(name.startswith('approved/') for name in entry.frames[:3])
    assert entry.frames[3:] == ['integration/approved_routes/GFMealCalc_v0.3.0_VIEW.html',
                                'integration/approved_routes/LOW_v0.2_VIEW.html',
                                'integration/approved_routes/GFHighTarget_v0.1.3_VIEW.html']
    for resource in entry.scripts + entry.frames:
        url = urlsplit(resource)
        assert not url.scheme and not url.netloc and (web / resource).is_file(), resource
    for directive in ["script-src 'self'", "connect-src 'none'", "frame-src 'self'", "object-src 'none'"]:
        assert directive in entry.csp

    manifest = ET.parse(root / 'app/src/main/AndroidManifest.xml').getroot()
    android = '{http://schemas.android.com/apk/res/android}'
    assert [child.get(android + 'name') for child in manifest if child.tag.startswith('uses-permission')] == [
        'android.permission.INTERNET']
    assert [p.get(android + 'authorities') for p in manifest.findall('queries/provider')] == [
        'com.eveningoutpost.dexdrip.contentprovider']
    app = manifest.find('application')
    assert app.get(android + 'allowBackup') == 'false'
    assert app.get(android + 'usesCleartextTraffic') == 'false'
    assert app.get(android + 'networkSecurityConfig') == '@xml/gf_loopback_network'
    network = ET.parse(root / 'app/src/main/res/xml/gf_loopback_network.xml').getroot()
    assert network.tag == 'network-security-config' and [child.tag for child in network] == ['base-config', 'domain-config']
    base, loopback = network
    assert base.attrib == {'cleartextTrafficPermitted': 'false'} and len(base) == 0
    assert loopback.attrib == {'cleartextTrafficPermitted': 'true'} and len(loopback) == 1
    assert loopback[0].tag == 'domain' and loopback[0].attrib == {'includeSubdomains': 'false'}
    assert loopback[0].text == '127.0.0.1' and len(loopback[0]) == 0
    native = root / 'app/src/main/java'
    databases = re.findall(r'extends\s+SQLiteOpenHelper', '\n'.join(
        name.read_text(encoding='utf-8') for name in native.rglob('*.java')))
    assert len(databases) == 1

    files = {p.relative_to(web).as_posix(): p.read_bytes() for p in web.rglob('*') if p.is_file()}
    assert len(files) >= 133
    assert not any('GFLOWPreviewFixture' in name for name in files)
    unchanged = None
    changes = []
    if args.archive_web:
        archived = {p.relative_to(args.archive_web).as_posix(): p.read_bytes()
                    for p in args.archive_web.rglob('*') if p.is_file()}
        allowed_additions = {'runtime/webview-compat.js', 'integration/GFProviderCgm_v0.1.0.js',
                             'integration/GFJournalBackup_v0.1.0.js', 'integration/GFForecastReadout_v0.1.0.js',
                             'integration/GFCalculationEvidence_v0.1.0.js', 'integration/GFConsensusReview_v0.1.0.js',
                             'integration/GFLevemirReview_v0.1.0.js', 'integration/GFResearchForecastRun_v0.1.0.js', 'integration/GFResearchForecastGraph_v0.1.0.js', 'runtime/APK_FILES.txt',
                             'modules/GFStorage_v0.5.11/src/gfstorage_core.js', core[0],
                             'integration/GFJournalPresentation_v0.1.0.js','integration/GFGraphFourLines_v0.1.0.js','integration/GFConsensusAutoSelection_v0.1.2.js',
                             'integration/GFConsensusEvidence_v0.1.0.js','integration/GFInjectionFact_v0.1.0.js',
                             'integration/GFMealTimingService_v0.1.0.js','integration/GFMealWorkflowView_v0.1.0.js',
                             'integration/approved_routes/GFMealCalc_v0.3.0_VIEW.html',
                             'integration/GFMainScreen_v1.0.0/gfmain_core.js','integration/GFMainScreen_v1.0.0/gfmain_ui.js',
                             'integration/GFMainScreen_v1.0.0/gfmain_home_scoped.css'}
        assert set(files) - set(archived) <= allowed_additions
        assert set(archived).issubset(files)
        changes = sorted(name for name in archived if files[name] != archived[name])
        assert set(changes) <= {
            'app.js', 'index.html', 'styles.css', 'runtime/LOAD_ORDER.txt', 'runtime/APK_FILES.txt', 'integration/GFCgmEvidencePolicy_v0.1.0.js',
            'integration/GFCOBAutoPanel_v0.2.0.js', 'integration/GFGraphEvidenceBridge_v0.1.0.js',
            'integration/GFModuleDirectory_v0.1.0.js', 'integration/GFModuleHub_v0.2.0.js',
            'integration/GFSettingsPanel_v0.1.0.js', 'integration/GFJournalPresentation_v0.1.0.js',
            'integration/GFModuleUI_v0.2.1.js', 'integration/GPMvp3ResearchUI_v0.1.0.js',
            'modules/GFSettings_v0.1.8/src/gfsettings.js',
            'integration/GFCalculationEvidence_v0.1.0.js', 'integration/GFResearchForecastRun_v0.1.0.js',
            'integration/GFHighTargetView_v0.1.0.js', 'integration/GFLOWView_v0.4.1.js','integration/GFLOWStorage_v0.4.1.js',
            'integration/GFInjectionTimingStorage_v0.1.0.js', 'integration/GFMealAbsorption_v0.1.0.js',
            'integration/GFInjectionFact_v0.1.0.js','modules/GFMealCalc_v0.1.2/adapters/gfmeal_controller.js',
            'integration/GFProviderCgm_v0.1.0.js', core[0],
            'modules/GFAuditExport_v0.1.4/src/gfaudit_export_storage_adapter.js',
        }, changes
        unchanged = len(archived) - len(changes)
    extra = [line.strip() for line in (web / 'runtime/APK_FILES.txt').read_text().splitlines()
             if line.strip() and not line.startswith('#')]
    assert {'index.html', 'styles.css', *entry.frames} <= set(extra)
    assert len(set(extra + order)) == len(extra) + len(order)
    packaged = {name: files[name] for name in extra + order}
    assert not any(name.startswith('approved-library/') for name in packaged)
    assert not re.search(r'seedDemo|modeDemo|resetDemo|gs1-demo',
                         (web / 'index.html').read_text() + (web / 'app.js').read_text())
    if args.apk:
        with ZipFile(args.apk) as apk:
            assert apk.testzip() is None
            assert {'assets/www/' + name: data for name, data in packaged.items()} == {
                name: apk.read(name) for name in apk.namelist()
                if name.startswith('assets/') and not name.endswith('/')}

    print(json.dumps({'status': 'PASS', 'protected_assets': protected, 'load_order': len(order),
                      'active_storage': core[0], 'native_helpers': len(databases), 'web_assets': len(files), 'packaged_assets': len(packaged),
                      'archive_verified': bool(args.archive_web), 'archive_unchanged_assets': unchanged, 'archive_changed_assets': changes, 'apk_mirror': bool(args.apk),
                      'frames': entry.frames}, indent=2))


if __name__ == '__main__':
    main()
