from pathlib import Path
import hashlib, sys
mode=sys.argv[1]
assert mode in ('integrated','offline')
root=Path('q07-ci/android-app/app/src')
test=root/'androidTest/java/org/glukopapa/v3/m00/Q02AndroidBackupTest.kt'
manifest=root/'main/AndroidManifest.xml'
original=Path('qa/v3-q02-backup/Q02AndroidBackupTest.kt').read_bytes()
assert hashlib.sha1(b'blob '+str(len(original)).encode()+b'\0'+original).hexdigest()=='fad7041c3ae86345ed7f62e6f3efbfcaa3c97e06'
old='autoJobScheduleRunsWithoutNetworkPermission'
new='autoJobScheduleIsNetworkIndependentInCgmBuild'
source=original.decode()
a='        assertFalse("No INTERNET permission may be requested", context.packageManager.checkPermission("android.permission.INTERNET",context.packageName)==android.content.pm.PackageManager.PERMISSION_GRANTED)'
b='''        assertEquals("Q09 loopback transport requires app INTERNET permission", android.content.pm.PackageManager.PERMISSION_GRANTED, context.packageManager.checkPermission("android.permission.INTERNET",context.packageName))
        assertEquals("Q02 periodic backup must have no network constraint", android.app.job.JobInfo.NETWORK_TYPE_NONE, pending.networkType)
        if(android.os.Build.VERSION.SDK_INT>=28)assertNull("Q02 must not require a network request",pending.requiredNetwork)
        scheduler.getPendingJob(GfV3AutoLocalBackup.INITIAL_JOB_ID)?.let { job ->
            assertEquals(android.app.job.JobInfo.NETWORK_TYPE_NONE,job.networkType)
            if(android.os.Build.VERSION.SDK_INT>=28)assertNull(job.requiredNetwork)
        }'''
assert source.count(a)==source.count(old)==1
changed=source.replace(old,new).replace(a,b)
permission='    <uses-permission android:name="android.permission.INTERNET"/>\n'
m=manifest.read_text()
assert m.count(permission)==1
if mode=='integrated':
    assert test.read_bytes()==original
    test.write_text(changed)
else:
    assert test.read_text()==changed
    test.write_bytes(original)
    manifest.write_text(m.replace(permission,''))
    assert test.read_bytes()==original
    assert 'android.permission.INTERNET' not in manifest.read_text()
print('Q10_V042',mode,'testSHA',hashlib.sha256(test.read_bytes()).hexdigest(),'manifestSHA',hashlib.sha256(manifest.read_bytes()).hexdigest())
