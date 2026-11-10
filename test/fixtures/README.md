# test/fixtures

`session.jsonl.zstd` 是一份**真实抓取的 dsh 会话日志**，用于测试 Claude transcript 合成与持久日志解码。

- 来源：本机 `dsh --profile loader-e2e-b "<任务>"` 的真实 headless 会话
  （loader 的 e2e 验证），会话里包含 read / edit / pwsh 工具调用以及一次 Stop 文档闸 steer。
- 脱敏：会话 id 换为 `session-fixture-0001`；用户目录/临时目录/vault 路径分别替换为
  `D:\sandbox\tester`、`D:\work`、`D:\plugins\vibe-flow`；任何超过 240 字符的文本截断为
  90 字符 + `…[redacted for fixture]`；`assistant/chunk`、`text-chunks`、`reasoning-chunks`
  每类只保留 1 条样本（结构保真，体积可控）。
- 格式：与 jsonl 后端一致的“多 zstd frame 拼接”文件，第一行是 `{type:"session",…}` 头，
  其后是 `SessionEvent` 记录（真实会话里还含 packed chunk 行）。
- 重新生成：见仓库提交历史 / e2e evidence；不要手工编辑这个二进制 fixture。
