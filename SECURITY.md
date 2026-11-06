# Security

This repository does not need API keys, SSH keys, GitHub tokens or server passwords to run.
Never commit private subtitle files, credentials, browser profiles or `.env` files.

CI scans the complete Git history and current files using Gitleaks. The scanner binary is
version-pinned and verified against a fixed SHA-256 checksum. Findings are fully redacted.
You can run the same check on Linux with `bash tools/scan-secrets.sh`.

Extraction, OCR and merging read videos in a local browser. Translation uploads subtitle
text to sub2learn.com and its translation providers; use it only for material you may share.

Report security issues privately to **websitejava@outlook.com**. Do not put working keys
or private subtitle contents in a public issue. Rotate a leaked credential at its provider;
removing it from the latest commit does not revoke it or remove it from Git history.

---

本仓库运行不需要 API Key、SSH 私钥、GitHub Token 或服务器密码。
不要提交私人字幕、凭据、浏览器配置或 `.env` 文件。

CI 使用 Gitleaks 扫描全部 Git 历史和当前文件，扫描程序固定版本并验证 SHA-256；
扫描结果中的密钥值全部脱敏。Linux 本地可运行 `bash tools/scan-secrets.sh`。

提取、OCR 和合并在本地浏览器内完成；翻译会把字幕文本提交给 sub2learn.com 及翻译服务。
安全问题请私下联系 **websitejava@outlook.com**，不要在公开 Issue 中贴有效密钥或私人字幕。
发现凭据泄漏后应在服务商处吊销；仅删除最新代码中的值不会使密钥失效，也不会清除 Git 历史。
