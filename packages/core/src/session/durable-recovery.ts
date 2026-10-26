import type { SessionMessage } from '../types.js';
import type { StepCheckpoint } from './checkpoint.js';

// Only these built-in readers are safe to repeat. Shell, plugins and arbitrary MCP tools are not inferred safe.
const READERS = new Set(['read_file', 'grep_files', 'list_files', 'history_read', 'history_search', 'memory_get']);
export function decideRecovery(input: {
 checkpoint?: Pick<StepCheckpoint, 'seq'|'id'>;
 messages: Pick<SessionMessage, 'seq'|'parts'>[];
 hasUnconfirmedEffects?: boolean;
}): {resume:boolean;reason:string;checkpointSeq?:number} {
 if (!input.checkpoint) return {resume:false,reason:'missing_checkpoint'};
 if (!Number.isSafeInteger(input.checkpoint.seq)||!input.messages.some(m=>m.seq===input.checkpoint!.seq))return {resume:false,reason:'checkpoint_not_retained'};
 if (input.hasUnconfirmedEffects !== false) return {resume:false,reason:'effects_unverified'};
 const pending = new Set<string>();
 for (const message of input.messages) {
  if ((message.seq ?? 0) <= input.checkpoint.seq) continue;
  for (const part of message.parts) {
   if (part.type === 'tool_call') {
    if (!READERS.has(part.name)) return {resume:false,reason:'unsafe_tail'};
    pending.add(part.toolCallId);
   }
   if (part.type === 'tool_result') pending.delete(part.toolCallId);
  }
 }
 // Resume only a closed boundary; never fabricate missing tool results.
 if (pending.size) return {resume:false,reason:'open_tool_wave'};
 return {resume:true,reason:'verified_checkpoint',checkpointSeq:input.checkpoint.seq};
}
