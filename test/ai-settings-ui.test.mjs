import assert from "node:assert/strict";
import test from "node:test";

const runBrowserRegression = process.env.RUN_AI_SETTINGS_UI === "1";

test("synthetic browser: first-run AI settings remain blocking, persist, and reopen globally", {
  skip: runBrowserRegression ? false : "set RUN_AI_SETTINGS_UI=1 with Playwright installed and AI_SETTINGS_UI_URL pointing at the local app",
}, async (context) => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}),
  });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
  const runtimeModel = {
    id: "synthetic-runtime-model",
    label: "GPT Synthetic Model With An Extremely Long Runtime Display Name",
    description: "Synthetic model returned only by this browser test.",
  };
  let settings = { configured: false, provider: null, model: null };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/ai-settings" && request.method() === "GET") {
      return route.fulfill({ json: syntheticAiSettings(settings, runtimeModel) });
    }
    if (pathname === "/api/ai-settings" && request.method() === "PATCH") {
      const selection = request.postDataJSON();
      settings = { configured: true, provider: selection.provider, model: selection.model };
      return route.fulfill({ json: { ok: true, settings } });
    }
    if (pathname === "/api/ai-settings/test") return route.fulfill({ json: { ok: true } });
    if (pathname === "/api/status") {
      return route.fulfill({ json: { tools: { ffmpeg: true, ffprobe: true, whisper: true, whisperModel: true, lark: false, larkUserReady: false } } });
    }
    if (pathname === "/api/materials") return route.fulfill({ json: { materials: [] } });
    if (pathname === "/api/trash") return route.fulfill({ json: { trash: [] } });
    if (pathname === "/api/learner-profile") return route.fulfill({ json: { profile: { version: 1, updatedAt: null, tooSimple: [] } } });
    return route.fulfill({ status: 404, json: { error: "synthetic route not provided" } });
  });

  const baseUrl = process.env.AI_SETTINGS_UI_URL || "http://127.0.0.1:4173/";
  await page.goto(baseUrl);
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("heading", { name: "先选择 AI 讲解账户" }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "关闭 AI 讲解设置" }).isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "取消" }).isVisible(), false);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);

  await page.getByRole("radio", { name: /Cursor/ }).check();
  assert.equal(await page.getByRole("button", { name: "保存并开始" }).isDisabled(), true);
  await page.getByRole("radio", { name: /Codex/ }).check();
  assert.equal(await page.getByLabel("3. 选择模型").inputValue(), runtimeModel.id);
  assert.equal(await page.getByRole("button", { name: "保存并开始" }).isEnabled(), true);
  await page.getByRole("button", { name: "保存并开始" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.match(await page.getByRole("button", { name: /AI讲解 · Codex/ }).getAttribute("aria-label"), /synthetic/i);

  await page.reload();
  assert.equal(await dialog.isVisible(), false);
  const globalEntry = page.getByRole("button", { name: /AI讲解 · Codex/ });
  await globalEntry.click();
  assert.equal(await page.getByRole("heading", { name: "AI 讲解设置" }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "取消" }).isVisible(), true);
  await page.getByRole("radio", { name: /Cursor/ }).check();
  assert.equal(await page.getByRole("button", { name: "保存设置" }).isDisabled(), true);
  await page.getByRole("button", { name: "取消" }).click();

  for (const width of [1000, 760]) {
    await page.setViewportSize({ width, height: 820 });
    const layout = await page.evaluate(() => {
      const entry = document.querySelector("#aiSettingsRailButton")?.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        entryLeft: entry?.left ?? -1,
        entryRight: entry?.right ?? -1,
      };
    });
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `no horizontal overflow at ${width}px`);
    assert.ok(layout.entryLeft >= 0 && layout.entryRight <= layout.viewportWidth + 1, `global entry remains in view at ${width}px`);
  }

  settings = { configured: true, provider: "cursor", model: "auto" };
  await page.reload();
  assert.equal(await dialog.isVisible(), false, "an already configured but temporarily unavailable account never blocks local listening");
  assert.equal(await page.getByRole("heading", { name: /把开过的会/ }).isVisible(), true);
  assert.equal(await page.getByText("账户状态有变化，点击检查").isVisible(), true);
});

function syntheticAiSettings(settings, runtimeModel) {
  return {
    settings,
    providers: {
      codex: { installed: true, authenticated: true, models: [runtimeModel] },
      cursor: { installed: false, authenticated: false, models: [], error: "未安装 Cursor Agent CLI" },
    },
  };
}
