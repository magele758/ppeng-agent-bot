import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createId, nowIso } from "../id.js";
import type { SkillSpec, ToolContract } from "../types.js";
import { filterSkillsByBot } from "../skills/bot-scope.js";
import { findSecretLikeContent, isValidSkillProposalName } from "./validate.js";
import { SkillProposalStore } from "./store.js";
import type { SkillCaptureService } from "./capture.js";

export type SkillAction =
  "create" | "update" | "share" | "unshare" | "set_sharing" | "delete";
export interface SkillManagementInput {
  action: SkillAction;
  skillId?: string;
  name?: string;
  description?: string;
  reason?: string;
  summary?: string;
  botIds?: string[];
  revision?: string;
}
export interface SkillOperation {
  id: string;
  sessionId: string;
  agentId: string;
  ownerBotId: string;
  input: SkillManagementInput;
  name: string;
  affectedBotIds: string[];
  revision: string;
  status: "pending" | "processing" | "saved" | "rejected" | "failed";
  authorization: "user" | "confirmation" | "pending";
  createdAt: string;
  updatedAt: string;
  error?: string;
  captureId?: string;
  requestKey?: string;
}
interface Deps {
  stateDir: string;
  captures: SkillCaptureService;
  listSkills(): Promise<SkillSpec[]>;
  getBotId(session: string): string | undefined;
  validateSharing(owner: string, ids: string[]): void;
  reloadSkills(): Promise<unknown>;
  authorize(session: string, input: SkillManagementInput): Promise<boolean>;
  requestKey?(session: string): string;
  listBots?(): Array<{ id: string; name: string }>;
}
export function skillRevision(skill?: SkillSpec): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        skill
          ? [skill.id, skill.content, skill.ownerBotId, skill.sharedBotIds]
          : null,
      ),
    )
    .digest("hex");
}
export class SkillManagementService {
  private directory: string;
  private requests = new Map<string, Promise<SkillOperation>>();
  private running = new Map<string, Promise<SkillOperation>>();
  private locked = new Set<string>();
  constructor(private deps: Deps) {
    this.directory = join(deps.stateDir, "skill-operations");
    for (const row of this.records().filter((r) => r.status === "processing")) {
      const captures = deps.captures.list(row.sessionId);
      const savedCapture =
        row.captureId &&
        captures.find((c) => c.id === row.captureId && c.status === "saved");
      const proposals = new SkillProposalStore(deps.stateDir);
      const own = proposals
        .list()
        .filter((p) => p.ownerBotId === row.ownerBotId && p.name === row.name);
      const installed = own.find(
        (p) => p.status === "approved" && proposals.isInstalled(p),
      );
      const ids = row.input.botIds ?? [];
      const applied =
        !!savedCapture ||
        (row.input.action === "delete" &&
          !installed &&
          own.some((p) => p.status === "revoked")) ||
        (!!installed &&
          row.input.action === "share" &&
          ids.every((id) => installed.sharedBotIds?.includes(id))) ||
        (!!installed &&
          row.input.action === "unshare" &&
          ids.every((id) => !installed.sharedBotIds?.includes(id))) ||
        (!!installed &&
          row.input.action === "set_sharing" &&
          JSON.stringify([...(installed.sharedBotIds ?? [])].sort()) ===
            JSON.stringify([...ids].sort()));
      this.write({
        ...row,
        status: applied ? "saved" : "failed",
        updatedAt: nowIso(),
        error: applied
          ? undefined
          : "Operation interrupted; inspect current state before retrying",
      });
    }
  }
  private write(row: SkillOperation) {
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, row.id + ".json");
    writeFileSync(path + ".tmp", JSON.stringify(row, null, 2), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  private records(): SkillOperation[] {
    try {
      return readdirSync(this.directory)
        .filter((f) => /^sm_[a-f0-9]{32}\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(join(this.directory, f), "utf8")));
    } catch {
      return [];
    }
  }
  listForBot(bot: string) {
    return this.records()
      .filter((r) => r.ownerBotId === bot)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async close() {
    await Promise.allSettled([
      ...this.running.values(),
      ...this.requests.values(),
    ]);
  }
  list(sessionId: string) {
    return this.records()
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private get(session: string, id: string) {
    const r = this.list(session).find((r) => r.id === id);
    if (!r) throw Error("Skill operation not found");
    return r;
  }
  async hasExplicitRequest(session: string, input: SkillManagementInput) {
    return this.deps.authorize(session, input);
  }
  recipientBots() {
    return this.deps.listBots?.() ?? [];
  }
  async catalog(session: string) {
    const bot = this.deps.getBotId(session);
    return filterSkillsByBot(await this.deps.listSkills(), bot).map((s) => ({
      ...s,
      canManage: !!bot && s.ownerBotId === bot,
      revision: skillRevision(s),
    }));
  }
  private async target(session: string, input: SkillManagementInput) {
    const bot = this.deps.getBotId(session);
    if (!bot) throw Error("A Bot context is required");
    const skills = await this.catalog(session);
    if (input.action === "create") {
      if (!input.name) throw Error("Skill name required");
      if (skills.some((s) => s.ownerBotId === bot && s.name === input.name))
        throw Error("Owned skill exists; use update with its exact ID");
      return undefined;
    }
    const found = skills.find((s) => s.id === input.skillId);
    if (!found || found.ownerBotId !== bot)
      throw Error(
        "Only own skills can be managed; shared skills are read-only",
      );
    return found;
  }
  request(
    session: string,
    agent: string,
    input: SkillManagementInput,
    authorization?: "user",
  ): Promise<SkillOperation> {
    const key = JSON.stringify([session, input, authorization]);
    const prior = this.requests.get(key);
    if (prior) return prior;
    const pending = this.requestInner(
      session,
      agent,
      input,
      authorization,
    ).finally(() => this.requests.delete(key));
    this.requests.set(key, pending);
    return pending;
  }
  private async requestInner(
    session: string,
    agent: string,
    input: SkillManagementInput,
    authorization?: "user",
  ): Promise<SkillOperation> {
    if ("body" in input) throw Error("Submit intent only, not a skill body");
    if (JSON.stringify(input).length > 6000)
      throw Error("Skill operation is too large");
    if (findSecretLikeContent(JSON.stringify(input)))
      throw Error("Possible secret in skill operation");
    if (input.action === "create" && !isValidSkillProposalName(input.name))
      throw Error("Invalid skill name");
    if (
      ![
        "create",
        "update",
        "share",
        "unshare",
        "set_sharing",
        "delete",
      ].includes(input.action)
    )
      throw Error("Unknown skill operation");
    const owner = this.deps.getBotId(session);
    if (!owner) throw Error("A Bot context is required");
    const requestKey = this.deps.requestKey?.(session);
    const previous = this.list(session).find(
      (r) =>
        JSON.stringify(r.input) === JSON.stringify(input) &&
        (r.status === "pending" ||
          r.status === "processing" ||
          (!!requestKey &&
            r.requestKey === requestKey &&
            r.status === "saved")),
    );
    if (previous) {
      if (
        previous.status === "pending" &&
        requestKey &&
        previous.requestKey !== requestKey &&
        (await this.deps.authorize(session, { ...input, name: previous.name })) && requestKey === this.deps.requestKey?.(session)
      )
        return this.confirm(session, previous.id, "user");
      return previous;
    }
    const skill = await this.target(session, input);
    if (input.revision && input.revision !== skillRevision(skill))
      throw Error("Skill changed; refresh before editing");
    if (["share", "unshare", "set_sharing"].includes(input.action)) {
      if (
        !Array.isArray(input.botIds) ||
        input.botIds.some((id) => typeof id !== "string")
      )
        throw Error("Explicit recipient IDs required");
      this.deps.validateSharing(owner, input.botIds);
    }
    if (
      ["create", "update"].includes(input.action) &&
      (!input.summary || !input.reason || !input.description)
    )
      throw Error("Description, reason and summary required");
    const verified =
      authorization === "user" ||
      (await this.deps.authorize(session, {
        ...input,
        name: skill?.name ?? input.name,
      }));
    const allowed =
      verified &&
      (!requestKey || requestKey === this.deps.requestKey?.(session));
    const row: SkillOperation = {
      id: createId("sm"),
      sessionId: session,
      agentId: agent,
      ownerBotId: owner,
      input,
      name: skill?.name ?? input.name!,
      affectedBotIds: [
        owner,
        ...new Set([...(skill?.sharedBotIds ?? []), ...(input.botIds ?? [])]),
      ],
      revision: skillRevision(skill),
      status: "pending",
      authorization: allowed ? "user" : "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      requestKey,
    };
    this.write(row);
    return allowed ? this.confirm(session, row.id, "user") : row;
  }
  reject(session: string, id: string) {
    const row = this.get(session, id);
    if (row.status === "rejected") return row;
    if (row.status !== "pending")
      throw Error("Only pending operations can be rejected");
    const next = { ...row, status: "rejected" as const, updatedAt: nowIso() };
    this.write(next);
    return next;
  }
  async confirm(
    session: string,
    id: string,
    authorization: "confirmation" | "user" = "confirmation",
  ): Promise<SkillOperation> {
    const inFlight = this.running.get(id);
    if (inFlight) return inFlight;
    const row = this.get(session, id);
    if (row.status !== "pending") return row;
    const key = JSON.stringify([row.ownerBotId, row.name]);
    if (this.locked.has(key))
      throw Error("Skill is being updated; retry later");
    this.locked.add(key);
    const work = this.execute({ ...row, authorization }).finally(() => {
      this.running.delete(id);
      this.locked.delete(key);
    });
    this.running.set(id, work);
    return work;
  }
  private async execute(row: SkillOperation): Promise<SkillOperation> {
    try {
      if (this.deps.getBotId(row.sessionId) !== row.ownerBotId)
        throw Error("Bot context changed; request a new decision");
      await this.deps.reloadSkills();
      const skill = await this.target(row.sessionId, row.input);
      if (skillRevision(skill) !== row.revision)
        throw Error("Skill or sharing changed; request a new decision");
      row = { ...row, status: "processing", updatedAt: nowIso() };
      this.write(row);
      if (row.input.action === "create" || row.input.action === "update") {
        const capture = await this.deps.captures.suggest(
          row.sessionId,
          row.agentId,
          {
            name: row.name,
            targetSkillId: skill?.id,
            description: row.input.description!,
            reason: row.input.reason!,
            summary: row.input.summary!,
          },
          { requestKey: row.id },
        );
        row.captureId = capture.id;
        this.write(row);
        const result = await this.deps.captures.confirm(
          row.sessionId,
          capture.id,
        );
        if (result.status !== "saved")
          throw Error(result.error ?? "Capture was not saved");
      } else {
        const store = new SkillProposalStore(this.deps.stateDir);
        const p = store
          .list({ status: "approved" })
          .find(
            (p) =>
              p.ownerBotId === row.ownerBotId &&
              p.name === row.name &&
              store.isInstalled(p),
          );
        if (!p) throw Error("Installed owned proposal not found");
        if (row.input.action === "delete") {
          const result = store.revoke(p.id);
          if (result.outcome === "foreign")
            throw Error("Skill changed; no file removed");
        } else {
          const ids = row.input.botIds!;
          const recipients =
            row.input.action === "share"
              ? [...new Set([...(skill?.sharedBotIds ?? []), ...ids])]
              : row.input.action === "unshare"
                ? (skill?.sharedBotIds ?? []).filter((id) => !ids.includes(id))
                : ids;
          store.setSharing(
            p.id,
            row.ownerBotId,
            recipients,
            this.deps.validateSharing,
          );
        }
      }
      row = { ...row, status: "saved", updatedAt: nowIso() };
      this.write(row);
      await this.deps.reloadSkills();
      return row;
    } catch (e) {
      if (row.status === "saved") return row;
      const failed = {
        ...row,
        status: "failed" as const,
        error: e instanceof Error ? e.message : String(e),
        updatedAt: nowIso(),
      };
      this.write(failed);
      return failed;
    }
  }
}
export function createSkillManageTool(
  service: SkillManagementService,
): ToolContract<Record<string, unknown>> {
  return {
    name: "skill_manage",
    description:
      "List accessible skills and manage skills owned by this Bot. Actions: list, create, update, share, unshare, delete. List supports query, offset and limit (default 20, max 50); it returns summaries, not bodies. Use exact skill IDs and Bot recipient IDs. User-directed operations execute automatically after runtime authorization verification; autonomous changes show one confirmation card then execute automatically. Submit intent/changes for create/update, never a body. Public and received skills are read-only. Do not use filesystem or shell tools to bypass this workflow.",
    approvalMode: "never",
    sideEffectLevel: "workspace",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "update", "share", "unshare", "delete"],
        },
        query: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        skillId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        reason: { type: "string" },
        summary: { type: "string" },
        botIds: { type: "array", items: { type: "string" } },
      },
      required: ["action"],
    },
    async execute(ctx, args) {
      try {
        if (args.action === "list") {
          const query =
            typeof args.query === "string" ? args.query.toLowerCase() : "";
          const offset =
            typeof args.offset === "number" && Number.isFinite(args.offset)
              ? Math.max(0, Math.floor(args.offset))
              : 0;
          const limit =
            typeof args.limit === "number" && Number.isFinite(args.limit)
              ? Math.max(1, Math.min(50, Math.floor(args.limit)))
              : 20;
          const catalog = (await service.catalog(ctx.session.id))
            .filter((s) =>
              (s.name + " " + s.description).toLowerCase().includes(query),
            )
            .sort(
              (a, b) =>
                Number(b.canManage) - Number(a.canManage) ||
                a.name.localeCompare(b.name) ||
                a.id.localeCompare(b.id),
            );
          return {
            ok: true,
            content: JSON.stringify({
              bots: service.recipientBots(),
              total: catalog.length,
              offset,
              nextOffset:
                offset + limit < catalog.length ? offset + limit : undefined,
              skills: catalog
                .slice(offset, offset + limit)
                .map((s) => ({
                  id: s.id,
                  name: s.name,
                  description: s.description,
                  source: s.source,
                  ownerBotId: s.ownerBotId,
                  sharedBotIds: s.sharedBotIds,
                  canManage: s.canManage,
                })),
            }),
          };
        }
        const result = await service.request(
          ctx.session.id,
          ctx.agent.id,
          args as unknown as SkillManagementInput,
        );
        return {
          ok: !("status" in result && result.status === "failed"),
          content: JSON.stringify(result),
        };
      } catch (e) {
        return {
          ok: false,
          content: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
