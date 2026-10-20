#!/usr/bin/env node
/** Installer for an immutable comparison checkout. Never substitutes candidate source. */
import {spawnSync} from 'node:child_process';
import {installationCommand} from './lib/package-manager.mjs';
import {resolveBin,sanitizeScriptEnv} from './spawn-utils.mjs';
const {command,args}=installationCommand(process.cwd());
const result=spawnSync(resolveBin(command),args,{cwd:process.cwd(),env:sanitizeScriptEnv(),stdio:'inherit',shell:false});
if(result.error)throw result.error;
process.exit(result.status??1);
