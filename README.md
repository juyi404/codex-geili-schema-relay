# codex-geili-schema-relay

让 Codex Desktop 通过 OpenAI 兼容的转售网关（GeiliAPI 等）**稳定使用 Gemini 模型**的本地中转。

零依赖、单文件（Node.js ≥ 18），监听 `http://127.0.0.1:18766`，把请求转发到上游
（默认 `https://sub.geiliapi.com/v1`）。GPT / Claude 请求**原字节直通、零改写、零开销**；
只有 gemini 模型的请求会被按需修复。

## 为什么需要它

Codex 发出的是 OpenAI Responses 格式的请求，转售网关将其翻译给 Google Gemini 后端。
这条链路上有一串实际踩到过的坑，每一个都会让对话直接报错：

| 症状（Codex 里看到的报错） | 根因 | 中转的对策 |
| --- | --- | --- |
| `functionDeclaration ... schema didn't specify the schema type field` | Gemini 要求每个参数 schema 显式写 `type`；而工具定义里大量使用 `anyOf: [T, null]`（可空参数）、裸节点、`$ref` 等写法，网关翻译时会把 `anyOf` 整个丢掉，留下无类型节点 | schema 清洗：`anyOf`/`oneOf` 压平（null 成员转 `nullable`）、`$ref`/`$defs` 就地展开、`allOf` 合并、`type` 数组转 `type + nullable`、字符串 `const` 转单值 `enum`、非字符串 enum 转 description 提示、缺失 `type` 自动推断、草案关键字（`not`/`if`/`patternProperties` 等）移除 |
| `Invalid JSON payload received. Unknown name "anthropic_version"/"messages"/...` | 网关的模型池按请求随机分配上游通道，个别通道"方言"配置错误（把请求转成 Anthropic 格式发给了 Gemini 后端） | 识别该失败签名后自动重发（重新分配通道），最多 2 次退避重试；其他错误（如余额不足）原样透传 |
| `Requests ending with a model turn are not supported` | 回复被截断后，对话历史以"半截的模型发言"结尾，Gemini 拒收，对话被永久卡死 | 自动补一条"请从中断处精确继续"的用户回合，模型真正从断点续写（已实测验证续写语义正确） |
| `stream disconnected ... reason: max_output_tokens` | Gemini 单次回复有约 6 万 token 的硬性输出上限（含隐藏思考），一次性生成大文件必撞 | 向每个 gemini 请求注入 `<output_budget>` 纪律（分块写文件、控制单次回复长度），约 70 token 且位置稳定、走 prompt cache；撞上限时由上一条的断点续写兜底 |
| 偶发 502 / 连接重置 | 上游 TCP 瞬断 | 在"尚未收到任何响应字节"的安全窗口内退避重试，避免 Codex 重传整个大请求 |

## 安装

1. 把本目录放到 `%USERPROFILE%\.codex\compat\geili-schema-relay\`（或任意位置）。
2. 在 `~/.codex/config.toml` 里把自定义 provider 的 `base_url` 指向中转：

   ```toml
   model_provider = "custom"

   [model_providers.custom]
   name = "GeiliAPI"
   base_url = "http://127.0.0.1:18766/v1"
   wire_api = "responses"
   requires_openai_auth = true
   supports_websockets = false
   experimental_bearer_token = "sk-..."   # 你的网关密钥
   ```

3. 启动（幂等，已在运行则跳过）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File start.ps1
   ```

4. 开机自启 + 自愈（可选，推荐）。注册计划任务：登录时启动，并每 2 分钟检查一次
   （启动脚本幂等，已在运行则直接退出；经 `start-hidden.vbs` 启动，完全无窗口闪烁）：

   ```powershell
   $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo ""$env:USERPROFILE\.codex\compat\geili-schema-relay\start-hidden.vbs"""
   $t1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   $t2 = New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
   $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable
   Register-ScheduledTask -TaskName 'CodexGeiliSchemaRelay' -Action $action -Trigger $t1,$t2 -Settings $settings -Force
   ```

   不要用 HKCU Run 键：它只在登录瞬间尝试一次，失败没有补救，进程日间退出也无人拉起
   （实测踩过：重启后 Run 键未生效，Codex 全线"重新连接"）。

5. 重启 Codex Desktop 使 provider 配置生效。

## 验证

```bash
node --test relay.test.mjs      # 单元测试（11 项，离线）
node verify-live.mjs --relay    # 经中转请求真实模型，验证工具调用链路
node verify-codex.mjs --turn    # 用 codex app-server 跑一个完整的真实回合
curl http://127.0.0.1:18766/health
```

## 运行时观测

`/health` 返回服务名、代码摘要和归一化计数。`relay.log` 每个被修改的请求一行：

| 日志事件 / 字段 | 含义 |
| --- | --- |
| `gemini_schema_normalized` + `count` | 本请求清洗的 schema 节点数 |
| `max_output_tokens` | 客户端实际携带的输出上限（Codex 通常为 null） |
| `appended_continue_turn: true` | 触发了断点续写 |
| `output_guidance: true` | 注入了输出纪律 |
| `upstream_misroute_retry` | 踩到错配通道，已自动重发 |
| `upstream_connect_retry` | 连接层瞬断，已自动重发 |

日志只含事件元数据，**不记录请求内容、对话文本或密钥**。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RELAY_PORT` | `18766` | 监听端口 |
| `RELAY_UPSTREAM` | `https://sub.geiliapi.com/v1` | 上游网关地址 |
| `CODEX_HOME` | `~/.codex` | verify 脚本读取配置的位置 |
| `CODEX_EXE` | 自动发现 | verify-codex 使用的 codex.exe 路径 |

## 卸载

把 `config.toml` 里的 `base_url` 改回上游地址，删除计划任务
（`Unregister-ScheduledTask CodexGeiliSchemaRelay -Confirm:$false`），
停掉 18766 端口上的进程即可。

## 设计原则

- **最小侵入**：只修 Gemini 链路上实测会炸的东西，每条规则都对应一个真实报错和一个回归测试；
- **GPT 零开销**：请求体不含 `gemini` 字样时连 JSON 解析都跳过，原字节透传；
- **缓存友好**：注入内容位置稳定，不破坏 Codex 的 prompt cache；
- **安全重试**：只在"未向客户端发送任何字节"的窗口内重试，用户取消的请求绝不重发。

## License

MIT
