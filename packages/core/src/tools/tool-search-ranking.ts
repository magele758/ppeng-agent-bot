import { toolGroup } from './tool-exposure.js';

/** Deterministic bilingual aliases; no network call or additional model configuration. */
const CONCEPTS = [
  ['quote', '股价', '行情', 'stock price', 'share price', 'stock quote'],
  ['fundamentals', '基本面', '财报', 'financial statement'],
  ['kubernetes', 'k8s', '集群', 'cluster', '容器'],
  ['logs', 'loki', '日志', 'log search'],
  ['metrics', 'prom', '指标', '监控'],
  ['cron', 'schedule', '定时', '日程', '提醒'],
  ['browser', '浏览器', '网页操作'],
  ['page', '页面'],
  ['memory', '记忆'],
  ['history', '历史'],
  ['file', '文件'],
  ['skill', '技能'],
  ['bot', '机器人'],
  ['room', '群聊'],
  ['session', '会话'],
  ['project', '项目'],
  ['goal', '目标'],
  ['team', '团队'],
  ['research', '研究'],
  ['search', '搜索', '查找'],
  ['list', '列表', '列出'],
  ['create', '创建', '新建'],
  ['delete', '删除', '移除'],
  ['update', '修改', '更新'],
  ['read', '读取'],
  ['write', '写入', '保存'],
];
const STOP_WORDS = new Set(['a','an','the','i','me','my','please','can','you','to','for','of','and','in','with','get','show','find','now']);
const normalize = (text: string) => text.toLowerCase().replace(/^\+/, '').trim();

function contains(text: string, phrase: string): boolean {
  if (/^[a-z ]+$/.test(phrase)) return new RegExp(`\\b${phrase}\\b`).test(text.replaceAll('_', ' '));
  return text.includes(phrase);
}

function conceptScore(query: string, hay: string): number {
  return CONCEPTS.reduce((score, words) => {
    const queryMatch = words.some(word => contains(query, word));
    const toolMatch = words.some(word => contains(hay, word));
    return score + (queryMatch && toolMatch ? 12 : 0);
  }, 0);
}

function scoreTool(tool: { name: string; description?: string }, query: string): number {
  if (!query) return 1;
  if (normalize(tool.name) === query) return 10000;
  const group = toolGroup(tool.name);
  const own = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
  const hay = `${own} ${group.id} ${group.labelZh} ${group.labelEn}`.toLowerCase();
  const tokens = query.split(/[\s,，。？！?!]+/).filter(token => token && !STOP_WORDS.has(token));
  const lexical = tokens.reduce((score, token) => score + (hay.includes(token) ? 4 : 0), 0);
  return lexical + conceptScore(query, own) + (query === group.id ? 20 : 0);
}

export function rankToolSearch<T extends {name: string; description?: string}>(tools: T[], query: string): T[] {
  const q = normalize(query);
  return tools.map(tool => ({tool, score: scoreTool(tool, q)}))
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name, 'en'))
    .map(hit => hit.tool);
}
