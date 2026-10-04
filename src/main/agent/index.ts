/**
 * 智能体 agentic loop 的域模块：
 * - toolkit：常量与工具入参助手
 * - tools：25 个项目工具注册表
 * - subagent：只读调研子智能体
 * - run：主循环 / 确认机制 / 系统提示
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
