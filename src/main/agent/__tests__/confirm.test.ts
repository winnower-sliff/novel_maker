import { describe, expect, it } from 'vitest'
import { ConfirmRegistry } from '../policy/confirm'

const info = (id: string) => ({
  confirmId: id,
  toolName: 'delete_chapter',
  input: { id: 'c1' },
  dangerReason: '删除操作不可恢复'
})

describe('ConfirmRegistry', () => {
  it('wait 挂起后 resolve 放行', async () => {
    const reg = new ConfirmRegistry()
    const p = reg.wait(info('c1'))
    expect(reg.peekPending()?.confirmId).toBe('c1')
    expect(reg.resolve('c1', true, false)).toBe(true)
    await expect(p).resolves.toBe(true)
    expect(reg.peekPending()).toBeNull()
  })

  it('resolve false 拒绝', async () => {
    const reg = new ConfirmRegistry()
    const p = reg.wait(info('c1'))
    reg.resolve('c1', false, false)
    await expect(p).resolves.toBe(false)
  })

  it('always 放行加入白名单，拒绝不加入', async () => {
    const reg = new ConfirmRegistry()
    const p1 = reg.wait(info('c1'))
    reg.resolve('c1', true, true)
    await p1
    expect(reg.isAlwaysAllowed('delete_chapter')).toBe(true)

    const p2 = reg.wait(info('c2'))
    reg.resolve('c2', false, true)
    await p2
    expect(reg.isAlwaysAllowed('delete_chapter')).toBe(true)
  })

  it('未知的 confirmId resolve 返回 false', () => {
    const reg = new ConfirmRegistry()
    expect(reg.resolve('ghost', true, false)).toBe(false)
  })

  it('cancelAll 全部按拒绝收场', async () => {
    const reg = new ConfirmRegistry()
    const p1 = reg.wait(info('c1'))
    const p2 = reg.wait(info('c2'))
    reg.cancelAll()
    await expect(p1).resolves.toBe(false)
    await expect(p2).resolves.toBe(false)
    expect(reg.peekPending()).toBeNull()
  })
})
