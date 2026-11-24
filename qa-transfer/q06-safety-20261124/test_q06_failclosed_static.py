#!/usr/bin/env python3
from pathlib import Path
import json
root=Path.cwd()
p=root/'android-app/app/src/main/assets/www/q06/guidance.html';s=p.read_text()
a=root/'android-app/app/src/main/java/org/glukopapa/v3/m00/GfV3Q06ContextAdapter.kt';kt=a.read_text()
checks={
 'Medical status explicitly missing':"med.status==='CORE_SOURCE_MISSING'" in s,
 'Model numeric opt-in disabled':'med.numericCorrectionEnabled===false' in s,
 'All medical fields MUST be present and null':'nullFields.every(' in s and 'med[key]===null' in s,
 'Applied modifiers always empty':'med.appliedModifiers.length===0' in s,
 'Model version null':'med.modelVersion===null' in s,
 'Context index exact by level':'c.configuredIndex===allowedIndex[c.level]' in s,
 'Context provenance required':"c.indexRole==='DESCRIPTIVE_STATE_ONLY'" in s,
 'Context modification disabled':'c.numericCorrectionEnabled===false' in s,
 'Native source one frozen read':kt.count('storage.readShellPort("activity")')==1,
 'Native numeric values are all NULL':all('put("'+f+'",JSONObject.NULL)' in kt for f in ['factor','insulinAdjustment','carbohydrateAdjustment','forecastAdjustment','glucoseAdjustment']),
 'Native source no writes':not any(s in kt for s in ['writableDatabase','execSQL','nativeWriter','append(']),
}
for n,v in checks.items(): assert v,n
print(json.dumps({'result':'PASS','checks':len(checks),'caseNames':list(checks)},ensure_ascii=False))