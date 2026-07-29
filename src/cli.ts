import { stdin as input, stdout as output } from "node:process";

import { createActivityRenderer } from "./activity-indicator.js";
import { createConversation, type Conversation } from "./agent.js";
import { createCredentialStore, maskApiKey } from "./auth.js";
import { createInputController } from "./chat-input.js";
import { createToolInteraction } from "./tool-interaction.js";
import {
  renderAvailableCommands,
  resolveCommandInput,
} from "./commands.js";
import { createSessionManager } from "./history/session-manager.js";
import { DEFAULT_HISTORY_PATH } from "./history/sqlite.js";
import {
  createHistoryStore,
  type HistoryStore,
} from "./history/store.js";
import { createLineStatus } from "./line-status.js";
import {
  getConfiguredLoginActionItems,
  getLoginCredentialItems,
  type CredentialStatus,
} from "./login-command.js";
import {
  getLogoutCandidates,
  getLogoutSelectionItems,
  renderLogoutMenu,
} from "./logout-command.js";
import {
  getModelSelectionItems,
  getModelMenuProviders,
  getProviderSelectionItems,
  renderProviderMenu,
} from "./model-command.js";
import { createPlanManager } from "./planning/manager.js";
import {
  createPlanProgressRenderer,
  parsePlanCommand,
  renderPlan,
} from "./planning/render.js";
import {
  loadHistoryPreferences,
  loadModelPreference,
  loadThemePreference,
  saveModelPreference,
  saveThemePreference,
  SETTINGS_PATH,
} from "./settings.js";
import {
  getSessionSelectionItems,
  parseDeleteConfirmation,
  renderSessionsMenu,
  sanitizeTerminalText,
} from "./session-commands.js";
import { CREDENTIALS, PROVIDERS } from "./models/catalog.js";
import { createOpenAICompletionsGateway } from "./models/openai-completions.js";
import { createModelRegistry } from "./models/registry.js";
import type {
  CredentialDefinition,
  CredentialId,
  ModelDefinition,
} from "./models/types.js";
import { renderStartupBanner } from "./startup-banner.js";
import {
  createStreamingMarkdownRenderer,
  type StreamingMarkdownRenderer,
} from "./streaming-markdown-renderer.js";
import { styleText } from "./terminal-format.js";
import { getThemeSelectionModel } from "./theme-command.js";
import {
  createStyleContext,
  DEFAULT_THEME_ID,
  resolveColorMode,
} from "./theme.js";
import { resolveWorkspaceRoot } from "./workspace.js";

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeTerminalText(message) || "未知错误";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

async function main(): Promise<number> {
  const colorMode = resolveColorMode({
    isTTY: output.isTTY,
    noColor: process.env.NO_COLOR,
    colorTerm: process.env.COLORTERM,
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
  });
  let styles = createStyleContext(
    DEFAULT_THEME_ID,
    colorMode,
  );
  const settingsPath =
    process.env.COFFEE_SETTINGS_PATH?.trim() || SETTINGS_PATH;
  const modelRegistry = createModelRegistry(CREDENTIALS, PROVIDERS);
  const credentialStore = createCredentialStore();
  const gateway = createOpenAICompletionsGateway();

  let loadedTheme;
  let loadedHistoryPreferences;
  let loadedModelPreference;
  let workspaceRoot: string;
  try {
    workspaceRoot = await resolveWorkspaceRoot();
    loadedTheme = await loadThemePreference(settingsPath);
    styles = createStyleContext(loadedTheme.themeId, colorMode);
    loadedHistoryPreferences = await loadHistoryPreferences(settingsPath);
    loadedModelPreference = await loadModelPreference(settingsPath);
  } catch (error) {
    console.error(
      styleText(`Error: ${getErrorMessage(error)}`, "error", styles),
    );
    return 1;
  }
  const startupWarnings = new Set(
    [
      loadedTheme.warning,
      loadedHistoryPreferences.warning,
      loadedModelPreference.warning,
    ].filter(
      (warning): warning is string => warning !== undefined,
    ),
  );
  for (const warning of startupWarnings) {
    console.error(styleText(`Warning: ${warning}`, "error", styles));
  }
  async function resolveApiKey(
    credentialId: CredentialId,
  ): Promise<string | undefined> {
    const definition = modelRegistry.getCredential(credentialId);
    if (!definition) {
      return undefined;
    }
    return (await credentialStore.resolve(definition, process.env))?.key;
  }

  let loadedGlobalDefaultModel: ModelDefinition | undefined;
  const savedPreference = loadedModelPreference.preference;
  if (savedPreference) {
    loadedGlobalDefaultModel = modelRegistry.getModel(
      savedPreference.provider,
      savedPreference.model,
    );
    if (!loadedGlobalDefaultModel) {
      console.error(
        styleText(
          "Warning: 保存的模型偏好无效，请使用 /model 重新选择模型。",
          "error",
          styles,
        ),
      );
    }
  } else if (loadedModelPreference.warning === undefined) {
    if (await resolveApiKey("deepseek")) {
      loadedGlobalDefaultModel = modelRegistry.getModel(
        "deepseek",
        "deepseek-v4-flash",
      );
    }
    if (!loadedGlobalDefaultModel) {
      for (const provider of modelRegistry.getProviders()) {
        if (await resolveApiKey(provider.credentialId)) {
          loadedGlobalDefaultModel = provider.models[0];
          break;
        }
      }
    }
  }

  const historyPath =
    process.env.COFFEE_HISTORY_PATH?.trim() || DEFAULT_HISTORY_PATH;
  let historyStore: HistoryStore | undefined;
  try {
    historyStore = createHistoryStore(historyPath);
  } catch (error) {
    console.error(
      styleText(`Error: ${getErrorMessage(error)}`, "error", styles),
    );
    return 1;
  }

  let cleanupActivity: ReturnType<typeof createActivityRenderer> | undefined;
  let cleanupPlanProgress:
    | ReturnType<typeof createPlanProgressRenderer>
    | undefined;
  let cleanupResponseStatus: ReturnType<typeof createLineStatus> | undefined;
  let cleanupInput: ReturnType<typeof createInputController> | undefined;
  let cleanupInterrupt: (() => void) | undefined;
  let interruptRegistered = false;
  let activeStreamRenderer: StreamingMarkdownRenderer | undefined;

  try {
    const sessionManager = createSessionManager({
      store: historyStore,
      getModel: (providerId, modelId) =>
        modelRegistry.getModel(providerId, modelId),
      defaultModel: loadedGlobalDefaultModel,
    });
    const planManager = createPlanManager({
      store: historyStore.plans,
      session: sessionManager,
    });

    const activityRenderer = createActivityRenderer({
      output,
      isTTY: output.isTTY,
      styles,
    });
    cleanupActivity = activityRenderer;
    const planProgressRenderer = createPlanProgressRenderer({
      output,
      isTTY: output.isTTY,
      styles,
      getColumns: () => output.columns,
    });
    cleanupPlanProgress = planProgressRenderer;
    const responseStatus = createLineStatus({
      output,
      isTTY: input.isTTY === true && output.isTTY === true,
      styles,
    });
    cleanupResponseStatus = responseStatus;
    const abortController = new AbortController();
    const handleInterrupt = () => {
      if (abortController.signal.aborted) {
        return;
      }
      const renderer = activeStreamRenderer;
      activeStreamRenderer = undefined;
      const planRenderer = cleanupPlanProgress;
      cleanupPlanProgress = undefined;
      const responseStatusToDispose = cleanupResponseStatus;
      cleanupResponseStatus = undefined;
      const activityToDispose = cleanupActivity;
      cleanupActivity = undefined;
      try {
        renderer?.dispose({ preserve: true });
      } catch {
        // Continue through the remaining SIGINT cleanup steps.
      }
      try {
        planRenderer?.dispose();
      } catch {
        // Continue through the remaining SIGINT cleanup steps.
      }
      try {
        responseStatusToDispose?.dispose();
      } catch {
        // Continue through the remaining SIGINT cleanup steps.
      }
      try {
        activityToDispose?.dispose();
      } catch {
        // Continue through the remaining SIGINT cleanup steps.
      }
      try {
        output.write("\n");
      } catch {
        // Aborting the active request is still required.
      }
      try {
        abortController.abort();
      } catch {
        // SIGINT cleanup must not surface an uncaught exception.
      }
    };
    cleanupInterrupt = handleInterrupt;
    process.on("SIGINT", handleInterrupt);
    interruptRegistered = true;
    const inputController = createInputController({
      input,
      output,
      signal: abortController.signal,
      styles,
    });
    cleanupInput = inputController;
    const toolInteraction = createToolInteraction({
      input: inputController,
      activity: activityRenderer,
      output,
      styles,
    });
    const conversation: Conversation = createConversation({
      gateway,
      resolveApiKey,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      session: sessionManager,
      historyPreferences: loadedHistoryPreferences.preferences,
      workspaceRoot,
      toolInteraction,
      planning: planManager,
    });

  async function getCredentialStatuses(): Promise<
    Map<CredentialId, CredentialStatus>
  > {
    const statuses = new Map<CredentialId, CredentialStatus>();
    for (const credential of modelRegistry.getCredentials()) {
      const resolved = await credentialStore.resolve(credential, process.env);
      if (resolved) {
        statuses.set(credential.id, {
          source: resolved.source,
          maskedKey: maskApiKey(resolved.key),
        });
      }
    }
    return statuses;
  }

  async function promptForApiKey(
    credential: CredentialDefinition,
  ): Promise<"continue" | "exit"> {
    const key = await inputController.askSecret(
      `请输入 ${credential.name} API Key：`,
    );
    if (key === undefined) {
      return "exit";
    }
    if (key.trim() === "") {
      console.error(styleText("Error: API Key 不能为空", "error", styles));
      return "continue";
    }
    await credentialStore.saveApiKey(credential.id, key);
    console.log(
      styleText(
        `✓ ${credential.name} 凭证已保存。`,
        "assistant",
        styles,
      ),
    );
    return "continue";
  }

  async function login(): Promise<"continue" | "exit"> {
    const statuses = await getCredentialStatuses();
    const selected = await inputController.select({
      message: "选择登录平台",
      items: getLoginCredentialItems(
        modelRegistry.getCredentials(),
        statuses,
      ),
    });
    if (!selected) {
      return "continue";
    }

    const status = statuses.get(selected.id);
    if (!status) {
      return await promptForApiKey(selected);
    }

    const action = await inputController.select({
      message: `当前凭证：${status.maskedKey}`,
      items: getConfiguredLoginActionItems(),
    });
    if (!action) {
      return "continue";
    }
    if (action === "keep") {
      console.log(
        styleText(
          `✓ 已保留 ${selected.name} 当前凭证。`,
          "assistant",
          styles,
        ),
      );
      return "continue";
    }
    if (action === "cancel") {
      return "continue";
    }
    return await promptForApiKey(selected);
  }

  async function logout(): Promise<"continue" | "exit"> {
    const savedIds = new Set(await credentialStore.getSavedCredentialIds());
    const candidates = getLogoutCandidates(
      modelRegistry.getCredentials(),
      savedIds,
    );
    if (candidates.length === 0) {
      console.log(renderLogoutMenu(candidates));
      return "continue";
    }

    const selected = await inputController.select({
      message: "选择退出的平台",
      items: getLogoutSelectionItems(candidates),
    });
    if (!selected) {
      return "continue";
    }

    await credentialStore.deleteApiKey(selected.id);
    const remaining = await credentialStore.resolve(selected, process.env);
    if (remaining?.source === "environment") {
      console.log("已删除保存的凭证，但项目 .env 中的凭证仍然生效。");
    } else {
      console.log(`✓ 已删除 ${selected.name} 保存的凭证。`);
    }
    return "continue";
  }

  async function selectModel(): Promise<"continue" | "exit"> {
    const availableCredentialIds = new Set<CredentialId>();
    for (const credential of modelRegistry.getCredentials()) {
      if (await credentialStore.resolve(credential, process.env)) {
        availableCredentialIds.add(credential.id);
      }
    }
    const providers = getModelMenuProviders(
      modelRegistry,
      availableCredentialIds,
    );
    if (providers.length === 0) {
      console.log(renderProviderMenu(providers));
      return "continue";
    }

    const currentModel = conversation.getModel();
    const selectedProvider = await inputController.select({
      message: "选择模型平台",
      items: getProviderSelectionItems(
        providers,
        currentModel?.providerId,
      ),
    });
    if (!selectedProvider) {
      return "continue";
    }

    const selectedModel = await inputController.select({
      message: `选择 ${selectedProvider.name} 模型`,
      items: getModelSelectionItems(
        selectedProvider,
        currentModel?.providerId === selectedProvider.id
          ? currentModel.id
          : undefined,
      ),
    });
    if (!selectedModel) {
      return "continue";
    }

    await saveModelPreference(settingsPath, {
      provider: selectedProvider.id,
      model: selectedModel.id,
    });
    sessionManager.setModel(selectedModel);
    loadedGlobalDefaultModel = selectedModel;
    console.log(
      styleText(
        `✓ 已切换模型：${selectedProvider.name} / ${selectedModel.name}`,
        "assistant",
        styles,
      ),
    );
    return "continue";
  }

  async function selectTheme(): Promise<void> {
    const model = getThemeSelectionModel(styles.theme.id, styles.colorMode);
    const selected = await inputController.select({
      message: "选择主题",
      items: model.items,
      initialIndex: model.initialIndex,
    });
    if (!selected || selected === styles.theme.id) {
      return;
    }

    await saveThemePreference(settingsPath, selected);
    styles = createStyleContext(selected, styles.colorMode);
    inputController.setStyleContext(styles);
    activityRenderer.setStyleContext(styles);
    planProgressRenderer.setStyleContext(styles);
    toolInteraction.setStyleContext(styles);
    responseStatus.setStyleContext(styles);
    console.log(
      styleText(
        `✓ 已切换为 ${styles.theme.label}`,
        "assistant",
        styles,
      ),
    );
  }

    console.log(
      `${renderStartupBanner({
        isTTY: output.isTTY,
        styles,
        workspaceRoot,
        modelName:
          sessionManager.getCurrent().model?.name ??
          loadedGlobalDefaultModel?.name,
      })}\n`,
    );
    const restored = sessionManager.getCurrent();
    if (restored.id) {
      const restoredTitle =
        sanitizeTerminalText(restored.title ?? "") || "新会话";
      const restoredProviderId =
        sanitizeTerminalText(restored.providerId ?? "") || "未知平台";
      const restoredModelId =
        sanitizeTerminalText(restored.modelId ?? "") || "未知模型";
      console.log(
        styleText(
          `已恢复会话：${restoredTitle}（${restoredProviderId}/${restoredModelId}）`,
          "assistant",
          styles,
        ),
      );
      if (!restored.model) {
        console.error(
          styleText(
            `Warning: 无法解析已恢复会话的模型 ${restoredProviderId}/${restoredModelId}，请使用 /model 重新选择。`,
            "error",
            styles,
          ),
        );
      } else {
        let credentialAvailable = false;
        try {
          credentialAvailable = Boolean(
            await resolveApiKey(restored.model.credentialId),
          );
        } catch {
          credentialAvailable = false;
        }
        if (!credentialAvailable) {
          console.error(
            styleText(
              "Warning: 已恢复会话的模型缺少可用凭证，请使用 /login 登录或使用 /model 切换模型。",
              "error",
              styles,
            ),
          );
        }
      }
    }

    while (true) {
      const answer = await inputController.ask("");
      if (answer === undefined) {
        return 0;
      }
      const userInput = answer.trim();
      if (!userInput) {
        continue;
      }

      let resolution = resolveCommandInput(userInput);
      if (resolution.type === "suggestion") {
        const unknownForDisplay =
          sanitizeTerminalText(resolution.unknown) || "未知命令";
        const suggestionForDisplay =
          sanitizeTerminalText(resolution.suggestedInput) || "建议命令";
        const confirmation = await inputController.ask(
          `${styleText(`未找到命令：${unknownForDisplay}`, "error", styles)}\n` +
            `是否改用 ${styleText(suggestionForDisplay, "startup", styles)}？ (Y/n) `,
          false,
        );
        if (confirmation === undefined) {
          return 0;
        }
        const normalized = confirmation.trim().toLowerCase();
        if (normalized !== "" && normalized !== "y" && normalized !== "yes") {
          continue;
        }
        resolution = resolveCommandInput(resolution.suggestedInput);
      }

      if (resolution.type === "unknown") {
        const commandForDisplay =
          sanitizeTerminalText(resolution.command) || "未知命令";
        console.error(
          styleText(
            `未知命令：${commandForDisplay}\n${renderAvailableCommands()}`,
            "error",
            styles,
          ),
        );
        continue;
      }

      if (resolution.type === "known") {
        if (resolution.command.name === "/exit") {
          return 0;
        }

        try {
          let commandResult: "continue" | "exit" | undefined;
          if (resolution.command.name === "/new") {
            sessionManager.startNew(loadedGlobalDefaultModel);
            console.log(
              styleText("✓ 已开始新会话。", "assistant", styles),
            );
            continue;
          } else if (resolution.command.name === "/sessions") {
            const sessions = sessionManager.listSessions();
            if (sessions.length === 0) {
              console.log(renderSessionsMenu(sessions));
              continue;
            }
            const selected = await inputController.select({
              message: "选择会话",
              items: getSessionSelectionItems(
                sessions,
                sessionManager.getCurrent().id,
              ),
            });
            if (!selected) {
              continue;
            }
            sessionManager.switchSession(selected.id);
            const selectedTitle =
              sanitizeTerminalText(selected.title) || "新会话";
            console.log(
              styleText(
                `✓ 已切换会话：${selectedTitle}`,
                "assistant",
                styles,
              ),
            );
            continue;
          } else if (resolution.command.name === "/delete") {
            const current = sessionManager.getCurrent();
            if (!current.id) {
              console.log("当前没有可删除的会话。");
              continue;
            }
            const currentTitle =
              sanitizeTerminalText(current.title ?? "") || "新会话";
            const confirmation = await inputController.ask(
              `确定删除“${currentTitle}”及其全部历史吗？ (y/N) `,
              false,
            );
            if (confirmation === undefined) {
              return 0;
            }
            if (!parseDeleteConfirmation(confirmation)) {
              continue;
            }
            sessionManager.deleteCurrent();
            console.log(
              styleText("✓ 当前会话已删除。", "assistant", styles),
            );
            continue;
          } else if (resolution.command.name === "/plan") {
            const command = parsePlanCommand(resolution.input);
            if (command.type === "invalid") {
              console.error(
                styleText(
                  "用法：/plan 或 /plan cancel",
                  "error",
                  styles,
                ),
              );
              continue;
            }
            const current = planManager.getCurrentPlan();
            if (command.type === "show") {
              console.log(renderPlan(current, styles));
              continue;
            }
            if (current === undefined) {
              console.log("当前会话还没有任务计划。");
              continue;
            }
            if (current.status === "completed") {
              console.log("当前计划已经完成，无法取消。");
              continue;
            }
            if (current.status === "cancelled") {
              console.log("当前计划已经取消。");
              continue;
            }
            planManager.cancelCurrent(abortController.signal);
            console.log("✓ 当前计划已取消。");
            continue;
          } else if (resolution.command.name === "/login") {
            commandResult = await login();
          } else if (resolution.command.name === "/logout") {
            commandResult = await logout();
          } else if (resolution.command.name === "/model") {
            commandResult = await selectModel();
          } else if (resolution.command.name === "/theme") {
            await selectTheme();
            continue;
          }
          if (commandResult === "exit") {
            return 0;
          }
          if (commandResult === "continue") {
            continue;
          }
        } catch (error) {
          console.error(
            styleText(`Error: ${getErrorMessage(error)}`, "error", styles),
          );
          continue;
        }

      }

      if (resolution.type !== "chat") {
        continue;
      }

      const renderer = createStreamingMarkdownRenderer({
        output,
        isTTY: inputController.isInteractive,
        styles,
        term: process.env.TERM,
        prefix: "",
      });
      activeStreamRenderer = renderer;
      let preserveRenderer = false;
      try {
        const activeModelName =
          sessionManager.getCurrent().model?.name ??
          loadedGlobalDefaultModel?.name ??
          "当前模型";
        responseStatus.show(`正在连接 ${activeModelName}…`);
        for await (const event of conversation.stream(
          resolution.input,
          abortController.signal,
        )) {
          if (event.type === "status" || event.type === "fallback") {
            planProgressRenderer.pause();
            responseStatus.show(event.text);
          } else if (event.type === "text_delta") {
            responseStatus.clear();
            planProgressRenderer.pause();
            renderer.append(event.delta);
          } else if (event.type === "segment_end") {
            renderer.finishSegment();
          } else if (event.type === "tool_activity") {
            responseStatus.clear();
            renderer.finishSegment();
            planProgressRenderer.pause();
            activityRenderer.handle(event.event);
          } else if (event.type === "plan_activity") {
            responseStatus.clear();
            renderer.finishSegment();
            activityRenderer.pause();
            planProgressRenderer.handle(event.plan);
          } else if (event.type === "done") {
            responseStatus.clear();
            planProgressRenderer.pause();
            renderer.finishSegment(event.content);
          }
        }
      } catch (error) {
        responseStatus.clear();
        if (abortController.signal.aborted || isAbortError(error)) {
          preserveRenderer = true;
          return 0;
        }
        preserveRenderer = true;
        planProgressRenderer.pause();
        renderer.finishSegment();
        cleanupActivity = undefined;
        activityRenderer.dispose();
        console.error(
          styleText(`Error: ${getErrorMessage(error)}`, "error", styles),
        );
      } finally {
        responseStatus.clear();
        if (activeStreamRenderer === renderer) {
          activeStreamRenderer = undefined;
        }
        renderer.dispose({ preserve: preserveRenderer });
      }
    }
  } catch (error) {
    console.error(
      styleText(`Error: ${getErrorMessage(error)}`, "error", styles),
    );
    return 1;
  } finally {
    const rendererToDispose = activeStreamRenderer;
    activeStreamRenderer = undefined;
    try {
      rendererToDispose?.dispose({ preserve: true });
    } finally {
      const responseStatusToDispose = cleanupResponseStatus;
      cleanupResponseStatus = undefined;
      try {
        responseStatusToDispose?.dispose();
      } finally {
        const inputToClose = cleanupInput;
        cleanupInput = undefined;
        try {
          inputToClose?.close();
        } finally {
          const planToDispose = cleanupPlanProgress;
          cleanupPlanProgress = undefined;
          try {
            planToDispose?.dispose();
          } finally {
            const activityToDispose = cleanupActivity;
            cleanupActivity = undefined;
            try {
              activityToDispose?.dispose();
            } finally {
              const interruptToRemove = cleanupInterrupt;
              cleanupInterrupt = undefined;
              try {
                historyStore.close();
              } finally {
                if (interruptRegistered && interruptToRemove) {
                  interruptRegistered = false;
                  process.off("SIGINT", interruptToRemove);
                }
              }
            }
          }
        }
      }
    }
  }
}

process.exitCode = await main();
