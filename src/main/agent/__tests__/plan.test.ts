import { describe, expect, it } from 'vitest'
import type { AgentBoard } from '../../../shared/types'
import {
  authorizeCall,
  buildExecInstruction,
  DELETE_TOOLS,
  executionToolDefs,
  FREE_TOOLS,
  makePlanTools,
  planningToolDefs,
  writeTargetOf
} from '../plan'

function boardOf(steps: Array<{ resource?: string; ids?: string[] }>): AgentBoard {
  return {
    id: 'b1',
    sessionId: 's1',
    projectId: 'p1',
    runId: 'r1',
    goal: '目标',
    steps: steps.map((s, i) => ({
      id: `st${i}`,
      title: `步骤${i}`,
      note: '',
      status: 'pending' as const,
      ...(s.resource ? { writeScope: { resource: s.resource as never, ids: s.ids ?? [] } } : {})
    })),
    ledger: '',
    status: 'approved',
    feedback: '',
    createdAt: 0,
    updatedAt: 0
  }
}

describe('authorizeCall 授权判定', () => {
  it('读工具/未知工具/衍生白名单放行', () => {
    const b = boardOf([])
    expect(authorizeCall('list_characters', {}, b).ok).toBe(true)
    expect(authorizeCall('spawn_subagent', {}, b).ok).toBe(true)
    expect(authorizeCall('save_summary', { outlineId: 'x' }, b).ok).toBe(true)
    expect(authorizeCall('update_character_state', { id: 'c1' }, b).ok).toBe(true)
    expect(authorizeCall('refresh_volume_summary', {}, b).ok).toBe(true)
  })

  it('删除类放行（confirm 层恒弹窗）', () => {
    expect(authorizeCall('delete_entity', { kind: 'character', id: 'c1' }, boardOf([])).ok).toBe(
      true
    )
    expect(authorizeCall('delete_outline', { id: 'o1' }, boardOf([])).ok).toBe(true)
    expect(DELETE_TOOLS.has('delete_entity')).toBe(true)
  })

  it('无看板时写工具拒绝', () => {
    const r = authorizeCall('save_character', { id: 'c1' }, null)
    expect(r.ok).toBe(false)
  })

  it('修改命中授权 id 放行；未授权 id 拒绝', () => {
    const b = boardOf([{ resource: 'character', ids: ['c1', 'c2'] }])
    expect(authorizeCall('save_character', { id: 'c1' }, b).ok).toBe(true)
    const r = authorizeCall('save_character', { id: 'c9' }, b)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('c9')
  })

  it('新建按资源类型放行；未授权资源拒绝', () => {
    const b = boardOf([{ resource: 'worldbuild', ids: [] }])
    expect(authorizeCall('save_worldbuild', { title: '新词条' }, b).ok).toBe(true)
    const r = authorizeCall('save_character', { name: '新人' }, b)
    expect(r.ok).toBe(false)
  })

  it('edit_text 按 kind 分流资源', () => {
    const b = boardOf([
      { resource: 'chapter', ids: ['o1'] },
      { resource: 'character', ids: ['c1'] }
    ])
    expect(
      authorizeCall('edit_text', { kind: 'chapter', id: 'o1', find: 'a', replace: 'b' }, b).ok
    ).toBe(true)
    expect(
      authorizeCall('edit_text', { kind: 'character', id: 'c1', find: 'a', replace: 'b' }, b).ok
    ).toBe(true)
    // chapter 授权不覆盖 character 目标
    expect(
      authorizeCall('edit_text', { kind: 'character', id: 'c9', find: 'a', replace: 'b' }, b).ok
    ).toBe(false)
  })

  it('章节写入按 outlineId 校验', () => {
    const b = boardOf([{ resource: 'chapter', ids: ['o1'] }])
    expect(authorizeCall('append_chapter', { outlineId: 'o1', text: 'x' }, b).ok).toBe(true)
    expect(authorizeCall('save_chapter', { outlineId: 'o2', content: 'x' }, b).ok).toBe(false)
  })

  it('无 id 的 instruction/project 类按资源出现放行', () => {
    const b = boardOf([
      { resource: 'instruction', ids: [] },
      { resource: 'project', ids: [] }
    ])
    expect(authorizeCall('update_instruction_section', { scope: 'global' }, b).ok).toBe(true)
    expect(authorizeCall('update_project', { title: 'x' }, b).ok).toBe(true)
    expect(
      authorizeCall('save_outline', { title: '插章' }, boardOf([{ resource: 'project', ids: [] }]))
        .ok
    ).toBe(false)
  })
})

describe('writeTargetOf 目标提取', () => {
  it('写工具返回 resource+id；读工具返回 null', () => {
    expect(writeTargetOf('list_characters', {})).toBeNull()
    expect(writeTargetOf('save_summary', {})).toBeNull() // FREE 工具不产生 NUDGE
    expect(writeTargetOf('save_character', { id: 'c1' })).toEqual({
      resource: 'character',
      id: 'c1'
    })
    expect(writeTargetOf('save_character', { name: '新' })).toEqual({ resource: 'character' })
    expect(writeTargetOf('edit_text', { kind: 'worldbuild', id: 'w1' })).toEqual({
      resource: 'worldbuild',
      id: 'w1'
    })
  })
})

describe('工具集筛选', () => {
  const mk = makePlanTools({ sessionId: 's', projectId: 'p', runId: 'r', persist: () => {} })

  it('计划期：写工具移出，plan 工具并入', () => {
    const names = new Set(planningToolDefs(mk.tools).map((d) => d.name))
    expect(names.has('propose_plan')).toBe(true)
    expect(names.has('get_board')).toBe(true)
    expect(names.has('update_board')).toBe(false) // 计划期未批准不可勾销
    expect(names.has('list_characters')).toBe(true)
    expect(names.has('spawn_subagent')).toBe(true)
    expect(names.has('compact_context')).toBe(true)
    for (const n of ['save_character', 'save_chapter', 'delete_entity', 'update_character_state']) {
      expect(names.has(n)).toBe(false)
    }
  })

  it('执行期：全集 + get_board/update_board，propose_plan 移出', () => {
    const names = new Set(executionToolDefs(mk.tools).map((d) => d.name))
    expect(names.has('propose_plan')).toBe(false)
    expect(names.has('get_board')).toBe(true)
    expect(names.has('update_board')).toBe(true)
    expect(names.has('save_character')).toBe(true)
    expect(names.has('delete_entity')).toBe(true)
  })

  it('FREE_TOOLS 与 DELETE_TOOLS 不相交', () => {
    for (const n of FREE_TOOLS) expect(DELETE_TOOLS.has(n)).toBe(false)
  })
})

describe('buildExecInstruction 执行指令', () => {
  it('含目标/步骤/授权范围/附加说明/硬账', () => {
    const b: AgentBoard = {
      ...boardOf([{ resource: 'character', ids: ['c1'] }]),
      goal: '给主角升级',
      feedback: '注意保持语气',
      ledger: '主角等级 3'
    }
    const text = buildExecInstruction(b)
    expect(text).toContain('给主角升级')
    expect(text).toContain('1. 步骤0')
    expect(text).toContain('character c1')
    expect(text).toContain('注意保持语气')
    expect(text).toContain('主角等级 3')
  })

  it('无授权步骤显示无写入', () => {
    const text = buildExecInstruction(boardOf([{}]))
    expect(text).toContain('本步骤无写入')
  })
})
