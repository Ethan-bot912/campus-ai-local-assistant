import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import uuid
import winreg


project = Path(__file__).resolve().parents[1]
registry_parent = r'Software\Google\Chrome\NativeMessagingHosts'
test_name = 'cn.campus_ai.test_' + uuid.uuid4().hex
test_key = registry_parent + '\\' + test_name
normal_key = registry_parent + r'\cn.campus_ai.readonly'


def registry_value(name):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, name) as key:
            return winreg.QueryValueEx(key, '')[0]
    except FileNotFoundError:
        return None


def call_host(host, request):
    data = json.dumps(request).encode('utf-8')
    process = subprocess.run(
        ['node', str(host)], input=struct.pack('<I', len(data)) + data,
        capture_output=True, check=True, timeout=15
    )
    assert not process.stderr, process.stderr
    length = struct.unpack('<I', process.stdout[:4])[0]
    assert len(process.stdout) == length + 4
    return json.loads(process.stdout[4:])


normal_before = registry_value(normal_key)
assert registry_value(test_key) is None, '测试注册项已存在，停止以免覆盖。'
with tempfile.TemporaryDirectory(prefix='校园助手安装测试 ') as temp:
    destination = Path(temp) / '全新安装 目录'
    shutil.copytree(
        project, destination,
        ignore=shutil.ignore_patterns('.git', '__pycache__', 'job-ledger', 'config.json', 'native-host.json')
    )
    setup = destination / 'host' / 'setup.ps1'
    assert setup.read_bytes().startswith(b'\xef\xbb\xbf'), 'Windows PowerShell 脚本需要 UTF-8 BOM。'
    test_manifest = destination / 'host' / 'native-host.json'
    background = destination / 'extension' / 'background.js'
    original = background.read_text(encoding='utf-8')
    assert original.count('cn.campus_ai.readonly') == 3
    background.write_text(original.replace('cn.campus_ai.readonly', test_name), encoding='utf-8')
    powershell = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(setup), '-HostName', test_name]

    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, test_key) as key:
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, str(destination / 'different-install.json'))
        blocked = subprocess.run(powershell, cwd=destination, capture_output=True, timeout=20)
        assert blocked.returncode != 0, '不应静默覆盖已有连接。'
        assert registry_value(test_key) == str(destination / 'different-install.json')
        assert not test_manifest.exists() and not (destination / 'host' / 'config.json').exists()
        print('PASS: an existing installation is not overwritten without explicit -Force')

        installed = subprocess.run(
            [os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', str(destination / 'install.cmd'),
             '-HostName', test_name, '-Force'],
            cwd=destination, input=b'\r\n', capture_output=True, timeout=20
        )
        assert installed.returncode == 0, (installed.stdout, installed.stderr)
        manifest = json.loads(test_manifest.read_text(encoding='utf-8'))
        config = json.loads((destination / 'host' / 'config.json').read_text(encoding='utf-8'))
        assert manifest['name'] == test_name
        assert Path(manifest['path']) == destination / 'host' / 'host.cmd'
        assert manifest['allowed_origins'] == ['chrome-extension://npoilipflmekpheijopnkkodofinhaci/']
        assert Path(config['root']) == destination / 'test-files'
        assert Path(registry_value(test_key)) == test_manifest
        listed = call_host(destination / 'host' / 'host.mjs', {'tool':'list_dir', 'path':'.'})
        assert listed['ok'] and any(entry['name'] == 'hello.txt' for entry in listed['entries']), listed
        print('PASS: a fresh installation in a path with Chinese characters generates working local configuration')

        env = os.environ.copy()
        env['CAMPUS_TEST_EXTENSION'] = str(destination / 'extension')
        script = destination / 'tests' / 'browser-compat.cjs'
        for case in ('recover', 'stop', 'format'):
            def run(browser):
                result = subprocess.run(
                    ['node', str(script), browser, case], cwd=destination, env=env,
                    capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=45
                )
                assert result.returncode == 0, (browser, case, result.stdout, result.stderr)
                return result.stdout.strip()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                for result in executor.map(run, ('chrome', 'edge')):
                    print(result, flush=True)
        assert registry_value(normal_key) == normal_before, '测试不应改变现有安装。'
    finally:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, test_key)

print('PASS: fresh installation and browser checks left the existing native host unchanged')
