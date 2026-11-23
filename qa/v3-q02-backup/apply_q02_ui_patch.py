"""Q02 adapter-only overlay. Does NOT mutate approved GFSettings/TimeGrid mathematical cores.
Fails closed on unexpected upstream Q01 shell source changes.
"""
from pathlib import Path
import sys,hashlib
root=Path(sys.argv[1]).resolve()
java=root/'app/src/main/java/org/glukopapa/v3/m00'
assets=root/'app/src/main/assets/www'
p=java/'MainActivity.kt';s=p.read_text('utf-8')
if 'GPV3Q02Native' in s: raise RuntimeError('Q02_ALREADY_ATTACHED')
assert 'private lateinit var settingsQueue: GfV3SettingsOwnerIntentQueue' in s
s=s.replace('private lateinit var settingsQueue: GfV3SettingsOwnerIntentQueue','private lateinit var settingsQueue: GfV3SettingsOwnerIntentQueue\n    private lateinit var backupOwnerUi:GfV3BackupOwnerUi')
src='nativeModuleGateway=GfV3NativeModuleGateway(v3,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)'
assert src in s
s=s.replace(src,src+'''
        // Independent Q02 native owner gateway; no direct JavaScript SQL or backup bytes.
        val q02Auto=GfV3AutoLocalBackup(applicationContext,helper)
        backupOwnerUi=GfV3BackupOwnerUi(this,GfV3EncryptedSnapshot(applicationContext,helper),q02Auto,v3) {
            web.loadUrl("$origin/") // restore success refreshes all M01/M02/Q01 views
        }
        GfV3AutoLocalBackup.schedule(applicationContext) // Android background 24h local backups''')
assert 'it.path!="/q01/settings.html"' in s
s=s.replace('it.path!="/q01/settings.html"','it.path!="/q01/settings.html" && it.path!="/q02/backup.html"')
assert 'addJavascriptInterface(GfV3Bridge(v3,editQueue,settingsQueue),"GPV3V3Bridge")' in s
s=s.replace('addJavascriptInterface(GfV3Bridge(v3,editQueue,settingsQueue),"GPV3V3Bridge")','addJavascriptInterface(GfV3Bridge(v3,editQueue,settingsQueue),"GPV3V3Bridge")\n            addJavascriptInterface(GfV3Q02Bridge(backupOwnerUi),"GPV3Q02Native")')
s=s.replace('settingsQueue.cancelPendingOnDestroy()','settingsQueue.cancelPendingOnDestroy()\n        backupOwnerUi.shutdown()')
s=s.replace('web.removeJavascriptInterface("GPV3V3Bridge")','web.removeJavascriptInterface("GPV3V3Bridge")\n        web.removeJavascriptInterface("GPV3Q02Native")')
p.write_text(s,'utf-8')
r=java/'GfV3LocalAssetRoutes.kt';s=r.read_text('utf-8')
assert 'if (path == "/q01/settings.html")' in s
s=s.replace('if (path == "/q01/settings.html")','if (path == "/q02/backup.html") return Resource("www/q02/backup.html", "text/html")\n        if (path == "/q01/settings.html")')
r.write_text(s,'utf-8')
manifest=root/'app/src/main/AndroidManifest.xml';s=manifest.read_text('utf-8')
assert '<application android:allowBackup="false"' in s
s=s.replace('<application android:allowBackup="false"', '<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>\n    <application android:allowBackup="false"')
assert '</application>' in s
s=s.replace('</application>', '<service android:name=".GfV3AutoBackupJobService" android:permission="android.permission.BIND_JOB_SERVICE" android:exported="true"/>\n    </application>')
manifest.write_text(s,'utf-8')
idx=assets/'index.html';s=idx.read_text('utf-8')
needle='<div class="page-heading"><div><p class="eyebrow">Настройки</p><h1>Профиль и подключения</h1></div></div>'
assert s.count(needle)==1
intro='''<article class="surface spaced" id="q02BackupEntry"><div class="section-head"><h2>Резервное копирование</h2><span class="thin-label">Q02 · шифрование</span></div><p class="micro-text">Создание зашифрованной локальной копии и безопасное восстановление. Пароль вводится только в Android.</p><a class="secondary-action" href="/q02/backup.html" style="display:block;text-decoration:none;text-align:center">Открыть защиту данных →</a></article>'''
s=s.replace(needle,needle+intro)
idx.write_text(s,'utf-8')
print('Q02_NATIVE_UI_PATCH_PASS',*[f'{name}:{hashlib.sha256((java/name).read_bytes()).hexdigest()[:12]}' for name in ('MainActivity.kt','GfV3LocalAssetRoutes.kt')])
