import type { Messages } from '../types.ts';

export const settingsEntries = {
  computerUse: {"title": "Local computer use (LCU)", "desc": "Let agents use local desktop apps. Requires LCU and ChatGPT; you decide app access.", "keywords": "LCU desktop computer use screenshot TextEdit", "enabled": "Enable local computer use", "hint": "Disabling hides desktop tools. Conversations have independent approvals; desktop turns are queued. Browser and audio are not enabled."},
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
    keywords: 'default mode task mode taskmode skill scope interrupt steer message while running loop',
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
      }
    }
  },
  agentLoopEngine: {
    title: 'Agent engine',
    keywords: 'kernel assembly preset drain tool launch inbox overflow cap low level scheduling',
    desc: 'Low-level scheduling options. Most people never need them; a wrong value can make interrupts and tool execution behave unpredictably.',
    fields: {
      drain: {
        label: 'Skip not-yet-started tools on interrupt',
        hint: 'When on, sequential tools that have not started yet are skipped when you interrupt, so the model sees your message sooner. Tools already running are unaffected.'
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
    desc: 'How commands run by the agent are kept apart from your computer, so they cannot read secrets or damage files by mistake. Saved changes apply immediately.',
    fields: {
      mode: {
        label: 'Isolation mode',
        hint: 'Keep "Auto" unless you are troubleshooting or using a remote sandbox.'
      }
    },
    options: {
      mode: {
        auto: { label: 'Auto', desc: 'Recommended. Picks the strongest isolation your machine supports; falls back to scrubbing environment variables only.' },
        os: { label: 'OS-level isolation', desc: 'Uses seatbelt on macOS and bwrap on Linux; commands cannot read key folders such as ~/.ssh.' },
        direct: { label: 'Run directly (no isolation)', desc: 'Only scrubs environment variables; commands have the same permissions as this service.' },
        container: { label: 'Container', desc: 'Not implemented on this machine yet; it actually runs directly.' },
        'cloudflare-computer': { label: 'Cloudflare remote sandbox', desc: 'Sends commands to the Cloudflare Computer you configure. Fill in the connection under "Sandbox · Cloudflare connection".' }
      }
    },
    risk: {
      direct: '"Run directly" has no OS isolation (no isolation): commands can read and write everything this service can reach, including key folders. Use it only in a trusted environment.',
      container: 'Container mode is not implemented on this machine and actually runs directly, so there is no OS isolation (no isolation) either.'
    }
  },
  sandboxCloudflare: {
    title: 'Sandbox · Cloudflare connection',
    keywords: 'cloudflare remote sandbox endpoint token workspace account timeout secret vault',
    desc: 'Only used when the isolation mode is "Cloudflare remote sandbox". The token is not stored here; keep it in the secret vault.',
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
    title: 'Capability discovery',
    keywords: 'discovery probe allowlist tailscale active scan lan network scan port devices',
    desc: 'Let the agent discover external capabilities on your network (for example services on Tailscale devices). Everything is off by default.',
    fields: {
      enabled: { label: 'Enable capability discovery', hint: 'Master switch. When off, the other options have no effect.' },
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
        toolSelect: 'Tool selection: shorten the tool list within what is allowed',
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
