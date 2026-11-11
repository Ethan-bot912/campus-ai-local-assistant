(() => {
  if (document.getElementById('campus-pc-bridge')) return;
  const start = 'PC_TOOL_REQUEST', end = 'PC_TOOL_END';
  const handled = new Set();
  const historyPrefix = 'campusPcStep:';
  let paused = false, armed = false, busy = false, candidateKey = null, stableSince = 0, conversationEpoch = 0, formatErrors = 0;
  let unsent = null, activePort = null, activeStep = null, activeTaskId = null, historyPath = null, recoveryDone = false, settingsReady = false, pauseVersion = 0;
  let contextLost = false, scanTimer = null;

  const host = document.createElement('div');
  host.id = 'campus-pc-bridge';
  const shadow = host.attachShadow({mode:'closed'});
  shadow.innerHTML = `<style>
    :host{all:initial}.panel{position:fixed;z-index:2147483646;right:16px;bottom:100px;width:300px;max-height:70vh;overflow:auto;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;color:#1e293b;box-shadow:0 8px 28px #0f172a26;font:13px/1.5 system-ui,sans-serif}.panel.minimized{width:230px;max-height:none;overflow:visible}.heading{display:flex;align-items:center;justify-content:space-between;gap:8px}h2{font-size:14px;margin:0}p{margin:6px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto;background:#f1f5f9;padding:8px;border-radius:6px}button{padding:7px 10px;margin:4px 4px 0 0;border:1px solid #9aaec5;border-radius:6px;background:#f8fafc;color:#172033;cursor:pointer}button:disabled{opacity:.6;cursor:default}.minimize{font-size:18px;line-height:1;padding:3px 8px;margin:0}summary{cursor:pointer}.panel.minimized [data-expanded]{display:none}#history-list{max-height:220px;overflow:auto}.entry{margin-top:8px}[hidden]{display:none!important}
  </style><div class="panel" role="region" aria-label="校园 AI 本地助手">
    <div class="heading"><h2>校园 AI 本地助手</h2><button id="minimize" class="minimize" aria-label="最小化面板" title="最小化面板">−</button></div>
    <p id="status" role="status">发送新消息后开始监听本次对话。</p>
    <button id="stop" hidden>停止当前命令</button><button id="fill" hidden>继续并发送待处理结果</button><button id="recheck" hidden>重新查询状态</button>
    <div id="progress" hidden><p id="elapsed"></p><details data-expanded open><summary>执行输出</summary><pre id="output">等待命令输出…</pre></details></div>
    <button id="toggle" data-expanded>暂停自动执行</button><pre id="activity" data-expanded hidden></pre>
    <details id="history" data-expanded><summary id="history-title">本次对话记录</summary><div id="history-list"></div></details>
  </div>`;
  document.documentElement.append(host);
  const $ = id => shadow.getElementById(id);
  const disconnectedMessage = '扩展已断开，请刷新当前网页；之前运行的操作状态请刷新后查看。';
  const status = value => { $('status').textContent = contextLost ? disconnectedMessage : value; };
  function extensionAvailable() {
    try { if (chrome.runtime?.id) return true; } catch {}
    contextLost = true;
    document.documentElement.dataset.campusPcPaused = 'true';
    for (const id of ['toggle', 'stop', 'fill', 'recheck', 'minimize']) $(id).disabled = true;
    if (scanTimer !== null) clearInterval(scanTimer);
    status(disconnectedMessage);
    return false;
  }
  const inputBox = () => document.querySelector('textarea[data-testid="chat-input"]');
  const sendButton = () => document.querySelector('button[data-testid="chat-send-button"][aria-label="发送消息"]');
  function setPaused(value, persist = true) {
    paused = value;
    document.documentElement.dataset.campusPcPaused = String(paused);
    $('toggle').textContent = paused ? '继续自动执行' : '暂停自动执行';
    if (persist) {
      pauseVersion++;
      chrome.storage.local.set({['campusPcPaused:' + location.pathname]:value}).catch(error => status(`保存暂停状态失败：${error.message}`));
    }
  }
  function setMinimized(value) {
    shadow.querySelector('.panel').classList.toggle('minimized', value);
    $('minimize').textContent = value ? '+' : '−';
    $('minimize').setAttribute('aria-label', value ? '展开面板' : '最小化面板');
    $('minimize').title = value ? '展开面板' : '最小化面板';
  }
  async function saveStep(step) {
    await chrome.storage.local.set({[historyPrefix + step.id]:structuredClone(step)});
  }
  async function conversationHistory() {
    const stored = await chrome.storage.local.get(null);
    return Object.entries(stored).filter(([key, value]) => key.startsWith(historyPrefix) && value?.path === location.pathname).map(([, value]) => value).sort((a, b) => b.startedAt - a.startedAt);
  }
  async function renderHistory() {
    const history = await conversationHistory();
    $('history-title').textContent = `本次对话记录（${history.length}）`;
    const openSteps = new Set(Array.from($('history-list').querySelectorAll('details[data-step-id][open]'), item => item.dataset.stepId));
    const closedTasks = new Set(Array.from($('history-list').querySelectorAll('details[data-task-id]:not([open])'), item => item.dataset.taskId));
    $('history-list').replaceChildren();
    const tasks = new Map();
    for (const step of history) {
      const id = step.taskId || step.id;
      if (!tasks.has(id)) tasks.set(id, []);
      tasks.get(id).push(step);
    }
    for (const [taskId, steps] of tasks) {
      steps.sort((a, b) => a.startedAt - b.startedAt);
      const task = document.createElement('details');
      task.dataset.taskId = taskId;
      task.open = !closedTasks.has(taskId);
      const heading = document.createElement('summary');
      heading.textContent = `任务 · ${new Date(steps[0].startedAt).toLocaleTimeString()} · ${steps.length} 步`;
      task.append(heading);
      for (const [index, step] of steps.entries()) {
        const entry = document.createElement('details');
        entry.className = 'entry';
        entry.dataset.stepId = step.id;
        entry.open = openSteps.has(step.id);
        const title = document.createElement('summary');
        const state = step.state === 'running' ? (activeStep?.id === step.id ? '运行中' : '未能确认状态') : ({completed:'已完成', failed:'失败', stopped:'已停止', not_started:'未执行', unknown:'状态未知', invalid:'格式错误'}[step.state] || step.state);
        const delivery = ({not_sent:'结果待发送', sending:'发送状态未知', submitted:'已交给网页', unknown:'发送状态未知'}[step.delivery] || '');
        const name = ({list_dir:'查看目录', read_file:'读取文件', write_file:'写入文件', run_command:'运行命令', open_terminal:'打开终端'})[step.tool] || step.tool;
        const elapsed = step.finishedAt ? ` · ${Math.max(0, Math.floor((step.finishedAt - step.startedAt) / 1000))} 秒` : '';
        title.textContent = `第 ${index + 1} 步 · ${name} · ${state}${elapsed}${delivery ? ' · ' + delivery : ''}`;
        const detail = document.createElement('pre');
        detail.textContent = JSON.stringify({taskId:step.taskId, request:step.request, error:step.error, result:step.result, startedAt:new Date(step.startedAt).toLocaleString(), finishedAt:step.finishedAt ? new Date(step.finishedAt).toLocaleString() : null}, null, 2);
        entry.append(title, detail);
        task.append(entry);
      }
      $('history-list').append(task);
    }
  }
  async function recoverPending() {
    const path = location.pathname, epoch = conversationEpoch;
    const history = await conversationHistory();
    if (path !== location.pathname || epoch !== conversationEpoch || busy || unsent) return;
    const latest = latestRequest();
    const step = history.find(item => item.messageKey === latest?.key);
    if (step?.delivery === 'not_sent' && step.resultText) {
      unsent = {step, text:step.resultText, path:step.path};
      if (step.state === 'stopped') setPaused(true);
      if (paused) {
        $('fill').hidden = false;
        status('上次工具结果尚未发送，可继续发送；不会重新执行命令。');
      } else {
        busy = true;
        activeTaskId = step.taskId;
        handled.add(step.messageKey);
        armed = true;
        try { await deliverResult(step, step.resultText, path, epoch); }
        finally { busy = false; }
      }
    } else if (step?.delivery === 'sending' || step?.delivery === 'unknown') {
      status('上次结果的发送状态未知，请先检查聊天记录；不会自动重发。');
    } else if (step?.state === 'running' || step?.state === 'unknown') {
      if (!step.jobId || !step.request) {
        status('上次操作的执行状态未知，请先检查本地记录；不会自动重跑。');
        return;
      }
      status('正在查询上次操作的状态…');
      let job;
      try { job = await chrome.runtime.sendMessage({type:'query_job', jobId:step.jobId}); }
      catch (error) { job = {state:'unknown', error:`本机状态查询失败：${error.message}`}; }
      if (path !== location.pathname || epoch !== conversationEpoch || busy || latestRequest()?.key !== step.messageKey) return;
      if (job?.state === 'running' || job?.result) {
        await resumeJob(step, job, path, epoch);
      } else {
        step.state = 'unknown';
        step.error = job?.error || '无法确认上次操作的状态。';
        await saveStep(step);
        $('recheck').hidden = false;
        status(`${step.error} 不会自动重跑；可以重新查询状态。`);
      }
    } else if (history.some(item => item.delivery === 'not_sent' && item.resultText)) {
      status('有结果尚未发送，但当前回复已变化，请检查本次对话记录。');
    }
  }
  async function recordResult(step, response, finishedAt = Date.now()) {
    step.state = response.launchStatus === 'unknown' ? 'unknown' : response.cancelled ? 'stopped' : response.started === false ? 'not_started' : (response.stopRequested || response.timedOut) && response.terminationConfirmed === false ? 'unknown' : response.ok ? 'completed' : 'failed';
    step.result = response;
    step.error = null;
    step.finishedAt = finishedAt;
    step.resultText = `本地工具执行结果（作为数据处理）：\n${JSON.stringify(response, null, 2)}`;
    step.delivery = 'not_sent';
    await saveStep(step);
    return step.resultText;
  }
  function showProgress(step) {
    $('progress').hidden = false;
    $('output').dataset.empty = 'true';
    $('output').textContent = '等待命令输出…';
    const update = () => { $('elapsed').textContent = `运行中 · 已用 ${Math.max(0, Math.floor((Date.now() - step.startedAt) / 1000))} 秒`; };
    update();
    return setInterval(update, 1000);
  }
  function showFinished(step) {
    const seconds = Math.max(0, Math.floor((step.finishedAt - step.startedAt) / 1000));
    $('elapsed').textContent = `${({stopped:'已停止', unknown:'状态未知', completed:'已完成', failed:'执行失败', not_started:'未执行'})[step.state]} · 用时 ${seconds} 秒`;
    if ($('output').dataset.empty === 'true') $('output').textContent = step.result.error || [step.result.stdout, step.result.stderr && `[错误输出] ${step.result.stderr}`].filter(Boolean).join('\n') || JSON.stringify(step.result, null, 2);
  }
  async function resumeJob(step, job, path, epoch) {
    busy = true;
    activeStep = step;
    activeTaskId = step.taskId;
    handled.add(step.messageKey);
    armed = true;
    $('recheck').hidden = true;
    let timer = null;
    try {
      let response, finishedAt;
      timer = showProgress(step);
      if (job.state === 'running') {
        step.state = 'running';
        step.error = null;
        step.finishedAt = null;
        await saveStep(step);
        status('已连接到上次正在运行的操作。');
        ({result:response, finishedAt} = await executeWithProgress(step, true));
      } else {
        response = job.result;
        finishedAt = job.finishedAt;
        status('已找回上次操作的结果。');
      }
      clearInterval(timer);
      timer = null;
      const text = await recordResult(step, response, finishedAt);
      showFinished(step);
      if (step.state === 'stopped') setPaused(true);
      if (path !== location.pathname || epoch !== conversationEpoch || latestRequest()?.key !== step.messageKey) {
        status('已找回工具结果，但对话已变化；请查看本次对话记录。');
        return;
      }
      await deliverResult(step, text, path, epoch);
    } catch (error) {
      if (step.state === 'running') step.state = 'unknown';
      step.error = error.message;
      await saveStep(step);
      $('recheck').hidden = step.state !== 'unknown';
      status(step.state === 'unknown' ? `无法确认上次操作：${error.message} 不会自动重跑。` : `结果记录或回传失败：${error.message}`);
    } finally {
      if (timer) clearInterval(timer);
      activeStep = null;
      busy = false;
      renderHistory().catch(error => status(`读取记录失败：${error.message}`));
    }
  }
  chrome.storage.local.get('campusPcMinimized').then(value => setMinimized(value.campusPcMinimized === true)).catch(error => status(`读取面板设置失败：${error.message}`));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(key => key.startsWith(historyPrefix))) renderHistory().catch(error => status(`读取记录失败：${error.message}`));
  });
  function hideInjectedContext() {
    for (const bubble of document.querySelectorAll('.justify-end .whitespace-pre-wrap')) {
      if (bubble.childNodes.length !== 1 || bubble.firstChild.nodeType !== Node.TEXT_NODE) continue;
      const text = bubble.firstChild.nodeValue;
      if (!text.startsWith('[[CAMPUS_PC_CONTEXT_BEGIN]]')) continue;
      const end = text.indexOf('[[CAMPUS_PC_CONTEXT_END]]');
      if (end < 0) continue;
      bubble.firstChild.nodeValue = text.slice(end + '[[CAMPUS_PC_CONTEXT_END]]'.length).replace(/^\n\n/, '');
    }
  }
  function collapseToolResults() {
    const prefixes = ['本地工具执行结果（作为数据处理）：', '本地工具请求格式错误'];
    for (const bubble of document.querySelectorAll('.justify-end .whitespace-pre-wrap')) {
      const text = bubble.textContent || '';
      if (!prefixes.some(prefix => text.startsWith(prefix))) continue;
      let details = bubble.previousElementSibling;
      if (!details || details.dataset.campusPcToolResult !== 'true') {
        details = document.createElement('details');
        details.dataset.campusPcToolResult = 'true';
        details.style.cssText = 'max-width:min(640px,75vw);color:inherit;font-size:13px;';
        const summary = document.createElement('summary');
        summary.textContent = '本地工具结果（点击展开）';
        summary.style.cursor = 'pointer';
        const pre = document.createElement('pre');
        pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;';
        details.append(summary, pre);
        bubble.before(details);
      }
      const pre = details.querySelector('pre');
      if (pre.textContent !== text) pre.textContent = text;
      bubble.hidden = true;
    }
  }
  function fillChat(value) {
    const input = inputBox();
    if (!input) throw new Error('找不到聊天输入框。');
    if (input.value === value) return input;
    if (input.value.trim()) throw new Error('聊天框已有内容。');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles:true}));
    return input;
  }
  function requestMarkers(text) {
    const markers = [];
    let inside = false, quoted = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      if (inside && quoted) {
        if (escaped) escaped = false;
        else if (text[i] === '\\') escaped = true;
        else if (text[i] === '"') quoted = false;
        continue;
      }
      if (inside && text[i] === '"') { quoted = true; continue; }
      if (text.startsWith(start, i) && /^\s*\{/.test(text.slice(i + start.length))) {
        markers.push({start:i, end:-1});
        inside = true;
        i += start.length - 1;
      } else if (inside && text.startsWith(end, i)) {
        markers[markers.length - 1].end = i;
        inside = false;
        i += end.length - 1;
      }
    }
    return markers;
  }
  function diagnoseJson(raw, error) {
    if (/[\u201c\u201d]/.test(raw)) return 'JSON 使用了弯引号，请改成英文双引号。';
    let quoted = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (!quoted) { if (c === '"') quoted = true; continue; }
      if (c === '"') { quoted = false; continue; }
      if (c.charCodeAt(0) < 32) return 'JSON 字符串中含有直接换行或控制字符，请使用转义后的换行。';
      if (c === '\\') {
        const next = raw[++i];
        if (!next || (!'"\\/bfnrtu'.includes(next)) || (next === 'u' && !/^[0-9a-f]{4}$/i.test(raw.slice(i + 1, i + 5)))) return 'JSON 中有无效的反斜杠转义；Windows 路径请使用正斜杠，命令中的反斜杠需正确转义。';
        if (next === 'u') i += 4;
      }
    }
    if (/unterminated/i.test(error.message)) return 'JSON 字符串没有正确结束，请检查引号和字符串末尾的反斜杠。';
    return `JSON 无法解析：${error.message}。请检查引号、逗号和转义字符。`;
  }
  function latestRequest() {
    const replies = document.querySelectorAll('.prose-code-custom');
    if (!replies.length) return null;
    const reply = replies[replies.length - 1];
    const fullText = reply.innerText;
    const count = requestMarkers(fullText).length;
    if (count > 1) return {error:`本次回复包含 ${count} 个工具请求，全部未执行；请每次只发送一个请求，等结果返回后再发送下一个。`, key:JSON.stringify([location.pathname, replies.length, fullText]), path:location.pathname};
    const fenced = Array.from(reply.querySelectorAll('pre code, [data-testid="code-block"] code')).find(code => code.textContent.includes(start) && code.textContent.includes(end));
    const text = fenced ? fenced.textContent : fullText;
    const marker = requestMarkers(text)[0];
    const first = marker?.start ?? text.indexOf(start);
    if (first < 0) return null;
    const last = marker?.end >= 0 ? marker.end : text.indexOf(end, first + start.length);
    if (last < 0) return null;
    const raw = text.slice(first + start.length, last).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const key = JSON.stringify([location.pathname, replies.length, text]);
    try {
      if (!fenced && reply.querySelector('.katex')) throw new Error('网页把命令中的字符渲染成公式，无法可靠读取');
      let v;
      try { v = JSON.parse(raw); } catch (error) { throw new Error(diagnoseJson(raw, error)); }
      if (!v || !['list_dir','read_file','write_file','run_command','open_terminal'].includes(v.tool)) throw new Error('工具名称无效');
      if (v.tool === 'open_terminal' && Object.keys(v).some(key => key !== 'tool')) throw new Error('打开终端请求不接受其他参数');
      if (v.tool === 'run_command' && typeof v.command !== 'string') throw new Error('缺少 command 字符串');
      if (!['run_command','open_terminal'].includes(v.tool) && typeof v.path !== 'string') throw new Error('缺少 path 字符串');
      if (v.tool === 'write_file' && typeof v.content !== 'string') throw new Error('缺少 content 字符串');
      if (!fenced && ['write_file','run_command'].includes(v.tool)) throw new Error('命令和写入请求必须放在完整的 JSON 代码块中');
      const request = v.tool === 'open_terminal' ? {tool:v.tool} : v.tool === 'run_command' ? {tool:v.tool, command:v.command, ...(v.cwd !== undefined ? {cwd:v.cwd} : {}), ...(v.timeout_sec !== undefined ? {timeout_sec:v.timeout_sec} : {})} : {tool:v.tool, path:v.path, ...(v.tool === 'write_file' ? {content:v.content} : {})};
      return {request, key, path:location.pathname};
    } catch (error) { return {error:error.message, key, path:location.pathname}; }
  }
  function noteUserSend() {
    const latest = latestRequest();
    if (latest) handled.add(latest.key);
    armed = true;
    conversationEpoch++;
    activeTaskId = crypto.randomUUID();
    formatErrors = 0;
    candidateKey = null;
    if (!paused) status('已开启自动执行，等待模型请求。');
  }
  document.addEventListener('click', e => {
    if (e.isTrusted && e.target instanceof Element && e.target.closest('button[data-testid="chat-send-button"]')) noteUserSend();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.isTrusted && e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target === inputBox()) noteUserSend();
  }, true);
  $('toggle').addEventListener('click', e => {
    if (!e.isTrusted) return;
    setPaused(!paused);
    status(paused ? '已暂停新的操作；正在运行的命令不会自动终止。' : '已继续自动执行。');
  });
  $('minimize').addEventListener('click', e => {
    if (!e.isTrusted) return;
    const value = !shadow.querySelector('.panel').classList.contains('minimized');
    setMinimized(value);
    chrome.storage.local.set({campusPcMinimized:value}).catch(error => status(`保存面板状态失败：${error.message}`));
  });
  $('stop').addEventListener('click', e => {
    if (!e.isTrusted || !activePort) return;
    setPaused(true);
    $('stop').disabled = true;
    $('stop').textContent = '正在停止…';
    status('正在停止当前命令；后续操作已暂停。');
    activePort.postMessage({type:'cancel'});
  });
  $('fill').addEventListener('click', async e => {
    if (!e.isTrusted || !unsent || busy) return;
    if (location.pathname !== unsent.path || latestRequest()?.key !== unsent.step.messageKey) { status('当前对话已变化，请检查记录后再继续。'); return; }
    const pending = unsent;
    setPaused(false);
    handled.add(pending.step.messageKey);
    armed = true;
    activeTaskId = pending.step.taskId;
    busy = true;
    try { await deliverResult(pending.step, pending.text, pending.path, conversationEpoch); }
    catch (error) { status(`记录写入失败：${error.message}`); }
    finally { busy = false; }
  });
  $('recheck').addEventListener('click', e => {
    if (!e.isTrusted || busy) return;
    $('recheck').hidden = true;
    recoverPending().catch(error => status(`查询状态失败：${error.message}`));
  });
  async function sendResult(text, conversation, epoch, beforeClick, onClick) {
    if (location.pathname !== conversation) throw new Error('对话已切换，结果未发送。');
    if (conversationEpoch !== epoch) throw new Error('对话已出现新消息，结果未自动发送。');
    const input = fillChat(text);
    for (let i=0; i<40; i++) {
      if (location.pathname !== conversation) throw new Error('对话已切换，结果未发送。');
      if (conversationEpoch !== epoch) throw new Error('对话已出现新消息，结果未自动发送。');
      const button = sendButton();
      if (button && !button.disabled && input.value === text) {
        await beforeClick();
        if (paused || location.pathname !== conversation || conversationEpoch !== epoch || input.value !== text) throw new Error('操作已暂停，或对话、输入框已变化，结果未发送。');
        onClick();
        button.click();
        for (let j=0; j<40; j++) {
          if (!input.value) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('已触发发送，但无法确认网页是否接收；不会自动重发。');
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('发送按钮未就绪，结果保留在聊天框。');
  }
  async function deliverResult(step, text, conversation, epoch) {
    unsent = {step, text, path:conversation};
    if (paused) { $('fill').hidden = false; status('已暂停；结果尚未发送，可继续任务。'); return; }
    let clicked = false;
    try {
      await sendResult(text, conversation, epoch, async () => { step.delivery = 'sending'; await saveStep(step); }, () => { clicked = true; });
      step.delivery = 'submitted';
      await saveStep(step);
      unsent = null;
      $('fill').hidden = true;
      status('结果已交给网页，等待模型继续。');
    } catch (error) {
      step.delivery = clicked ? 'unknown' : 'not_sent';
      await saveStep(step);
      if (clicked) { unsent = null; $('fill').hidden = true; }
      else $('fill').hidden = false;
      status(clicked ? `${error.message} 请先检查聊天记录。` : error.message);
    }
  }
  function executeWithProgress(step, reconnect = false) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({name:'campus-pc-progress'});
      activePort = port;
      $('stop').hidden = step.request.tool !== 'run_command';
      $('stop').disabled = false;
      $('stop').textContent = '停止当前命令';
      let settled = false;
      function closePort() {
        if (activePort === port) activePort = null;
        $('stop').hidden = true;
        port.disconnect();
      }
      port.onMessage.addListener(event => {
        if (event.type === 'snapshot' && event.output) {
          $('output').dataset.empty = 'false';
          $('output').textContent = event.output;
          $('output').scrollTop = $('output').scrollHeight;
        } else if (event.type === 'progress') {
          if ($('output').dataset.empty === 'true') { $('output').textContent = ''; $('output').dataset.empty = 'false'; }
          $('output').textContent = ($('output').textContent + (event.source === 'stderr' ? '[错误输出] ' : '') + event.text).slice(-12000);
          $('output').scrollTop = $('output').scrollHeight;
        } else if (event.type === 'result') {
          settled = true;
          resolve({result:event.result, finishedAt:Date.now()});
          closePort();
        } else if (event.type === 'job_status') {
          settled = true;
          if (event.job?.result) resolve({result:event.job.result, finishedAt:event.job.finishedAt});
          else reject(new Error(event.job?.error || '操作状态未知，请检查后再继续。'));
          closePort();
        } else if (event.type === 'connection_error') {
          settled = true;
          reject(new Error(event.error));
          closePort();
        } else if (event.type === 'cancel_error') {
          status(event.error);
        }
      });
      port.onDisconnect.addListener(() => {
        if (activePort === port) activePort = null;
        $('stop').hidden = true;
        if (!settled) reject(new Error(chrome.runtime.lastError?.message || '本地连接中断，操作状态未知；请检查后再重试。'));
      });
      port.postMessage(reconnect ? {type:'attach', jobId:step.jobId} : {type:'execute', request:step.request, jobId:step.jobId, startedAt:step.startedAt});
    });
  }
  async function scan() {
    if (!extensionAvailable()) return;
    hideInjectedContext();
    collapseToolResults();
    if (historyPath !== location.pathname) {
      historyPath = location.pathname;
      const path = historyPath, version = pauseVersion;
      settingsReady = false;
      recoveryDone = false;
      unsent = null;
      $('fill').hidden = true;
      $('recheck').hidden = true;
      renderHistory().catch(error => status(`读取记录失败：${error.message}`));
      chrome.storage.local.get('campusPcPaused:' + path).then(value => {
        if (historyPath !== path || location.pathname !== path) return;
        if (pauseVersion === version) setPaused(value['campusPcPaused:' + path] === true, false);
        settingsReady = true;
      }).catch(error => status(`读取暂停状态失败：${error.message}`));
      return;
    }
    if (!settingsReady) return;
    if (!recoveryDone && !busy && inputBox() && sendButton() && latestRequest()) {
      recoveryDone = true;
      recoverPending().catch(error => status(`恢复记录失败：${error.message}`));
    }
    if (!armed || paused || busy || !sendButton() || !inputBox()) return;
    const latest = latestRequest();
    if (!latest || handled.has(latest.key)) { candidateKey = null; return; }
    if (latest.key !== candidateKey) { candidateKey = latest.key; stableSince = Date.now(); return; }
    if (Date.now() - stableSince < 1200) return;
    if (inputBox().value.trim()) { status('聊天框已有草稿，等待清空后执行。'); return; }
    busy = true;
    const epoch = conversationEpoch;
    handled.add(latest.key);
    $('activity').hidden = false;
    $('activity').textContent = latest.error ? `格式错误：${latest.error}` : JSON.stringify(latest.request, null, 2);
    status(latest.error ? '模型请求格式有误，正在反馈。' : latest.request.tool === 'open_terminal' ? '正在打开 PowerShell 终端。' : `正在执行 ${latest.request.tool}。`);
    const step = activeStep = {id:crypto.randomUUID(), taskId:activeTaskId || crypto.randomUUID(), path:latest.path, messageKey:latest.key, tool:latest.request?.tool || '请求解析', request:latest.request || null, error:latest.error || null, state:'running', delivery:null, startedAt:Date.now(), finishedAt:null, result:null, resultText:null};
    if (step.request) step.jobId = step.id;
    let progressTimer = null, executionStarted = false;
    try {
      await saveStep(step);
      if (location.pathname !== latest.path || conversationEpoch !== epoch || paused) {
        step.state = 'not_started';
        step.finishedAt = Date.now();
        step.error = '对话已变化或操作已暂停，此次请求未执行。';
        await saveStep(step);
        status(step.error);
        return;
      }
      let text;
      if (latest.error) {
        formatErrors++;
        step.state = 'invalid';
        step.finishedAt = Date.now();
        if (formatErrors > 2) { await saveStep(step); status('模型连续两次返回无效格式，请换一个模型或重新描述任务。'); return; }
        text = `本地工具请求格式错误，未执行任何操作。原因：${latest.error} 请把 PC_TOOL_REQUEST、完整 JSON 和 PC_TOOL_END 放在同一个以 \`\`\`json 开头、\`\`\` 结尾的代码块里；JSON 字符串内部的双引号和反斜杠需要转义，Windows 路径使用正斜杠，例如 D:/。不要在 JSON 字符串中直接换行，每次只输出一个请求。`;
        step.resultText = text;
        step.delivery = 'not_sent';
        await saveStep(step);
      } else {
        formatErrors = 0;
        progressTimer = showProgress(step);
        executionStarted = true;
        const {result:response, finishedAt} = await executeWithProgress(step);
        clearInterval(progressTimer);
        progressTimer = null;
        if (!response) throw new Error('本地连接没有返回结果。');
        text = await recordResult(step, response, finishedAt);
        showFinished(step);
      }
      await deliverResult(step, text, latest.path, epoch);
    } catch (error) {
      if (progressTimer) clearInterval(progressTimer);
      if (step.state === 'running') step.state = executionStarted ? 'unknown' : 'not_started';
      step.error = error.message;
      step.finishedAt = Date.now();
      try { await saveStep(step); } catch (storageError) { status(`记录写入失败：${storageError.message}`); }
      if (step.state === 'unknown' && step.jobId) $('recheck').hidden = false;
      $('elapsed').textContent = step.state === 'not_started' ? '请求未执行。' : '请检查操作记录。';
      status(step.state === 'not_started' ? `记录失败，请求未执行：${error.message}` : `本地工具或记录失败：${error.message}${step.state === 'unknown' ? ' 可重新查询状态，不会自动重跑。' : ''}`);
    } finally { activeStep = null; busy = false; candidateKey = null; renderHistory().catch(error => status(`读取记录失败：${error.message}`)); }
  }
  scanTimer = setInterval(scan, 500);
})();
