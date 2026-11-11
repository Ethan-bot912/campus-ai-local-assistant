import base64
import hashlib
import json
from pathlib import Path
import re


root = Path(__file__).resolve().parents[1]
for local_path in ('host/config.json', 'host/native-host.json', 'host/job-ledger'):
    assert not (root / local_path).exists(), f'发布内容不能包含本机生成的文件：{local_path}'

manifest = json.loads((root / 'extension' / 'manifest.json').read_text(encoding='utf-8'))
assert manifest['host_permissions'] == ['https://ai.cuhk.edu.cn/*']
assert all(item['matches'] == ['https://ai.cuhk.edu.cn/chat/*'] for item in manifest['content_scripts'])
digest = hashlib.sha256(base64.b64decode(manifest['key'])).digest()[:16]
extension_id = ''.join(chr(ord('a') + nibble) for byte in digest for nibble in (byte >> 4, byte & 15))
assert extension_id == 'npoilipflmekpheijopnkkodofinhaci'
assert extension_id in (root / 'host' / 'setup.ps1').read_text(encoding='utf-8-sig')

patterns = {
    '个人 Windows 用户目录': re.compile(r'(?i)[a-z]:[\\/]+users[\\/]+[^\\/\s"\x27]+'),
    'GitHub 令牌': re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,}'),
    '可能的 API 密钥': re.compile(r'sk-[A-Za-z0-9]{20,}'),
    '私钥': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
}
for item in root.rglob('*'):
    if not item.is_file() or '.git' in item.parts or '__pycache__' in item.parts:
        continue
    text = item.read_text(encoding='utf-8-sig')
    for description, pattern in patterns.items():
        assert not pattern.search(text), f'{item.relative_to(root)} 包含疑似{description}。'

assert (root / 'LICENSE').read_text(encoding='utf-8').startswith('MIT License\n')
print('PASS: release contains no generated host configuration, known token patterns or personal Windows paths')
print('PASS: extension is restricted to the school site and its ID matches the installer')
