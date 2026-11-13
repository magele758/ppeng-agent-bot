import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { ValidationError, type SessionMessage, type SessionRecord } from '@ppeng/agent-core';

type Vault = { path: string; open?: boolean };
export function selectVault(vaults: Record<string, Vault>): string {
  const all = Object.values(vaults);
  const open = all.filter(vault => vault.open);
  const candidates = open.length ? open : all;
  if (candidates.length !== 1) throw new ValidationError('obsidian_vault_required');
  return candidates[0]!.path;
}

export async function activeVault(): Promise<string> {
  const config = path.join(homedir(), '.config');
  const dirs: Partial<Record<NodeJS.Platform,string | undefined>> = {
    darwin: path.join(homedir(),'Library/Application Support'), win32: process.env.APPDATA
  };
  const dir = dirs[process.platform];
  try {
    const registry = JSON.parse(await readFile(path.join(dir ?? process.env.XDG_CONFIG_HOME ?? config, 'obsidian/obsidian.json'),'utf8'));
    return selectVault(registry.vaults);
  } catch { throw new ValidationError('obsidian_vault_required'); }
}

const subjects = {
  ai: /大模型|智能体|机器学习|人工智能|\b(llms?|agents?|transformers?)\b/i,
  engineering: /数据库|软件|开发|编程|测试|部署|\b(python|rust|typescript|database)\b/i,
  business: /经济|金融|股票|投资|\b(finance|investment)\b/i,
  arts: /文学|哲学|历史|艺术|音乐|\b(history|music|philosophy)\b/i,
  science: /物理|数学|生物|化学|天文|\b(physics|biology)\b/i,
  life: /健康|烹饪|旅行|运动|\b(fitness|travel)\b/i
};
export function noteTopics(body: string): string[] {
  const topics = Object.entries(subjects).filter(([,pattern])=>pattern.test(body)).map(([key])=>key);
  return topics.length ? topics : ['other'];
}

function messageText(message: SessionMessage): string[] {
  if (message.hidden || !['assistant','user'].includes(message.role)) return [];
  const text = message.parts.filter(part=>part.type==='text').map(part=>part.text).join('\n').trim();
  return text ? ['## '+message.role+' · '+(message.createdAt ?? '')+'\n\n'+text] : [];
}

export function noteBody(messages: SessionMessage[]): string {
  const body = messages.flatMap(messageText).join('\n\n');
  if (!body) throw new ValidationError('obsidian_empty');
  return body;
}

export async function saveConversation(vault: string, session: Pick<SessionRecord,'id'|'title'|'createdAt'>, messages: SessionMessage[], body = noteBody(messages)): Promise<string> {
  const title = session.title || session.id;
  const tags = noteTopics(title+'\n'+body);
  const content = ['---','title: '+JSON.stringify(title),'session_id: '+JSON.stringify(session.id),'date: '+JSON.stringify(session.createdAt),'tags: [agent-home, '+tags.join(', ')+']','---','','# '+title,'',body,''].join('\n');
  const hash = createHash('sha256').update(content).digest('hex').slice(0,20);
  const stem = Array.from(title.replace(/[^\p{L}\p{N} _-]/gu,' ').trim()).slice(0,40).join('') || 'Chat';
  const relative = path.join('Agent Home',stem+' - '+hash+'.md');
  const root = await realpath(vault);
  if (!(await lstat(path.join(root,'.obsidian'))).isDirectory()) throw new ValidationError('obsidian_vault_required');
  const dir = path.join(root,'Agent Home');
  await mkdir(dir,{recursive:true});
  if (await realpath(dir)!==dir) throw new ValidationError('obsidian_vault_required');
  const tmp = path.join(dir,'.'+randomUUID()+'.tmp');
  await writeFile(tmp,content,{flag:'wx',mode:0o600});
  try {
    await link(tmp,path.join(root,relative));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code!=='EEXIST') throw err;
    if (!(await lstat(path.join(root,relative))).isFile()) throw new ValidationError('obsidian_file_conflict');
  } finally { await unlink(tmp); }
  return relative;
}
