import type { ForeshadowStatus } from '../../shared/types.js'
import { buildStatusCard } from '../director/context.js'
import {
  activateLine,
  activeLine,
  createBook,
  deleteBook,
  deleteCard,
  deleteCharacter,
  deleteLine,
  effectiveChapters,
  forkLine,
  getBook,
  getCard,
  getChapter,
  getCharacter,
  listBooks,
  listCards,
  listCharacters,
  listForeshadows,
  listLines,
  listMessages,
  listVersions,
  saveCard,
  saveCharacter,
  saveForeshadow,
  updateBook
} from '../store.js'
import type { HandlerCtx, HandlerTable } from './types.js'

/** 书架/分叉树/设定卡/人物/伏笔/对话历史 */

type Domain = Pick<
  HandlerTable,
  | 'book:create'
  | 'book:list'
  | 'book:get'
  | 'book:update'
  | 'book:delete'
  | 'book:statusCard'
  | 'line:fork'
  | 'line:activate'
  | 'line:delete'
  | 'chapter:get'
  | 'chapter:versions'
  | 'card:list'
  | 'card:save'
  | 'card:delete'
  | 'character:list'
  | 'character:save'
  | 'character:delete'
  | 'foreshadow:list'
  | 'foreshadow:save'
  | 'message:list'
>

export const bookHandlers: Domain = {
  'book:create': (_ctx, [input]) => createBook(input),
  'book:list': () => listBooks(),
  'book:get': (_ctx, [bookId]) => {
    const book = getBook(bookId)
    if (!book) throw new Error('书不存在')
    const lines = listLines(bookId)
    const line = activeLine(book)
    const chapters = line
      ? effectiveChapters(line.id).map((c) => ({
          id: c.id,
          lineId: c.lineId,
          orderNo: c.orderNo,
          title: c.title,
          wordCount: c.wordCount,
          updatedAt: c.updatedAt
        }))
      : []
    return { book, lines, chapters }
  },
  'book:update': (_ctx, [bookId, patch]) => {
    const book = updateBook(bookId, patch)
    if (!book) throw new Error('书不存在')
    return book
  },
  'book:delete': (_ctx, [bookId, confirm]) => {
    if (!confirm) throw new Error('删除书需要二次确认')
    if (!deleteBook(bookId)) throw new Error('书不存在')
    return true
  },
  'book:statusCard': (_ctx, [bookId]) => buildStatusCard(bookId),
  'line:fork': (_ctx, [bookId, forkChapterId, name, note]) => {
    const line = forkLine(bookId, forkChapterId, name || '新线', note ?? '')
    if (!line) throw new Error('分叉失败：书或分叉点章节不存在')
    return line
  },
  'line:activate': (_ctx, [bookId, lineId]) => {
    if (!activateLine(bookId, lineId)) throw new Error('切线失败')
    return true
  },
  'line:delete': (_ctx, [lineId, confirm]) => {
    if (!confirm) throw new Error('删除线需要二次确认')
    if (!deleteLine(lineId)) throw new Error('线不存在')
    return true
  },
  'chapter:get': (_ctx, [chapterId]) => getChapter(chapterId),
  'chapter:versions': (_ctx, [chapterId]) => listVersions(chapterId),
  'card:list': (_ctx, [lineId, kind, q]) => listCards(lineId, { kind, q }),
  'card:save': (_ctx, [input]) => {
    const card = saveCard(input)
    if (!card) throw new Error('设定卡保存失败')
    return card
  },
  'card:delete': (_ctx, [cardId]) => {
    if (!getCard(cardId)) throw new Error('设定卡不存在')
    return deleteCard(cardId)
  },
  'character:list': (_ctx, [lineId, q]) => listCharacters(lineId, { q }),
  'character:save': (_ctx, [input]) => {
    const c = saveCharacter(input)
    if (!c) throw new Error('人物保存失败')
    return c
  },
  'character:delete': (_ctx, [characterId]) => {
    if (!getCharacter(characterId)) throw new Error('人物不存在')
    return deleteCharacter(characterId)
  },
  'foreshadow:list': (_ctx, [lineId, status]) =>
    listForeshadows(lineId, status as ForeshadowStatus | undefined),
  'foreshadow:save': (_ctx, [input]) => {
    const f = saveForeshadow(input)
    if (!f) throw new Error('伏笔保存失败')
    return f
  },
  'message:list': (_ctx, [bookId, chapterId]) =>
    listMessages(bookId, chapterId ? { chapterId } : undefined)
}

export type BookHandlers = Domain
