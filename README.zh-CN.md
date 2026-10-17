# Sub2Learn Skill —— 让你的 AI 帮你处理电影字幕

[![test](https://github.com/jwsky/sub2learn-skill/actions/workflows/test.yml/badge.svg)](https://github.com/jwsky/sub2learn-skill/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) · **中文**

这是一个给 **Claude Code、Codex 等 AI 智能体**用的 Skill：AI 会用无头浏览器打开 [sub2learn.com](https://sub2learn.com)，替你完成字幕的**提取**、**合并**和**翻译**——包括蓝光图形字幕的 OCR，以及「只翻你英语水平以上的句子」的学习型翻译。没有显示器的 **Linux VPS** 也能跑，视频本身不会离开你的机器。

## 能让 AI 做什么

| 对 AI 说 | 实际发生 |
|---|---|
| 「把 `movie.mkv` 里的英文和中文字幕合成一个文件」 | `merge` → 一个双语 SRT：英文在上、中文在下，按英文时间轴对齐 |
| 「中文放上面」 | `merge --top chi --bottom eng` |
| 「把 `movie.mkv` 的字幕导出来」 | `extract` → 每条文本字幕轨各存一个 `.srt` |
| 「中文那条是图片字幕，转成文字」 | `extract --track N` → 本地 OCR 蓝光 PGS 字幕 |
| 「用 `movie.en.srt` 做一份四级水平的学习字幕」 | `translate --level cet4` → 只有超过四级的句子加中文，其余保留英文练语感 |
| 「全部翻成繁体中文」 | `translate --level all --to zh-Hant` |
| 「把这两个 SRT 合并」 | `merge-srt`（纯本地，不开浏览器） |

可以直接这样说：

- 「用 sub2learn 技能，把 ~/videos/Arrival.mkv 的英文轨和简体中文轨合并成双语字幕。」
- 「我是六级水平，用 ~/subs/show.s01e01.en.srt 做一份双语字幕，只翻我大概率不认识的句子。」
- 「列出 movie.mkv 的字幕轨，把 PGS 英文轨 OCR 出来，再和中文轨合并。」

## 安装

### Claude Code

在 Claude Code 里用插件市场：

```text
/plugin marketplace add jwsky/sub2learn-skill
/plugin install sub2learn@sub2learn-skill
```

或者用安装脚本（会顺带完成下面的环境准备）：

```bash
curl -fsSL https://raw.githubusercontent.com/jwsky/sub2learn-skill/main/install.sh | bash -s -- --claude
```

想先看脚本内容？先 clone，再在仓库里执行：

```bash
git clone https://github.com/jwsky/sub2learn-skill
bash sub2learn-skill/install.sh --claude      # 或 --codex，也可以两个都加
```

### Codex

直接让 Codex 用它自带的 skill 安装器：

```text
Install the skill from https://github.com/jwsky/sub2learn-skill/tree/main/skills/sub2learn
```

或者：`curl -fsSL https://raw.githubusercontent.com/jwsky/sub2learn-skill/main/install.sh | bash -s -- --codex`

### 其他智能体

```bash
git clone --depth 1 https://github.com/jwsky/sub2learn-skill.git
cd sub2learn-skill/skills/sub2learn && bash scripts/setup.sh
```

然后告诉 AI：「阅读 sub2learn-skill/skills/sub2learn/SKILL.md 并按它操作。」

Skill 第一次使用时会先自检（`doctor`），缺浏览器或 npm 包就自动跑 `scripts/setup.sh`，所以通过插件市场或 skill 安装器装好后不需要额外步骤。

## 环境要求

| | |
|---|---|
| Node.js | 20 或更高（Playwright 1.63 的要求） |
| 浏览器 | Playwright 自带的 Chromium（默认；支持 x86_64 和 ARM64），**或** Google Chrome / Edge / 系统 Chromium |
| 系统 | Linux，包括服务器（已测：Ubuntu 24.04 ARM64；CI 里测 Ubuntu 24.04 x86_64）。无头运行，不需要显示器；root 运行没问题。macOS 理论上同样可用，但未测试。 |
| 内存 | 提取/合并/翻译约 400 MB，带 OCR 约 550 MB 起（用自带样例实测）；建议预留 1 GB，OCR 预留 2 GB |
| 磁盘 | Playwright 的 Chromium 约 650 MB（`--shell-only` 约 270 MB） |
| 网络 | 能访问 `https://sub2learn.com` |

Linux VPS 说明：

- **Debian / Ubuntu**：用 root（或有 sudo）执行 `bash scripts/setup.sh`，会把 Chromium **和**它需要的系统库一起装好。
- **RHEL / Alma / Rocky / CentOS Stream**：最省事的是装 Google Chrome 的 RPM（会自动带上所有依赖），然后用 `--browser chrome`：
  `sudo dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm && bash scripts/setup.sh --browser none`
- **ARM64**（Ampere、Graviton 等）：用默认的 Playwright Chromium；本 Skill 就是在 ARM64 Ubuntu VPS 上开发测试的。
- 已经有一个带 `--remote-debugging-port` 的 Chrome 在跑？加 `--cdp http://127.0.0.1:9222` 直接接管。

更多：[skills/sub2learn/references/vps-setup.md](skills/sub2learn/references/vps-setup.md)（英文）

## 工作原理

```
 你的 AI ──► node scripts/s2l.mjs merge movie.mkv
                  │  Playwright 启动无头 Chromium / Chrome
                  ▼
           https://sub2learn.com（就是普通的公开网页）
                  │
  MKV/WebM ───────┤ 网页里的 Web Worker 通过 File API 从你的硬盘流式读取，
  （留在本机）     │ 只留字幕数据包；PGS 图片用 Tesseract（WASM）本地 OCR
                  │ → 轨道列表 · SRT · 双语合并
                  │
  字幕文本 ────────┤ 只有 translate 会上传 SRT 文本；网站标出超过你水平的句子，
  （仅翻译时）     │ 只翻这些（Bing，失败自动切 Google）
                  ▼
           下载的文件存到原文件旁边（或 --out 指定的位置）
```

AI 用的就是普通人用的同一个网页，所以结果和网站完全一致，也不需要装 ffmpeg / Tesseract。

## 命令

在 Skill 目录（`skills/sub2learn`）下运行，每条命令在 stdout 输出一个 JSON（进度在 stderr）。

| 命令 | 用途 |
|---|---|
| `node scripts/s2l.mjs doctor` | 检查 Node、Playwright、浏览器和网站 |
| `node scripts/s2l.mjs tracks movie.mkv` | 列出轨道（文本/图形字幕、语言、条数） |
| `node scripts/s2l.mjs extract movie.mkv [--lang eng] [--track N] [--ocr]` | 把字幕轨存成 SRT；图形轨自动 OCR |
| `node scripts/s2l.mjs merge movie.mkv [--top eng] [--bottom chi]` | 两条轨 → 一个双语 SRT |
| `node scripts/s2l.mjs translate movie.en.srt [--level cet4] [--to zh-Hans] [--mode both\|only]` | 按水平翻译（SRT、VTT、ASS/SSA、SBV 或视频里的某条轨） |
| `node scripts/s2l.mjs merge-srt top.srt bottom.srt` | 本地合并两个字幕文件 |
| `node scripts/s2l.mjs selftest [--with-ocr] [--with-translate]` | 用自带样例做端到端自测 |

水平：`all`（全翻）· `kindergarten`（约 1000 词）· `primary` / `middle` / `cet4`（约 3000 词）· `high` / `cet6`（约 6000 词）。
完整参考：[skills/sub2learn/references/commands.md](skills/sub2learn/references/commands.md) · 给 AI 的说明：[skills/sub2learn/SKILL.md](skills/sub2learn/SKILL.md)

## 隐私

| 命令 | 会离开你机器的内容 |
|---|---|
| `tracks`、`extract`、`merge` | 视频的任何内容都不会——它在本机浏览器里读取；OCR 也在本机 |
| `translate` | 字幕文本：会上传到 sub2learn.com（网站会保存上传的字幕文件），需要翻译的句子由网站服务器发给 Bing/Google |
| `merge-srt` | 无 |

## 常见问题

**免费吗？** 免费。翻译用的是网站共享的免费 Bing 额度（用完自动切 Google），所以请一次处理一个文件，不要批量循环轰炸。

**MP4 / AVI 呢？** 网站只读 Matroska（`.mkv`、`.webm`）。其他格式先拿到 `.srt`（比如 `ffmpeg -i in.mp4 -map 0:s:0 out.srt`），再用 `translate` 或 `merge-srt`。

**DVD 的 VobSub 图形字幕？** 网站暂不支持；蓝光 PGS 支持。

**两条轨怎么对齐？** 上行轨保留自己的时间轴；下行轨里与之时间重叠的每一条都放到它下面（去重）。两条轨之间几百毫秒的偏差能正确配对。

**为什么用浏览器而不是 ffmpeg？** 结果与网站一致、不依赖本地工具链、自带图形字幕 OCR，网站改进后 AI 也能直接受益，不用更新 Skill。

## 开发

```bash
cd skills/sub2learn && npm ci && npx playwright install chromium
node scripts/s2l.mjs selftest --with-ocr --with-translate
python3 tools/make-samples.py      # 重新生成样例视频（需要 Pillow + ffmpeg）
```

CI 在 Ubuntu 24.04（x86_64）上分别用 Playwright Chromium 和 runner 自带的 Google Chrome 跑自测。

## 联系

网站：[sub2learn.com](https://sub2learn.com) · 邮箱：websitejava@outlook.com · 许可证：[MIT](LICENSE)
