const jobs = new Map();
const allowed = sender => sender?.id === chrome.runtime.id && sender.tab && sender.url && new URL(sender.url).origin === 'https://ai.cuhk.edu.cn';
const ownerOf = sender => ({tabId:sender.tab.id, path:new URL(sender.url).pathname});
const owns = (job, sender) => job.owner.tabId === sender.tab.id && job.owner.path === new URL(sender.url).pathname;
const tools = ['list_dir', 'read_file', 'write_file', 'run_command', 'open_terminal'];

function queryJob(jobId, sender, respond) {
  const job = jobs.get(jobId);
  if (job && owns(job, sender)) {
    respond({jobId, state:'running', startedAt:job.startedAt, output:job.output});
    return;
  }
  chrome.runtime.sendNativeMessage('cn.campus_ai.readonly', {type:'query', jobId}).then(
    event => respond(event.job || {jobId, state:'unknown', error:'本机没有返回操作状态。'}),
    error => respond({jobId, state:'unknown', error:`本机状态查询失败：${error.message}`})
  );
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!allowed(sender)) return;
  if (message?.type === 'query_job') {
    queryJob(message.jobId, sender, respond);
    return true;
  }
  if (message?.type !== 'execute' || !tools.includes(message.request?.tool)) return;
  chrome.runtime.sendNativeMessage('cn.campus_ai.readonly', message.request).then(
    result => respond(result),
    error => respond({ok:false, error:error.message})
  );
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  if (port.name !== 'campus-pc-progress' || !allowed(sender)) { port.disconnect(); return; }
  let attached = null;

  function attach(job) {
    attached = job;
    job.ports.add(port);
    port.postMessage({type:'snapshot', startedAt:job.startedAt, output:job.output});
  }
  function broadcast(job, event) {
    for (const listener of job.ports) {
      try { listener.postMessage(event); } catch { job.ports.delete(listener); }
    }
  }

  port.onMessage.addListener(message => {
    if (attached && message?.type === 'cancel') { attached.native.postMessage({type:'cancel'}); return; }
    if (attached) return;
    if (message?.type === 'attach') {
      const job = jobs.get(message.jobId);
      if (job && owns(job, sender)) { attach(job); return; }
      queryJob(message.jobId, sender, status => port.postMessage({type:'job_status', job:status}));
      return;
    }
    if (message?.type !== 'execute' || !tools.includes(message.request?.tool)) return;
    const existing = jobs.get(message.jobId);
    if (existing) {
      if (owns(existing, sender)) attach(existing);
      else port.postMessage({type:'connection_error', error:'该操作属于另一个对话。'});
      return;
    }
    const native = chrome.runtime.connectNative('cn.campus_ai.readonly');
    const job = {id:message.jobId, owner:ownerOf(sender), native, ports:new Set(), output:'', startedAt:message.startedAt || Date.now(), finished:false};
    if (job.id) jobs.set(job.id, job);
    attach(job);
    native.onMessage.addListener(event => {
      if (event.type === 'progress') job.output = (job.output + (event.source === 'stderr' ? '[错误输出] ' : '') + event.text).slice(-12000);
      broadcast(job, event);
      if (event.type === 'result' || event.type === 'job_status') {
        job.finished = true;
        if (job.id) jobs.delete(job.id);
        native.disconnect();
      }
    });
    native.onDisconnect.addListener(() => {
      if (job.id) jobs.delete(job.id);
      const error = chrome.runtime.lastError?.message;
      if (!job.finished) broadcast(job, {type:'connection_error', error:error || '本机连接中断，操作状态未知。'});
    });
    native.postMessage({...message.request, ...(job.id ? {jobId:job.id} : {}), stream:true});
  });
  port.onDisconnect.addListener(() => { if (attached) attached.ports.delete(port); });
});
