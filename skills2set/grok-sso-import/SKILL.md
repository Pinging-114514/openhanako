---
name: grok-sso-import
description: "把 Grok 网页 SSO cookie（sso / sso-rw）换成官方 Build OAuth，写入 Hana 现有 Grok OAuth 账号列表。当用户要导入 Grok SSO、粘贴 sso cookie、SSO 换 OAuth、把网页登录加进 Grok 账号列表时使用。
  MANDATORY TRIGGERS: grok sso, grok sso cookie, sso-rw, 导入 grok, 导入 Grok SSO, SSO 换 OAuth, grok oauth 列表, ConvertSSOToBuild"
---

# Grok SSO → OAuth 导入

把 Grok 网页的 `sso` / `sso-rw` cookie 换成官方 Build OAuth，写入 `~/.hanako/oauth-accounts.json` 的 `xai-oauth` 列表。不持久化 raw SSO。

## 红线

- 不要让用户把 cookie / JWT 贴进聊天。已经贴进来就立刻改口：请他写到本地文件，再跑脚本。
- 不要把 cookie、access、refresh 写进回复、日志或 SKILL 正文。
- 命令行不要跟 raw token（会进进程列表）。只用 `--file` 或 `--token-env`。
- 脚本成功时只回报邮箱 / 是否写入 / 失败码。

## 怎么跑

票先落到文件，一行一个，或 `sso=...` / `Cookie: sso=...`：

```bash
node skills2set/grok-sso-import/scripts/import-grok-sso.mjs --file %TEMP%\grok-sso.txt
```

多张票：

```bash
node skills2set/grok-sso-import/scripts/import-grok-sso.mjs --file a.txt --file b.txt
```

已装到用户目录时：

```bash
node "%USERPROFILE%\.hanako\skills\grok-sso-import\scripts\import-grok-sso.mjs" --file %TEMP%\grok-sso.txt
```

默认**不切换**当前 Grok 号，只追加/更新列表。要切到刚导入的号才加 `--activate`。

本机 Node 出不去 xAI 时，用月卡站换票口（凭据走环境变量，不要写进聊天）：

```bash
set SUB2API_EMAIL=...
set SUB2API_PASSWORD=...
node skills2set/grok-sso-import/scripts/import-grok-sso.mjs --converter sub2api --file %TEMP%\grok-sso.txt
```

`--converter auto`（默认）：先本地 ConvertSSOToBuild，网络失败再尝试 sub2api。

## 跑完

1. 看脚本打印的邮箱列表，确认张数。
2. 设置页打开 Grok OAuth 账号列表，点刷新。
3. Hana 当时开着的话，脚本会打本机 `/api/auth/oauth/xai-oauth/accounts?refresh=1` 让列表立刻可见。
4. 导入用的临时文件删掉。
