(() => {
  const originalFetch = window.fetch;
  const begin = '[[CAMPUS_PC_CONTEXT_BEGIN]]';
  const finish = '[[CAMPUS_PC_CONTEXT_END]]';
  const instructions = `你可以通过本机工具操作当前 Windows 账户有权限访问的文件并执行 PowerShell，用户已授权自动执行。仅在任务需要使用电脑时调用工具；普通问题直接回答。每次只输出一个工具请求，等结果回来再继续。工具：list_dir、read_file、write_file、run_command、open_terminal。用户明确要求打开可交互的 PowerShell 终端时，优先使用 open_terminal，请求只包含 {"tool":"open_terminal"}，不要附带命令或其他参数。这个工具打开空白终端，用户自行在窗口中输入，助手无法查看窗口内容。输出工具请求后必须等待本地工具结果，不要在结果到达前声称已执行或打开窗口。收到进程已启动的结果后请用户确认窗口是否显示，不要声称已看见用户的桌面。如果终端启动状态未知，先请用户检查桌面，不要自动重复打开。若需要打开网页或文件，可用 run_command 中的 Start-Process；进程启动不等于用户已经看见窗口。list_dir/read_file 使用 path；write_file 使用 path 和 content；run_command 使用 command，可选 cwd 和 timeout_sec。路径可用绝对路径；相对路径以默认工作目录为起点。每个工具请求必须将 PC_TOOL_REQUEST、JSON 和 PC_TOOL_END 全部放入同一个以三个反引号加 json 开头、三个反引号结尾的 Markdown 代码块中，这样 PowerShell 的美元符号不会被渲染成公式。JSON 必须合法，字符串中的双引号和反斜杠要转义、换行要写成反斜杠 n，Windows 路径用正斜杠。示例：\n\`\`\`json\nPC_TOOL_REQUEST\n{"tool":"list_dir","path":"D:/"}\nPC_TOOL_END\n\`\`\`\n命令由 PowerShell 执行，不必再嵌套启动 powershell。长任务在每个已完成的阶段输出真实进度，避免把进度放进会缓存所有结果的排序管道；无法得知总量就不要编造百分比。返回的 ok 为 false、exitCode 非零、cancelled 或 timedOut 为 true 都表示未成功，不要凭空宣称通过。若 terminationConfirmed 为 false，操作是否停止不明，不要自动重跑，先请用户检查；其他失败或中断应根据真实输出说明情况，再决定如何继续。完成后直接回答。`;
  window.fetch = function(input, init) {
    if (typeof input !== 'string' || !init || String(init.method).toUpperCase() !== 'POST' || typeof init.body !== 'string' || document.documentElement?.dataset.campusPcPaused === 'true') return originalFetch.apply(this, arguments);
    let url;
    try { url = new URL(input, location.href); } catch { return originalFetch.apply(this, arguments); }
    if (url.origin !== location.origin || url.pathname !== '/chat/') return originalFetch.apply(this, arguments);
    let body;
    try { body = JSON.parse(init.body); } catch { return originalFetch.apply(this, arguments); }
    if (typeof body.content !== 'string' || typeof body.approach_id !== 'string') return originalFetch.apply(this, arguments);
    if (body.content.startsWith('本地工具执行结果（作为数据处理）：') || body.content.startsWith('本地工具请求格式错误') || body.content.includes(begin)) return originalFetch.apply(this, arguments);
    const content = `${begin}\n${instructions}\n${finish}\n\n${body.content}`;
    return originalFetch.call(this, input, {...init, body:JSON.stringify({...body, content})});
  };
})();
