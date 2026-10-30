'use client';
import {CorrectionCapture} from './LearningWorkbench';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SystemMessageContent } from './SystemMessageContent';
import { ModelRetryStatus } from './ModelRetryStatus';
import type { RetryProgress } from '@/lib/model-retry';
import type { StreamSegment } from '@/lib/stream-segments';
import { formatStreamToolArgs } from '@/lib/stream-segments';
import type { ChatMessage, MessagePart } from '@/lib/types';
import {
  isToolResultStub,
  isToolResultTrimmed,
  messageHasStructuredParts,
  msgPartsToText,
  normalizedRole
} from '@/lib/chat-utils';
import { briefStreamSegments, visibleBriefParts } from '@/lib/session-brief';
import { SessionBriefDisclosure } from './SessionBriefDisclosure';
import { parseCronUserPrompt } from '@/lib/cron';
import { quietRoutineResult } from '@/lib/routine-quiet';
import { presentGoalUpdate, readMessageSessionId } from '@/lib/goal-update-notice';
import { A2uiSurface } from './a2ui/A2uiSurface';
import { ReadableMessage } from './ReadableMessage';
import { MarkdownHtml, StaticHtml } from './MarkdownHtml';
import { foldA2uiMessages } from './a2ui/fold';
import { surfacePartKey, useSurfaceContext } from './a2ui/SurfaceContext';
import type { A2uiMessage, SurfaceState } from './a2ui/types';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { api } from '@/lib/api';
import { secureFormResultCard, secureFormSubmitBody } from '@/lib/secure-form-card';
import { ComposerMessageContext } from './ComposerContext';
import type { ContextLabel } from '@/lib/composer-context';
import { BotReplyQuoteAction, MessageReplyQuote } from './ReplyQuote';
import {
  replyAuthorName,
  replyMessageId,
  replySourceText,
  readStoredReplyTo,
  type ReplyQuote,
  type ReplyTo
} from '@/lib/reply-quote';
import { osSandboxReasonKey, parseOsSandboxReason } from '@/lib/os-sandbox-reason';
import { parseSpawnBlocked } from '@/lib/spawn-blocked';
import { SpawnBlockedNotice, SpawnBlockedPill } from './SpawnBlockedNotice';
import {
  formatToolInput,
  hasVisibleStructuredParts,
  previewToolInput,
  toolIoPartKey,
  type ToolCallPart
} from '@/lib/tool-io';
import {
  chatImageRef,
  chatImageSrc,
  isToolObservationCaption,
  type ChatImageRef
} from '@/lib/chat-images';

function buildModClass(
 _role: string,
  stream?: boolean
): string {
  if (stream) return 'chat-turn--streaming';
  const role = _role;
  if (role === 'user') return 'chat-turn--user';
  if (role === 'tool') return 'chat-turn--tool';
  if (role === 'system') return 'chat-turn--system';
  return 'chat-turn--assistant';
}

function roleLabel(role: string, t: (key: MessageKey) => string): string {
  switch (role) {
    case 'user':
      return t('play.role.user');
    case 'tool':
      return t('play.role.tool');
    case 'system':
      return t('play.role.system');
    case 'assistant':
      return t('play.role.assistant');
    default:
      return role;
  }
}

function avatarText(role: string, me: string, stream?: boolean): string {
  if (stream) return 'AI';
  if (role === 'user') return me;
  if (role === 'tool') return 'T';
  if (role === 'system') return 'S';
  return 'AI';
}

function ToolIoBlocks({ input, output }: { input?: string; output?: string }) {
  const { t } = useI18n();
  return (
    <div className="chat-tool-io">
      <details className="chat-tool-io__block chat-tool-io__block--in" open>
        <summary className="chat-tool-io__label" onClick={(e) => e.stopPropagation()}>
          {t('play.ioInput')}
        </summary>
        <pre className="chat-tool-io__body">{input?.trim() ? input : '…'}</pre>
      </details>
      <details className="chat-tool-io__block chat-tool-io__block--out" open>
        <summary className="chat-tool-io__label" onClick={(e) => e.stopPropagation()}>
          {t('play.ioOutput')}
        </summary>
        <pre className="chat-tool-io__body">{output?.trim() ? output : '…'}</pre>
      </details>
    </div>
  );
}

function ToolCallFold({ p }: { p: Extract<MessagePart, { type: 'tool_call' }> }) {
  const { t } = useI18n();
  const isSubagent = p.name === 'spawn_subagent';
  const isTeammate = p.name === 'spawn_teammate';
  const inputObj = typeof p.input === 'object' && p.input !== null ? (p.input as Record<string, unknown>) : null;
  const subagentRole = inputObj?.role ? String(inputObj.role) : undefined;
  const subagentPrompt = inputObj?.prompt ? String(inputObj.prompt) : undefined;
  const body = formatToolInput(p.input);
  const preview = previewToolInput(p.input);
  return (
    <details className={`chat-tool-fold chat-tool-fold--call chat-tool-fold--compact${isSubagent ? ' chat-tool-fold--subagent' : ''}${isTeammate ? ' chat-tool-fold--team' : ''}`}>
      <summary className="chat-tool-fold__summary">
        {isSubagent ? (
          <span className="chat-tool-fold__pill chat-tool-fold__pill--subagent">{t('play.turns.dispatchSubagent')}</span>
        ) : isTeammate ? (
          <span className="chat-tool-fold__pill chat-tool-fold__pill--team">{t('play.turns.createTeammate')}</span>
        ) : (
          <span className="chat-tool-fold__pill chat-tool-fold__pill--call">{t('play.call')}</span>
        )}
        <span className="chat-tool-fold__name">{p.name ?? 'unknown'}</span>
        {preview ? <span className="chat-tool-fold__preview">{preview}</span> : null}
        {subagentRole ? (
          <span className="chat-tool-fold__pill chat-tool-fold__pill--subagent-role">
            {t('play.turns.role', { role: subagentRole })}
          </span>
        ) : null}
      </summary>
      {isSubagent && subagentPrompt ? (
        <div className="chat-subagent-card">
          <div className="chat-subagent-card__header">
            <strong>{t('play.turns.subtaskGoal')}</strong>
          </div>
          <div className="chat-subagent-card__prompt">{subagentPrompt}</div>
        </div>
      ) : null}
      <ToolIoBlocks input={body} />
    </details>
  );
}

/** 与 ToolResultFold 同款交互：独立 `<details>`；流式中展开，输出结束后默认折叠 */
function ReasoningFold({ text, streaming }: { text: string; streaming?: boolean }) {
  const { t } = useI18n();
  const body = text.trim();
  if (!body) return null;
  return (
    <details
      className="chat-tool-fold chat-tool-fold--compact chat-tool-fold--reasoning"
      {...(streaming ? { open: true } : {})}
    >
      <summary className="chat-tool-fold__summary">
        <span className="chat-tool-fold__pill chat-tool-fold__pill--reasoning">{t('play.thinking')}</span>
        <span className="chat-tool-fold__name">{t('play.reasoningProcess')}</span>
      </summary>
      <pre className="chat-tool-fold__body">{body}</pre>
    </details>
  );
}

function secureFormStatusText(action: 'submit' | 'cancel', failed: boolean, failedText: string): string {
  if (failed) return failedText;
  return action === 'submit' ? 'filled' : 'cancelled';
}

function SecureFormStatus({ status }: { status: string }) {
  return <p className="secure-form-card__status">{status}</p>;
}

function SecureFormField({
  sessionId,
  content,
  value,
  onValue,
  onSubmit,
  onCancel
}: {
  sessionId: string;
  content: string;
  value: string;
  onValue: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const face = secureFormResultCard(content);
  if (!face || !sessionId) return null;
  return (
    <div className="secure-form-card">
      <p>{face.prompt}</p>
      <input
        className="secure-form-field"
        type="password"
        autoComplete="off"
        placeholder={t('play.approval.secureFormPlaceholder')}
        aria-label={face.label}
        value={value}
        onChange={(e) => onValue(e.target.value)}
      />
      <button type="button" disabled={!value.trim()} onClick={onSubmit}>
        {t('play.approval.secureFormSubmit')}
      </button>
      <button type="button" onClick={onCancel}>
        {t('play.approval.secureFormCancel')}
      </button>
    </div>
  );
}

function SecureFormFill({ sessionId, content }: { sessionId: string; content: string }) {
  const { t } = useI18n();
  const face = secureFormResultCard(content);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('');
  if (!face || !sessionId) return null;
  const send = (action: 'submit' | 'cancel') => {
    if (action === 'submit' && !value.trim()) return;
    void api(`/api/sessions/${encodeURIComponent(sessionId)}/secure-form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(secureFormSubmitBody(face, value.trim(), action))
    })
      .then(() => {
        setValue('');
        setStatus(secureFormStatusText(action, false, t('play.approval.secureFormFailed')));
      })
      .catch(() => {
        setValue('');
        setStatus(secureFormStatusText(action, true, t('play.approval.secureFormFailed')));
      });
  };
  if (status) return <SecureFormStatus status={status} />;
  return (
    <SecureFormField
      sessionId={sessionId}
      content={content}
      value={value}
      onValue={setValue}
      onSubmit={() => send('submit')}
      onCancel={() => send('cancel')}
    />
  );
}

function toolResultConfidence(content: string): string | null {
  const confMatch = content.match(/(?:confidence|置信度)\s*[:=：]?\s*(\d{1,3})\s*%?/i);
  return confMatch ? `${confMatch[1]}%` : null;
}

function toolResultFoldClass(flags: {
  ok: boolean;
  modelView?: boolean;
  stub: boolean;
  isSubagent: boolean;
  isSteerSkipped: boolean;
  spawnBlocked: boolean;
}): string {
  const parts = [
    'chat-tool-fold chat-tool-fold--result chat-tool-fold--compact',
    flags.ok ? 'chat-tool-fold--success' : 'chat-tool-fold--error'
  ];
  if (flags.modelView) parts.push('chat-tool-fold--model-view');
  if (flags.stub) parts.push('chat-tool-fold--stub');
  if (flags.isSubagent) parts.push('chat-tool-fold--subagent');
  if (flags.isSteerSkipped) parts.push('chat-tool-fold--steer');
  if (flags.spawnBlocked) parts.push('chat-tool-fold--blocked');
  return parts.join(' ');
}

function ToolResultStatusPill({
  isSteerSkipped,
  spawnBlocked,
  isSubagent,
  isTeammate,
  ok
}: {
  isSteerSkipped: boolean;
  spawnBlocked: boolean;
  isSubagent: boolean;
  isTeammate: boolean;
  ok: boolean;
}) {
  const { t } = useI18n();
  if (isSteerSkipped) {
    return <span className="chat-tool-fold__pill chat-tool-fold__pill--steer">{t('play.turns.steerSkip')}</span>;
  }
  if (spawnBlocked) return null;
  if (isSubagent) {
    return <span className="chat-tool-fold__pill chat-tool-fold__pill--subagent">{t('play.turns.subagentDeliver')}</span>;
  }
  if (isTeammate) {
    return <span className="chat-tool-fold__pill chat-tool-fold__pill--team">{t('play.turns.teammateReply')}</span>;
  }
  return (
    <span className={`chat-tool-fold__pill ${ok ? 'chat-tool-fold__pill--ok' : 'chat-tool-fold__pill--err'}`}>
      {ok ? t('play.output') : t('play.fail')}
    </span>
  );
}

function ToolResultSummary({
  name,
  preview,
  confidence,
  isLowConf,
  modelView,
  spawnBlocked,
  sandboxReason,
  stub,
  trimmed,
  status
}: {
  name?: string;
  preview: string;
  confidence: string | null;
  isLowConf: boolean;
  modelView?: boolean;
  spawnBlocked: ReturnType<typeof parseSpawnBlocked>;
  sandboxReason: ReturnType<typeof parseOsSandboxReason>;
  stub: boolean;
  trimmed: boolean;
  status: {
    isSteerSkipped: boolean;
    spawnBlocked: boolean;
    isSubagent: boolean;
    isTeammate: boolean;
    ok: boolean;
  };
}) {
  const { t } = useI18n();
  return (
    <summary className="chat-tool-fold__summary">
      <ToolResultStatusPill
        isSteerSkipped={status.isSteerSkipped}
        spawnBlocked={status.spawnBlocked}
        isSubagent={status.isSubagent}
        isTeammate={status.isTeammate}
        ok={status.ok}
      />
      <span className="chat-tool-fold__name">{name ?? 'unknown'}</span>
      {preview ? <span className="chat-tool-fold__preview">{preview}</span> : null}
      {confidence ? (
        <span className={`chat-tool-fold__pill ${isLowConf ? 'chat-tool-fold__pill--err' : 'chat-tool-fold__pill--ok'}`}>
          {t('play.turns.confidence', { value: confidence })}
        </span>
      ) : null}
      {modelView ? (
        <span className="chat-tool-fold__pill chat-tool-fold__pill--model-view">{t('play.modelViewOnly')}</span>
      ) : null}
      {spawnBlocked ? <SpawnBlockedPill /> : null}
      {sandboxReason ? (
        <span className="chat-tool-fold__pill" data-testid="os-sandbox-reason">
          {t(osSandboxReasonKey(sandboxReason))}
        </span>
      ) : null}
      {stub ? <span className="chat-tool-fold__pill chat-tool-fold__pill--stub">{t('play.stub')}</span> : null}
      {trimmed ? <span className="chat-tool-fold__pill chat-tool-fold__pill--trim">{t('play.trimmed')}</span> : null}
    </summary>
  );
}

function ToolResultBody({
  content,
  inputText,
  isSubagent,
  stub,
  modelView,
  spawnBlocked
}: {
  content: string;
  inputText: string;
  isSubagent: boolean;
  stub: boolean;
  modelView?: boolean;
  spawnBlocked: ReturnType<typeof parseSpawnBlocked>;
}) {
  return (
    <>
      {spawnBlocked ? <SpawnBlockedNotice blocked={spawnBlocked} /> : null}
      {isSubagent && !stub && !modelView && !spawnBlocked ? (
        <MarkdownHtml className="chat-subagent-summary chat-bubble__md" text={content} />
      ) : (
        <ToolIoBlocks input={inputText} output={content} />
      )}
    </>
  );
}

function ToolResultFold({
  p,
  call,
  modelView,
  sessionId
}: {
  p: Extract<MessagePart, { type: 'tool_result' }>;
  call?: ToolCallPart;
  modelView?: boolean;
  sessionId?: string;
}) {
  const ok = p.ok !== false;
  const content = p.content ?? '';
  const stub = Boolean(modelView && isToolResultStub(content));
  const trimmed = Boolean(modelView && isToolResultTrimmed(content));
  const inputText = call ? formatToolInput(call.input) : '';
  const preview = call ? previewToolInput(call.input) : '';
  const isSubagent = p.name === 'spawn_subagent';
  const isTeammate = p.name === 'spawn_teammate';
  const isSteerSkipped = content.startsWith('[skipped by user steer:');
  const confidence = toolResultConfidence(content);
  const isLowConf = content.includes('[low-confidence:');
  const spawnBlocked = parseSpawnBlocked(p.name, content);
  const sandboxReason = parseOsSandboxReason(content);
  const secureForm = !modelView && sessionId ? secureFormResultCard(content) : null;
  return (
    <div className="chat-tool-result-block">
      {secureForm && sessionId ? <SecureFormFill sessionId={sessionId} content={content} /> : null}
      <details
        className={toolResultFoldClass({ ok, modelView, stub, isSubagent, isSteerSkipped, spawnBlocked: Boolean(spawnBlocked) })}
        data-model-view={modelView ? (stub ? 'stub' : trimmed ? 'trimmed' : '1') : undefined}
        {...(spawnBlocked ? { open: true } : {})}
      >
        <ToolResultSummary
          name={p.name}
          preview={preview}
          confidence={confidence}
          isLowConf={isLowConf}
          modelView={modelView}
          spawnBlocked={spawnBlocked}
          sandboxReason={sandboxReason}
          stub={stub}
          trimmed={trimmed}
          status={{ isSteerSkipped, spawnBlocked: Boolean(spawnBlocked), isSubagent, isTeammate, ok }}
        />
        <ToolResultBody
          content={content}
          inputText={inputText}
          isSubagent={isSubagent}
          stub={stub}
          modelView={modelView}
          spawnBlocked={spawnBlocked}
        />
      </details>
    </div>
  );
}

function ChatImageThumb({ sessionId, image }: { sessionId: string; image: ChatImageRef }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const src = chatImageSrc(sessionId, image.assetId);
  const alt = image.alt?.trim() || t('play.turns.toolShotAlt');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="chat-image-thumb"
        aria-label={t('play.turns.enlargeImage')}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} />
      </button>
      <dialog
        ref={dialogRef}
        className="chat-image-lightbox"
        aria-label={alt}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
      >
        <img src={src} alt={alt} />
        <button type="button" className="chat-image-lightbox__close" onClick={() => setOpen(false)}>
          {t('common.close')}
        </button>
      </dialog>
    </>
  );
}

function SurfaceUpdateBlock({
  p,
  sessionId,
  msgIndex,
  partIndex
}: {
  p: Extract<MessagePart, { type: 'surface_update' }>;
  sessionId: string;
  msgIndex: number;
  partIndex: number;
}) {
  /**
   * The same surface may grow across multiple a2ui_render calls (each landing
   * as its own SurfaceUpdatePart on a different tool message). The accumulator
   * provided by SurfaceContext folds them all and tells us which part is the
   * latest position for each surfaceId — only that one renders the surface,
   * earlier positions render a small breadcrumb so the chat history stays
   * readable.
   */
  const ctx = useSurfaceContext();
  const myKey = surfacePartKey(msgIndex, partIndex);
  const latest = ctx.latestKey.get(p.surfaceId);
  const isLatest = latest === myKey;

  if (!isLatest) {
    return (
      <div className="a2ui-debug">
        a2ui surface {p.surfaceId}: superseded by a later update
      </div>
    );
  }

  // Prefer the cross-message accumulated state; fall back to a local fold for
  // standalone parts (covers older sessions or pure-test contexts where the
  // provider is not mounted).
  let state: SurfaceState | undefined = ctx.states.get(p.surfaceId);
  if (!state) {
    state = foldA2uiMessages((p.messages ?? []) as A2uiMessage[]).get(p.surfaceId);
  }
  if (!state) return null;
  return <A2uiSurface state={state} sessionId={sessionId} />;
}

function StructuredBubble({
  parts,
  role,
  sessionId,
  msgIndex,
  modelView,
  toolCallsById,
  resolvedCallIds
}: {
  parts: MessagePart[];
  role: string;
  sessionId: string;
  msgIndex: number;
  modelView?: boolean;
  toolCallsById?: ReadonlyMap<string, ToolCallPart>;
  resolvedCallIds?: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const usePre = role === 'tool' || role === 'system';
  const nodes: ReactNode[] = [];
  const textBuf: string[] = [];
  const flush = () => {
    const joined = textBuf.join('\n').trim();
    textBuf.length = 0;
    if (!joined) return;
    if (role === 'system' && !modelView) {
      nodes.push(<SystemMessageContent key={nodes.length} text={joined} scope={{ conversationId: sessionId }} />);
    } else if (usePre) {
      nodes.push(
        <pre key={nodes.length} className="chat-bubble__pre">
          {joined}
        </pre>
      );
    } else {
      nodes.push(
        <MarkdownHtml key={nodes.length} className="chat-bubble__body chat-bubble__md" text={joined} />
      );
    }
  };
  const partsList = parts ?? [];
  for (let pi = 0; pi < partsList.length; pi += 1) {
    const p = partsList[pi]!;
    if (p.type === 'text') {
      const line = p.text ?? '';
      if (isToolObservationCaption(line)) {
        flush();
        nodes.push(
          <p key={nodes.length} className="chat-tool-observation">
            {t('play.turns.toolObservation')}
          </p>
        );
      } else if (line) {
        textBuf.push(line);
      }
    } else if (p.type === 'reasoning') {
      flush();
      const t = (p.text ?? '').trim();
      if (t) {
        nodes.push(<ReasoningFold key={nodes.length} text={t} />);
      }
    } else if (p.type === 'image') {
      flush();
      const refs: ChatImageRef[] = [];
      let cursor = pi;
      while (cursor < partsList.length && partsList[cursor]?.type === 'image') {
        const ref = chatImageRef(partsList[cursor]!);
        if (ref) refs.push(ref);
        cursor += 1;
      }
      pi = cursor - 1;
      if (refs.length > 0) {
        nodes.push(
          <div key={nodes.length} className="chat-image-thumbs">
            {refs.map((image, index) => (
              <ChatImageThumb key={`${image.assetId}-${index}`} sessionId={sessionId} image={image} />
            ))}
          </div>
        );
      }
    } else if (p.type === 'tool_call') {
      if (resolvedCallIds?.has(p.toolCallId)) continue;
      flush();
      nodes.push(<ToolCallFold key={nodes.length} p={p} />);
    } else if (p.type === 'tool_result') {
      flush();
      nodes.push(
        <ToolResultFold
          key={nodes.length}
          p={p}
          call={
            toolCallsById?.get(p.toolCallId) ?? toolCallsById?.get(toolIoPartKey(msgIndex, pi))
          }
          modelView={modelView}
          sessionId={sessionId}
        />
      );
    } else if (p.type === 'surface_update') {
      flush();
      nodes.push(
        <SurfaceUpdateBlock
          key={nodes.length}
          p={p}
          sessionId={sessionId}
          msgIndex={msgIndex}
          partIndex={pi}
        />
      );
    }
  }
  flush();
  return <>{nodes}</>;
}

export function ChatTurnFromMessage({
  m,
  sessionId = '',
  msgIndex = 0,
  modelView = false,
  toolCallsById,
  resolvedCallIds,
  quoteBot = null,
  onQuote,
  replyNames,
  brief = false
}: {
  m: ChatMessage;
  sessionId?: string;
  msgIndex?: number;
  modelView?: boolean;
  toolCallsById?: ReadonlyMap<string, ToolCallPart>;
  resolvedCallIds?: ReadonlySet<string>;
  quoteBot?: { id: string; name: string } | null;
  onQuote?: (quote: ReplyQuote) => void;
  replyNames?: Readonly<Record<string, string>>;
  brief?: boolean;
}) {
  const { t } = useI18n();
  const shown = brief ? { ...m, parts: visibleBriefParts(m.parts) } : m;
  const r = normalizedRole(m);
  const storedReply = r === 'user' ? readStoredReplyTo(m) : null;
  /** 与流式行一致：助手侧（含「调用工具」等结构化气泡）统一不占左侧头像列 */
  const noAvatar = r === 'tool' || r === 'system' || r === 'assistant';
  const presented =
    r === 'system'
      ? presentGoalUpdate(msgPartsToText(shown.parts), {
          messageSessionId: readMessageSessionId(m as { sessionId?: unknown }),
          conversationId: sessionId
        })
      : { kind: 'absent' as const };
  if (presented.kind === 'hidden') return null;
  if (
    messageHasStructuredParts(shown.parts) &&
    resolvedCallIds &&
    !hasVisibleStructuredParts(shown.parts, resolvedCallIds)
  ) {
    return null;
  }
  const goalCard = presented.kind === 'card' && !modelView;
  const bubble =
    (r === 'system' && !modelView && !messageHasStructuredParts(shown.parts) ? (
      <SystemMessageContent text={msgPartsToText(shown.parts)} scope={{ messageSessionId: readMessageSessionId(m as { sessionId?: unknown }), conversationId: sessionId }} />
    ) : null) ??
    (messageHasStructuredParts(shown.parts) && shown.parts ? (
      <div className="chat-bubble--stream-blocks">
        <StructuredBubble
          parts={shown.parts}
          role={r}
          sessionId={sessionId}
          msgIndex={msgIndex}
          modelView={modelView}
          toolCallsById={toolCallsById}
          resolvedCallIds={resolvedCallIds}
        />
      </div>
    ) : r === 'tool' || r === 'system' ? (
      <pre className="chat-bubble__pre">{msgPartsToText(shown.parts)}</pre>
    ) : (
      <ReadableMessage text={msgPartsToText(shown.parts)} role={r} messageKey={(m as { key?: string }).key} />
    ));
  const artifactBubble = r === 'tool' || r === 'system';
  const isSteerMessage =
    r === 'user' &&
    ((m as { key?: unknown }).key === 'steer' ||
      (typeof (m as { key?: unknown }).key === 'string' &&
        ((m as { key?: string }).key!.includes('steer') || (m as { key?: string }).key!.includes('note'))));
  const cronPrompt = r === 'user' ? parseCronUserPrompt(msgPartsToText(shown.parts)) : null;
  const cronBubble =
    cronPrompt && !(messageHasStructuredParts(shown.parts) && shown.parts) ? (
      <MarkdownHtml className="chat-bubble__body chat-bubble__md" text={cronPrompt.body || cronPrompt.name} />
    ) : bubble;
  return (
    <div className={`chat-turn ${buildModClass(r)}${noAvatar ? ' chat-turn--no-avatar' : ''}${goalCard ? ' chat-turn--goal-update' : ''}`}>
      {!noAvatar ? <div className="chat-avatar">{avatarText(r, t('play.me'))}</div> : null}
      <div className="chat-turn__content">
        <div className="chat-turn__label">
          {roleLabel(r, t)}
          {r==='assistant'&&sessionId&&replyMessageId(m)&&<CorrectionCapture sessionId={sessionId} messageId={replyMessageId(m)}/>}
          {onQuote && quoteBot ? (
            <BotReplyQuoteAction
              reply={{
                messageId: replyMessageId(m),
                botId: quoteBot.id,
                botName: quoteBot.name,
                text: replySourceText(shown.parts),
                author: r === 'assistant' ? 'bot' : 'user'
              }}
              onQuote={onQuote}
            />
          ) : null}
          {isSteerMessage ? (
            <span className="chat-steer-tag" title={t('play.turns.steerTagTitle')}>
              {t('play.turns.steerTag')}
            </span>
          ) : null}
          {cronPrompt ? (
            <span className="chat-cron-tag" title={t('play.turns.cronTagTitle')}>
              {t('play.turns.cronTag', { name: cronPrompt.name })}
            </span>
          ) : null}
        </div>
        <div className={`chat-bubble${artifactBubble ? ' chat-bubble--artifact' : ''}`}>
          {storedReply ? (
            <MessageReplyQuote replyTo={storedReply} botName={replyAuthorName(storedReply, replyNames)} />
          ) : null}
          {cronBubble}
          <ComposerMessageContext role={r} message={m} />
        </div>
      </div>
    </div>
  );
}

/** Hide a stored no-update receipt without adding branches to the turn renderer. */
function storedMessageKey(message: object): string | undefined {
  if (!('key' in message)) return undefined;
  return typeof message.key === 'string' ? message.key : undefined;
}
export function ChatTurnIfVisible(props: Parameters<typeof ChatTurnFromMessage>[0]) {
  const message = props.m;
  if (quietRoutineResult(normalizedRole(message), storedMessageKey(message), msgPartsToText(message.parts))) return null;
  return <ChatTurnFromMessage {...props} />;
}

export function ChatTurnPlain({
  role,
  text,
  labelOverride,
  extraClass = '',
  contextLabels,
  replyTo = null,
  replyBotName,
  messageSessionId,
  conversationId
}: {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'stream';
  text: string;
  labelOverride?: string;
  extraClass?: string;
  contextLabels?: readonly ContextLabel[];
  replyTo?: ReplyTo | null;
  replyBotName?: string;
  messageSessionId?: string;
  conversationId?: string;
}) {
  const { t } = useI18n();
  const presented = role === 'system' ? presentGoalUpdate(text, { messageSessionId, conversationId }) : { kind: 'absent' as const };
  if (presented.kind === 'hidden') return null;
  const stream = role === 'stream';
  const mod = buildModClass(role === 'stream' ? 'assistant' : role, stream);
  const av = avatarText(role === 'stream' ? 'assistant' : role, t('play.me'), stream);
  const label = labelOverride ?? (stream ? t('play.role.streaming') : roleLabel(role, t));
  const goalCard = presented.kind === 'card';
  const usePre = (role === 'tool' || role === 'system') && !goalCard;
  const noAvatar =
    role === 'tool' || role === 'system' || role === 'assistant' || role === 'stream';
  return (
    <div className={`chat-turn ${mod} ${noAvatar ? 'chat-turn--no-avatar' : ''} ${goalCard ? 'chat-turn--goal-update' : ''} ${extraClass}`.trim()}>
      {!noAvatar ? <div className="chat-avatar">{av}</div> : null}
      <div className="chat-turn__content">
        <div className="chat-turn__label">{label}</div>
        <div className="chat-bubble">
          {role === 'user' ? <MessageReplyQuote replyTo={replyTo} botName={replyBotName} /> : null}
          {role === 'system' ? (
            <SystemMessageContent text={text} scope={{ messageSessionId, conversationId }} />
          ) : usePre ? (
            <pre className="chat-bubble__pre">{text}</pre>
          ) : (
            <MarkdownHtml className="chat-bubble__body chat-bubble__md" text={text} />
          )}
          <ComposerMessageContext role={role} labels={contextLabels} />
        </div>
      </div>
    </div>
  );
}

export function ChatTurnStreaming({
  segments,
  retry,
  typing,
  sessionId = '',
  resolvedCallIds,
  brief = false
}: {
  segments: StreamSegment[];
  retry?: RetryProgress;
  typing?: boolean;
  sessionId?: string;
  resolvedCallIds?: ReadonlySet<string>;
  brief?: boolean;
}) {
  const { t } = useI18n();
  const shown = brief ? briefStreamSegments(segments) : { segments, hidden: [] as StreamSegment[] };
  const renderSeg = (seg: StreamSegment) => {
    if (seg.kind === 'reasoning') {
      return <ReasoningFold key={seg.id} text={seg.text} streaming />;
    }
    if (seg.kind === 'tool') {
      if (resolvedCallIds?.has(seg.toolCallId)) return null;
      const args = formatStreamToolArgs(seg.args);
      return (
        <details key={seg.id} className="chat-tool-fold chat-tool-fold--call chat-tool-fold--compact">
          <summary className="chat-tool-fold__summary">
            <span className="chat-tool-fold__pill chat-tool-fold__pill--call">{t('play.call')}</span>
            <span className="chat-tool-fold__name">{seg.name || 'unknown'}</span>
            {args && args !== '…' ? <span className="chat-tool-fold__preview">{args.replace(/\s+/g, ' ')}</span> : null}
          </summary>
          <ToolIoBlocks input={args} />
        </details>
      );
    }
    if (seg.kind === 'a2ui') {
      const map = foldA2uiMessages(seg.envelopes as A2uiMessage[]);
      const state: SurfaceState | undefined = map.get(seg.surfaceId);
      if (!state) return null;
      return <A2uiSurface key={seg.id} state={state} sessionId={sessionId} />;
    }
    return (
      <StaticHtml
        key={seg.id}
        className="chat-bubble__body chat-bubble__md chat-stream-fold__text"
        html={seg.html}
      />
    );
  };
  return (
    <div
      className={`chat-turn chat-turn--streaming chat-turn--no-avatar${typing ? ' chat-turn--typing' : ''}`}
    >
      <div className="chat-turn__content">
        <div className="chat-turn__label">{t('play.role.streaming')}</div>
        <div className="chat-bubble chat-bubble--stream-blocks">
          {retry ? <ModelRetryStatus progress={retry} /> : null}
          {shown.hidden.length > 0 ? (
            <SessionBriefDisclosure label={t('play.turns.processNote', { count: shown.hidden.length })} title={t('play.turns.processNoteTitle')}>
              {shown.hidden.map(renderSeg)}
            </SessionBriefDisclosure>
          ) : null}
          {shown.segments.length === 0 ? (
            shown.hidden.length > 0 ? null : <div className="chat-stream-placeholder muted">…</div>
          ) : (
            shown.segments.map(renderSeg)
          )}
        </div>
      </div>
    </div>
  );
}
