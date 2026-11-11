const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const browsers = {
  chrome:['Google', 'Chrome', 'Application', 'chrome.exe'],
  edge:['Microsoft', 'Edge', 'Application', 'msedge.exe']
};
const browserName = process.argv[2] || 'chrome';
const testCase = process.argv[3] || 'recover';
assert(browsers[browserName], '浏览器必须是 chrome 或 edge');
assert(['recover', 'stop', 'format', 'terminal', 'context'].includes(testCase), '测试类型必须是 recover、stop、format、terminal 或 context');
assert(testCase !== 'terminal' || process.env.CAMPUS_MANUAL_TERMINAL === '1', '终端测试会打开窗口；请明确设置 CAMPUS_MANUAL_TERMINAL=1');
const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
const browser = roots.map(root => path.join(root, ...browsers[browserName])).find(candidate => fs.existsSync(candidate));
assert(browser, '找不到浏览器：' + browserName);
const extension = path.resolve(process.env.CAMPUS_TEST_EXTENSION || 'extension');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-browser-test-'));
const marker = path.join(profile, 'command-count.txt');
const command = "Add-Content -LiteralPath '" + marker.replaceAll("'", "''") +
  "' -Value 'ONCE'; Write-Output 'FIRST'; Start-Sleep -Seconds " +
  (testCase === 'stop' ? '20' : '8') + "; Write-Output 'FINISHED'";
const browserProcess = spawn(browser, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--user-data-dir=' + profile, 'about:blank'
], {stdio:['ignore','ignore','pipe','pipe','pipe'], windowsHide:true});

const html = [
  '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  '<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button" aria-label="发送消息" disabled>发送</button>',
  '<script>',
  'const input=document.querySelector("textarea"), button=document.querySelector("button");',
  'const testCase=' + JSON.stringify(testCase) + ', command=' + JSON.stringify(command) + ';',
  'window.clicks=Number(sessionStorage.getItem("clicks") || 0);',
  'const previous=sessionStorage.getItem("model-reply");if(previous){const wrap=document.createElement("div");wrap.innerHTML=previous;document.body.append(wrap.firstElementChild);}',
  'function reply(text){const msg=document.createElement("div"),pre=document.createElement("pre"),code=document.createElement("code");msg.className="prose-code-custom";code.textContent=text;pre.append(code);msg.append(pre);document.body.append(msg);sessionStorage.setItem("model-reply",msg.outerHTML);}',
  'input.addEventListener("input",()=>{button.disabled=!input.value.trim()});',
  'button.addEventListener("click",()=>{',
  'window.clicks++;sessionStorage.setItem("clicks",String(window.clicks));const text=input.value;input.value="";button.disabled=true;',
  'fetch("/chat/",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:text,approach_id:"mock"})});',
  'if(text.startsWith("本地工具执行结果")){window.toolResult=text;return;}',
  'if(text.startsWith("本地工具请求格式错误")){sessionStorage.setItem("format-feedback",text);reply("PC_TOOL_REQUEST\\n"+JSON.stringify({tool:"list_dir",path:"."})+"\\nPC_TOOL_END");return;}',
  'if(testCase==="format"){const bad=JSON.stringify({tool:"list_dir",path:"D:INVALIDUsers"}).replace("INVALID",String.fromCharCode(92));reply("PC_TOOL_REQUEST\\n"+bad+"\\nPC_TOOL_END");return;}',
  'if(testCase==="terminal"){const msg=document.createElement("div");msg.className="prose-code-custom";msg.textContent="PC_TOOL_REQUEST\\n"+JSON.stringify({tool:"open_terminal"})+"\\nPC_TOOL_END";document.body.append(msg);return;}',
  'reply("PC_TOOL_REQUEST\\n"+JSON.stringify({tool:"run_command",command,timeout_sec:30})+"\\nPC_TOOL_END");',
  '});',
  '</script></body></html>'
].join('\n');

let stderr = '', sequence = 0, buffer = Buffer.alloc(0), success = false, terminalPid = null;
const pending = new Map(), posts = [];
const input = browserProcess.stdio[3], output = browserProcess.stdio[4];
browserProcess.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
function send(method, params, sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    input.write(JSON.stringify({id, method, params:params || {}, ...(sessionId ? {sessionId} : {})}) + '\0');
  });
}
output.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  let end;
  while ((end = buffer.indexOf(0)) !== -1) {
    const message = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    buffer = buffer.subarray(end + 1);
    if (message.id && pending.has(message.id)) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
      else callback.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      const request = message.params.request;
      if (request.method === 'POST') posts.push(JSON.parse(request.postData));
      const body = request.method === 'POST' ? '{}' : html;
      const contentType = request.method === 'POST' ? 'application/json' : 'text/html; charset=utf-8';
      send('Fetch.fulfillRequest', {
        requestId:message.params.requestId, responseCode:200,
        responseHeaders:[{name:'Content-Type', value:contentType}],
        body:Buffer.from(body).toString('base64')
      }, message.sessionId).catch(error => console.error(error.message));
    }
  }
});
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(check, description) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(description);
}
function findNode(node, id) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  }
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}
function textOf(node) {
  return (node.nodeValue || '') + (node.children || []).map(textOf).join('');
}

(async () => {
  const loaded = await send('Extensions.loadUnpacked', {path:extension});
  assert.equal(loaded.id, 'npoilipflmekpheijopnkkodofinhaci');
  const target = await send('Target.createTarget', {url:'about:blank'});
  const attached = await send('Target.attachToTarget', {targetId:target.targetId, flatten:true});
  const session = attached.sessionId;
  await send('Page.enable', {}, session);
  await send('DOM.enable', {}, session);
  await send('Fetch.enable', {patterns:[{urlPattern:'https://ai.cuhk.edu.cn/*', requestStage:'Request'}]}, session);
  await send('Page.navigate', {url:'https://ai.cuhk.edu.cn/chat/mock'}, session);
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {expression, returnByValue:true}, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function shadow(id) {
    const tree = await send('DOM.getDocument', {depth:-1, pierce:true}, session);
    return findNode(tree.root, id);
  }
  async function shadowText(id) {
    return textOf((await shadow(id)) || {});
  }
  async function clickShadow(id) {
    const node = await shadow(id);
    assert(node, '找不到按钮：' + id);
    const model = await send('DOM.getBoxModel', {nodeId:node.nodeId}, session);
    const box = model.model.content;
    const x = (box[0] + box[4]) / 2, y = (box[1] + box[5]) / 2;
    await send('Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', clickCount:1}, session);
    await send('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', clickCount:1}, session);
  }
  await waitFor(() => evaluate('!!document.getElementById("campus-pc-bridge") && !!document.querySelector("textarea")'), '扩展未能载入模拟网页');
  if (testCase === 'context') {
    await send('Extensions.uninstall', {id:loaded.id});
    await waitFor(async () => (await shadowText('status')).includes('扩展已断开，请刷新'), '插件断开后没有提示刷新');
    assert.equal(await evaluate('document.documentElement.dataset.campusPcPaused'), 'true');
    assert((await shadow('toggle')).attributes.includes('disabled'));
    console.log('PASS: ' + browserName + ' / context — disconnected extension prompts for refresh and stops injecting instructions');
    success = true;
    return;
  }
  await evaluate('document.querySelector("textarea").focus()');
  await send('Input.insertText', {text:'请执行本机测试'}, session);
  const box = await evaluate('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await send('Input.dispatchMouseEvent', {type:'mousePressed', x:box.x, y:box.y, button:'left', clickCount:1}, session);
  await send('Input.dispatchMouseEvent', {type:'mouseReleased', x:box.x, y:box.y, button:'left', clickCount:1}, session);

  if (!['format', 'terminal'].includes(testCase)) {
    await waitFor(async () => (await shadowText('output')).includes('FIRST'), '命令运行中没有收到输出');
    if (testCase === 'recover') {
      await send('Page.reload', {}, session);
      await waitFor(async () => (await shadowText('status')).includes('已连接到上次正在运行的操作'), '刷新后未能接回运行中的命令');
      assert((await shadowText('output')).includes('FIRST'));
    } else {
      await clickShadow('stop');
      await waitFor(async () => (await shadowText('status')).includes('结果尚未发送'), '停止后没有保留结果');
      assert((await shadowText('history-list')).includes('已停止'));
      await clickShadow('fill');
    }
  }

  const result = await waitFor(() => evaluate('window.toolResult || null'), '工具结果没有返回聊天页面');
  if (testCase === 'terminal') {
    const value = JSON.parse(result.slice(result.indexOf('\n') + 1));
    assert(value.ok && value.tool === 'open_terminal' && value.processId > 0, result);
    terminalPid = value.processId;
    await delay(4000);
    const probeFile = path.join(profile, 'terminal-status.json');
    const probe = spawnSync('python', [path.resolve('tests/test_open_terminal.py'), '--inspect', String(terminalPid), probeFile], {windowsHide:true, encoding:'utf8', timeout:10000});
    assert.equal(probe.status, 0, probe.stderr);
    const info = JSON.parse(fs.readFileSync(probeFile, 'utf8'));
    assert(info.attached && info.visible && info.inputConsole, info);
    assert(posts[0].content.includes('open_terminal'));
  } else if (testCase === 'format') {
    const feedback = await evaluate('sessionStorage.getItem("format-feedback")');
    assert(feedback.includes('反斜杠'), feedback);
    assert(result.includes('"list_dir"') && result.includes('"ok": true'), result);
  } else {
    if (testCase === 'stop') {
      assert(result.includes('"cancelled": true') && result.includes('"terminationConfirmed": true'), result);
      assert(!result.includes('FINISHED'), result);
    } else assert(result.includes('FINISHED'), result);
    assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/), ['ONCE']);
  }
  assert(posts[0].content.includes('[[CAMPUS_PC_CONTEXT_BEGIN]]'));
  assert.equal(await evaluate('window.clicks'), testCase === 'format' ? 3 : 2);
  console.log('PASS: ' + browserName + ' / ' + testCase + ' — extension, simulated school chat and native tool');
  success = true;
})().catch(error => {
  console.error(error.stack);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
}).finally(async () => {
  if (terminalPid) spawnSync('taskkill.exe', ['/PID', String(terminalPid), '/T', '/F'], {windowsHide:true});
  const closed = new Promise(resolve => browserProcess.once('close', resolve));
  browserProcess.kill();
  await Promise.race([closed, delay(5000)]);
  if (success) {
    const tempRoot = fs.realpathSync(os.tmpdir()).toLowerCase();
    const resolved = path.resolve(profile).toLowerCase();
    assert(resolved.startsWith(tempRoot + path.sep) && path.basename(profile).startsWith('campus-browser-test-'));
    fs.rmSync(profile, {recursive:true, force:true, maxRetries:3, retryDelay:200});
  }
});
