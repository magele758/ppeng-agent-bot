/** Source-linked editable Excalidraw draft. Run from the repository root. */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const out = 'doc/architecture';
const panels = [
  ['01', '项目总览 · 产品入口与执行主干', '从用户消息到实际工具，再回到持久记录', [
    ['Lab / Desktop / CLI', 'Next.js 界面、桌面壳、命令行\n乐观消息、流式气泡、i18n', 'apps/web-console|apps/desktop|apps/cli'],
    ['Daemon API', '认证、资源归属、API 路由\nSSE、会话与配置入口', 'apps/daemon/src/app.ts|apps/daemon/src/routes'],
    ['渠道与接入', '外部消息、连接器、客户端\n统一进入宿主运行时', 'packages/daemon-client|packages/core/src/channels|packages/core/src/connectors'],
    ['Bots / 目标与工作', '稳定身份、职责、Goal / Routine\n待办、子任务、持久等待', 'packages/core/src/bots|packages/core/src/cron|packages/core/src/waits'],
    ['RawAgentRuntime', '产品宿主与协作者装配\n会话生命周期、模型与工具接线', 'packages/core/src/runtime.ts|packages/core/src/runtime'],
    ['控制面与授权', '用户/租户、热设置、审批\n来源授权、工作区与机器选择', 'packages/core/src/auth|packages/core/src/config|packages/core/src/approval|packages/core/src/workspace|packages/core/src/registered-machines'],
    ['协作执行', 'SubAgent / Swarm / Team DAG\nOrchestrator / Rooms / Factory', 'packages/core/src/swarm|packages/core/src/teams|packages/core/src/orchestrator|packages/core/src/rooms|packages/core/src/factory'],
    ['agent-loop SDK', 'mini / normal / full / max\nTurn Kernel、流式、转向与停止', 'packages/agent-loop/src/assembly|packages/agent-loop/src/turn|packages/agent-loop/src/index.ts'],
    ['工具与外部系统', '文件、Shell、浏览器、MCP\n领域工具；有副作用边界', 'packages/core/src/tools|packages/core/src/mcp|packages/core/src/computer-use|packages/capability-gateway']
  ], [[0,1,'HTTP / IPC'],[2,1,'消息'],[1,4,'调用'],[3,4,'执行'],[5,4,'约束'],[4,7,'装配'],[3,6,'分工'],[6,7,'独立会话'],[7,8,'工具波']]],
  ['02', '单次执行 · Turn Kernel 与上下文循环', '工具完成后继续模型循环；结束结果与目标验收分开', [
    ['接收与转向', '用户输入、Inbox、steer\n附件与引用、next-step / next-run', 'packages/agent-loop/src/session/step-inbox.ts|packages/core/src/agent-inbox'],
    ['执行权与恢复边界', 'writerRunId、claim、审批恢复\n拒绝过期写入与重复消费', 'packages/agent-loop/src/turn/host.ts|packages/core/src/session/checkpoint.ts|packages/core/src/session/durable-recovery.ts'],
    ['构建模型视图', 'Prompt、Skill / Tools、记忆附录\n窗口预算、历史裁剪与微压缩', 'packages/core/src/model/prompt-builder.ts|packages/agent-loop/src/session|packages/agent-loop/src/turn/prepare-turn-input.ts'],
    ['轮内/跨轮恢复', '流式复读、思考空转、Risk\nLoopGuard、失败与来源保护', 'packages/agent-loop/src/streaming|packages/core/src/streaming|packages/agent-loop/src/recovery|packages/core/src/recovery'],
    ['模型一步', '文本 / reasoning / tool_calls\n流式事件、usage 与 request-id', 'packages/agent-loop/src/turn|packages/agent-loop/src/model'],
    ['模型与路由', '配置目录、会话模型选择\nChat / Responses / Anthropic / VL', 'packages/core/src/model|packages/core/src/runtime/run-profile.ts'],
    ['工具执行波', '派发前校验、权限与审批\n并发、取消、快照与有限补偿', 'packages/agent-loop/src/runtime|packages/core/src/runtime/tool-loop.ts|packages/agent-loop/src/session/compensation.ts'],
    ['消息与步骤提交', '调用/结果配对、Surface、EventLog\nCheckpoint、Working Log、压缩', 'packages/agent-loop/src/session|packages/core/src/session|packages/core/src/stores/session-store.ts'],
    ['结束与目标收尾', 'answered / stopReason / 中断\n目标判定、等待与跟进唤醒', 'packages/core/src/bots/goals|packages/core/src/goal|packages/agent-loop/src/goal']
  ], [[0,1,'接纳'],[1,2,'读状态'],[2,5,'模型输入'],[5,4,'选择适配器'],[4,3,'守卫'],[3,6,'有工具'],[6,7,'保存结果'],[7,8,'结束/挂起'],[7,4,'结果回流 / 下一轮'],[4,8,'正常答复']]],
  ['03', '协作与调度 · 多种执行粒度', '多个 session 可以协作；各模块的生命周期和验收边界独立', [
    ['Goal / Bot Work', '目标、执行尝试、委托与复盘\n完成判定、跟进与通知', 'packages/core/src/bots/goals|packages/core/src/bots/bot-work.ts|packages/core/src/services'],
    ['Routine / Scheduler', '定时触发、运行队列与租约\n后台唤醒、超时与重启整理', 'packages/core/src/cron|packages/core/src/services/autonomous-scheduler.ts|packages/core/src/runtime/scheduler-host.ts'],
    ['Durable Wait', '登记条件、观测、组合判断\n持久等待、归属检查、消费恢复', 'packages/core/src/waits|packages/core/src/bots/bot-work-waits.ts'],
    ['SubAgent / Teammate', '独立上下文、权限继承\n结果摘要、任务与信箱通信', 'packages/core/src/runtime/spawn-host.ts|packages/core/src/session/subagent-contract.ts'],
    ['Swarm · pipeline', '任务依赖、并发槽位、超时\n独立审查 + 实际测试 + 证据门禁', 'packages/core/src/swarm|packages/core/src/runtime/quality-gates.ts|packages/core/src/quality'],
    ['Orchestrator', 'classify → research → implement\n→ review → test；失败阻断后续', 'packages/core/src/orchestrator|packages/core/src/runtime/collaborators.ts'],
    ['Team DAG', '规划与依赖图、角色、工作区同步\n团队闸门与文件信箱', 'packages/core/src/teams'],
    ['Rooms / Agent Inbox', '房间轮次、成员调度、预算\n多 Bot 消息、引用与交接', 'packages/core/src/rooms|packages/core/src/agent-inbox'],
    ['Factory / 机器协作', '远程工作、证据、验收与交付\n机器路由、重分配、操作记录', 'packages/core/src/factory|packages/core/src/registered-machines']
  ], [[0,1,'调度'],[1,2,'条件等待'],[0,3,'子执行'],[3,4,'任务粒度'],[5,4,'实现阶段'],[3,6,'团队粒度'],[4,7,'通信接缝'],[5,8,'独立交付体系']]],
  ['04', '工具与安全 · 发现、授权、执行、回流', '外部内容是证据；工具可见、获准、执行成功是三个不同事实', [
    ['能力发现与路由', '工具搜索、可选组、动态披露\n发现设置与能力健康状态', 'packages/core/src/discovery|packages/core/src/dyn-tools|packages/core/src/tools/tool-search.ts'],
    ['Skills / 扩展', '加载、shortlist、允许名单\n自建提案、插件与扩展注册', 'packages/core/src/skills|packages/core/src/skill-proposals|packages/core/src/plugins|packages/core/src/extensions'],
    ['MCP / PTC', '远端工具扩展、代码编排\n隔离执行、动态工具与回放', 'packages/core/src/mcp|packages/core/src/ptc|packages/agent-loop/src/ptc'],
    ['工具注册与选择', 'Builtin / Domain / MCP 合并\nAgent、会话、领域权限过滤', 'packages/core/src/tools/builtin-tools.ts|packages/core/src/turn/resolve-turn-tools.ts'],
    ['审批与来源授权', 'permissionMode、精确调用审批\n来源台账、用户意图与归属', 'packages/core/src/approval|packages/core/src/learning|packages/core/src/trust|packages/core/src/safety'],
    ['执行宿主', '工具契约、工作区、机器、取消\n文件、浏览器、外部 CLI 与网络', 'packages/core/src/runtime/tool-loop.ts|packages/core/src/computer-use|packages/core/src/external-agents|packages/core/src/net'],
    ['命令沙箱', '环境清洗、路径保护\nOS / direct / 云计算后端', 'packages/core/src/sandbox'],
    ['Secret Vault', '密钥引用、凭证注入与访问\n不把密钥变成界面或模型正文', 'packages/core/src/secrets'],
    ['回流与审计', '结果脱敏、超大结果归档\n调用配对、Trace 与失败证据', 'packages/core/src/sandbox/result-redaction.ts|packages/core/src/artifact|packages/core/src/observability']
  ], [[0,3,'候选'],[1,4,'加载授权'],[2,5,'调用契约'],[3,4,'允许名单'],[4,5,'获准派发'],[5,8,'返回结果'],[5,7,'密钥引用'],[4,7,'授权边界'],[3,6,'执行隔离'],[6,7,'凭证边界'],[7,8,'脱敏']]],
  ['05', '知识与状态 · 模型视图不等于存储真相', '保存原始记录；压缩与检索构造每次模型看到的有限视图', [
    ['输入与摄取', '图片、附件、来源与资产\n规范化文本、不可信内容边界', 'packages/core/src/ingestion|packages/core/src/ingestion/attachment-ingest-service.ts|packages/core/src/services/image-ingest-service.ts'],
    ['五层记忆', 'session scratch / long\nuser / team / project', 'packages/core/src/memory'],
    ['检索与知识', '历史、来源、召回与知识结构\nCase 治理、检索授权', 'packages/core/src/knowledge|packages/core/src/evolving|packages/core/src/tools/history-tools.ts'],
    ['Working Log / 压缩', '高信号外存、压缩锚点\n微压缩只改模型视图', 'packages/core/src/session/working-log.ts|packages/core/src/session/micro-compact.ts'],
    ['Session / Surface', '消息、引用、Inbox、可见视图\nSQLite 主状态与 writer 边界', 'packages/core/src/storage.ts|packages/core/src/stores|packages/agent-loop/src/session'],
    ['EventLog / Checkpoint', '步骤开始/提交、日志与恢复\n未知副作用不自动重放', 'packages/core/src/session/event-log-saga.ts|packages/core/src/session/durable-recovery.ts|packages/agent-loop/src/session/event-log.ts'],
    ['Artifact / Library Page', '大结果按页引用、持久 Markdown\n独立库页面与修订记录', 'packages/core/src/artifact|packages/core/src/library'],
    ['Daydream / Learning', '反思、候选经验、验证与治理\n长期职责与临时任务分开', 'packages/core/src/daydream|packages/core/src/learning|packages/core/src/bots/bot-coaching.ts'],
    ['A2UI / 领域展示', 'Surface 协议、注册表与绑定\n动作回传成为新的用户输入', 'packages/core/src/a2ui|apps/web-console/components/a2ui']
  ], [[0,1,'规范化'],[1,2,'检索视图'],[0,3,'上下文'],[1,4,'记忆读写'],[2,5,'证据引用'],[3,4,'视图与原文分离'],[4,5,'步骤记录'],[3,6,'外存引用'],[4,7,'经验候选'],[5,8,'展示事件'],[6,7,'工件'],[7,8,'用户可见结果']]],
  ['06', '部署与持久化 · 当前边界', '绿色=当前默认路径；黄色=可选或局部能力；虚线不代表现场认证', [
    ['Web / Desktop / CLI', 'Next 代理 API、桌面壳与客户端\n浏览器不持有 daemon 密钥', 'apps/web-console/middleware.ts|apps/desktop|packages/daemon-client'],
    ['Daemon / Runtime', '主进程、健康检查、调度器\n默认单实例主状态', 'apps/daemon|packages/core/src/runtime.ts'],
    ['执行环境', '本机工作区、OS 沙箱\n已登记机器与可选云执行后端', 'packages/core/src/workspace|packages/core/src/sandbox|packages/core/src/registered-machines'],
    ['SQLite + 本地状态目录', '会话、Bot、目标、审批、任务\n主运行状态仍在这里', 'packages/core/src/storage.ts|packages/core/src/stores'],
    ['PG / Redis · 局部', '事件缓冲、技能注册、锁等端口\n不等于完整会话已迁移 PG', 'packages/core/src/storage/repository-factory.ts|packages/core/src/storage/cloud'],
    ['S3 / 分层资产 · 可选', '资产缓存与对象存储\n需实际配置、依赖与可用性验证', 'packages/core/src/storage/tiered-asset-storage.ts'],
    ['Docker / Compose', 'daemon、web、持久卷\n开发与发布配置模板', 'deploy/docker|deploy/compose'],
    ['Helm / K8s · 配置', 'Pod、PVC、PG / Redis / MinIO\n多 Pod 会话接管未完整认证', 'deploy/helm|deploy/k8s'],
    ['观测与运维', 'Trace、usage、成本、诊断\nOTel / Langfuse、doctor、恢复记录', 'packages/core/src/observability|packages/core/src/langfuse|packages/core/src/doctor|packages/core/src/stores/trace.ts']
  ], [[0,1,'同源 API'],[1,2,'派发'],[1,4,'可选存储端口'],[1,3,'主状态'],[2,5,'资产'],[3,6,'持久卷'],[4,7,'可选组件'],[5,8,'指标与错误'],[6,7,'部署模板'],[7,8,'现场观测']]],
  ['07', '包与扩展 · 产品组合边界', 'SDK、产品宿主、领域能力与接入层各有职责', [
    ['api-types / daemon-client', '消息、工具、事件等公共契约\n客户端调用与连接', 'packages/api-types|packages/daemon-client'],
    ['agent-loop SDK', '可嵌入内核与四档装配\nmini 无 Node 静态依赖', 'packages/agent-loop'],
    ['core 产品宿主', 'Bot、调度、持久化、治理\n把 SDK 端口接到产品能力', 'packages/core/src/exports|packages/core/src/runtime.ts'],
    ['Capability Gateway', '执行网关、工具能力与接入\n独立协议与能力服务', 'packages/capability-gateway'],
    ['Domain Bundles', 'SRE / Stock / HomeIoT / ERP\nAgent、工具、Skill 的安装组合', 'packages/agent-sre|packages/agent-stock|packages/agent-homeiot|packages/agent-erp'],
    ['连接器 / MCP / 插件', '服务连接、外部工具、扩展\n发现、注册、权限与健康状态', 'packages/core/src/connectors|packages/core/src/mcp|packages/core/src/plugins|packages/core/src/extensions'],
    ['渠道 / App Control', '消息渠道、应用控制与平台适配\n归一化到产品运行入口', 'packages/core/src/channels|packages/core/src/app-control'],
    ['外部 Coding Agent', 'CLI / 远程 Agent 等执行入口\n运行权限与来源作用域仍有效', 'packages/core/src/external-agents|packages/core/src/agents'],
    ['研究与可选增强', 'DeepResearch 最小管线\nJEV 插入点、Hook、演进遗留入口', 'packages/core/src/deepresearch|packages/core/src/jev|packages/core/src/hooks|packages/core/src/evolution']
  ], [[0,1,'公共契约'],[1,2,'宿主端口'],[3,4,'能力组合'],[4,5,'注册与发现'],[2,5,'动态接入'],[3,6,'平台适配'],[4,7,'任务执行'],[5,8,'扩展能力']]],
  ['08', '验证与交付 · 成功必须有证据', '软件通过、真实模型样本、部署认证分开记录', [
    ['需求 → 验收规格', 'acceptance/*.yaml\napproved → 失败用例 → implemented', 'acceptance|skills/acceptance-first'],
    ['自动化行为测试', 'Core / SDK / API / UI 单测\n失败、缺证据、权限与取消边界', 'packages/core/test|packages/agent-loop/src|apps/daemon/test|apps/web-console/lib'],
    ['形式与恢复验证', '工具配对、生命周期、真实进程重启\n结果与验证范围共同保留', 'scripts/formal|doc/formal|packages/core/src/formal'],
    ['独立代码审查', '先审查，再修改并回归\n权限、来源、异常、并发与证据', 'skills/verify-tool-call-pairing|skills/verify-session-restart'],
    ['真实多 Agent 样本', '实现 → 独立审查 → 实际测试\nSwarm → Orchestrator → 操作员复验', 'scripts/agent-eval/collaboration-quality-live.mjs|packages/core/src/runtime/quality-gates.ts'],
    ['长期与现场验证', 'Soak / 性能 / 故障 / 回滚\n不由单个真实模型样本替代', 'scripts/agent-eval|scripts/release|deploy'],
    ['Commit / PR', '变更、验收、测试与证据可追溯\n不跳过 hooks，不强推', '.github/pull_request_template.md'],
    ['CI / 合并门禁', 'Quick / Core / 完整验证\n主分支健康、验收与复杂度', '.github/workflows|scripts/ci|scripts/crap|scripts/acceptance'],
    ['部署与运行核验', '发布版本、服务进程、现场状态\n源码合并不等于正在运行新版本', 'scripts/release|scripts/deploy-smoke.mjs|doc/README.md|packages/core/src/self-heal']
  ], [[0,1,'行为标准'],[1,2,'恢复边界'],[0,3,'审查依据'],[1,4,'真实执行'],[2,5,'扩大范围'],[3,6,'审查后提交'],[4,7,'附验证证据'],[5,8,'现场认证'],[6,7,'检查'],[7,8,'获准发布']]]
];
const elements = [], svgGroups = [], refs = [];
let seq = 0;
const escape = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function base(type,x,y,width,height,frameId=null) { const id=`map-${++seq}`; return { id,type,x,y,width,height,angle:0,strokeColor:'#263b51',backgroundColor:'transparent',fillStyle:'solid',strokeWidth:1.5,strokeStyle:'solid',roughness:0,opacity:100,groupIds:[],frameId,index:null,roundness:null,seed:seq*3917,version:1,versionNonce:seq*8311,isDeleted:false,boundElements:[],updated:1,link:null,locked:false }; }
function text(value,x,y,size,frameId,color='#263b51') { const lines=value.split('\n'); const width=Math.max(...lines.map(line=>[...line].reduce((sum,ch)=>sum+size*(ch.charCodeAt(0)>255?1:0.56),0))); const e={...base('text',x,y,width,size*1.3*lines.length,frameId),text:value,originalText:value,fontSize:size,fontFamily:2,textAlign:'left',verticalAlign:'top',containerId:null,autoResize:true,lineHeight:1.3,strokeColor:color}; elements.push(e); return `<text x="${x}" y="${y+size}" fill="${color}" font-size="${size}" font-family="Arial,PingFang SC,sans-serif">${lines.map((l,i)=>`<tspan x="${x}" dy="${i?size*1.3:0}">${escape(l)}</tspan>`).join('')}</text>`; }
const W=1400,H=1000;
for (const [index,panel] of panels.entries()) {
  const [number,title,subtitle,nodes,edges]=panel, px=(index%2)*1480, py=Math.floor(index/2)*1080;
  const frame={...base('frame',px,py,W,H),name:`${number} ${title}`,strokeColor:'#d4dce5'}; elements.push(frame);
  let svg=`<rect x="${px}" y="${py}" width="${W}" height="${H}" rx="18" fill="#fcfcfa" stroke="#d4dce5"/>`;
  svg+=text(`${number}  ${title}`,px+45,py+32,30,frame.id);
  svg+=text(subtitle,px+45,py+83,17,frame.id,'#64758a');
  const boxes=nodes.map(([title,body,paths],i)=> {
    const x=px+45+(i%3)*450,y=py+155+Math.floor(i/3)*265;
    const sourcePaths=paths.split('|'); for (const path of sourcePaths) assert.ok(existsSync(path), `Missing architecture source ${path}`);
    const amber=title.includes('可选')||title.includes('局部')||title.includes('配置')||title.includes('现场');
    const fill=amber?'#fff3d6':i===4?'#e3f3ec':'#edf3f8';
    const box={...base('rectangle',x,y,390,175,frame.id),backgroundColor:fill,roundness:{type:3},customData:{sourcePaths},link:`https://github.com/magele758/ppeng-agent-bot/tree/main/${sourcePaths[0]}`}; elements.push(box);
    svg+=`<rect x="${x}" y="${y}" width="390" height="175" rx="12" fill="${fill}" stroke="#91a3b5"/>`;
    box.groupIds=[box.id+'-group'];
    svg+=text(title,x+20,y+17,22,frame.id); elements.at(-1).groupIds=box.groupIds;
    svg+=text(body,x+20,y+62,18,frame.id,'#465b70'); elements.at(-1).groupIds=box.groupIds;
    refs.push({panel:number,title,sourcePaths}); return box;
  });
  for (const [a,b,label] of edges) {
    const from=boxes[a],to=boxes[b],horizontal=from.y===to.y;
    const direction=horizontal?Math.sign(to.x-from.x):Math.sign(to.y-from.y);
    const sx=horizontal?from.x+(direction>0?from.width+5:-5):from.x+from.width/2;
    const sy=horizontal?from.y+from.height/2:from.y+(direction>0?from.height+5:-5);
    const ex=horizontal?to.x+(direction>0?-5:to.width+5):to.x+to.width/2;
    const ey=horizontal?to.y+to.height/2:to.y+(direction>0?-5:to.height+5);
    const arrow={...base('arrow',sx,sy,Math.abs(ex-sx),Math.abs(ey-sy),frame.id),points:[[0,0],[ex-sx,ey-sy]],lastCommittedPoint:null,startBinding:{elementId:from.id,focus:0,gap:5},endBinding:{elementId:to.id,focus:0,gap:5},startArrowhead:null,endArrowhead:'arrow',elbowed:false}; elements.push(arrow);
    from.boundElements.push({id:arrow.id,type:'arrow'}); to.boundElements.push({id:arrow.id,type:'arrow'});
    svg+=`<path d="M${sx},${sy} L${ex},${ey}" fill="none" stroke="#7c8c9e" stroke-width="1.6" marker-end="url(#arrow)"/>`;
    const lx=(sx+ex)/2+(horizontal?0:8),ly=(sy+ey)/2+(horizontal?-27:-10);
    svg+=text(label,lx-(horizontal?label.length*3:0),ly,11,frame.id,'#60748a');
  }
  svg+=text('蓝：运行模块   绿：本区核心   黄：可选 / 局部 / 现场边界     ·     源码路径保存在每个框的链接与 customData 中',px+45,py+952,14,frame.id,'#64758a');
  svgGroups.push({number,px,py,svg});
}
const scene={type:'excalidraw',version:2,source:'https://github.com/magele758/ppeng-agent-bot',elements,appState:{viewBackgroundColor:'#f0f3f6',gridSize:null,zoom:{value:0.32},scrollX:0,scrollY:0,theme:'light'},files:{}};
const head=(viewBox)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="#7c8c9e"/></marker></defs>`;
mkdirSync(out,{recursive:true});
writeFileSync(`${out}/project-architecture.excalidraw`,JSON.stringify(scene,null,2)+'\n');
writeFileSync(`${out}/project-architecture.svg`,head('0 0 2880 4240')+svgGroups.map(p=>p.svg).join('')+'</svg>');
for(const p of svgGroups) writeFileSync(`${out}/${p.number}.svg`,head(`${p.px} ${p.py} ${W} ${H}`)+p.svg+'</svg>');
writeFileSync(`${out}/sources.json`,JSON.stringify(refs,null,2)+'\n');
const coreDirs=readdirSync('packages/core/src',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);
const linked=coreDirs.map(name=>({name,panels:refs.filter(ref=>ref.sourcePaths.some(p=>p===`packages/core/src/${name}`||p.startsWith(`packages/core/src/${name}/`))).map(ref=>ref.panel)}));
const unmapped=linked.filter(entry=>entry.panels.length===0);
assert.equal(unmapped.length,0,`Unmapped core module families: ${unmapped.map(e=>e.name).join(', ')}`);
const readme=`# 项目架构图稿\n\n基于 2026-11-11 当前源码与本次质量门禁实现整理。图表示模块与调用关系，不表示所有能力已经通过生产现场认证。\n\n- [可编辑 Excalidraw 文件](project-architecture.excalidraw)：导入 Excalidraw 后有 8 个可分别选择的 Frame，方框、文字、箭头均可编辑。\n- [整图 SVG](project-architecture.svg)：可放大、检索文字；[总览预览](01.svg)。\n- [源码索引](sources.json)：每个节点对应的真实路径；框本身也带源码链接。\n- 更新方式：在仓库根目录执行 \`node scripts/architecture/generate-project-map.mjs\`。生成器会核对路径存在与 core 模块族覆盖。\n\n## 分区\n\n${panels.map(p=>`- [${p[0]} ${p[1]}](${p[0]}.svg)：${p[2]}`).join('\n')}\n\n## 阅读边界\n\n1. 总览是分层地图，不是一条把所有模块依次调用的执行序列。每区箭头表示标注的调用、数据或约束接缝，跨区细节由源码索引展开。\n2. Loop 的正常答复、session 结束、Goal 达成、Swarm 验收通过和外部交付完成是不同状态。\n3. 持久等待与限定重启恢复已有实现；未知外部副作用不会因为 EventLog / Saga 命名而自动获得恰好一次或自动补偿保证。\n4. Swarm 当前只支持 pipeline；Team DAG 是独立执行器，不能把它的能力算作 Swarm 的其他策略。\n5. SQLite 仍为主运行状态；PG / Redis / S3 是局部可选端口，Helm 模板不代表完整多 Pod 会话接管已经跑通。\n6. 研究、JEV、Factory、领域包与部署各自有授权和验收范围；单个真实模型任务通过不代表长期成功率或生产发布已认证。\n7. 图按架构模块族组织，完整覆盖 apps、packages 和 core 的目录级模块；不逐个绘制所有函数与 API。\n\n## core 模块族完整索引\n\n| 模块 | 图中分区 |\n|---|---|\n${linked.map(e=>`| \`${e.name}\` | ${[...new Set(e.panels)].join(' / ')} |`).join('\n')}\n\n文件格式依据：[Excalidraw 官方 JSON Schema](https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/codebase/json-schema.mdx)。\n`;
writeFileSync(`${out}/README.md`,readme);
console.log(JSON.stringify({frames:panels.length,nodes:refs.length,elements:elements.length,coreModuleFamilies:linked.length,unmapped:unmapped.map(e=>e.name)}));
