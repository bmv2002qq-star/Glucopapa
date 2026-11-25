# Q10 v0.3.4 QA checkpoint — 2026-11-25

Status: OPEN; Q11 not started. HTML v0.2 unchanged. No production activation.

- Parent: donor audit 15981bbb90f499f041c3348b48ec97fc150f9cce.
- Exact original GFSafety 0.1.0 Git blob 73c4d920a6f6a652f24ccaefb2388cc3cb6d8866 retained; installation verifies its hash.
- V3 native read-only research snapshot schema 3 consumed directly; no masquerading as V2 schema 4/5, no quality score or coverage invention.
- Original V2 bridge/policy retained for audit; four reproduced legacy defects remain in those immutable donors, which are not executed on the V3 data path.
- Local isolated JS execution: 14/14 synthetic assertions passed. Not Android evidence.
- Android workflow commit ba8956c474d385ddb9fe1e117c69af7eda3e65e8 adds an instrumented WebView invocation of the exact donor using a real native storage snapshot, revision and audit invariance, and all authorization flags false. CI XML not yet verified.
- Full baseline identity gate retained with one additional Q10 test.
- Open: verify CI XML and hashes, repeat native source coverage/capacity and producer regression, review full condition/fact projection, device testing and clinical validation. No release or treatment recommendations.

The QA projection is observational only and does not connect to any dose calculator, automatic injection, forecast enablement, or production screen. No patient data in new fixtures.
