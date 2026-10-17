"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { mergeHistoryWindow, prependHistoryPage } from "@/lib/history-window";
import type { BotInfo } from "@/lib/types";
import { api, json, useAction, Feedback, Result, Status } from "./shared";
type Room = {
  id: string;
  title: string;
  botIds: string[];
  hostBotId: string;
  maxBotTurns: number;
  maxToolCalls: number;
  maxCostUsd: number;
  status: string;
};
type Turn={id:string;status:string;botTurns:number;maxBotTurns:number;toolCalls?:number;costUsd?:number;costStatus?:string;terminationReason?:string;partialResult?:unknown};
type Message = {
  id: string;
  seq: number;
  sender: { name: string };
  text: string;
  attachmentIds: string[];
};
export function BotRooms({ bots }: { bots: BotInfo[] }) {
  const { t } = useI18n();
  const action = useAction();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [host, setHost] = useState("");
  const [budget, setBudget] = useState(8);
  const [maxToolCalls, setMaxToolCalls] = useState(100);
  const [maxCostUsd, setMaxCostUsd] = useState(1);
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [attachments, setAttachments] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const roomIdRef = useRef<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const cursorRef = useRef<number | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [newMember, setNewMember] = useState("");
  const historyEpoch = useRef(0);
  const rememberCursor = (next: number | null) => {
    cursorRef.current = next;
    setCursor(next);
  };
  const load = async () => {
    const data = (await api("/api/bot-rooms")) as { rooms: Room[] };
    setRooms(data.rooms);
  };
  const open = async (r: Room, older = false) => {
    if (roomIdRef.current !== r.id) {
      roomIdRef.current = r.id;
      setText(""); setMentions([]); setAttachments(""); setNewMember("");
      messagesRef.current = []; setMessages([]); rememberCursor(null); setTurns([]);
    }
    setRoom(r);
    const base = `/api/bot-rooms/${r.id}`;
    const beforeSeq = older ? cursorRef.current : null;
    const epoch = ++historyEpoch.current;
    const [data, status] = (await Promise.all([
      api(
        `${base}/messages?limit=50${beforeSeq != null ? `&beforeSeq=${beforeSeq}` : ""}`,
      ),
      api(`${base}/turns`),
    ])) as [
      { messages: Message[]; nextCursor: number | null; hasMore: boolean },
      { turns: Turn[] },
    ];
    if (roomIdRef.current !== r.id || epoch !== historyEpoch.current) return;
    const nextMessages = older ? prependHistoryPage(messagesRef.current, data.messages) : data.messages;
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    rememberCursor(data.hasMore ? data.nextCursor : null);
    setTurns(status.turns);
  };
  useEffect(() => {
    void action.run(load);
  }, []);
  useEffect(() => {
    if (!room) return;
    let active = true;
    const timer = setInterval(() => {
      const epoch = historyEpoch.current;
      void Promise.all([
        api(`/api/bot-rooms/${room.id}/messages?limit=50`),
        api(`/api/bot-rooms/${room.id}/turns`),
        api(`/api/bot-rooms/${room.id}`),
      ])
        .then(([history, status, current]) => {
          if (!active || roomIdRef.current !== room.id || epoch !== historyEpoch.current) return;
          const page = history as { messages: Message[]; hasMore: boolean; nextCursor: number | null };
          const merged = mergeHistoryWindow(messagesRef.current, page.messages, true);
          messagesRef.current = merged.messages;
          setMessages(merged.messages);
          // A disjoint tail means a page was skipped. The tail cursor only reaches
          // that page; the next older read has to start at the oldest row still shown.
          if (merged.reset) {
            const oldest = merged.messages[0]?.seq;
            rememberCursor(oldest != null && oldest > 1 ? oldest : page.hasMore ? page.nextCursor : null);
          }
          setTurns((status as { turns: Turn[] }).turns);
          setRoom(prev=>prev?{...prev,status:(current as {room:Room}).room.status,botIds:(current as {room:Room}).room.botIds}:(current as {room:Room}).room);
        })
        .catch(() => {});
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [room?.id]);
  const modify = async (path: string, init: RequestInit) => {
    if (!room) return;
    const data = (await api(`/api/bot-rooms/${room.id}${path}`, init)) as {
      room: Room;
    };
    await open(data.room);
    await load();
  };
  return (
    <section className="ag-panel" data-testid="bot-rooms">
      <h3>{t("botWork.rooms")}</h3>
      <Feedback {...action} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const data = (await api(
              "/api/bot-rooms",
              json({
                title,
                botIds: members,
                hostBotId: host || members[0],
                maxBotTurns: budget,
                maxToolCalls,
                maxCostUsd,
              }),
            )) as { room: Room };
            await load();
            await open(data.room);
            setTitle("");
          });
        }}
      >
        <label>
          {t("botWork.title")}
          <input
            data-testid="room-title"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          {t("botWork.members")}
          <select
            data-testid="room-members"
            multiple
            required
            value={members}
            onChange={(e) =>
              setMembers(Array.from(e.target.selectedOptions, (o) => o.value))
            }
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <details>
          <summary>{t("agents.common.advanced")}</summary>
          <label>
            {t("botWork.host")}
            <select value={host} onChange={(e) => setHost(e.target.value)}>
              <option value="">{t("botWork.notSelected")}</option>
              {bots
                .filter((b) => members.includes(b.id))
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {t("botWork.budget")}
            <input
              type="number"
              min={1}
              max={20}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
            />
          </label>
          <label>
            {t("botWork.maxToolCalls")}
            <input
              type="number"
              min={1}
              max={10000}
              value={maxToolCalls}
              onChange={(e) => setMaxToolCalls(Number(e.target.value))}
            />
          </label>
          <label>
            {t("botWork.maxCostUsd")}
            <input
              type="number"
              min={0.001}
              max={1000}
              step="any"
              value={maxCostUsd}
              onChange={(e) => setMaxCostUsd(Number(e.target.value))}
            />
          </label>
        </details>
        <button
          data-testid="room-create"
          disabled={action.busy || !members.length}
        >
          {t("botWork.create")}
        </button>
      </form>
      <nav>
        {rooms.map((r) => (
          <button
            key={r.id}
            disabled={action.busy}
            onClick={() => void action.run(() => open(r))}
          >
            {r.title}
          </button>
        ))}
      </nav>
      {!rooms.length && !action.busy && <p>{t("botWork.empty")}</p>}
      {room && (
        <div>
          <h4 data-testid="room-selected-title">{room.title}</h4>
          <label>{t('botWork.title')}<input value={room.title} onChange={e=>setRoom({...room,title:e.target.value})}/></label>
          <label>{t('botWork.host')}<select value={room.hostBotId} onChange={e=>setRoom({...room,hostBotId:e.target.value})}>{room.botIds.map(id=><option key={id} value={id}>{bots.find(b=>b.id===id)?.name??id}</option>)}</select></label>
          <p data-testid="room-status">
            <Status value={room.status} />
          </p>
          <button
            disabled={action.busy}
            onClick={() => void action.run(() => open(room))}
          >
            {t("botWork.refresh")}
          </button>
          <button
            data-testid="room-stop"
            disabled={action.busy}
            onClick={() =>
              void action.run(() => modify("/stop", { method: "POST" }))
            }
          >
            {t("botWork.stop")}
          </button>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(() => modify("/resume", { method: "POST" }))
            }
          >
            {t("botWork.resume")}
          </button>
          <label>
            {t("botWork.budget")}
            <input
              type="number"
              min={1}
              max={20}
              value={room.maxBotTurns}
              onChange={(e) =>
                setRoom({ ...room, maxBotTurns: Number(e.target.value) })
              }
            />
          </label>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(() =>
                modify(
                  "",
                  json(
                    {
                      title:room.title,hostBotId:room.hostBotId,maxBotTurns: room.maxBotTurns,
                      maxToolCalls: room.maxToolCalls,
                      maxCostUsd: room.maxCostUsd,
                    },
                    "PATCH",
                  ),
                ),
              )
            }
          >
            {t("botWork.save")}
          </button>
          <label>
            {t("botWork.maxToolCalls")}
            <input
              type="number"
              min={1}
              max={10000}
              value={room.maxToolCalls ?? 100}
              onChange={(e) =>
                setRoom({ ...room, maxToolCalls: Number(e.target.value) })
              }
            />
          </label>
          <label>
            {t("botWork.maxCostUsd")}
            <input
              type="number"
              min={0.001}
              max={1000}
              step="any"
              value={room.maxCostUsd ?? 1}
              onChange={(e) =>
                setRoom({ ...room, maxCostUsd: Number(e.target.value) })
              }
            />
          </label>
          <ul>
            {room.botIds.map((id) => (
              <li role="presentation" key={id}>
                {bots.find((b) => b.id === id)?.name ?? id}
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      modify(`/members/${encodeURIComponent(id)}`, {
                        method: "DELETE",
                      }),
                    )
                  }
                >
                  {t("botWork.remove")}
                </button>
              </li>
            ))}
          </ul>
          <select
            aria-label={t("botWork.members")}
            value={newMember}
            onChange={(e) => setNewMember(e.target.value)}
          >
            <option value="">{t("botWork.notSelected")}</option>
            {bots
              .filter((b) => !room.botIds.includes(b.id))
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
          <button
            disabled={action.busy || !newMember}
            onClick={() =>
              void action.run(() =>
                modify("/members", json({ botId: newMember })),
              )
            }
          >
            {t("botWork.save")}
          </button>
          {cursor != null && (
            <button
              disabled={action.busy}
              onClick={() => void action.run(() => open(room, true))}
            >
              {t("botWork.older")}
            </button>
          )}
          <div role="log" style={{ maxHeight: 400, overflow: "auto" }}>
            {messages.map((m) => (
              <article key={m.id}>
                <strong>{m.sender.name}</strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{m.text}</p>
                {m.attachmentIds?.length > 0 && (
                  <Result value={m.attachmentIds} />
                )}
              </article>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const submitted = text;
              setText("");
              void action.run(async () => {
                try {
                  await api(
                    `/api/bot-rooms/${room.id}/messages`,
                    json({
                      text: submitted,
                      ...(mentions.length ? { mentions } : {}),
                      attachmentIds: attachments
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                      idempotencyKey: crypto.randomUUID(),
                    }),
                  );
                  await open(room);
                } catch (error) {
                  setText(submitted);
                  throw error;
                }
              });
            }}
          >
            <label>
              {t("botWork.message")}
              <textarea
                required
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <label>
              {t("botWork.mentions")}
              <select
                multiple
                value={mentions}
                onChange={(e) =>
                  setMentions(
                    Array.from(e.target.selectedOptions, (o) => o.value),
                  )
                }
              >
                {room.botIds.map((id) => (
                  <option key={id} value={id}>
                    {bots.find((b) => b.id === id)?.name ?? id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("botWork.attachments")}
              <input
                value={attachments}
                onChange={(e) => setAttachments(e.target.value)}
              />
            </label>
            <button disabled={action.busy || room.status !== "active"}>
              {t("botWork.send")}
            </button>
          </form>
          <h4>{t("botWork.queue")}</h4>
          {turns.map(turn=><article key={turn.id}><Status value={turn.status}/><p>{t('botWork.turnProgress')}: {turn.botTurns}/{turn.maxBotTurns}</p><p>{turn.costStatus==='estimated'?`${t('botWork.costEstimate')}: ${turn.costUsd??0}`:t('botWork.costUnknown')}</p>{turn.terminationReason&&<p>{t('botWork.termination')}: {['members_completed','budget','tool_budget','cost_budget','external_effect_unconfirmed','interrupted_requires_review','user_abort','member_execution_failed'].includes(turn.terminationReason)?t(`botWork.reasons.${turn.terminationReason}` as MessageKey):t('botWork.states.unknown')}</p>}<Result value={turn.partialResult}/></article>)}
        </div>
      )}
    </section>
  );
}
