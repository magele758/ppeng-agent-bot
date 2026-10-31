export const shell = {
  nav: {
    label: '主导航',
    primary: '一级导航',
    subPages: '子页面',
    pending: '{count} 项待处理',
    collapse: '收起导航',
    expand: '展开导航',
    bot: 'Bot',
    chat: '对话',
    agents: 'Bots 与 Agents',
    tasks: '任务',
    knowledge: '知识与记忆',
    ops: '运维',
    settings: '设置',
    footMenu: '模型与外观'
  },
  desc: {
    agents: '管理 Agent、Bot、团队协作与技能。',
    tasks: '任务队列、编排运行、审批与收件箱。',
    knowledge: '查看与管理 Agent 的长期记忆、库页面与摄取配置。',
    ops: '会话轨迹、系统健康与诊断。',
    settings: '常用项在前；实验特性单独成组。仍有少量分组需打开「显示高级」。可用搜索快速定位。'
  },
  sub: {
    agents: { agents: 'Agents', bots: 'Bots', teams: 'Teams', skills: '技能' },
    tasks: { bots: 'Bot 任务', queue: '任务队列', runs: '编排运行', inbox: '审批与收件箱' },
    knowledge: { memory: '记忆', pages: '页面', ingestion: '摄取' },
    ops: { trajectory: '会话轨迹', health: '系统健康' }
  },
  ui: {
    advanced: '显示高级',
    advancedHint: '显示不常用的高级设置',
    toggleGroup: '展开或收起：{title}'
  }
};
