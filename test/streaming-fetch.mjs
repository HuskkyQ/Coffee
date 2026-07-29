import { appendFileSync } from "node:fs";
import path from "node:path";

if (process.env.COFFEE_TEST_TTY_LIKE_OUTPUT) {
  Object.defineProperties(process.stdout, {
    columns: { configurable: true, value: 80, writable: true },
    isTTY: { configurable: true, value: true },
  });
}

const encoder = new TextEncoder();
const interruptTracePath = process.env.COFFEE_TEST_INTERRUPT_TRACE_PATH;
const ptyTracePath = process.env.COFFEE_TEST_PTY_TRACE_PATH;
const scenario = process.env.COFFEE_STREAM_TEST_SCENARIO;
const requestsPath = process.env.COFFEE_TEST_REQUESTS_PATH;
let requestCount = 0;

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function event(payload) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return encoder.encode(`data: ${data}\n\n`);
}

function sse(payloads, signal, options = {}) {
  let timer;
  let keepAlive;
  let settled = false;
  let controller;
  const cleanup = () => {
    clearTimeout(timer);
    clearInterval(keepAlive);
    signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    if (process.env.COFFEE_TEST_DELAY_ABORT_ERROR) {
      process.stdout.write("\nABORT_OBSERVED\n");
      timer = setTimeout(() => controller.error(abortError()), 100);
    } else {
      controller.error(abortError());
    }
  };
  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
      let index = 0;
      const push = () => {
        timer = undefined;
        if (settled) {
          return;
        }
        if (signal?.aborted) {
          onAbort();
          return;
        }
        if (index < payloads.length) {
          options.beforePush?.(index);
          controller.enqueue(event(payloads[index++]));
          timer = setTimeout(push, options.delayMs ?? 8);
          return;
        }
        if (options.hang) {
          process.stdout.write("\nSTREAM_STARTED\n");
          if (interruptTracePath) {
            const originalWrite = process.stdout.write.bind(process.stdout);
            process.stdout.write = (chunk, ...args) => {
              if (String(chunk) === "\n") {
                appendFileSync(interruptTracePath, "newline\n", "utf8");
              }
              return originalWrite(chunk, ...args);
            };
            signal?.addEventListener(
              "abort",
              () => appendFileSync(interruptTracePath, "abort\n", "utf8"),
              { once: true },
            );
          }
          keepAlive = setInterval(() => {}, 1_000);
          return;
        }
        settled = true;
        cleanup();
        controller.close();
      };
      signal?.addEventListener(
        "abort",
        onAbort,
        { once: true },
      );
      if (options.initialDelayMs) {
        timer = setTimeout(push, options.initialDelayMs);
      } else {
        push();
      }
    },
    cancel() {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function textStream(parts, signal, options) {
  return sse(
    [
      ...parts.map((content) => ({
        choices: [{ delta: { content }, finish_reason: null }],
      })),
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ],
    signal,
    options,
  );
}

function toolCallStream({ id, name, argumentsJson }, signal) {
  const nameSplit = Math.max(1, Math.floor(name.length / 2));
  const argumentsSplit = Math.max(1, Math.floor(argumentsJson.length / 2));
  return sse(
    [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id,
              function: {
                name: name.slice(0, nameSplit),
                arguments: argumentsJson.slice(0, argumentsSplit),
              },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: {
                name: name.slice(nameSplit),
                arguments: argumentsJson.slice(argumentsSplit),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
      "[DONE]",
    ],
    signal,
  );
}

function toolCallsStream(calls, signal) {
  return sse(
    [
      {
        choices: [{
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              function: {
                name: call.name,
                arguments: call.argumentsJson,
              },
            })),
          },
          finish_reason: "tool_calls",
        }],
      },
      "[DONE]",
    ],
    signal,
  );
}

function requestBody(init) {
  if (typeof init?.body !== "string") {
    throw new Error("测试请求缺少 JSON body");
  }
  return JSON.parse(init.body);
}

function protocolError(detail) {
  throw new Error(`工具协议无效：${detail}`);
}

export function validateToolBatchesProtocol(messages, expectedBatches) {
  if (!Array.isArray(messages)) {
    protocolError("messages 不是数组");
  }
  if (!Array.isArray(expectedBatches) || expectedBatches.length === 0) {
    protocolError("expectedBatches 不是非空数组");
  }
  const userIndex = messages.findLastIndex(
    (message) => message?.role === "user",
  );
  if (userIndex < 0) {
    protocolError("当前轮缺少 user 消息");
  }
  const round = messages.slice(userIndex + 1);
  const expectedLength = expectedBatches.reduce(
    (length, batch) => length + 1 + batch.length,
    0,
  );
  if (round.length !== expectedLength) {
    protocolError("当前轮的 assistant/tool 消息数量不匹配");
  }
  const results = [];
  let messageIndex = 0;
  for (const expectedCalls of expectedBatches) {
    if (!Array.isArray(expectedCalls) || expectedCalls.length === 0) {
      protocolError("每个工具批次必须是非空数组");
    }
    const assistantMessage = round[messageIndex++];
    if (
      assistantMessage?.role !== "assistant" ||
      !Array.isArray(assistantMessage.tool_calls) ||
      assistantMessage.tool_calls.length !== expectedCalls.length
    ) {
      protocolError("assistant tool_call 批次数量不匹配");
    }
    for (let index = 0; index < expectedCalls.length; index += 1) {
      const expected = expectedCalls[index];
      const call = assistantMessage.tool_calls[index];
      if (
        call?.type !== "function" ||
        call.id !== expected.id ||
        call.function?.name !== expected.name ||
        call.function?.arguments !== expected.argumentsJson
      ) {
        protocolError("assistant tool_call 的类型、ID、名称或参数不匹配");
      }
    }
    for (const expected of expectedCalls) {
      const toolMessage = round[messageIndex++];
      if (
        toolMessage?.role !== "tool" ||
        toolMessage.tool_call_id !== expected.id
      ) {
        protocolError("assistant 后未按顺序提供匹配 tool_call_id 的结果");
      }
      if (typeof toolMessage.content !== "string") {
        protocolError("tool result 缺少字符串 content");
      }
      let result;
      try {
        result = JSON.parse(toolMessage.content);
      } catch {
        protocolError("tool result 不是 JSON");
      }
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result)
      ) {
        protocolError("tool result 不是对象");
      }
      results.push(result);
    }
  }
  return results;
}

export function validateToolProtocol(messages, expected) {
  return validateToolBatchesProtocol(messages, [[expected]])[0];
}

function planningResult(result, expected) {
  if (expected.compacted) {
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result) ||
      Object.keys(result).length !== 4 ||
      result.id !== expected.id ||
      result.revision !== expected.revision ||
      result.status !== expected.status ||
      result.compacted !== true
    ) {
      protocolError(`计划工具结果不是预期的 compact snapshot (${expected.id}@${expected.revision})`);
    }
    return result;
  }

  if (
    result.ok !== true ||
    typeof result.plan !== "object" ||
    result.plan === null ||
    Array.isArray(result.plan) ||
    result.plan.id !== expected.id ||
    result.plan.revision !== expected.revision ||
    result.plan.status !== expected.status
  ) {
    protocolError(`计划工具结果不是预期的完整计划 (${expected.id}@${expected.revision})`);
  }
  return result.plan;
}

function calculatorResult(result, expression, value) {
  if (
    result.ok !== true ||
    result.expression !== expression ||
    result.result !== value
  ) {
    protocolError(`calculator 结果不是 ${expression} = ${value}`);
  }
}

let planningPlanId;

globalThis.fetch = async (_input, init) => {
  requestCount += 1;
  const signal = init?.signal;
  if (requestsPath && typeof init?.body === "string") {
    appendFileSync(requestsPath, `${init.body}\n`, "utf8");
  }

  if (scenario === "text") {
    return textStream(["* **晨", "光**"], signal);
  }

  if (scenario === "web-tool-hang") {
    if (requestCount === 1) {
      return toolCallStream(
        {
          id: "call-web-tool-hang",
          name: "web_search",
          argumentsJson: JSON.stringify({ query: "coffee" }),
        },
        signal,
      );
    }
    if (requestCount !== 2) {
      throw new Error("web-tool-hang 不应发起更多请求");
    }
    return await new Promise((_resolve, reject) => {
      const rejectAbort = () => reject(abortError());
      if (signal?.aborted) {
        rejectAbort();
        return;
      }
      signal?.addEventListener("abort", rejectAbort, {
        once: true,
      });
      process.once("SIGINT", rejectAbort);
      process.stdout.write("\nWEB_TOOL_STARTED\n");
    });
  }

  if (scenario === "stable-lines") {
    return textStream(
      [
        "当前项目是 Coffee",
        "。\n",
        "从项目结构来看",
        "，这是一个 CLI。",
      ],
      signal,
    );
  }

  if (scenario === "slow-text") {
    return textStream(["稳定正文"], signal, { delayMs: 80 });
  }

  if (scenario === "delayed-first-text") {
    return textStream(["延迟回答"], signal, { initialDelayMs: 120 });
  }

  if (scenario === "pty-preview") {
    if (ptyTracePath) {
      appendFileSync(
        ptyTracePath,
        `tty=${process.stdin.isTTY === true && process.stdout.isTTY === true};columns=${process.stdout.columns}\n`,
        "utf8",
      );
    }
    return textStream(["abc", "def"], signal, {
      delayMs: 80,
      beforePush(index) {
        if (index !== 1) {
          return;
        }
        process.stdout.columns = 10;
        if (ptyTracePath) {
          appendFileSync(
            ptyTracePath,
            `columns=${process.stdout.columns}\n`,
            "utf8",
          );
        }
      },
    });
  }

  if (scenario === "tool") {
    if (requestCount === 1) {
      return sse(
        [
          {
            choices: [
              { delta: { content: "先算一下：" }, finish_reason: null },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-calculator",
                      function: {
                        name: "calcu",
                        arguments: '{"expression":"6',
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { name: "lator", arguments: '*7"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          "[DONE]",
        ],
        signal,
      );
    }
    return textStream(["结果是 **42**。"], signal);
  }

  if (
    scenario === "planning" ||
    scenario === "planning-hang" ||
    scenario === "planning-blocked" ||
    scenario === "planning-long"
  ) {
    const body = requestBody(init);
    const planningNames = new Set(
      (body.tools ?? []).map((tool) => tool?.function?.name),
    );
    for (const name of ["create_plan", "update_plan", "finish_plan"]) {
      if (!planningNames.has(name)) {
        throw new Error(`planning 场景缺少已注册工具 ${name}`);
      }
    }
    const steps = [
      {
        id: "inspect",
        title: scenario === "planning-long"
          ? "检查一个非常非常长的中文输入标题".repeat(6)
          : "检查输入",
        successCriteria: "calculator 返回 42",
        dependsOn: [],
      },
      {
        id: "verify",
        title: scenario === "planning-long"
          ? "验证一个非常非常长的中文结果标题".repeat(6)
          : "验证结果",
        successCriteria: "calculator 返回 43",
        dependsOn: ["inspect"],
      },
    ];
    const create = {
      id: "call-plan-create",
      name: "create_plan",
      argumentsJson: JSON.stringify({
        goal: "完成两步确定性验证",
        steps,
      }),
    };
    if (requestCount === 1) {
      return toolCallStream(create, signal);
    }

    if (requestCount === 2) {
      const [created] = validateToolBatchesProtocol(body.messages, [[create]]);
      if (
        created.ok !== true ||
        typeof created.plan?.id !== "string" ||
        created.plan.revision !== 1 ||
        created.plan.status !== "active"
      ) {
        throw new Error("planning 场景缺少成功的 create_plan 结果");
      }
      planningPlanId = created.plan.id;
    }
    if (typeof planningPlanId !== "string") {
      protocolError("planning 场景缺少 create_plan 的计划 ID");
    }
    const planId = planningPlanId;
    const startInspect = {
      id: "call-plan-start-inspect",
      name: "update_plan",
      argumentsJson: JSON.stringify({
        planId,
        expectedRevision: 1,
        action: "start_step",
        stepId: "inspect",
      }),
    };
    const calculateInspect = {
      id: "call-plan-calculate-inspect",
      name: "calculator",
      argumentsJson: JSON.stringify({ expression: "6*7" }),
    };
    const blockInspect = {
      id: "call-plan-block-inspect",
      name: "update_plan",
      argumentsJson: JSON.stringify({
        planId,
        expectedRevision: 2,
        action: "block_step",
        stepId: "inspect",
        reason: "需要用户选择目标文件",
      }),
    };

    if (requestCount === 2) {
      if (process.env.COFFEE_TEST_THROW_PLAN_OUTPUT) {
        const originalWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = (chunk, ...args) => {
          if (String(chunk).includes("检查输入")) {
            process.stdout.write = originalWrite;
            throw new Error("injected plan output failure");
          }
          return originalWrite(chunk, ...args);
        };
      }
      if (scenario === "planning-blocked") {
        return toolCallStream(startInspect, signal);
      }
      return toolCallsStream([startInspect, calculateInspect], signal);
    }

    if (scenario === "planning-blocked" && requestCount === 3) {
      const results = validateToolBatchesProtocol(body.messages, [
        [create],
        [startInspect],
      ]);
      planningResult(results[0], {
        id: planId,
        revision: 1,
        status: "active",
        compacted: true,
      });
      planningResult(results[1], {
        id: planId,
        revision: 2,
        status: "active",
        compacted: false,
      });
      return toolCallStream(blockInspect, signal);
    }

    if (scenario === "planning-blocked" && requestCount === 4) {
      const results = validateToolBatchesProtocol(body.messages, [
        [create],
        [startInspect],
        [blockInspect],
      ]);
      planningResult(results[0], {
        id: planId,
        revision: 1,
        status: "active",
        compacted: true,
      });
      planningResult(results[1], {
        id: planId,
        revision: 2,
        status: "active",
        compacted: true,
      });
      planningResult(results[2], {
        id: planId,
        revision: 3,
        status: "blocked",
        compacted: false,
      });
      return textStream(["请选择目标文件：A 还是 B？"], signal);
    }

    if (scenario === "planning-hang" && requestCount === 3) {
      const results = validateToolBatchesProtocol(body.messages, [
        [create],
        [startInspect, calculateInspect],
      ]);
      planningResult(results[0], {
        id: planId,
        revision: 1,
        status: "active",
        compacted: true,
      });
      planningResult(results[1], {
        id: planId,
        revision: 2,
        status: "active",
        compacted: false,
      });
      calculatorResult(results[2], "6*7", 42);
      return sse([], signal, { hang: true });
    }

    const completeInspect = {
      id: "call-plan-complete-inspect",
      name: "update_plan",
      argumentsJson: JSON.stringify({
        planId,
        expectedRevision: 2,
        action: "complete_step",
        stepId: "inspect",
        result: "calculator 返回 42",
      }),
    };
    const startVerify = {
      id: "call-plan-start-verify",
      name: "update_plan",
      argumentsJson: JSON.stringify({
        planId,
        expectedRevision: 3,
        action: "start_step",
        stepId: "verify",
      }),
    };
    const calculateVerify = {
      id: "call-plan-calculate-verify",
      name: "calculator",
      argumentsJson: JSON.stringify({ expression: "42+1" }),
    };

    if (requestCount === 3) {
      const results = validateToolBatchesProtocol(body.messages, [
        [create],
        [startInspect, calculateInspect],
      ]);
      planningResult(results[0], {
        id: planId,
        revision: 1,
        status: "active",
        compacted: true,
      });
      planningResult(results[1], {
        id: planId,
        revision: 2,
        status: "active",
        compacted: false,
      });
      calculatorResult(results[2], "6*7", 42);
      return toolCallsStream(
        [completeInspect, startVerify, calculateVerify],
        signal,
      );
    }

    const completeVerify = {
      id: "call-plan-complete-verify",
      name: "update_plan",
      argumentsJson: JSON.stringify({
        planId,
        expectedRevision: 4,
        action: "complete_step",
        stepId: "verify",
        result: "calculator 返回 43",
      }),
    };
    const finish = {
      id: "call-plan-finish",
      name: "finish_plan",
      argumentsJson: JSON.stringify({
        planId,
        expectedRevision: 5,
        summary: "两步 calculator 结果均已验证",
      }),
    };

    if (requestCount === 4) {
      const results = validateToolBatchesProtocol(body.messages, [
        [create],
        [startInspect, calculateInspect],
        [completeInspect, startVerify, calculateVerify],
      ]);
      planningResult(results[0], {
        id: planId,
        revision: 1,
        status: "active",
        compacted: true,
      });
      planningResult(results[1], {
        id: planId,
        revision: 2,
        status: "active",
        compacted: true,
      });
      calculatorResult(results[2], "6*7", 42);
      planningResult(results[3], {
        id: planId,
        revision: 3,
        status: "active",
        compacted: false,
      });
      planningResult(results[4], {
        id: planId,
        revision: 4,
        status: "active",
        compacted: false,
      });
      calculatorResult(results[5], "42+1", 43);
      return toolCallsStream([completeVerify, finish], signal);
    }

    if (requestCount === 5) {
      const results = validateToolBatchesProtocol(body.messages, [
        [create],
        [startInspect, calculateInspect],
        [completeInspect, startVerify, calculateVerify],
        [completeVerify, finish],
      ]);
      planningResult(results[0], {
        id: planId,
        revision: 1,
        status: "active",
        compacted: true,
      });
      planningResult(results[1], {
        id: planId,
        revision: 2,
        status: "active",
        compacted: true,
      });
      calculatorResult(results[2], "6*7", 42);
      planningResult(results[3], {
        id: planId,
        revision: 3,
        status: "active",
        compacted: true,
      });
      planningResult(results[4], {
        id: planId,
        revision: 4,
        status: "active",
        compacted: true,
      });
      calculatorResult(results[5], "42+1", 43);
      planningResult(results[6], {
        id: planId,
        revision: 5,
        status: "active",
        compacted: false,
      });
      planningResult(results[7], {
        id: planId,
        revision: 6,
        status: "completed",
        compacted: false,
      });
      return textStream(["两步计划已完成。"], signal);
    }

    throw new Error("planning 场景超过五次模型请求");
  }

  if (scenario === "shell-auto") {
    const argumentsJson = '{"command":"pwd"}';
    if (requestCount === 1) {
      return toolCallStream(
        {
          id: "call-shell-auto",
          name: "shell",
          argumentsJson,
        },
        signal,
      );
    }
    if (requestCount !== 2) {
      throw new Error("shell-auto 第二轮缺少成功的工作区结果");
    }
    const result = validateToolProtocol(requestBody(init).messages, {
      id: "call-shell-auto",
      name: "shell",
      argumentsJson,
    });
    if (result.exitCode !== 0 || !result.output?.includes(process.cwd())) {
      throw new Error("shell-auto 第二轮缺少成功的工作区结果");
    }
    return textStream(["Shell 自动执行完成。"], signal);
  }

  if (scenario === "shell-confirm") {
    const markerName = process.env.COFFEE_TEST_SHELL_MARKER_NAME;
    if (
      !markerName ||
      path.basename(markerName) !== markerName ||
      !/^[A-Za-z0-9._-]+$/.test(markerName)
    ) {
      throw new Error("COFFEE_TEST_SHELL_MARKER_NAME 不安全");
    }
    const argumentsJson = JSON.stringify({ command: `touch ${markerName}` });
    if (requestCount === 1) {
      return toolCallStream(
        {
          id: "call-shell-confirm",
          name: "shell",
          argumentsJson,
        },
        signal,
      );
    }
    if (requestCount !== 2) {
      throw new Error("shell-confirm 第二轮缺少 USER_REJECTED");
    }
    const result = validateToolProtocol(requestBody(init).messages, {
      id: "call-shell-confirm",
      name: "shell",
      argumentsJson,
    });
    if (result.code !== "USER_REJECTED") {
      throw new Error("shell-confirm 第二轮缺少 USER_REJECTED");
    }
    return textStream(["命令未执行。"], signal);
  }

  if (scenario === "shell-hang") {
    const pidPath = process.env.COFFEE_TEST_SHELL_PID_PATH;
    if (
      !pidPath ||
      !path.isAbsolute(pidPath) ||
      !/^[A-Za-z0-9._/-]+$/.test(pidPath)
    ) {
      throw new Error("COFFEE_TEST_SHELL_PID_PATH 不安全");
    }
    if (requestCount !== 1) {
      throw new Error("shell-hang 不应发起第二轮模型请求");
    }
    const childScript =
      `const fs=require("node:fs");` +
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));` +
      `process.stdout.write(["SHELL","STARTED"].join("_")+"\\n");` +
      `setInterval(()=>{},1000)`;
    return toolCallStream(
      {
        id: "call-shell-hang",
        name: "shell",
        argumentsJson: JSON.stringify({
          command: `node -e '${childScript}'`,
          timeout: 300,
        }),
      },
      signal,
    );
  }

  if (scenario === "fallback-json") {
    return new Response(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", content: "完整输出答案" } },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  if (scenario === "partial-error") {
    return sse(
      [
        {
          choices: [
            { delta: { content: "已经显示的部分" }, finish_reason: null },
          ],
        },
        "{malformed-json",
      ],
      signal,
    );
  }

  if (scenario === "hang") {
    if (ptyTracePath) {
      appendFileSync(
        ptyTracePath,
        `tty=${process.stdin.isTTY === true && process.stdout.isTTY === true};columns=${process.stdout.columns}\n`,
        "utf8",
      );
    }
    return sse(
      [
        {
          choices: [
            { delta: { content: "中断前可见\r" }, finish_reason: null },
          ],
        },
      ],
      signal,
      {
        hang: true,
        ...(process.env.COFFEE_TEST_HANG_DELAY_MS ? { delayMs: 80 } : {}),
      },
    );
  }

  throw new Error("未配置测试流场景");
};
