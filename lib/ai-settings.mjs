import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AI_SETTINGS_PATH } from "./config.mjs";

export const AI_PROVIDERS = Object.freeze(["codex", "cursor"]);

export class AiSettingsError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AiSettingsError";
    this.statusCode = statusCode;
  }
}

export function createAiSettingsStore(settingsPath = AI_SETTINGS_PATH) {
  return {
    async read() {
      let parsed;
      try {
        parsed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return emptyAiSettings();
        if (error instanceof SyntaxError) {
          throw new AiSettingsError("AI 设置文件无法读取，请重新保存设置", 500);
        }
        throw error;
      }

      try {
        const selection = validateAiSettingsInput(parsed, { allowExtraKeys: false });
        return { configured: true, ...selection };
      } catch (error) {
        if (error instanceof AiSettingsError) {
          throw new AiSettingsError("AI 设置文件内容无效，请重新保存设置", 500);
        }
        throw error;
      }
    },

    async save(input) {
      const selection = validateAiSettingsInput(input, { allowExtraKeys: false });
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      const temporary = `${settingsPath}.${process.pid}-${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, settingsPath);
        await fs.chmod(settingsPath, 0o600).catch(() => {});
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
      return { configured: true, ...selection };
    },
  };
}

const defaultStore = createAiSettingsStore();

export function readAiSettings() {
  return defaultStore.read();
}

export function saveAiSettings(input) {
  return defaultStore.save(input);
}

export async function captureAiSettings() {
  const settings = await readAiSettings();
  if (!settings.configured) {
    throw new AiSettingsError("请先选择并测试 AI 账户", 409);
  }
  return Object.freeze({ provider: settings.provider, model: settings.model });
}

export function validateAiSettingsInput(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AiSettingsError("AI 设置格式无效");
  }
  const keys = Object.keys(input);
  if (!options.allowExtraKeys && keys.some((key) => !["provider", "model"].includes(key))) {
    throw new AiSettingsError("AI 设置只能包含 provider 和 model");
  }
  if (!AI_PROVIDERS.includes(input.provider)) {
    throw new AiSettingsError("AI provider 只能是 codex 或 cursor");
  }
  if (typeof input.model !== "string") {
    throw new AiSettingsError("AI model 必须是字符串");
  }
  const model = input.model.trim();
  if (!model || model.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/+ -]*$/u.test(model)) {
    throw new AiSettingsError("AI model 名称无效");
  }
  return { provider: input.provider, model };
}

function emptyAiSettings() {
  return { configured: false, provider: "", model: "" };
}
