/**
 * 智能体 agentic loop 的域模块：
 * - toolkit：常量与工具入参助手
 * - tools：38 个项目工具注册表
 * - loop：主/子代理共用的循环骨架
 * - executor：单轮工具调用执行（阶段②在此落地只读并发）
 * - policy/：确认/压缩/续跑策略（钩子注入骨架）
 * - subagent：只读调研子智能体（组装 runLoop）
 * - run：主入口 / 确认注册表 / 系统提示
 * 本文件仅做聚合导出，保持 `from './agent'` 导入路径不变。
 */

export {
  cancelAgentConfirms,
  getAgentPendingConfirm,
  getAgentToolResultStatuses,
  resolveAgentConfirm,
  runAgent
} from './run'
export { AGENT_MAX_TOKENS } from './toolkit'
export { getToolDefs } from './tools'
