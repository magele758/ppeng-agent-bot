import { ValidationError, NotFoundError } from '../errors.js';
import type { WebSettingsReadStore } from './web-settings.js';
import type { SqliteStateStore } from '../storage.js';
export interface ToolGroup {
    id: string;
    tier: number;
    labelZh: string;
    labelEn: string;
    tools: string[];
    extension?: boolean;
}
export const TOOL_GROUPS: ToolGroup[] = [
    {
        "id": "files",
        "tier": 1,
        "labelZh": "文件与工作区",
        "labelEn": "Files and workspace",
        "tools": [
            "read_file",
            "write_file",
            "edit_file",
            "grep_files",
            "glob_files",
            "workspace_list"
        ]
    },
    {
        "id": "execution",
        "tier": 1,
        "labelZh": "执行与产物",
        "labelEn": "Execution and artifacts",
        "tools": [
            "bash",
            "bg_run",
            "bg_check",
            "work_evidence",
            "spill_tool_result",
            "retrieve_tool_result",
            "read_artifact_page",
            "search_artifact_content"
        ]
    },
    {
        "id": "network",
        "tier": 1,
        "labelZh": "网络与视觉读取",
        "labelEn": "Web and vision",
        "tools": [
            "web_search",
            "web_fetch",
            "vision_analyze"
        ]
    },
    {
        "id": "memory",
        "tier": 1,
        "labelZh": "记忆与上下文",
        "labelEn": "Memory and context",
        "tools": [
            "memory_set",
            "memory_get",
            "memory_search",
            "memory_read",
            "memory_delete",
            "memory_prefetch",
            "save_user_info",
            "handoff_state",
            "record_summary",
            "compact_context",
            "history_search",
            "history_read"
        ]
    },
    {
        "id": "planning",
        "tier": 1,
        "labelZh": "计划、进度与用户交互",
        "labelEn": "Plans and progress",
        "tools": [
            "TodoWrite",
            "submit_plan",
            "request_confirmation",
            "confirm_plan",
            "start_step",
            "complete_step",
            "fail_step",
            "ask_user",
            "task_create",
            "task_get",
            "task_update",
            "task_list",
            "goal_checkpoint",
            "room_route_turn"
        ]
    },
    {
        "id": "discovery",
        "tier": 1,
        "labelZh": "技能与工具发现",
        "labelEn": "Skills and tool discovery",
        "tools": [
            "search_skills",
            "load_skill",
            "tool_search",
            "load_capability_tool"
        ]
    },
    {
        "id": "bot-contact",
        "tier": 1,
        "labelZh": "已有 Bot 的查找与通信",
        "labelEn": "Existing bot communication",
        "tools": [
            "bot_list",
            "bot_get",
            "message_agent",
            "ask_bot_help"
        ]
    },
    {
        "id": "app",
        "tier": 2,
        "labelZh": "本机应用操作",
        "labelEn": "Local applications",
        "tools": [
            "app_activate",
            "app_type_text",
            "app_keystroke"
        ]
    },
    {
        "id": "computer",
        "tier": 2,
        "labelZh": "电脑操作",
        "labelEn": "Computer use",
        "tools": [
            "lcu_js",
            "lcu_js_reset"
        ]
    },
    {
        "id": "team",
        "tier": 2,
        "labelZh": "团队协作",
        "labelEn": "Team collaboration",
        "tools": [
            "spawn_subagent",
            "spawn_teammate",
            "list_team",
            "send_message",
            "read_inbox",
            "bot_team_status",
            "bot_delegate",
            "bot_task_results",
            "external_agent_list",
            "external_agent_delegate",
            "external_agent_status",
            "external_agent_cancel",
            "external_agent_input"
        ]
    },
    {
        "id": "schedule",
        "tier": 2,
        "labelZh": "定时与发布",
        "labelEn": "Schedules and publishing",
        "tools": [
            "cron_create",
            "cron_list",
            "cron_remove",
            "cron_run_now",
            "cron_runs",
            "schedule_social_post"
        ]
    },
    {
        "id": "development",
        "tier": 2,
        "labelZh": "专业开发执行",
        "labelEn": "Development execution",
        "tools": [
            "lsp_request",
            "harness_write_spec",
            "ptc_exec"
        ]
    },
    {
        "id": "credentials",
        "tier": 2,
        "labelZh": "凭据收集",
        "labelEn": "Credential collection",
        "tools": [
            "collect_credentials",
            "secure_form"
        ]
    },
    {
        "id": "dynamic",
        "tier": 3,
        "labelZh": "动态工具与技能管理",
        "labelEn": "Dynamic tools and skills",
        "tools": [
            "save_as_tool",
            "propose_tool",
            "search_dyn_tools",
            "skill_manage",
            "skill_propose"
        ]
    },
    {
        "id": "factory",
        "tier": 3,
        "labelZh": "工厂",
        "labelEn": "Factory",
        "tools": [
            "factory_dispatch",
            "factory_status",
            "factory_settings_save",
            "factory_patrol_set",
            "factory_list_repos"
        ]
    },
    {
        "id": "bot-config",
        "tier": 3,
        "labelZh": "Bot 配置",
        "labelEn": "Bot configuration",
        "tools": [
            "bot_create",
            "create_bot",
            "bot_update",
            "bot_open",
            "bot_work_control_set",
            "bot_shared_context_get",
            "bot_shared_context_set"
        ]
    },
    {
        "id": "rooms",
        "tier": 3,
        "labelZh": "群聊管理与操作",
        "labelEn": "Rooms",
        "tools": [
            "bot_room_list",
            "bot_room_get",
            "bot_room_create",
            "create_room",
            "bot_room_update",
            "bot_room_add_member",
            "bot_room_remove_member",
            "bot_room_delete",
            "bot_room_messages",
            "bot_room_post",
            "bot_room_stop",
            "bot_room_resume"
        ]
    },
    {
        "id": "bot-groups",
        "tier": 3,
        "labelZh": "Bot 分组管理",
        "labelEn": "Bot groups",
        "tools": [
            "bot_group_list",
            "bot_group_create",
            "bot_group_rename",
            "bot_group_delete",
            "bot_group_assign"
        ]
    },
    {
        "id": "sessions",
        "tier": 3,
        "labelZh": "Lab 会话管理",
        "labelEn": "Session management",
        "tools": [
            "lab_session_list",
            "lab_session_create",
            "lab_session_update",
            "lab_session_delete"
        ]
    },
    {
        "id": "settings",
        "tier": 3,
        "labelZh": "Lab 设置与模型管理",
        "labelEn": "Settings and models",
        "tools": [
            "lab_settings_list",
            "lab_settings_get",
            "lab_settings_update",
            "lab_model_providers_list",
            "lab_model_provider_upsert",
            "lab_model_provider_delete",
            "lab_model_default_set"
        ]
    },
    {
        "id": "projects",
        "tier": 3,
        "labelZh": "项目与目标管理",
        "labelEn": "Projects and goals",
        "tools": [
            "lab_project_list",
            "lab_project_create",
            "lab_project_update",
            "lab_project_delete",
            "lab_goal_upsert",
            "lab_goal_list",
            "goal_dispatch"
        ]
    },
    {
        "id": "team-plans",
        "tier": 3,
        "labelZh": "团队计划与 Swarm 管理",
        "labelEn": "Team plans and swarms",
        "tools": [
            "lab_team_plan_list",
            "lab_team_plan_get",
            "lab_team_plan_create",
            "lab_team_plan_start",
            "lab_team_plan_resume",
            "lab_swarm_run_list",
            "lab_swarm_run_create",
            "lab_swarm_run_start"
        ]
    },
    {
        "id": "research",
        "tier": 3,
        "labelZh": "研究与编排管理",
        "labelEn": "Research and orchestration",
        "tools": [
            "lab_research_task_list",
            "lab_research_task_create",
            "lab_research_task_update",
            "lab_orchestration_run_list",
            "lab_orchestration_run_create",
            "lab_orchestration_run_status"
        ]
    },
    {
        "id": "external",
        "tier": 3,
        "labelZh": "外部服务发现",
        "labelEn": "External service discovery",
        "tools": [
            "tailscale_list_devices",
            "tailscale_get_device"
        ]
    },
    {
        "id": "pages",
        "tier": 1,
        "labelZh": "库级页面",
        "labelEn": "Library pages",
        "tools": [
            "list_pages",
            "get_page",
            "write_page",
            "edit_page",
            "rotate_page_share",
            "delete_page"
        ],
        "extension": true
    },
    {
        "id": "vault",
        "tier": 2,
        "labelZh": "用户保险库填表",
        "labelEn": "User Vault form fill",
        "tools": [
            "vault_list",
            "vault_get",
            "vault_fill"
        ],
        "extension": true
    },
    {
        "id": "browser",
        "tier": 2,
        "labelZh": "浏览器",
        "labelEn": "Browser",
        "tools": [
            "browser_navigate",
            "browser_snapshot",
            "browser_screenshot",
            "browser_click",
            "browser_type"
        ],
        "extension": true
    },
    {
        "id": "external-ai",
        "tier": 2,
        "labelZh": "外部编程助手",
        "labelEn": "External coding assistants",
        "tools": [
            "claude_code",
            "codex_exec",
            "cursor_agent"
        ],
        "extension": true
    },
    {
        "id": "stock",
        "tier": 3,
        "labelZh": "股票",
        "labelEn": "Stocks",
        "tools": [
            "quote_get",
            "fundamentals_get",
            "news_search"
        ],
        "extension": true
    },
    {
        "id": "sre",
        "tier": 3,
        "labelZh": "SRE",
        "labelEn": "SRE",
        "tools": [
            "prom_query",
            "loki_query",
            "k8s_get",
            "pagerduty_list"
        ],
        "extension": true
    },
    {
        "id": "tailscale-ops",
        "tier": 3,
        "labelZh": "Tailscale 运维",
        "labelEn": "Tailscale operations",
        "tools": [
            "tailscale_ping",
            "tailscale_ssh"
        ],
        "extension": true
    }
];
export const TOOL_EXPOSURE_KEY = 'tool_exposure_settings';
export interface ToolExposureSettings {
    mode: 'progressive' | 'full';
    pinnedGroups: Record<string, string[]>;
}
export function toolGroup(name: string): ToolGroup {
    return TOOL_GROUPS.find(g => g.tools.includes(name)) ?? { id: 'extensions', tier: 3, labelZh: '未分类扩展', labelEn: 'Unclassified extensions', tools: [] };
}
export function readToolExposure(store?: WebSettingsReadStore): ToolExposureSettings {
    const raw = store?.getDaemonControl?.(TOOL_EXPOSURE_KEY) as Partial<ToolExposureSettings> | undefined;
    return { mode: raw?.mode === 'full' ? 'full' : 'progressive', pinnedGroups: raw?.pinnedGroups ?? {} };
}
export function writeToolExposure(store: Pick<SqliteStateStore, 'getDaemonControl' | 'setDaemonControl'>, patch: {
    mode?: unknown;
    agentId?: unknown;
    groups?: unknown;
}): ToolExposureSettings {
    const next = readToolExposure(store);
    if (patch.mode !== undefined) {
        if (patch.mode !== 'full' && patch.mode !== 'progressive')
            throw new ValidationError('Invalid tool delivery mode');
        next.mode = patch.mode;
    }
    if (patch.groups !== undefined) {
        if (typeof patch.agentId !== 'string' || !patch.agentId.trim() || ['__proto__', 'constructor', 'prototype'].includes(patch.agentId))
            throw new ValidationError('agentId required');
        if (!Array.isArray(patch.groups) || !patch.groups.every(g => typeof g === 'string' && (g === 'extensions' || TOOL_GROUPS.some(x => x.id === g))))
            throw new ValidationError('Invalid capability groups');
        next.pinnedGroups = { ...next.pinnedGroups, [patch.agentId]: [...new Set(patch.groups)] };
    }
    store.setDaemonControl(TOOL_EXPOSURE_KEY, next);
    return next;
}
export function clearToolExposure(store: Pick<SqliteStateStore, 'getSession' | 'updateSession'>, sessionId: string): void {
    const session = store.getSession(sessionId);
    if (!session)
        throw new NotFoundError('Session', sessionId);
    store.updateSession(sessionId, { metadata: { ...session.metadata, disclosedToolNames: [] } });
}
export function toolDirectory(store?: WebSettingsReadStore): string {
    if (readToolExposure(store).mode === 'full')
        return 'All currently authorized tools are provided directly. Do not search or load tools.';
    return 'Tool delivery is progressive. Daily tools are provided directly. Search other capabilities with tool_search; matching tools are loaded automatically (up to 5), callable next turn. Never execute tools absent from the current tools list. Capability groups: ' + TOOL_GROUPS.filter(g => g.tier > 1).map(g => g.id + ': ' + g.labelEn + ' / ' + g.labelZh).join('; ') + '; extensions: unclassified registered tools. Availability still depends on permissions and configuration.';
}
