import { create } from 'zustand'
import { useAgentRunStore } from './agentRunStore'

/** 一个 tab 对应一个会话；sessionId=null 表示草稿 tab（每次项目同时至多一个草稿 tab） */
export interface AgentTab {
  key: string
  sessionId: string | null
}

interface ProjectTabs {
  tabs: AgentTab[]
  activeKey: string
}

interface AgentTabsState {
  byProject: Record<string, ProjectTabs>
  /** tab key → 输入框草稿 */
  drafts: Record<string, string>
  /** tab key → 滚动位置（切换 tab 保留阅读进度） */
  scrolls: Record<string, number>
  /** 首次进入项目时初始化：跟随 agentRunStore 当前活跃会话开一个 tab */
  ensure: (projectId: string) => void
  /** 打开（或激活已存在的）某会话的 tab */
  openTab: (projectId: string, sessionId: string) => void
  /** 新建草稿 tab（已有草稿 tab 则直接激活） */
  newDraftTab: (projectId: string) => void
  closeTab: (projectId: string, key: string) => void
  setActive: (projectId: string, key: string) => void
  /** active tab 跟随 agentRunStore.sessionId（草稿起步建会话/项目恢复时对账） */
  syncActiveSession: (projectId: string, sessionId: string | null) => void
  setDraft: (key: string, text: string) => void
  setScroll: (key: string, top: number) => void
  /** 删除会话后清掉对应 tab */
  dropSessionTabs: (projectId: string, sessionId: string) => void
}

let tabSeq = 0
const newKey = (): string => `t${++tabSeq}`

export const useAgentTabsStore = create<AgentTabsState>((set, get) => ({
  byProject: {},
  drafts: {},
  scrolls: {},

  ensure: (projectId) => {
    if (get().byProject[projectId]) return
    const key = newKey()
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: {
          tabs: [{ key, sessionId: useAgentRunStore.getState().sessionId }],
          activeKey: key
        }
      }
    }))
  },

  openTab: (projectId, sessionId) => {
    set((s) => {
      const cur = s.byProject[projectId]
      if (cur) {
        const hit = cur.tabs.find((t) => t.sessionId === sessionId)
        if (hit)
          return { byProject: { ...s.byProject, [projectId]: { ...cur, activeKey: hit.key } } }
        const key = newKey()
        return {
          byProject: {
            ...s.byProject,
            [projectId]: { tabs: [...cur.tabs, { key, sessionId }], activeKey: key }
          }
        }
      }
      const key = newKey()
      return {
        byProject: { ...s.byProject, [projectId]: { tabs: [{ key, sessionId }], activeKey: key } }
      }
    })
  },

  newDraftTab: (projectId) => {
    set((s) => {
      const cur = s.byProject[projectId]
      if (cur) {
        const draft = cur.tabs.find((t) => t.sessionId === null)
        if (draft)
          return { byProject: { ...s.byProject, [projectId]: { ...cur, activeKey: draft.key } } }
        const key = newKey()
        return {
          byProject: {
            ...s.byProject,
            [projectId]: { tabs: [...cur.tabs, { key, sessionId: null }], activeKey: key }
          }
        }
      }
      const key = newKey()
      return {
        byProject: {
          ...s.byProject,
          [projectId]: { tabs: [{ key, sessionId: null }], activeKey: key }
        }
      }
    })
  },

  closeTab: (projectId, key) => {
    set((s) => {
      const cur = s.byProject[projectId]
      if (!cur) return s
      const idx = cur.tabs.findIndex((t) => t.key === key)
      if (idx < 0) return s
      const tabs = cur.tabs.filter((t) => t.key !== key)
      const drafts = { ...s.drafts }
      const scrolls = { ...s.scrolls }
      delete drafts[key]
      delete scrolls[key]
      if (tabs.length === 0) {
        const nk = newKey()
        return {
          byProject: {
            ...s.byProject,
            [projectId]: { tabs: [{ key: nk, sessionId: null }], activeKey: nk }
          },
          drafts,
          scrolls
        }
      }
      const activeKey = cur.activeKey === key ? tabs[Math.max(0, idx - 1)].key : cur.activeKey
      return { byProject: { ...s.byProject, [projectId]: { tabs, activeKey } }, drafts, scrolls }
    })
  },

  setActive: (projectId, key) => {
    set((s) => {
      const cur = s.byProject[projectId]
      if (!cur?.tabs.some((t) => t.key === key)) return s
      return { byProject: { ...s.byProject, [projectId]: { ...cur, activeKey: key } } }
    })
  },

  syncActiveSession: (projectId, sessionId) => {
    set((s) => {
      const cur = s.byProject[projectId]
      if (!cur) return s
      const tab = cur.tabs.find((t) => t.key === cur.activeKey)
      if (!tab || tab.sessionId === sessionId) return s
      return {
        byProject: {
          ...s.byProject,
          [projectId]: {
            tabs: cur.tabs.map((t) => (t.key === tab.key ? { ...t, sessionId } : t)),
            activeKey: cur.activeKey
          }
        }
      }
    })
  },

  setDraft: (key, text) => {
    set((s) => ({ drafts: { ...s.drafts, [key]: text } }))
  },

  setScroll: (key, top) => {
    set((s) => ({ scrolls: { ...s.scrolls, [key]: top } }))
  },

  dropSessionTabs: (projectId, sessionId) => {
    set((s) => {
      const cur = s.byProject[projectId]
      if (!cur) return s
      const tabs = cur.tabs.filter((t) => t.sessionId !== sessionId)
      if (tabs.length === cur.tabs.length) return s
      if (tabs.length === 0) {
        const nk = newKey()
        return {
          byProject: {
            ...s.byProject,
            [projectId]: { tabs: [{ key: nk, sessionId: null }], activeKey: nk }
          }
        }
      }
      const activeKey =
        cur.tabs.find((t) => t.key === cur.activeKey)?.sessionId === sessionId
          ? tabs[0].key
          : cur.activeKey
      return { byProject: { ...s.byProject, [projectId]: { tabs, activeKey } } }
    })
  }
}))
