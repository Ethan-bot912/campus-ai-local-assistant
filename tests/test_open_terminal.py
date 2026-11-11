"""Manual Windows test: opens an interactive terminal and leaves it for the user."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid


if len(sys.argv) == 4 and sys.argv[1] == '--inspect':
    pid, output = int(sys.argv[2]), Path(sys.argv[3])
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    user = ctypes.WinDLL('user32', use_last_error=True)
    kernel.FreeConsole.restype = wintypes.BOOL
    kernel.AttachConsole.argtypes = [wintypes.DWORD]
    kernel.AttachConsole.restype = wintypes.BOOL
    kernel.GetConsoleWindow.restype = wintypes.HWND
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetConsoleMode.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.IsWindowVisible.restype = wintypes.BOOL
    kernel.FreeConsole()
    attached = bool(kernel.AttachConsole(pid))
    error = ctypes.get_last_error() if not attached else 0
    handle = kernel.GetConsoleWindow() if attached else None
    input_handle = kernel.CreateFileW('CONIN$', 0x80000000, 3, None, 3, 0, None) if attached else None
    mode = wintypes.DWORD()
    input_console = bool(input_handle and kernel.GetConsoleMode(input_handle, ctypes.byref(mode)))
    output.write_text(json.dumps({'attached':attached, 'error':error, 'visible':bool(handle and user.IsWindowVisible(handle)), 'inputConsole':input_console}), encoding='utf-8')
    if input_handle:
        kernel.CloseHandle(input_handle)
    kernel.FreeConsole()
    raise SystemExit(0)

if os.environ.get('CAMPUS_MANUAL_TERMINAL') != '1':
    print('SKIP: set CAMPUS_MANUAL_TERMINAL=1 to open a visible interactive terminal')
    raise SystemExit(0)

source = Path('host/host.mjs').resolve()
working_directory = Path('test-files').resolve()
with tempfile.TemporaryDirectory(prefix='campus-open-terminal-') as folder:
    base = Path(folder)
    shutil.copy2(source, base / 'host.mjs')
    (base / 'config.json').write_text(json.dumps({'root':str(working_directory)}), encoding='utf-8')
    request = {'tool':'open_terminal', 'jobId':str(uuid.uuid4())}
    data = json.dumps(request).encode('utf-8')
    process = subprocess.run(
        ['node', str(base / 'host.mjs')], input=struct.pack('<I', len(data)) + data,
        capture_output=True, check=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW
    )
    length = struct.unpack('<I', process.stdout[:4])[0]
    assert len(process.stdout) == length + 4
    result = json.loads(process.stdout[4:])
    assert result['ok'] and result['tool'] == 'open_terminal' and result['processId'] > 0, result
    output = base / 'console.json'
    subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), '--inspect', str(result['processId']), str(output)],
        capture_output=True, check=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW
    )
    info = json.loads(output.read_text(encoding='utf-8'))
    assert info['attached'] and info['visible'] and info['inputConsole'], info
    print('PASS: open_terminal created a visible PowerShell console with an interactive input buffer')
    if os.environ.get('CAMPUS_KEEP_TERMINAL') == '1':
        print('The terminal remains open for the user to inspect and close.')
    else:
        subprocess.run(
            ['taskkill.exe', '/PID', str(result['processId']), '/T', '/F'],
            capture_output=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW
        )
        print('The short-lived test terminal was closed after inspection.')
