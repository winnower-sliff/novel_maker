# 任务交接板

> **用途**：长任务的执行状态外置。会话被中断/达到限制后，任何新会话读此文件即可无损续做。
> **纪律**（写入 AGENTS.md 的约定）：
> 1. 长任务（多文件/多轮）**动手前**先把计划写到这里，再开工；
> 2. 每完成一步就更新勾选与「下一步」，不等任务全做完才写；
> 3. 新会话开始时若本文件有未完成任务，**先续做它**，不接新需求；
> 4. 任务完成（commit+push+部署）后清空回本模板。

---

## 当前任务：修「chat 三连中断」——thinking 吃光输出预算静默退出

### 根因（已查实）
- 三次 chat job（20ad0475/8e566317/37321869，deepseek-v4-pro）末轮 usage out:8192=顶格，
  finish_reason=length：思考计入输出 token，预算耗尽→正文/工具全空
- loop.ts 518 行「空文本+无工具」路径直接 return 占位符「（导演没有说话）」——用户视角=中途停止

### 步骤
- [ ] loop.ts：stopReason==='max_tokens' 且空响应时不静默退出——推 nudge 消息让模型压缩思考直接作答；
      第二次 nudge 时 maxTokens 提到 16384；nudge 上限 2 次，仍空则返回可见错误文案+console.warn
- [ ] 门禁：tsc 主+mobile、biome、build
- [ ] 回归：m2/m4/m5/m6 冒烟（chat 链路改动跑 m5 重点）
- [ ] deploy（主进程改动必须 deploy）+ commit + push（上次 1374215 也待补 push，网络故障）

### 已知坑 / 关键决策
- llmOpenai 已把 finish_reason=length 映射成 stopReason='max_tokens'，callRaw 原样返回——loop 侧直接可用
- nudge 推 user 消息会产生连续两条 user role（OpenAI 协议接受）
- chat job thinking:'enabled'（jobs.ts 581）→ maxTokens 8192（loop.ts 492 三元）

### 下一步
- 改 src/main/agent/loop.ts 478-520 段

<!-- 模板：
## 当前任务：<一句话任务名>

### 目标 / 验收
- <做成什么样算完>

### 步骤
- [ ] 步骤1（含涉及文件）
- [x] 步骤2 ✅ 已提交 <commit>
- [ ] 步骤3

### 已知坑 / 关键决策
- <本轮发现的坑、用户拍板的决策>

### 下一步
- <中断恢复后从这继续，精确到文件与操作>

### 状态
- 进行中 | 已提交待部署 | 已完成待验收
-->
