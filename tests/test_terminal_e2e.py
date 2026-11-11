"""Manual Windows test: briefly opens a terminal through an isolated Chrome profile."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid
import winreg

if os.environ.get('CAMPUS_MANUAL_TERMINAL') != '1':
    print('SKIP: set CAMPUS_MANUAL_TERMINAL=1 to run the visible terminal browser test')
    raise SystemExit(0)

source = Path('.').resolve()
host_name = 'cn.campus_ai.terminaltest_' + uuid.uuid4().hex
registry = r'Software\Google\Chrome\NativeMessagingHosts\\' + host_name
normal_registry = r'Software\Google\Chrome\NativeMessagingHosts\cn.campus_ai.readonly'

def registry_value(key_name):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_name) as key:
            return winreg.QueryValueEx(key, '')[0]
    except FileNotFoundError:
        return None

before = registry_value(normal_registry)
assert registry_value(registry) is None
with tempfile.TemporaryDirectory(prefix='campus-terminal-browser-') as folder:
    base = Path(folder)
    host = base / 'host'
    extension = base / 'extension'
    host.mkdir()
    shutil.copytree(source / 'extension', extension)
    for name in ('host.cmd', 'host.mjs'):
        shutil.copy2(source / 'host' / name, host / name)
    background = extension / 'background.js'
    text = background.read_text(encoding='utf-8')
    assert text.count('cn.campus_ai.readonly') == 3
    background.write_text(text.replace('cn.campus_ai.readonly', host_name), encoding='utf-8')
    (host / 'config.json').write_text(json.dumps({'root':str(source / 'test-files')}), encoding='utf-8')
    manifest = {
        'name':host_name, 'description':'isolated terminal test',
        'path':str(host / 'host.cmd'), 'type':'stdio',
        'allowed_origins':['chrome-extension://npoilipflmekpheijopnkkodofinhaci/']
    }
    manifest_path = host / 'native-host.json'
    manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
    env = os.environ.copy()
    env['CAMPUS_TEST_EXTENSION'] = str(extension)
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, registry) as key:
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, str(manifest_path))
        browser = os.environ.get('CAMPUS_TEST_BROWSER', 'chrome')
        subprocess.run(['node', 'tests/browser-compat.cjs', browser, 'terminal'], env=env, check=True, timeout=40)
        records = [json.loads(item.read_text(encoding='utf-8')) for item in (host / 'job-ledger').glob('*.json')]
        assert len(records) == 1 and records[0]['tool'] == 'open_terminal' and records[0]['state'] == 'completed', records
        assert registry_value(normal_registry) == before
        print('PASS: the browser executed one terminal request and returned the real result without changing the installed bridge')
    finally:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, registry)
