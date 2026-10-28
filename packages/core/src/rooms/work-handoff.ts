import { createHash } from 'node:crypto';
import { BotGoalService } from '../bots/goals/service.js';
import { classifyGoalMessage } from '../bots/goals/intake.js';
import type { BotGoal, GoalStatus } from '../bots/goals/types.js';
import { visibleTaskText } from '../bots/fork-inheritance.js';
import { openBot } from '../bots/bot-facade.js';
import { botWorkControl } from '../bots/bot-work.js';
import { botPrincipalKey, principalFromSession, sameBotPrincipal } from '../bots/bot-identity.js';
import { SourceLedger } from '../learning/sources.js';
import { stableJson } from '../cron/notification-decision.js';
import { ValidationError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import type { BotRoom, BotRoomMessage, BotRoomMessageInput, BotRoomTurn } from './index.js';
import { readRoomGoals, writeRoomGoals, type RoomGoal } from './room-goals.js';
export interface RoomWorkRef {
    goalId: string;
    sessionId: string;
    botId: string;
    roomGoalId: string;
    originTurnId: string;
    sourceMessageId: string;
    routingHash: string;
    goalRevision: number;
    status: GoalStatus;
    draining?: boolean;
    updatedAt: string;
    deliveryStatus: 'accepted' | 'published' | 'blocked';
    publishedStateKey: string;
}
export interface RoomWorkReceipt {
    kind: 'accepted' | 'state' | 'clarify';
    goalId?: string;
    sessionId?: string;
    botId?: string;
    roomGoalId?: string;
    status?: GoalStatus;
    draining?: boolean;
    recordedAt?: string;
}
interface WorkOrigin {
    roomId: string;
    roomGoalId: string;
    turnId: string;
    goalId: string;
    sessionId: string;
    botId: string;
    sourceMessageId: string;
    principalId: string;
}
export type ReceiptWriter = (turn: BotRoomTurn, receipt: RoomWorkReceipt, key: string) => BotRoomMessage;
const originKey = (id: string) => `room.work-origin:${id}`;
export function roomRoutingHash(input: BotRoomMessageInput): string { return createHash('sha256').update(stableJson(input.mentions ?? null)).digest('hex'); }
function directText(text: string): string { return text.replace(/«external [\s\S]*?«end external»/g, '').replace(/```[\s\S]*?```|^\s*>.*$/gm, '').replace(/@[^\s，,。:：]+[\s:：]*/g, '').trim(); }
export function roomHumanIntent(text: string) { return classifyGoalMessage(directText(text)); }
export function assignedRoomWork(text: string): boolean {
    const clean = directText(text);
    if (classifyGoalMessage(clean).kind !== 'new_goal')
        return false;
    return /^(?:(?:现在|那就|接下来|先|继续|请|帮我|麻烦|给我|直接|开始|把|将|在)[\s\S]{0,60})?(?:开发|实现|修复|部署|编写|构建|研究|调查|优化|改造|重构|创建|完成)|^(?:(?:please|can you|could you)\s+)?(?:implement|build|fix|develop|deploy|write|research|investigate|refactor|create)\b/i.test(clean);
}
function receipt(ref: RoomWorkRef, kind: 'accepted' | 'state'): RoomWorkReceipt { return { kind, goalId: ref.goalId, sessionId: ref.sessionId, botId: ref.botId, roomGoalId: ref.roomGoalId, status: ref.status, draining: ref.draining, recordedAt: ref.updatedAt }; }
function stateKey(goal: BotGoal): string { return `${goal.revision}:${goal.status}:${!!goal.draining}`; }
export function acceptHumanRoomWork(store: SqliteStateStore, room: BotRoom, turn: BotRoomTurn, message: BotRoomMessage, input: BotRoomMessageInput, writeReceipt: ReceiptWriter): RoomWorkRef {
    if (!turn.goalId || !turn.ownerBotId || !room.botIds.includes(turn.ownerBotId))
        throw new ValidationError('A current room work owner is required');
    const control = botWorkControl(store, room.principal, turn.ownerBotId);
    if (control.paused || control.disabled)
        throw new ValidationError('The assigned Bot is paused or disabled');
    const board = readRoomGoals(store, room.id), roomGoal = board.goals.find(g => g.id === turn.goalId);
    if (!roomGoal)
        throw new ValidationError('Room work goal unavailable');
    const facade = { store, runImageRetention: async () => { }, wakeAllAutonomousSessions() { }, wakeAgentSessions() { } };
    const opened = openBot(facade, turn.ownerBotId, room.principal), session = store.getSession(opened.sessionId)!;
    const source = store.appendMessage(session.id, 'user', [{ type: 'text', text: message.text }], { key: `room-work:${room.id}:${message.id}` });
    new SourceLedger(store).record(session.id, { kind: 'user', ref: source.id, messageId: source.id, label: room.title });
    const service = new BotGoalService(store, Date.now, session.id), goal = service.create({ botId: turn.ownerBotId, sessionId: session.id, title: visibleTaskText(message.text).slice(0, 120), objective: visibleTaskText(message.text), sourceMessageId: source.id, constraints: [...roomGoal.constraints], resources: [`workspace:${session.workspaceId ?? session.metadata.workspaceId ?? 'default'}`, `room-source:${room.id}:${message.id}`, ...message.attachmentIds.map(id => `room-attachment:${id}`)], resumeRequested: true });
    const ref: RoomWorkRef = { goalId: goal.id, sessionId: session.id, botId: goal.botId, roomGoalId: roomGoal.id, originTurnId: turn.id, sourceMessageId: message.id, routingHash: roomRoutingHash(input), goalRevision: goal.revision, status: goal.status, updatedAt: goal.updatedAt, deliveryStatus: 'accepted', publishedStateKey: stateKey(goal) };
    const origin: WorkOrigin = { roomId: room.id, roomGoalId: roomGoal.id, turnId: turn.id, goalId: goal.id, sessionId: session.id, botId: goal.botId, sourceMessageId: message.id, principalId: botPrincipalKey(room.principal) };
    store.setDaemonControl(originKey(roomGoal.id), origin);
    roomGoal.workRef = ref;
    writeRoomGoals(store, room.id, board);
    writeReceipt(turn, receipt(ref, 'accepted'), `work-accepted:${turn.id}`);
    return ref;
}
function linkedWork(store: SqliteStateStore, room: BotRoom, ref: RoomWorkRef): {
    service: BotGoalService;
    goal: BotGoal;
} | undefined {
    const origin = store.getDaemonControl<WorkOrigin>(originKey(ref.roomGoalId)), session = store.getSession(ref.sessionId);
    if (!origin || origin.roomId !== room.id || origin.roomGoalId !== ref.roomGoalId || origin.turnId !== ref.originTurnId || origin.goalId !== ref.goalId || origin.sessionId !== ref.sessionId || origin.botId !== ref.botId || origin.sourceMessageId !== ref.sourceMessageId || origin.principalId !== botPrincipalKey(room.principal))
        return undefined;
    if (!session || session.metadata.canonicalBotChat !== true || session.metadata.botId !== ref.botId || !sameBotPrincipal(principalFromSession(store, session), room.principal) || !room.botIds.includes(ref.botId))
        return undefined;
    const service = new BotGoalService(store, Date.now, session.id), goal = service.get(ref.botId, ref.goalId);
    return goal ? { service, goal } : undefined;
}
function publicRoomStatus(status: GoalStatus): RoomGoal['status'] { if (status === 'completed' || status === 'cancelled' || status === 'failed')
    return status; return ['paused', 'blocked', 'pending_review'].includes(status) ? 'paused' : 'running'; }
/** Projects only phase/ref information. Private progress, evidence and transcripts are never copied. */
export function synchronizeRoomWork(store: SqliteStateStore, room: BotRoom, writeReceipt: ReceiptWriter): void {
    const board = readRoomGoals(store, room.id);
    let changed = false;
    for (const roomGoal of board.goals) {
        const ref = roomGoal.workRef;
        if (!ref)
            continue;
        const linked = linkedWork(store, room, ref);
        if (!linked) {
            if (ref.deliveryStatus !== 'blocked') {
                ref.deliveryStatus = 'blocked';
                changed = true;
            }
            continue;
        }
        const goal = linked.goal, key = stateKey(goal), before = JSON.stringify(ref);
        ref.status = goal.status;
        ref.draining = goal.draining;
        ref.goalRevision = goal.revision;
        ref.updatedAt = goal.updatedAt;
        roomGoal.status = publicRoomStatus(goal.status);
        roomGoal.progress = '';
        if (!['queued', 'running'].includes(goal.status) && key !== ref.publishedStateKey) {
            const row = store.db.prepare('SELECT data FROM bot_room_turns WHERE id=? AND room_id=?').get(ref.originTurnId, room.id);
            if (row) {
                writeReceipt(JSON.parse(String(row.data)) as BotRoomTurn, receipt(ref, 'state'), `work-state:${ref.originTurnId}:${key}`);
                ref.publishedStateKey = key;
                ref.deliveryStatus = 'published';
            }
        }
        else if (ref.deliveryStatus === 'blocked')
            ref.deliveryStatus = 'accepted';
        if (JSON.stringify(ref) !== before)
            changed = true;
    }
    if (changed)
        writeRoomGoals(store, room.id, board);
}
export function handleHumanRoomFollowup(store: SqliteStateStore, room: BotRoom, turn: BotRoomTurn, text: string, mentions: readonly string[] | undefined, writeReceipt: ReceiptWriter): string[] {
    const intent = roomHumanIntent(text), board = readRoomGoals(store, room.id);
    let candidates = board.goals.filter(g => g.workRef);
    if (intent.goalId)
        candidates = candidates.filter(g => g.id === intent.goalId || g.workRef!.goalId === intent.goalId);
    else if (mentions?.length)
        candidates = candidates.filter(g => mentions.includes(g.workRef!.botId));
    if (candidates.length !== 1) {
        writeReceipt(turn, { kind: 'clarify' }, `work-clarify:${turn.id}`);
        return [];
    }
    const roomGoal = candidates[0]!, ref = roomGoal.workRef!, linked = linkedWork(store, room, ref);
    if (!linked)
        throw new ValidationError('Linked work is no longer authorized for this room');
    let interrupts: string[] = [];
    if (['pause', 'resume', 'cancel', 'amend_goal'].includes(intent.kind)) {
        interrupts = intent.kind === 'resume' ? [] : linked.service.executions(ref.botId, ref.goalId).filter(e => e.status === 'running' && e.sessionId).map(e => e.sessionId!);
        linked.service.applyIntent(ref.botId, { kind: intent.kind as 'pause', goalId: ref.goalId, text: intent.text, sourceMessageId: turn.messageId, sessionId: ref.sessionId });
    }
    const goal = linked.service.get(ref.botId, ref.goalId)!;
    ref.status = goal.status;
    ref.draining = goal.draining;
    ref.goalRevision = goal.revision;
    ref.updatedAt = goal.updatedAt;
    roomGoal.status = publicRoomStatus(goal.status);
    ref.publishedStateKey = stateKey(goal);
    writeRoomGoals(store, room.id, board);
    turn.workRef = { ...ref };
    writeReceipt(turn, receipt(ref, 'state'), `work-followup:${turn.id}`);
    return interrupts;
}
