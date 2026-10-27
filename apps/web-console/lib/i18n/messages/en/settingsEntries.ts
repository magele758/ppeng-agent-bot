import type {
 Messages } from '../types.ts';

export const settingsEntries = {
  toolExposure: {
  "title": "Tool delivery",
  "keywords": "tools full progressive tiers search load",
  "desc": "Daily tools stay available; other capabilities load on demand. Full mode provides all permitted and configured business tools.",
  "mode": "Tool delivery",
  "progressive": "Progressive loading",
  "full": "All available tools",
  "discoveryHint": "External service discovery controls network service discovery separately. Turning it off does not change tool delivery.",
  "agent": "Agent for pinned groups",
  "pins": "Pinned capability groups (permissions unchanged)",
  "session": "Inspect session",
  "preview": "New session preview",
  "viewMode": "Current delivery mode",
  "registered": "Registered",
  "available": "Available",
  "provided": "Provided",
  "pending": "Pending load",
  "unavailable": "Unavailable",
  "details": "Tools and availability reasons",
  "tool": "Tool",
  "tier": "Tier",
  "state": "Status or reason",
  "not_configured": "Not configured",
  "disabled": "Disabled",
  "not_allowed": "Excluded by allowlist",
  "policy": "Policy restriction",
  "not_loaded": "Not loaded",
  "clear": "Clear temporary session loads",
  "refresh": "Refresh",
  "saved": "Saved; applies to the next model request",
  "error": "Operation failed. Please try again.",
  "modeReason": "Not applicable in this mode"
},

  computerUse: {"title": "Local computer use (LCU)", "desc": "Let agents use local desktop apps. Requires LCU and ChatGPT; you decide app access.", "keywords": "LCU desktop computer use screenshot TextEdit", "enabled": "Enable local computer use", "hint": "Disabling hides desktop tools. Conversations have independent approvals; desktop turns are queued. Browser and audio are not enabled."},
  appControl: {"title": "macOS app control", "desc": "Let an agent activate a named Mac app, type into the front app, or send a small set of keys. macOS only.", "keywords": "macOS app control Apple Events Automation keystroke", "enabled": "Enable macOS app control", "hint": "Off by default. The agent can only activate an app, type text, or send return, tab, escape, arrows, copy, and paste. Each action still needs Lab approval. The first use can show the normal macOS permission dialog; this switch does not grant that permission. Other operating systems report that the actions are unavailable."},
  common: {
    saved: 'Saved, takes effect immediately',
    save: 'Save',
    undo: 'Undo changes',
    unsaved: 'You have unsaved changes',
    restoreDefault: 'Restore default',
    restoreDefaultAria: 'Restore default: {name}',
    defaultValue: 'Default: {value}',
    invalidRange: 'Enter a whole number between {min}–{max}',
    loading: 'Loading settings…',
    loadFailed: 'Failed to load settings: {error}',
    retry: 'Retry',
    refresh: 'Refresh',
    on: 'On',
    off: 'Off',
    none: 'Not set',
    sourceUi: 'Saved in the UI',
    sourceDefault: 'Using defaults',
    sourceEnv: 'From environment variables (not saved in the UI yet)',
    effectiveNow: 'Currently in effect: {value}',
    keepSecret: 'Saved. Leave blank to keep it unchanged'
  },
  agentLoop: {
    title: 'Default chat behavior',
    keywords: 'default mode task mode taskmode skill scope interrupt steer message while running loop repeat detection weak model strong model file view',
    desc: 'What new chats start with, and what happens when you send another message while the agent is still working. Changes apply immediately, no restart needed.',
    fields: {
      taskMode: {
        label: 'Default task mode',
        hint: 'The working style new chats start with. You can still switch it from the chat composer.'
      },
      skillScope: {
        label: 'Default skill scope',
        hint: 'Which skills new chats may use by default.'
      },
      interrupt: {
        label: 'New message while working',
        hint: 'How to handle a new message you send while the agent is still on the previous one.'
      },
      repeatGuard: {
        label: 'Repeat detection',
        hint: 'By default this only stops weak models from repeating the same tools, or from browsing and searching files too many times. Strong models are not stopped by it. A saved choice applies on the next turn, with no restart. The sandbox, approvals, and sensitive-path refusal stay in place.'
      }
    },
    options: {
      taskMode: {
        auto: { label: 'Auto', desc: 'Picks as needed with all tools available. Fits most cases.' },
        fast: { label: 'Fast', desc: 'Less thinking, quicker replies. Good for simple questions.' },
        planner: { label: 'Planner', desc: 'Writes a plan first, then acts. Good for multi-step tasks.' },
        teams: { label: 'Teams', desc: 'Splits the work across several agents.' },
        deep_research: { label: 'Deep research', desc: 'Searches many sources and compiles findings. Takes longer.' },
        browser: { label: 'Browser', desc: 'Mostly browsing and operating web pages.' },
        computer: { label: 'Computer use', desc: 'Mostly operating the command line and desktop.' },
        dynamic_workflow: { label: 'Dynamic workflow', desc: 'Automatically orchestrates and runs several steps.' }
      },
      skillScope: {
        full: { label: 'All skills', desc: 'Every enabled skill is available on every turn.' },
        requested: { label: 'Only ticked this turn', desc: 'Only the skills you tick in the composer for this turn, which saves context.' }
      },
      interrupt: {
        queue: { label: 'Queue it', desc: 'Handle the new message after the current step finishes. The safest choice.' },
        steer: { label: 'Steer right away', desc: 'Change direction on the next step. A model request already in flight is not cancelled.' },
        disabled: { label: 'Do not accept', desc: 'Ignore new messages while the agent works; send again once it is done.' }
      },
      repeatGuard: {
        weak: { label: 'Weak models only', desc: 'Default. The local demo model and small models still stop when tools repeat or file views pile up. Common large models, and models that cannot be classified, do not.' },
        all: { label: 'All models', desc: 'Strong models also stop when tools repeat or file views pile up.' },
        off: { label: 'Off', desc: 'No model stops for repeated tools or file-view counts. Safety limits still apply.' }
      }
    }
  },
  agentLoopEngine: {
    title: 'Agent engine',
    keywords: 'kernel assembly preset drain tool launch inbox overflow cap low level scheduling',
    desc: 'Low-level scheduling options. Most people never need them; a wrong value can make interrupts and tool execution behave unpredictably.',
    fields: {
      drain: {
        label: 'Receive interjections before tools start',
        hint: 'Consume pending interjections before tools start while keeping tools running. Only an explicit stop or a direct conflict with your new request cancels the affected tools; the conversation continues.'
      },
      kernel: {
        label: 'Loop kernel',
        hint: 'Decides how each turn schedules the model and tools. ppeng core is only for comparison when troubleshooting.'
      },
      assembly: {
        label: 'Feature tier',
        hint: 'How many features the kernel assembles. Higher tiers are more capable and cost more.',
        ppengDisabled: 'Has no effect with the ppeng core kernel.'
      },
      inboxCap: {
        label: 'Message backlog limit',
        hint: 'When unhandled messages exceed this number, the oldest ones are folded into one summary so context does not blow up. Leave blank or 0 for no limit.',
        placeholder: 'No limit'
      }
    },
    options: {
      kernel: {
        'agent-loop': 'agent-loop (recommended)',
        ppeng: 'ppeng core (comparison)'
      },
      assembly: {
        mini: 'mini · minimal',
        normal: 'normal · standard',
        full: 'full · complete',
        max: 'max · everything'
      }
    },
    defaults: {
      kernel: 'agent-loop (recommended)',
      assembly: 'max · everything',
      inboxCap: 'No limit'
    }
  },
  sessionRecap: {
    title: 'Session recap',
    keywords: 'recap away return summary progress where I left off end of session',
    desc: 'When you leave a session for at least three minutes and come back, one line above the composer says where you left off: what you were doing, which files changed, and what is still open. It is only for you and is not sent to the assistant. Turning this off stops the automatic line. You can still recap on demand.',
    fields: {
      enabled: {
        label: 'Recap automatically when you come back',
        hint: 'On by default. The session needs at least three turns, and the same progress is not recapped twice in a row. It stays hidden while you are typing or a reply is still generating.'
      }
    }
  },
  inputSuggestion: {
    title: 'Next-message suggestion',
    keywords: 'input suggestion ghost text tab completion next message composer bot',
    desc: 'After a bot replies, the empty composer shows a faint guess of what you might type next. Tab accepts it, Esc dismisses it. Turn this off to stop generating guesses.',
    fields: {
      enabled: {
        label: 'Suggest the next message after a reply',
        hint: 'On by default. Shown only in a bot chat, while the composer is empty and focused. It never replaces text you already typed.'
      }
    }
  },
  compact: {
    title: 'Context compaction',
    keywords: 'compact compaction context too long window full oversized save tokens cost tool results collapse placeholder micro',
    desc: 'In long chats, tool output the model has already read is folded into a one-line placeholder to save context window. The full original stays in the session record.',
    fields: {
      policy: {
        label: 'When to fold already-read tool output',
        hint: 'Folding only changes what is sent to the model; nothing is deleted from the record.'
      },
      keepRecent: {
        label: 'Recent outputs kept in full',
        hint: 'With "Keep the latest few", this many recent tool outputs stay intact and older long ones are folded.'
      }
    },
    options: {
      policy: {
        keep_recent: { label: 'Keep the latest few', desc: 'Default: only older long tool outputs are folded; the latest few stay in full.' },
        after_text_assistant: { label: 'After the assistant writes text', desc: 'Fold once the assistant has replied in text; originals stay during consecutive tool calls.' },
        after_any_assistant: { label: 'Fold on the next turn', desc: 'Fold the previous turn tool output as soon as the assistant replies. Saves the most context.' }
      }
    },
    globalOff: 'Compaction is switched off system-wide, so the options below have no effect for now.'
  },
  goal: {
    title: 'Goals',
    keywords: 'goal completion condition gate done yet auto continue max turns attempts',
    desc: 'Let the agent work toward a clear finish condition. The system checks whether it is done and keeps trying if not.',
    fields: {
      enabled: {
        label: 'Enable goals',
        hint: 'When off, finish conditions set in a session no longer apply.'
      },
      maxTurns: {
        label: 'Default max attempts',
        hint: 'A goal stops after automatically continuing this many turns without finishing, to avoid endless spending.'
      }
    }
  },
  goalVerify: {
    title: 'Goals: automatic verification',
    keywords: 'verify verification http request url network access goal',
    desc: 'A goal can let the system check the result itself. This controls which verification methods are allowed.',
    fields: {
      http: {
        label: 'Allow verification by HTTP request',
        hint: 'When on, the agent may call URLs you specify to decide whether the goal is met. This makes outbound network requests.'
      }
    }
  },
  sandbox: {
    title: 'Command sandbox',
    keywords: 'sandbox bash isolation security no isolation direct bwrap seatbelt container command execution permissions secrets protection',
    desc: 'The isolation mode saved here constrains later commands, including ssh. Run directly does not use the OS sandbox. OS-level isolation, or Auto when a command does not drop it, still uses the OS sandbox, and the conversation says why. The OS sandbox still cannot read key folders.',
    fields: {
      mode: {
        label: 'Isolation mode',
        hint: 'Saving this constrains later shell commands immediately.'
      }
    },
    options: {
      mode: {
        auto: { label: 'Auto', desc: 'The agent can choose per command. An omitted choice uses the strongest isolation on this machine, so a command may still use the OS sandbox. It is not switched to a direct run for ssh.' },
        os: { label: 'OS-level isolation', desc: 'Uses seatbelt on macOS and bwrap on Linux; commands cannot read key folders such as ~/.ssh. After this is saved, one command cannot switch to a direct run, and the conversation says why.' },
        direct: { label: 'Run directly (no isolation)', desc: 'No OS sandbox, only environment scrubbing. The ssh client runs this way.' },
        container: { label: 'Container', desc: 'Not available. Saving this does not run the command, and does not switch it to a direct run or the OS sandbox.' },
        'cloudflare-computer': { label: 'Cloudflare remote sandbox', desc: 'Commands go to a connected remote computer. If it is not connected, the command does not run and is not pulled back to this machine.' }
      }
    },
    risk: {
      direct: 'No isolation means a command can read and write every file this service can reach, including key folders. This saved mode is what later shell commands use.',
      container: 'Container isolation is not available. Saving this does not run the command, and does not switch it to no isolation or the OS sandbox.'
    }
  },
  sandboxCloudflare: {
    title: 'Sandbox · Cloudflare connection',
    keywords: 'cloudflare remote sandbox endpoint token workspace account timeout secret vault',
    desc: 'Connection for a remote computer. When the isolation mode is Auto, the agent uses it by choosing remote for a command. When the saved mode is the remote sandbox, commands go here. If it is not connected, the command does not run and is not pulled back to this machine. The token is not stored here; keep it in the secret vault.',
    fields: {
      endpoint: { label: 'Service URL', hint: 'Where your Cloudflare Computer is deployed.' },
      workspace: { label: 'Workspace name', hint: 'Workspace used in the remote sandbox. Letters, digits, dots, underscores and hyphens only.' },
      account: { label: 'Account ID', hint: 'Optional Cloudflare account ID.' },
      timeout: { label: 'Per-command timeout (ms)', hint: 'A command running longer than this is terminated.' },
      backend: { label: 'Execution backend', hint: 'When not set, the remote service decides.' },
      tokenName: { label: 'Token secret name', hint: 'Name of the access token in the secret vault. Leave blank for the default name.' }
    },
    options: {
      backend: {
        none: 'Not set',
        'worker-shell': 'worker-shell',
        'container-shell': 'container-shell'
      }
    },
    token: {
      found: 'Token ready (source: {source}).',
      missing: 'No token found yet. Save one in the secret vault (PUT /api/secrets/{name}) or set an environment variable with the same name.'
    }
  },
  skills: {
    title: 'Skill loading',
    keywords: 'skill routing disclosure load_skill prompt list shortlist lazy full context',
    desc: 'With many skills, how many names and summaries go into the prompt each turn. Skill bodies are always loaded on demand.',
    fields: {
      disclosure: {
        label: 'How the skill list is shown to the model',
        hint: 'Affects context usage and how likely a skill is discovered.'
      }
    },
    options: {
      disclosure: {
        shortlist: { label: 'Pick by relevance', desc: 'Default. Lists only the skills most related to your message; the agent searches for others when needed.' },
        lazy: { label: 'Search on demand', desc: 'No list. The agent searches, then loads. Saves the most context but may miss a skill.' },
        full: { label: 'List everything', desc: 'Lists every skill name and summary. Most complete, uses the most context.' }
      }
    }
  },
  dynTools: {
    title: 'Dynamic tools',
    keywords: 'dynamic tools optional tool groups custom tools save reuse promote experimental',
    desc: 'Let the agent create, save and reuse small tools of its own during chats. Experimental and off by default.',
    fields: {
      enabled: { label: 'Enable dynamic tools', hint: 'When off, the options below have no effect.' },
      allowSave: { label: 'Allow saving as reusable tools', hint: 'The agent can keep a tool it wrote so later chats can use it too.' },
      allowPropose: { label: 'Allow suggesting new tools', hint: 'When the agent notices a repeated action, it may suggest turning it into a tool.' },
      allowPromote: { label: 'Allow promoting to project tools', hint: 'A promoted tool is usable in every session of the project, so its impact is wider.' },
      hydrateTopK: { label: 'Tools preloaded per turn', hint: 'At most this many of the most relevant dynamic tools are handed to the model up front.' },
      unusedTurns: { label: 'Turns unused before suggesting retirement', hint: 'Tools not used for this long are suggested for cleanup.' }
    },
    tuning: {
      title: 'Tuning',
      desc: 'Usually no need to change these.'
    },
    session: {
      title: 'Dynamic tools in the current session',
      desc: 'View and manage dynamic tools in the selected session.',
      noSession: 'Select a session in Chat first to list its dynamic tools here.',
      empty: 'This session has no dynamic tools yet.',
      status: 'Status: {status} · Scope: {scope}',
      retire: 'Retire',
      promoteLong: 'Promote to long-term',
      promoteProject: 'Promote to project',
      promotePending: 'Promotion requested, waiting for approval.'
    }
  },
  discovery: {
    title: 'External service discovery',
    keywords: 'discovery probe allowlist tailscale active scan lan network scan port devices',
    desc: 'Let the agent discover external capabilities on your network (for example services on Tailscale devices). The master switch is on by default; reading the device list and active scanning stay off by default.',
    fields: {
      enabled: { label: 'Enable external service discovery', hint: 'Controls external discovery only, on by default. Local tool search and tool delivery mode are independent.' },
      tailscale: { label: 'Read the Tailscale device list', hint: 'Fetch devices from the local Tailscale to find usable services.' },
      activeScan: { label: 'Allow active scanning', hint: 'Actively send probe requests to allowlisted hosts and ports.' },
      hosts: { label: 'Hosts allowed to be probed', hint: 'Comma separated, e.g. api.example.com.' },
      cidrs: { label: 'Networks allowed to be probed', hint: 'Comma separated, e.g. 100.64.0.0/10, 10.0.0.0/8.' }
    },
    allowlist: {
      title: 'Probe allowlist',
      desc: 'Probing only targets the hosts and networks listed here.'
    },
    risk: {
      activeScan: 'Active scanning sends probe requests to hosts and ports on the network and may trigger security alerts. Only enable it on networks you are allowed to scan.'
    },
    probe: 'Probe Tailscale now',
    probeDone: 'Probe finished: found {count}, source {source}'
  },
  connectors: {
    title: 'Connector grants',
    keywords: 'connector grant plugin domain secret authorization',
    desc: 'Each connector is granted on its own. Usage notes reach the model only after a grant. This list shows the name and whether it is granted.',
    empty: 'No connectors to grant.',
    granted: 'Granted',
    notGranted: 'Not granted',
    loadFailed: 'Could not load connectors'
  },
  langfuse: {
    title: 'Langfuse tracing',
    keywords: 'tracing trace langfuse observability monitoring logs call chain usage cost troubleshooting',
    desc: 'Send the call chain of every chat to Langfuse for review and troubleshooting. Keys are write-only and never shown again.',
    fields: {
      baseUrl: { label: 'Service URL', hint: 'Your Langfuse address, e.g. https://cloud.langfuse.com.', placeholder: 'https://cloud.langfuse.com' },
      publicKey: { label: 'Public key', hint: 'Create it in your Langfuse project settings.' },
      secretKey: { label: 'Secret key', hint: 'Write-only, never shown again.' },
      enabled: { label: 'Enable tracing', hint: 'New chats start reporting once on. The connection must be filled in and saved first.' }
    },
    probe: 'Test connection',
    probeOk: 'Connection OK.',
    probeFail: 'Connection failed. Check the URL and keys.',
    configured: 'Connection details are configured.',
    unconfigured: 'Connection details are not configured yet.'
  },
  jev: {
    enabledLabel: 'Enable evaluation',
    stateOff: 'Off — evaluation model is not called',
    stateNeedsConnection: 'On — connection setup required',
    stateNoPoints: 'On — no evaluation stages selected',
    stateActive: 'Evaluation connected',
    title: 'Jev evaluation',
    keywords: 'evaluation eval jev judge second opinion goal gate tool gate hook points review model',
    desc: 'Plug in an independent evaluation model (Jev) that gives a second opinion at key moments, such as deciding whether a goal is met or reviewing risky commands.',
    connection: {
      title: 'Connection',
      desc: 'Fill in and save the evaluation model connection before choosing which stages to enable.'
    },
    fields: {
      baseUrl: { label: 'Service URL', hint: 'API address of the evaluation model.', placeholder: 'https://jev.example.com/v1' },
      apiKey: { label: 'API key', hint: 'Write-only, never shown again.', placeholder: 'Enter the API key' },
      model: { label: 'Model name', hint: 'The model used for evaluation.' },
      profile: { label: 'Which stages are enabled', hint: 'Pick a preset tier, or choose "Custom" to toggle each stage.' }
    },
    probe: 'Test connection',
    probeOk: 'Connection OK.',
    probeFail: 'Connection failed. Check the URL and key.',
    configured: 'Connection saved. You can now choose the enabled stages.',
    unconfigured: 'Connection details are not configured yet.',
    needsEntry: 'Save the connection first to choose the enabled stages.',
    stages: {
      title: 'Enabled stages',
      desc: 'Decides which decisions the evaluation model takes part in.',
      custom: 'Tick the stages to take part in:',
      preset: 'Stages in this tier (read-only; choose "Custom" to adjust one by one):',
      empty: 'This tier does not insert any stage.',
      active: 'Currently active: {points}'
    },
    options: {
      profile: {
        off: 'Off',
        mini: 'Minimal (no stages)',
        normal: 'Standard (goal gate only)',
        full: 'Complete (goal gate + tool gate)',
        max: 'Everything (goal gate + tool gate + compaction + routing)',
        custom: 'Custom'
      },
      points: {
        goalGate: 'Goal gate: decide whether the goal is met',
        toolGate: 'Tool gate: review commands and external CLIs',
        compact: 'Compaction: trim long successful tool output',
        route: 'Routing: more tools needed, done, or retry',
        contextSelect: 'Context selection: pick early snippets before compaction',
        toolSelect: 'Tool selection: legacy integration point; local chat respects tool delivery without a second reduction',
        skillSelect: 'Skill selection: filter the candidate skills again',
        sagaGate: 'Saga gate: helper only; the main loop does not ask once ticked',
        memorySelect: 'Memory selection: filter by relevance before injection',
        recoveryChoice: 'Recovery choice: pick among recovery actions',
        preTurn: 'Pre-turn check: skip the turn when the goal is already met',
        ptcDecide: 'PTC decisions: semantic branches inside scripts'
      }
    }
  },
  eventLog: {
    title: 'Event log (EventLog / Saga)',
    keywords: 'event log saga eventlog audit record replay trajectory trace back',
    desc: 'Record the key events of every session for auditing, troubleshooting and replay.',
    fields: {
      enabled: {
        label: 'Record the session event log',
        hint: 'When off, new events are no longer written; existing records are kept.'
      }
    }
  }
} satisfies Messages['settingsEntries'];
