import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMANDS,
  getCommandSuggestions,
  renderAvailableCommands,
  resolveCommandInput,
} from "../src/commands.js";

test("filters registered commands for the live dropdown", () => {
  assert.deepEqual(getCommandSuggestions("/"), [...COMMANDS]);
  assert.deepEqual(
    getCommandSuggestions("/lo").map((command) => command.name),
    ["/login", "/logout"],
  );
  assert.deepEqual(
    getCommandSuggestions("/m").map((command) => command.name),
    ["/model"],
  );
  assert.deepEqual(
    getCommandSuggestions("/th").map((command) => command.name),
    ["/theme"],
  );
  assert.deepEqual(
    getCommandSuggestions("/n").map((command) => command.name),
    ["/new"],
  );
  assert.deepEqual(
    getCommandSuggestions("/sess").map((command) => command.name),
    ["/sessions"],
  );
  assert.deepEqual(
    getCommandSuggestions("/p").map((command) => command.name),
    ["/plan"],
  );
  assert.deepEqual(
    getCommandSuggestions("/e").map((command) => command.name),
    ["/exit"],
  );
  assert.deepEqual(getCommandSuggestions("/login "), []);
  assert.deepEqual(getCommandSuggestions("你好"), []);
});

test("classifies chat and registered commands locally", () => {
  assert.deepEqual(resolveCommandInput("你好"), {
    type: "chat",
    input: "你好",
  });
  assert.deepEqual(resolveCommandInput("/like"), {
    type: "unknown",
    command: "/like",
  });
  const plan = resolveCommandInput("/plan cancel");
  assert.equal(plan.type, "known");
  if (plan.type === "known") {
    assert.equal(plan.command.name, "/plan");
    assert.equal(plan.command.acceptsArguments, true);
    assert.equal(plan.input, "/plan cancel");
  }
  for (const commandName of [
    "/login",
    "/logout",
    "/model",
    "/theme",
    "/new",
    "/sessions",
    "/delete",
  ] as const) {
    const resolution = resolveCommandInput(commandName);
    assert.equal(resolution.type, "known");
    if (resolution.type === "known") {
      assert.equal(resolution.command.name, commandName);
      assert.equal(resolution.command.acceptsArguments, false);
    }
  }
});

test("suggests a nearby command and preserves its arguments", () => {
  assert.deepEqual(resolveCommandInput("/n"), {
    type: "suggestion",
    unknown: "/n",
    suggestedInput: "/new",
  });
  assert.deepEqual(resolveCommandInput("/sess"), {
    type: "suggestion",
    unknown: "/sess",
    suggestedInput: "/sessions",
  });
  assert.deepEqual(resolveCommandInput("/delte"), {
    type: "suggestion",
    unknown: "/delte",
    suggestedInput: "/delete",
  });
  assert.deepEqual(resolveCommandInput("/p"), {
    type: "suggestion",
    unknown: "/p",
    suggestedInput: "/plan",
  });
  assert.deepEqual(resolveCommandInput("/paln"), {
    type: "suggestion",
    unknown: "/paln",
    suggestedInput: "/plan",
  });
  assert.deepEqual(resolveCommandInput("/modle"), {
    type: "suggestion",
    unknown: "/modle",
    suggestedInput: "/model",
  });
  assert.deepEqual(resolveCommandInput("/theem"), {
    type: "suggestion",
    unknown: "/theem",
    suggestedInput: "/theme",
  });
  assert.deepEqual(resolveCommandInput("/logn"), {
    type: "suggestion",
    unknown: "/logn",
    suggestedInput: "/login",
  });
});

test("uses an unambiguous dropdown prefix before typo distance", () => {
  for (const [input, suggestedInput] of [
    ["/se", "/sessions"],
    ["/e", "/exit"],
    ["/ex", "/exit"],
    ["/del", "/delete"],
  ] as const) {
    assert.deepEqual(resolveCommandInput(input), {
      type: "suggestion",
      unknown: input,
      suggestedInput,
    });
  }
});

test("does not guess when a dropdown prefix is ambiguous", () => {
  assert.deepEqual(resolveCommandInput("/l"), {
    type: "unknown",
    command: "/l",
  });
  assert.deepEqual(resolveCommandInput("/lo"), {
    type: "unknown",
    command: "/lo",
  });
});

test("blocks a slash command without a nearby suggestion", () => {
  assert.deepEqual(resolveCommandInput("/coffee"), {
    type: "unknown",
    command: "/coffee",
  });
  assert.deepEqual(resolveCommandInput("/logt"), {
    type: "unknown",
    command: "/logt",
  });
  assert.deepEqual(resolveCommandInput("/plans"), {
    type: "suggestion",
    unknown: "/plans",
    suggestedInput: "/plan",
  });
});

test("renders every registered command in the help list", () => {
  const help = renderAvailableCommands();

  assert.match(help, /\/login\s+登录模型平台/);
  assert.match(help, /\/logout\s+退出模型平台/);
  assert.match(help, /\/model\s+切换模型/);
  assert.match(help, /\/theme\s+切换终端主题/);
  assert.match(help, /\/new\s+开始新会话/);
  assert.match(help, /\/sessions\s+查看和切换会话/);
  assert.match(help, /\/delete\s+删除当前会话/);
  assert.match(help, /\/plan\s+查看或取消当前任务计划/);
  assert.doesNotMatch(help, /\/like/u);
  assert.match(help, /\/exit\s+退出 Coffee/);
});

test("registers commands in their help order", () => {
  assert.deepEqual(
    COMMANDS.map((command) => command.name),
    [
      "/login",
      "/logout",
      "/model",
      "/theme",
      "/new",
      "/sessions",
      "/delete",
      "/plan",
      "/exit",
    ],
  );
});
