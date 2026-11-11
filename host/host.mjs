import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const base = path.dirname(fileURLToPath(import.meta.url));
const maxMessage = 1024 * 1024;
const maxFile = 200 * 1024;
const ledgerDir = path.join(base, 'job-ledger');
const validJobId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function readJob(jobId) {
  if (!validJobId(jobId)) throw new Error('任务编号无效。');
  let job;
  try {
    job = JSON.parse(await fs.readFile(path.join(ledgerDir, `${jobId}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {jobId, state:'unknown', error:'没有找到该操作的本机记录，无法确认是否执行。'};
    throw error;
  }
  if (job.state === 'running') return {...job, state:'unknown', error:'本机记录显示操作已提交，但无法确认是否开始或当前执行状态。'};
  return job;
}

async function startJob(jobId, tool) {
  if (!validJobId(jobId)) throw new Error('任务编号无效。');
  await fs.mkdir(ledgerDir, {recursive:true});
  const file = path.join(ledgerDir, `${jobId}.json`);
  const job = {jobId, tool, state:'running', startedAt:Date.now()};
  try {
    await fs.writeFile(file, JSON.stringify(job), {encoding:'utf8', flag:'wx'});
    return {file, job};
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
}

async function finishJob(file, job, result) {
  const state = result.launchStatus === 'unknown' ? 'unknown' : result.cancelled ? 'stopped' : result.started === false ? 'not_started' : (result.stopRequested || result.timedOut) && result.terminationConfirmed === false ? 'unknown' : result.ok ? 'completed' : 'failed';
  const finished = {...job, state, finishedAt:Date.now(), result};
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(finished), 'utf8');
  await fs.rename(temp, file);
}

async function execute(request, progress, control) {
  if (!request || !['list_dir', 'read_file', 'write_file', 'run_command', 'open_terminal'].includes(request.tool)) {
    throw new Error('不支持的请求。');
  }
  const config = JSON.parse(await fs.readFile(path.join(base, 'config.json'), 'utf8'));
  const root = await fs.realpath(config.root);
  if (request.tool === 'open_terminal') {
    const command = "$p=Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoLogo','-NoExit' -PassThru -ErrorAction Stop; Write-Output $p.Id";
    const result = await runCommand(command, root, 15, progress, control);
    const pid = result.stdout.trim();
    if (!result.ok || !/^\d+$/.test(pid)) {
      return {...result, ok:false, tool:'open_terminal', launchStatus:'unknown', error:'无法确认终端是否已启动；请先检查桌面，不要自动重试。'};
    }
    return {ok:true, tool:'open_terminal', processId:Number(pid), message:'已启动 PowerShell 终端进程；请用户确认窗口是否显示。助手无法查看窗口内的操作。'};
  }
  if (request.tool === 'run_command') {
    if (typeof request.command !== 'string' || !request.command.trim()) throw new Error('缺少 PowerShell 命令。');
    if (request.cwd !== undefined && typeof request.cwd !== 'string') throw new Error('工作目录必须是字符串。');
    const cwd = path.resolve(root, request.cwd || '.');
    const timeout = Math.min(Math.max(Number(request.timeout_sec) || 120, 1), 1800);
    if (control.stopRequested) return {ok:false, tool:'run_command', cwd, started:false, cancelled:true, terminationConfirmed:true, stdout:'', stderr:''};
    return await runCommand(request.command, cwd, timeout, progress, control);
  }
  if (typeof request.path !== 'string' || request.path.includes('\0')) throw new Error('路径无效。');
  const target = path.resolve(root, request.path);
  if (request.tool === 'write_file') {
    if (typeof request.content !== 'string') throw new Error('写入内容必须是文本。');
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, request.content, 'utf8');
    return {ok:true, tool:request.tool, path:target, bytes:Buffer.byteLength(request.content, 'utf8')};
  }
  if (request.tool === 'list_dir') {
    const entries = await fs.readdir(target, { withFileTypes: true });
    if (entries.length > 500) throw new Error('目录项目超过 500 个，请选择较小的目录。');
    return { ok: true, tool: request.tool, path: request.path, entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other' })) };
  }
  const info = await fs.stat(target);
  if (!info.isFile()) throw new Error('目标不是文件。');
  if (info.size > maxFile) throw new Error('文件超过 200 KB。');
  const bytes = await fs.readFile(target);
  if (bytes.length > maxFile || bytes.includes(0)) throw new Error('文件过大或不是文本文件。');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { ok: true, tool: request.tool, path: request.path, content };
}

function runCommand(command, cwd, timeout, progress, control) {
  return new Promise((resolve, reject) => {
    const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; " + command;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {cwd, windowsHide:true});
    let output = Buffer.alloc(0), errors = Buffer.alloc(0), truncated = false, timedOut = false;
    let stopReason = null, killDone = false, killConfirmed = false, closed = false, exitCode = null;
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    const append = (current, chunk) => {
      const room = 100000 - current.length;
      if (chunk.length > room) truncated = true;
      return room > 0 ? Buffer.concat([current, chunk.subarray(0, room)]) : current;
    };
    child.stdout.on('data', chunk => { const room = Math.max(0, 100000 - output.length); output = append(output, chunk); const text = stdoutDecoder.write(chunk.subarray(0, room)); if (text) progress('stdout', text); });
    child.stderr.on('data', chunk => { const room = Math.max(0, 100000 - errors.length); errors = append(errors, chunk); const text = stderrDecoder.write(chunk.subarray(0, room)); if (text) progress('stderr', text); });
    function finishIfReady() {
      if (!closed || (stopReason && !killDone)) return;
      const stdoutTail = stdoutDecoder.end(), stderrTail = stderrDecoder.end();
      if (stdoutTail) progress('stdout', stdoutTail);
      if (stderrTail) progress('stderr', stderrTail);
      resolve({ok:exitCode === 0 && !stopReason, tool:'run_command', cwd, started:true, exitCode, timedOut, cancelled:stopReason === 'user' && killConfirmed, stopRequested:stopReason === 'user', terminationConfirmed:stopReason ? killConfirmed : null, truncated, stdout:output.toString('utf8'), stderr:errors.toString('utf8')});
    }
    function stop(reason) {
      if (stopReason || closed) return;
      stopReason = reason;
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true, stdio:'ignore'});
      function finished(success) {
        if (killDone) return;
        killDone = true;
        killConfirmed = success;
        if (!success) {
          if (!closed) child.kill();
          control.notify({type:'cancel_error', error:'未能确认整个进程树已停止，请检查命令状态。'});
        }
        finishIfReady();
      }
      killer.on('error', () => finished(false));
      killer.on('close', code => finished(code === 0));
    }
    control.stop = () => stop('user');
    const timer = setTimeout(() => { timedOut = true; stop('timeout'); }, timeout * 1000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); closed = true; exitCode = code; finishIfReady(); });
    if (control.stopRequested) control.stop();
  });
}

function respond(payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  process.stdout.write(Buffer.concat([header, data]));
}

let buffer = Buffer.alloc(0), activeControl = null, requestStarted = false;
function handleRequest(request) {
  if (request?.type === 'cancel') {
    if (!activeControl || activeControl.finished || activeControl.tool !== 'run_command') {
      respond({type:'cancel_error', error:'当前没有可停止的命令。'});
      return;
    }
    if (activeControl.stopRequested) return;
    activeControl.stopRequested = true;
    respond({type:'cancel_status', state:'stopping'});
    if (activeControl.stop) activeControl.stop();
    return;
  }
  if (requestStarted) return;
  requestStarted = true;
  if (request?.type === 'query') {
    readJob(request.jobId).then(job => respond({type:'job_status', job}), error => respond({type:'job_status', job:{jobId:request.jobId, state:'unknown', error:`读取本机记录失败：${error.message}`}}));
    return;
  }
  const stream = request?.stream === true;
  const control = activeControl = {tool:request?.tool, stopRequested:false, stop:null, finished:false, notify:respond};
  (async () => {
    let entry = null;
    if (request.jobId !== undefined) {
      entry = await startJob(request.jobId, request.tool);
      if (!entry) {
        let job;
        try { job = await readJob(request.jobId); }
        catch (error) { job = {jobId:request.jobId, state:'unknown', error:`已有操作的状态无法读取：${error.message}`}; }
        control.finished = true;
        respond({type:'job_status', job});
        return;
      }
    }
    let result;
    try {
      result = await execute(request, (source, text) => { if (stream) respond({type:'progress', source, text}); }, control);
    } catch (error) {
      result = {ok:false, error:error.message};
    }
    control.finished = true;
    if (entry) {
      try { await finishJob(entry.file, entry.job, result); }
      catch (error) { result.recoveryWarning = `操作已返回，但本机结果记录失败：${error.message}`; }
    }
    respond(stream ? {type:'result', result} : result);
  })().catch(error => {
    control.finished = true;
    const result = {ok:false, started:false, error:`操作未开始：${error.message}`};
    respond(stream ? {type:'result', result} : result);
  });
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE(0);
    if (size > maxMessage) { respond({ok:false, error:'请求过大。'}); process.stdin.destroy(); return; }
    if (buffer.length < size + 4) return;
    const payload = buffer.subarray(4, size + 4);
    buffer = buffer.subarray(size + 4);
    try { handleRequest(JSON.parse(payload.toString('utf8'))); }
    catch (error) { respond({ok:false, error:error.message}); }
  }
});
