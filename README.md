# prompt-slim

压缩「每一步都重发给模型的工具定义」——不改工具行为，只砍说明文字。

DSH 在每次请求前把当前可见的 80+ 个工具（名称、描述、完整 JSON Schema）整体发给模型，实测约 65 KB。其中大部分是散文式描述，参数结构只占小头。prompt-slim 在 `system-prompt/assemble` 阶段重写这份工具块：

- **保留**：工具名、参数名、`type` / `enum` / `const` / `required` / `items` / `oneOf` 等一切会改变模型填参行为的字段，顺序不变。
- **裁剪**：每个描述只留开头的完整句子（在句号、分号处断开），参数描述各自限量；多余空白压成单空格。
- **可逆**：原始描述始终在注册表里，`prompt_slim_help` 可按名字随时取回完整定义。

## 效果（本机 81 个生效工具实测）

| 配置 | 工具块 | 节省 |
| --- | --- | --- |
| 原始 | 65492 B（≈18.2k tokens） | — |
| 保守档 `200 / 60` | 43651 B（≈12.1k tokens） | 33.3% |
| **默认档 `160 / 40`** + `workflow: 1200` | 39812 B（≈11.1k tokens） | **39.2%** |
| `120 / 30` | 37072 B（≈10.3k tokens） | 43.4% |
| `100 / 20` | 34752 B（≈9.7k tokens） | 46.9% |
| `60 / 0`（丢弃参数描述） | 30000 B | 54.2% |
| `0 / 0`（只留名字和结构） | 26130 B | 60.1% |

默认档砍掉的几乎都是示例、重复叮嘱和长尾细节：工具的第一句（它做什么、关键约束）和参数的短说明都还在，所以模型仍然知道每个工具干什么、必填什么。`160 / 40` 之后每往下一档，省下的 token 边际收益变小、误用风险变大；再狠就用 `100 / 20`，并且配合 `prompt_slim_help` 让模型按需查全文。

## 配置

写在 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: prompt-slim
      name: dsh-prompt-slim
      config:
        toolDescriptionMax: 160      # 每个工具描述保留的字符数，0 = 全删
        parameterDescriptionMax: 40  # 每个参数描述保留的字符数
        keepTools: []                # 原样透传的工具名
        overrides:                   # 按工具单独放宽
          workflow: 1200
        minTools: 6                  # 可见工具少于这个数就不动
        helpTool: true               # 注册 prompt_slim_help
        logSavings: true             # 节省比例变化时写一条宿主日志
        mode: terse                  # off = 完全关掉
```

`workflow` 单独放宽，是因为它的描述本身就是脚本 API 文档（`agent()` / `pipeline()` / `parallel()` / `phase()`），压到 160 字符会丢掉用法。

## 安装

1. 取到本目录，链进 profile：

   ```sh
   git clone https://github.com/wsxuyue/dsh-prompt-slim ~/dsh-prompt-slim
   ln -s ~/dsh-prompt-slim ~/.dsh/profiles/web/node_modules/dsh-prompt-slim
   ```

2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾加上面那段 `insert`。

3. 依赖解析：本目录 `node_modules/@deepseek-ai/*` 是指向 DSH 安装目录 `.pnpm` 的符号链接（和 `dsh-mobile-shizuku` 的做法一致），换机器时重新指向即可。

改动 `cordis.patch.yml` 会被 loader 热加载，不需要重启 `dsh web`。

## 卸载

删掉 `cordis.patch.yml` 里的 `prompt-slim` 段即可；工具定义立刻恢复全量，无需重启。

## 设计取舍

- **不做「延迟加载」网关**：`deferLoading` 只对 Anthropic 有效，openai-compatible 适配器不看这个字段；用 `tool_call` 代理转发又会把工具调用渲染成嵌套 JSON、丢掉参数校验。压缩文本则是跨 provider 都成立的省法。
- **固定点**：压缩对自身输出幂等（已验证），同一份工具集每次产出完全相同的字节，不会因为描述抖动而破坏上游 prompt cache。
- **失败即放行**：重写包在 `try/catch` 里，插件自身出错时原样返回组装结果，绝不让一个提示词优化拖垮一次对话。

## 自测

```sh
node test/measure.mjs test/tools-captured.json   # 结构保真 + 节省比例
node test/plugin.test.mjs                        # 注册、重写、幂等、取回原文
```
