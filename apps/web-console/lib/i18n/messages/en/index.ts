import { goals } from './goals.ts';
import { polish } from './polish.ts';
import { factory } from './factory.ts';
import { botWork } from './botWork.ts';
import { externalAgents } from './externalAgents.ts';
import type { Messages } from '../types.ts';
import { agents } from './agents.ts';
import { knowledge } from './knowledge.ts';
import { settings } from './settings.ts';
import { settingsEntries } from './settingsEntries.ts';
import { shell } from './shell.ts';
import { tasks } from './tasks.ts';
import { auth } from './auth.ts';
import { common } from './common.ts';
import { configMessages } from './config.ts';
import { memory } from './memory.ts';
import { modelFallback } from './modelFallback.ts';
import { more } from './more.ts';
import { nav } from './nav.ts';
import { ops } from './ops.ts';
import { play } from './play.ts';
import { skillProposals } from './skillProposals.ts';
import { teams } from './teams.ts';

export const en = {
  goals,
  polish,
  factory,
  externalAgents,
  botWork,
  common,
  auth,
  nav,
  play,
  more,
  memory,
  teams,
  ops,
  skillProposals,
  modelFallback,
  config: configMessages,
  shell,
  settings,
  settingsEntries,
  agents,
  tasks,
  knowledge
} as const satisfies Messages;
