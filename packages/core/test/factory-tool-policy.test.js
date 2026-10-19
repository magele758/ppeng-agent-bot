import test from "node:test";
import assert from "node:assert/strict";
import { filterFactoryTools } from "../src/factory/tool-policy.ts";

const READONLY_OPS = ["snapshot", "count-files", "read-log"];

function settings(overrides = {}) {
  return {
    roomId: "room-factory",
    coordinatorBotId: "super-bot",
    machines: [
      {
        id: "u0",
        botIds: ["worker-bot"],
        sshAlias: "ubuntu0",
        repositories: [{ id: "core", path: "/repo/core" }],
      },
    ],
    patrol: { enabled: false, timezone: "Asia/Shanghai" },
    ...overrides,
  };
}

function storeFor(settingsRow, options = {}) {
  const userId = options.userId ?? "owner";
  const tenantId = options.tenantId ?? "team";
  const key = "factory.settings:" + JSON.stringify([tenantId, userId]);
  const values = { [key]: settingsRow };
  if (options.installationPrincipal) {
    values["bot.installationPrincipal"] = options.installationPrincipal;
  }
  return {
    getDaemonControl(name) {
      return values[name];
    },
  };
}

function tool(name) {
  return { name };
}

const CATALOG = [
  tool("bash"),
  tool("bot_delegate"),
  tool("bot_room_create"),
  tool("lab_settings_update"),
  tool("lab_settings_list"),
  tool("write_file"),
  tool("ptc_exec"),
  tool("factory_status"),
  tool("factory_dispatch"),
  tool("factory_settings_save"),
  tool("factory_patrol_set"),
  tool("factory_list_repos"),
  tool("factory_shell"),
];

function names(tools) {
  return tools.map((item) => item.name);
}

const coordinator = {
  metadata: {
    userId: "owner",
    tenantId: "team",
    botId: "super-bot",
    roomId: "room-factory",
  },
};

test("coordinator can still change machines, repos, and patrol after factory settings apply [AC:superbot-factory-setup#AC-8]", () => {
  const store = storeFor(settings());
  assert.deepEqual(names(filterFactoryTools(coordinator, CATALOG, store)), [
    "factory_status",
    "factory_dispatch",
    "factory_settings_save",
    "factory_patrol_set",
    "factory_list_repos",
  ]);

  const privateChat = {
    metadata: { userId: "owner", tenantId: "team", botId: "super-bot" },
  };
  assert.deepEqual(names(filterFactoryTools(privateChat, CATALOG, store)), [
    "factory_status",
    "factory_dispatch",
    "factory_settings_save",
    "factory_patrol_set",
    "factory_list_repos",
  ]);

  const installation = {
    getDaemonControl(name) {
      if (name === "bot.installationPrincipal") return "installation:home";
      if (name === "factory.settings:" + JSON.stringify(["", "installation:home"])) {
        return settings();
      }
      return undefined;
    },
  };
  assert.deepEqual(
    names(filterFactoryTools({ metadata: { botId: "super-bot" } }, CATALOG, installation)),
    [
      "factory_status",
      "factory_dispatch",
      "factory_settings_save",
      "factory_patrol_set",
      "factory_list_repos",
    ],
  );

  const worker = {
    metadata: {
      userId: "owner",
      tenantId: "team",
      botId: "worker-bot",
      roomId: "room-factory",
    },
  };
  assert.deepEqual(names(filterFactoryTools(worker, CATALOG, store)), ["factory_status"]);

  const visitor = {
    metadata: { userId: "owner", tenantId: "team", roomId: "room-factory" },
  };
  assert.deepEqual(names(filterFactoryTools(visitor, CATALOG, store)), ["factory_status"]);
});

test("coordinator read-only trial cannot submit an arbitrary remote command [AC:superbot-factory-setup#AC-10]", () => {
  const dispatch = {
    name: "factory_dispatch",
    description: "Dispatch one factory task",
    inputSchema: {
      type: "object",
      properties: {
        machineId: { type: "string" },
        repositoryId: { type: "string" },
        operation: {
          type: "string",
          description: "Factory operation",
          enum: ["snapshot", "count-files", "read-log", "shell"],
        },
        command: { type: "string" },
        argv: { type: "array" },
        shell: { type: "string" },
        script: { type: "string" },
        remoteCommand: { type: "string" },
        cmd: { type: "string" },
      },
      required: ["machineId", "repositoryId", "operation", "command"],
      oneOf: [{ required: ["command"] }],
    },
  };
  const open = {
    name: "factory_dispatch",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "remote command" },
        command: { type: "string" },
      },
      required: ["operation", "command"],
    },
  };
  const store = storeFor(settings());
  const kept = filterFactoryTools(
    coordinator,
    [dispatch, open, tool("bash"), tool("bot_delegate"), tool("lab_settings_update"), tool("factory_shell")],
    store,
  );
  assert.deepEqual(names(kept), ["factory_dispatch", "factory_dispatch"]);
  for (const tool of kept) {
    assert.deepEqual(tool.inputSchema.properties.operation.enum, READONLY_OPS);
    for (const field of ["command", "argv", "shell", "script", "remoteCommand", "cmd"]) {
      assert.equal(tool.inputSchema.properties[field], undefined);
    }
    assert.equal(tool.inputSchema.oneOf, undefined);
    assert.ok(!tool.inputSchema.required.includes("command"));
  }
  assert.equal(kept[0].inputSchema.properties.machineId.type, "string");
  assert.equal(kept[0].inputSchema.properties.operation.description, "Factory operation");
  assert.deepEqual(kept[1].inputSchema.required, ["operation"]);
  assert.deepEqual(dispatch.inputSchema.properties.operation.enum, [
    "snapshot",
    "count-files",
    "read-log",
    "shell",
  ]);
  assert.equal(dispatch.inputSchema.properties.command.type, "string");
});

test("factory tool filter stays idle until settings name a room", () => {
  const store = storeFor(settings({ roomId: "" }));
  assert.deepEqual(names(filterFactoryTools(coordinator, CATALOG, store)), names(CATALOG));
  const outsider = {
    metadata: { userId: "owner", tenantId: "team", botId: "other-bot" },
  };
  assert.deepEqual(
    names(filterFactoryTools(outsider, CATALOG, storeFor(settings()))),
    names(CATALOG),
  );
  const sealed = {
    name: "factory_dispatch",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: [...READONLY_OPS] },
      },
      required: ["operation"],
    },
  };
  const passed = filterFactoryTools(coordinator, [sealed], storeFor(settings()));
  assert.equal(passed[0], sealed);
});
