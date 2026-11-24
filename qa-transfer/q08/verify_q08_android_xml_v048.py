#!/usr/bin/env python3
"""Verify Android instrumentation case identities, not XML filenames or suite labels."""
import argparse
from pathlib import Path
import xml.etree.ElementTree as ET
from collections import Counter
import json

CLASS='org.glukopapa.v3.m00.Q08LevemirNativeInstrumentedTest'
REQUIRED={
 'notConnectedOrNotConfirmedNeverWrites', 'manualFactIsIdempotentAndSeparateFromRapid',
 'staleProfileInvalidDoseAndDuplicateSlotBlocked', 'crossOwnerWriteDenied',
 'correctionPreservesBasalIdentityAndHistory', 'historyReadsMoreThanTwoThousandAndNeverClaimsSensorCoverage',
 'extraActualSeparateFromRegularAndIdempotent',
 'strictUtcRejectsImpossibleCalendarValuesAndNormalizedTimes',
 'restartPreservesActualBasalFactAndWriteReceipt',
 'encryptedRestoreKeepsBasalFactAndReceiptAndRemovesLaterCorrection',
 'nativeInstallerActivationSeparateFromActualAndGrantBound',
 'ownerQueueRejectsForgedConsentAndSeparatesCancelActivateActualReplay',
 'nativeLocalTimeUsesProfileZoneAndRejectsInvalidWallClock',
 'journalOwnerCorrectionKeepsActualBasalIdentity',
 'indexedHistorySkipsOldCgmAndEnforcesBoundOwner',
 'explicitActivationPersistsAcrossReopenAndEncryptedRestore',
 'additionalActualOwnerQueueRequiresSeparateConsentAndReason','scopedRelatedHistoryRetainsBasalAndUnknownMealsWithoutLifetimeNoise','abandonedTerminalReceiptsDoNotBlockNewOwnerActionAndVersionIsExplicit',
}
WEB_CLASS='org.glukopapa.v3.m00.Q08LevemirWebViewInstrumentedTest'
WEB_CASE='approvedScreenNativeActivationAndActualConfirmationAreSeparate'
BASELINE={
 'Q04NativeDraftsInstrumentedTest':10, 'Q04WebViewSmokeInstrumentedTest':1,
 'Q05ActivityInstrumentedTest':16, 'Q05ActivityWebViewInstrumentedTest':1,
 'Q06GuidanceInstrumentedTest':26, 'Q06GuidanceWebViewInstrumentedTest':1,
 'Q07RinFastContractInstrumentedTest':12, 'Q07RinFastModuleInstallerInstrumentedTest':9,
 'Q07RinFastNativeIntegrationInstrumentedTest':8, 'Q07RinFastWebViewInstrumentedTest':1,
}
def check(directory, legacy=False):
 files=sorted(Path(directory).rglob('*.xml'))
 if not files: raise ValueError('missing XML evidence')
 seen=set(); classes=Counter(); names=set()
 for file in files:
  root=ET.parse(file).getroot()
  suites=[root] if root.tag=='testsuite' else list(root.findall('testsuite')) if root.tag=='testsuites' else []
  if not suites: raise ValueError(f'no test suite: {file}')
  for suite in suites:
   tests=list(suite.findall('testcase'))
   if int(suite.attrib['tests'])!=len(tests): raise ValueError('case count mismatch')
   if any(int(suite.get(k,'0'))!=0 for k in ('failures','errors','skipped','disabled')): raise ValueError('unsuccessful suite')
   for t in tests:
    c,n=t.get('classname'),t.get('name')
    if not c or not n or (c,n) in seen: raise ValueError('missing or duplicate test identity')
    if any(t.find(k) is not None for k in ('failure','error','skipped','disabled')): raise ValueError('unsuccessful testcase')
    seen.add((c,n));classes[c]+=1
    if c==CLASS:names.add(n)
 for c,n in BASELINE.items():
  if classes['org.glukopapa.v3.m00.'+c]<n: raise ValueError('baseline class missing: '+c)
 required=REQUIRED-{'extraActualSeparateFromRegularAndIdempotent','strictUtcRejectsImpossibleCalendarValuesAndNormalizedTimes','restartPreservesActualBasalFactAndWriteReceipt','encryptedRestoreKeepsBasalFactAndReceiptAndRemovesLaterCorrection','nativeInstallerActivationSeparateFromActualAndGrantBound','ownerQueueRejectsForgedConsentAndSeparatesCancelActivateActualReplay','nativeLocalTimeUsesProfileZoneAndRejectsInvalidWallClock','journalOwnerCorrectionKeepsActualBasalIdentity','indexedHistorySkipsOldCgmAndEnforcesBoundOwner','explicitActivationPersistsAcrossReopenAndEncryptedRestore'} if legacy else REQUIRED
 if not required<=names: raise ValueError('Q08 cases missing: '+str(sorted(required-names)))
 if not legacy and (WEB_CLASS,WEB_CASE) not in seen: raise ValueError('Q08 actual WebView native confirmation test missing')
 return {'gate_passed':True,'total':len(seen),'q08':len(names)+classes[WEB_CLASS],'baseline':len(seen)-len(names)-classes[WEB_CLASS],'failures':0,'errors':0,'skipped':0,'q08_cases':sorted(names),'q08_webview_cases':sorted(n for c,n in seen if c==WEB_CLASS),'classes':dict(classes)}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--legacy-v040',action='store_true');args=p.parse_args();print(json.dumps(check(args.directory,args.legacy_v040),ensure_ascii=False,indent=2))
