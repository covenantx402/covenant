#!/usr/bin/env python3
"""Write one stable weekly COVENANT settlement-audit snapshot."""
import hashlib
import json
import os
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

AUDIT_URL = 'http://127.0.0.1:8792/x402/audit/settlements'
OUT_DIR = Path(__file__).resolve().parent.parent / 'data' / 'audit-snapshots'

with urllib.request.urlopen(AUDIT_URL, timeout=20) as response:
    audit = json.load(response)
canonical_audit = json.dumps(audit, sort_keys=True, separators=(',', ':')).encode()
payload = {
    'schema': 'covenant.audit.snapshot.v1',
    'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
    'auditSha256': hashlib.sha256(canonical_audit).hexdigest(),
    'audit': audit,
}
serialized = json.dumps(payload, indent=2, sort_keys=True) + '\n'
OUT_DIR.mkdir(parents=True, exist_ok=True)
week = datetime.now(timezone.utc).strftime('%G-W%V')
for name in ('latest.json', f'{week}.json'):
    target = OUT_DIR / name
    fd, temporary = tempfile.mkstemp(prefix='.snapshot-', dir=OUT_DIR)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(serialized)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
print(f'wrote {OUT_DIR / "latest.json"} sha256={payload["auditSha256"]}')
