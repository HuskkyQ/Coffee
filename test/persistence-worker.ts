import { createCredentialStore } from "../src/auth.js";
import {
  saveModelPreference,
  saveThemePreference,
} from "../src/settings.js";

const [operation, targetPath] = process.argv.slice(2);

if (operation === undefined || targetPath === undefined) {
  throw new Error("worker 缺少 operation 或 targetPath");
}

async function run(): Promise<void> {
  switch (operation) {
    case "auth-save-deepseek":
      await createCredentialStore(targetPath).saveApiKey(
        "deepseek",
        "deepseek-key",
      );
      return;
    case "auth-save-opencode":
      await createCredentialStore(targetPath).saveApiKey(
        "opencode",
        "opencode-key",
      );
      return;
    case "settings-save-theme":
      await saveThemePreference(targetPath, "coast");
      return;
    case "settings-save-model":
      await saveModelPreference(targetPath, {
        provider: "openai",
        model: "gpt-5",
      });
      return;
    default:
      throw new Error(`未知 worker operation：${operation}`);
  }
}

function send(type: "ready" | "attempting" | "started" | "done"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error("worker 缺少 IPC 通道"));
      return;
    }
    process.send({ type }, (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

await send("ready");
process.once("message", (message) => {
  if (message !== "start") {
    throw new Error("worker 收到无效启动消息");
  }

  void (async () => {
    await send("attempting");
    const operationPromise = run();
    await send("started");
    await operationPromise;
    await send("done");
  })()
    .then(() => {
      if (process.connected) {
        process.disconnect();
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
      if (process.connected) {
        process.disconnect();
      }
    });
});
