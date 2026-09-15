"""Explicit, revision-pinned download. Inference never downloads models."""
import hashlib
import json
import os
from pathlib import Path
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['HF_HUB_DISABLE_XET'] = '1'
from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parents[1]
config = json.loads((ROOT / 'python/model.json').read_text())
target = ROOT / '.models/depth-anything-v2-small'
print(f"Downloading {config['id']} @ {config['revision']}", flush=True)
snapshot_download(repo_id=config['id'], revision=config['revision'], local_dir=target, allow_patterns=config['files'], max_workers=2)
files = {}
for name in config['files']:
    digest = hashlib.sha256()
    with (target / name).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    files[name] = {'sha256': digest.hexdigest(), 'bytes': (target / name).stat().st_size}
manifest = {**config, 'files': files}
(target / 'download.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps({'ready': True, 'path': str(target), 'files': files}, indent=2), flush=True)
