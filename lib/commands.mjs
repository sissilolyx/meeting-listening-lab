import { spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "CommandError";
    this.result = result;
  }
}

export function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env = {},
    inheritEnv = true,
    input,
    timeoutMs = 0,
    onOutput = () => {},
    allowFailure = false,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: inheritEnv ? { ...process.env, ...env } : { ...env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timer;

    const collect = (kind, chunk) => {
      const value = chunk.toString("utf8");
      if (kind === "stdout") stdout += value;
      else stderr += value;
      onOutput(kind, value);
    };

    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const result = { command, args, code, signal, stdout, stderr };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new CommandError(`${command} exited with code ${code}`, result));
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    }

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function commandExists(command) {
  try {
    const result = await runCommand("which", [command], { allowFailure: true });
    return result.code === 0 ? result.stdout.trim().split("\n").at(-1) : null;
  } catch {
    return null;
  }
}

export function parseLastJson(text) {
  const value = String(text || "").trim();
  const candidates = [0];
  for (let i = 0; i < value.length - 1; i += 1) {
    if (value[i] === "\n" && value[i + 1] === "{") candidates.push(i + 1);
  }
  for (const index of candidates.reverse()) {
    try {
      return JSON.parse(value.slice(index));
    } catch {
      // Try the previous JSON-looking line.
    }
  }
  throw new Error("Command did not return a readable JSON envelope");
}

export function friendlyCommandError(error) {
  const output = error?.result?.stderr || error?.result?.stdout || error?.message || String(error);
  try {
    const envelope = parseLastJson(output);
    const detail = envelope?.error;
    if (detail?.code === 2091005 || /permission/i.test(detail?.subtype || "")) {
      return "你目前没有这条妙记的读取权限。请让妙记所有者授权后重试；工具不会自动申请权限。";
    }
    if (detail?.code === 2091003) return "这条妙记仍在生成逐字稿，请稍后重试。";
    if (detail?.message) return detail.message;
  } catch {
    // Fall through to a compact stderr message.
  }
  return output.trim().split("\n").slice(-4).join("\n") || "命令执行失败";
}
