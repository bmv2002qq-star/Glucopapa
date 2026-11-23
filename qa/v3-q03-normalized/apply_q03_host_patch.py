from pathlib import Path
import sys,hashlib
p=Path(sys.argv[1])
java=p/'app/src/main/java/org/glukopapa/v3/m00'
assets=p/'app/src/main/assets/www/q03'
source=Path(__file__).resolve().parent # Q03 CI keeps assets beside this script
route=java/'GfV3LocalAssetRoutes.kt';activity=java/'MainActivity.kt'
s=route.read_text(encoding='utf8')
needle='        "/q01/settings_ui_v3.js"'
assert s.count(needle)==1 and '/q03/gf_normalized_facts_v3.js' not in s
s=s.replace(needle,needle+',\n        "/q03/gf_normalized_facts_v3.js",\n        "/q03/q03_readonly_screen.js"')
needle='        if (path == "/q02/backup.html")'
assert s.count(needle)==1
s=s.replace(needle,'        if (path == "/q03/normalized-facts.html") return Resource("www/q03/normalized-facts.html", "text/html")\n'+needle)
route.write_text(s,encoding='utf8')
s=activity.read_text(encoding='utf8')
needle='it.path!="/q02/backup.html"'
assert s.count(needle)==1
s=s.replace(needle,needle+' && it.path!="/q03/normalized-facts.html"')
activity.write_text(s,encoding='utf8')
assets.mkdir(parents=True,exist_ok=True)
for src,dst in [('gf_normalized_facts_v3.js','gf_normalized_facts_v3.js'),('q03_readonly_screen.js','q03_readonly_screen.js'),('q03_normalized_facts.html','normalized-facts.html')]:
 (assets/dst).write_bytes((source/src).read_bytes())
assert '/q03/' in route.read_text() and '/q03/' in activity.read_text()
print('Q03_HOST_READONLY_PATCH_PASS',*(f'{x.name}:{hashlib.sha256(x.read_bytes()).hexdigest()[:12]}' for x in [route,activity]))
