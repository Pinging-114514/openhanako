---
name: hana-oauth-convert
description: "Converts Grok Web SSO cookies (sso / sso-rw) into HanaAgent xai-oauth credential JSON. Use when converting Grok SSO to Hana OAuth format, exporting a credential Hana can read, or packaging SSO into auth.json / oauth-accounts shape.
  MANDATORY TRIGGERS: hana oauth convert, grok sso convert, sso to hana, Hana OAuth 格式, 转换成 Hana 凭证, xai-oauth json"
compatibility: "Node 18+. Optional HTTPS_PROXY for xAI. Writes JSON files only; does not touch ~/.hanako."
---

# Hana OAuth 转换

把 Grok 网页 SSO 换成 Hana 能直接认的 `xai-oauth` 凭证 JSON。只做转换和落盘，不写金库、不调 Hana、不绑任何站点。

## 红线

- 票进文件或环境变量，不要进聊天、不要当命令行参数。
- 不要把 cookie / access / refresh 打进回复。
- 输出文件当密钥：权限收紧，用完再决定怎么导入。

## 命令

```bash
node scripts/convert.mjs --file %TEMP%\grok-sso.txt --out %TEMP%\hana-oauth
```

多张票就多个 `--file`，或文件里一行一张。出不去 xAI 时加代理：

```bash
node scripts/convert.mjs --file sso.txt --out out --proxy http://127.0.0.1:7890
```

标准输出只报邮箱、输出路径、失败码。

## 输出格式

每个成功的号写一个文件，内容就是 Hana `auth.json` 里 `xai-oauth` 槽 / `oauth-accounts.json` 里 `credential` 的那份对象：

```json
{
  "type": "oauth",
  "access": "<redacted>",
  "refresh": "<redacted>",
  "expires": 1789000000000,
  "tokenEndpoint": "https://auth.x.ai/oauth2/token",
  "email": "user@example.com"
}
```

`idToken` 有才写。字段说明见 [format.md](format.md)。

导入仍是另一步：把这份对象放进对应 provider 槽，或交给会写金库的工具。本技能不负责导入。
