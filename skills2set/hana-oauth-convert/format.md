# Hana OAuth 凭证格式

Hana 认的 Grok 槽位键是 `xai-oauth`。凭证对象必须满足：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `"oauth"` | 是 | 不是这个，Hana 当普通 API Key 或直接丢掉 |
| `access` | string | 是 | Build access token |
| `refresh` | string | 是 | 刷新用；没有就不能续期 |
| `expires` | number | 是 | **毫秒**时间戳，不是秒 |
| `tokenEndpoint` | string | 建议 | 固定 `https://auth.x.ai/oauth2/token` |
| `idToken` | string | 否 | 有就留下，给邮箱/sub 兜底 |
| `email` | string | 否 | 列表展示用；没有就靠后来 userinfo |

不要改字段名（不要写成 `access_token` / `refresh_token` / `expires_in`）。

单号文件：上面这个对象本身。多号清单（`--bundle`）是：

```json
{
  "version": 1,
  "kind": "hana-oauth-bundle",
  "provider": "xai-oauth",
  "accounts": [
    { "email": "user@example.com", "credential": { "type": "oauth" } }
  ]
}
```
