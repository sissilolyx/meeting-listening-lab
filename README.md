# 原声精听（macOS 私有测试版）

把真实英文会议录音或录屏变成可逐段听写、核对、讲解和复习的本地工具。训练时播放的始终是真实会议原声，不是 AI 配音。

> 这是面向受邀测试者的 **macOS 本地自托管版本**。GitHub 私有仓库只分发源代码；它不是 GitHub Pages，也不是云端网站。每位测试者需要把代码下载到自己的 Mac，在自己的电脑上启动。

## 先了解数据边界

- 材料、音视频、逐字稿、学习进度、复习内容和“问问”记录默认保存在当前项目的 `.data/`，只在这台电脑的这个项目副本中使用。
- 不同测试者之间没有账号数据同步，也不会同步你的材料。换电脑、换项目目录或删除 `.data/` 后，原来的学习数据不会自动出现。
- 本地音视频由 `whisper.cpp` 在电脑上转写，不会上传到 GitHub，也不会由本项目上传到自建云存储。
- 讲解和“问问”通过本机的 Codex CLI 生成。项目会把完成讲解所需的逐字稿片段、问题和语境交给 Codex 处理；请只导入符合你所在组织和 OpenAI/ChatGPT 使用规则的内容。若内容完全不能离开电脑，请设置 `SKIP_CODEX_ANALYSIS=1`，并不要使用讲解或“问问”功能。
- 每位测试者使用自己的 `codex login` 和自己的 ChatGPT/Codex 订阅额度。本项目不要求独立 OpenAI API Key，也不会把 Codex 凭据写入仓库、`.data/` 或项目配置；登录凭据由 Codex CLI 自己管理。
- 飞书/Lark 导入是可选能力。使用者需要在自己的电脑上安装并登录 `lark-cli`；本项目不会共享仓库维护者或其他测试者的 Lark 登录。
- 服务默认只监听 `127.0.0.1`。不要把 `HOST` 改成 `0.0.0.0`，不要做端口转发，也不要把它部署到公网服务器。

### 绝对不要提交的本地内容

提交代码或反馈前先运行 `git status`，确认以下内容没有进入 Git：

- `.data/`：所有材料、逐字稿、进度、复习和问问记录
- `.models/`：本地 Whisper 模型
- `.env`、`.env.*`：可能包含个人路径或本地配置

不要为了“方便测试”移除这些忽略规则，也不要在 Issue、截图或日志中暴露会议内容。

## 5 分钟 Quick Start

以下 5 分钟指依赖已经安装后的首次启动；第一次下载约 466 MB 的 Whisper 模型可能需要更久。

1. 接受私有 GitHub 仓库邀请，然后在终端克隆代码：

   ```bash
   git clone <private-repository-url>
   cd meeting-listening-lab
   ```

2. 双击 `setup.command`，或在终端运行：

   ```bash
   ./setup.command
   ```

   它只检查本机环境并给出修复提示，不会替你修改系统或自动安装软件。

3. 按检查结果完成 Codex 登录，并下载本地英文 Whisper 模型：

   ```bash
   codex login
   npm run setup:model
   ```

4. 双击 `start.command`。它会选择本机可用端口、启动服务并打开正确的本地页面。也可以在终端运行：

   ```bash
   ./start.command
   ```

5. 在“本地文件”中选择、拖入或按 `⌘V` 粘贴 MP3、M4A、WAV、MP4、MOV；需要导入飞书妙记时，再完成可选的 Lark 设置。

关闭运行 `start.command` 的终端窗口，或在该终端按 `Control-C`，即可停止服务。

## 系统要求

第一版仅验证 macOS，不保证 Windows 或 Linux 可用。

必需：

- Git
- Node.js 22 或更高版本
- FFmpeg（同时需要 `ffmpeg` 和 `ffprobe`）
- `whisper-cli`（whisper.cpp）
- Codex CLI，并已使用测试者自己的 ChatGPT/Codex 账号登录
- 本地 Whisper 英文模型 `.models/ggml-small.en.bin`

可选：

- `lark-cli`，仅在粘贴飞书/Lark 妙记链接时需要

使用 Homebrew 的 Mac 可以先安装常见依赖：

```bash
brew install node@22 ffmpeg whisper-cpp
```

安装 Codex CLI 后必须由当前测试者本人登录：

```bash
npm install -g @openai/codex
codex login
```

需要飞书妙记导入时，再安装并登录可选的 Lark CLI：

```bash
npm install -g @larksuite/cli
lark-cli auth login
```

安装后以 `npm run doctor` 的实际检查结果为准。Lark 缺失或未登录不应影响本地文件导入。

## 环境检查

随时运行：

```bash
npm run doctor
```

它会检查 Node.js 版本、FFmpeg、`whisper-cli`、Whisper 模型、Codex CLI 与 ChatGPT 登录状态，并单独提示可选的 Lark 状态。

也可以单独确认账号状态：

```bash
codex login status
lark-cli auth status --json
```

## 日常启动

推荐双击 `start.command`，它会自动选择空闲端口并打开浏览器。

也可以运行：

```bash
npm start
```

手动启动默认地址为 [http://127.0.0.1:4173](http://127.0.0.1:4173)。如端口被占用，可以改用另一个仅限本机的端口：

```bash
PORT=4174 npm start
```

可选环境变量：

- `PORT`：本地端口，默认 `4173`
- `LISTENING_DATA_DIR`：材料和学习数据目录，默认是项目内的 `.data/`
- `WHISPER_MODEL_PATH`：自定义 Whisper 模型文件路径
- `CODEX_ANALYSIS_BATCH_SIZE`：每批交给 Codex 的句子数，默认 `60`
- `SKIP_CODEX_ANALYSIS=1`：只做本地转写，不生成 Codex 讲解

请保留默认主机 `127.0.0.1`，不要设置 `HOST=0.0.0.0`。

## 主要能力

- 导入本地 MP3、M4A、WAV、MP4、MOV，或从 macOS「语音备忘录」复制后在页面中按 `⌘V` 粘贴
- 可选导入飞书/Lark 妙记链接，保留官方逐字稿和说话人时间戳
- 本地 Whisper 转写和时间校准；训练时播放真实原声
- 按自然分段听写、拖动进度、变速、手动循环、续听和独立左右滚动
- 核对听写差异，并按自然句展示中文意思、表达与语法
- 对选中表达继续问 Codex，将生成的知识点加入精确原句复习
- 本地记录已听覆盖度、需复习内容、材料排序、问问历史和最近位置
- 材料删除后进入本地垃圾桶，30 天内可以恢复

## 更新代码而不丢学习数据

`.data/` 和 `.models/` 已被 Git 忽略，正常 `git pull` 不会覆盖它们。更新前仍建议备份，尤其是保存了不可重新获取的会议材料时。

1. 停止本地服务。
2. 在 Finder 中复制一份 `.data/` 到项目目录之外，或在项目目录运行：

   ```bash
   cp -R .data ../meeting-listening-lab-data-backup
   ```

3. 拉取代码并重新检查环境：

   ```bash
   git pull --ff-only
   npm run doctor
   ```

4. 再次双击 `start.command`。

不要用 `git reset --hard`、清理未跟踪文件的命令或直接删除整个旧目录来“更新”。如果必须重新克隆，请先把旧目录中的 `.data/` 备份，再复制到新项目目录；`.models/` 可以复制，也可以重新运行 `npm run setup:model` 下载。

## 故障排查

### 页面显示“无法访问此网站”或 `ERR_CONNECTION_REFUSED`

- 确认运行 `start.command` 的终端仍然打开且没有报错。
- 重新双击 `start.command`，使用它实际打开或打印的地址；端口不一定总是 `4173`。
- 运行 `npm run doctor`，先修复标为缺失的必需项。

### macOS 不允许打开 `.command` 文件

第一次可在 Finder 中右键文件并选择“打开”。若文件没有执行权限，在项目目录运行：

```bash
chmod +x setup.command start.command
```

### 提示缺少模型

```bash
npm run setup:model
```

网络中断后可以重新运行；模型保存在 `.models/`，不会进入 Git。

### Codex 未登录或讲解一直失败

```bash
codex login
codex login status
npm run doctor
```

确认显示的是测试者自己的 ChatGPT/Codex 账号。不要在项目内创建或粘贴 API Key。

### 本地文件可用，但飞书链接不可用

这是可选的 Lark 环境未准备好。安装 `lark-cli` 后，使用自己的 Lark 账号登录，再用 `lark-cli auth status --json` 和 `npm run doctor` 检查。没有 Lark CLI 时仍可继续使用本地音视频。

### `ffmpeg`、`ffprobe` 或 `whisper-cli` 找不到

```bash
brew install ffmpeg whisper-cpp
npm run doctor
```

如果终端能找到命令但双击启动仍找不到，关闭并重新打开 Terminal 后再试。

### 手动 `npm start` 提示端口被占用

优先改用 `start.command` 自动选择空闲端口，或手动指定其他端口：

```bash
PORT=4174 npm start
```

## 删除材料与卸载

- 删除单份材料：在左侧材料库使用“删除”，材料会先进入本机垃圾桶，可在 30 天内恢复。
- 停止工具：关闭启动终端，或按 `Control-C`。本项目不会安装常驻云服务。
- 卸载但保留数据：先把 `.data/` 复制到项目目录之外，再把 `meeting-listening-lab` 文件夹移到 macOS 废纸篓。
- 永久删除全部本地材料：停止服务后，在 Finder 中显示隐藏文件并删除项目内的 `.data/`；模型位于 `.models/`，可以单独删除。

卸载项目不会自动卸载 Node.js、FFmpeg、whisper.cpp、Codex CLI 或 Lark CLI，因为其他本地工具也可能在使用它们。

## 开发者检查

```bash
npm run check
npm test
```

提交前再次确认：

```bash
git status
```

仓库中只能出现代码和公开文档，不能出现任何测试者的 `.data/`、`.models/`、`.env`、会议音视频、逐字稿或学习记录。
