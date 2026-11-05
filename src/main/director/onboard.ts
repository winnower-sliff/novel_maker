import type { Book, CardKind, CharacterState } from '../../shared/types.js'
import {
  appendMessage,
  getBook,
  listMessages,
  saveCard,
  saveCharacter,
  updateBook
} from '../store.js'
import { callJson } from './callJson.js'
import { directorPersona } from './prompts.js'

/**
 * 开书引导（B1 分阶段确认 / B2 红线 / B3 文风 / B4 字数）：
 * premise（3-6 轮选择题）→ world 草案确认 → characters 草案确认 → title/简介/轻骨架 → done。
 * 历史落 messages 表；阶段与草案存 assistant 消息 meta。
 */

export type OnboardStage = 'premise' | 'world' | 'characters' | 'title' | 'done'

export interface OnboardReply {
  reply: string
  options: string[]
  stage: OnboardStage
  /** 本阶段产出的草案（world=卡片区/characters=人物/title=书名组） */
  draft?: WorldDraft | CharactersDraft | TitleDraft
  done?: boolean
}

export interface WorldDraft {
  cards: Array<{
    kind: CardKind
    title: string
    readerText: string
    authorText: string
    revealPlan: string
  }>
}

export interface CharactersDraft {
  characters: Array<{
    name: string
    role: string
    card: Record<string, unknown>
    state: CharacterState
    relations: Array<{ to: string; label: string }>
  }>
}

export interface TitleDraft {
  titles: Array<{ title: string; intro: string }>
  styleName: string
  styleNotes: string
  targetWords: number
  redlines: string[]
  /** 轻骨架：终局方向感+前 3 章概要（B1 融合项） */
  skeleton: { ending: string; firstThree: string[] }
}

const JSON_HINT = `{"reply":"≤200字，有态度的引导语","options":["选项1","选项2","选项3"],"stage":"premise|world|characters|title|done","draft":{...按stage},"done":false}`

function stageInstruction(stage: OnboardStage, _book: Book, collected: string): string {
  switch (stage) {
    case 'premise':
      return `当前阶段【设定采访】。你在用 3-6 轮快问快答收集：题材类型、基调、雷点红线（绝不能出现的剧情，如主角不能死/不要NTR）、文风偏好、单章字数偏好。每轮只问一个维度，给 3-4 个具体选项（可加一个「自定义」占位）。已收集：${collected || '（还没有）'}。
全部收集完成后，stage 改为 world 并直接产出世界观草案。`
    case 'world':
      return `当前阶段【世界观草案】。基于采访结果产出一套世界观设定卡（5-10 张：地理/势力/历史/力量体系/物品/其他），每张卡区分读者已知（第一章就能感知的）与作者真相（暂不揭示的底层设定，含揭示计划）。draft 形状：{"cards":[{"kind":"geography|faction|history|power|item|custom","title":"...","readerText":"...","authorText":"...","revealPlan":"第N章前后揭示..."}]}。reply 简述这套世界观的卖点。options 固定为 ["就这么定","重来一套","我要改（选此项后在下方输入）"]。`
    case 'characters':
      return `当前阶段【人物草案】。产出 3-8 个核心人物（主角必在）：人物卡（背景/外貌/性格/口癖）+ 初始活状态（location/body/mood/items/knows/goal 尽量填）+ 与其他人物的关系。draft 形状：{"characters":[{"name":"...","role":"主角|配角|反派...","card":{"背景":"...","外貌":"...","性格":"..."},"state":{"location":"...","mood":"...","goal":"..."},"relations":[{"to":"另一人物名","label":"关系"}]}]}。options 固定为 ["就这么定","重来一套","我要改（选此项后在下方输入）"]。`
    case 'title':
      return `当前阶段【书名与骨架】。产出 3 个书名候选（各配 100 字内简介）、文风卡（styleName+styleNotes）、单章字数建议（1500-4000）、红线清单（从采访提取，含用户明确说的雷点）、轻骨架（终局方向感 ending——注意不是预定义结局，只是长线方向感；前 3 章概要 firstThree 各一句）。draft 形状：{"titles":[{"title":"...","intro":"..."}],"styleName":"...","styleNotes":"...","targetWords":2000,"redlines":["..."],"skeleton":{"ending":"...","firstThree":["...","...","..."]}}。options 为三个书名+「我要改」。`
    default:
      return '引导已完成。'
  }
}

function historyText(bookId: string): string {
  const msgs = listMessages(bookId, { limit: 30 })
  return msgs.map((m) => `${m.role === 'user' ? '作者' : '导演'}：${m.content}`).join('\n')
}

async function ask(book: Book, stage: OnboardStage, extra?: string): Promise<OnboardReply> {
  const history = historyText(book.id)
  const res = await callJson<OnboardReply>({
    slot: 'director',
    system: `${directorPersona()}

你是开书引导员，与作者一起把一本书从零立起来。分阶段推进，每阶段产出草案请作者拍板。书名暂定：${book.title}。`,
    user: `${history ? `## 已有对话\n${history}\n\n` : ''}${stageInstruction(stage, book, extra ?? '')}${extra ? `\n## 作者补充\n${extra}` : ''}`,
    jsonHint: JSON_HINT,
    maxTokens: 3500
  })
  if (!res?.reply) throw new Error('引导模型未返回有效回复')
  const stage2: OnboardStage = res.stage ?? stage
  return {
    reply: res.reply,
    options: Array.isArray(res.options) ? res.options : [],
    stage: stage2,
    draft: res.draft ?? undefined,
    done: res.done ?? stage2 === 'done'
  }
}

function saveTurn(bookId: string, user: string | null, reply: OnboardReply): void {
  if (user !== null) {
    appendMessage({ bookId, role: 'user', content: user })
  }
  appendMessage({
    bookId,
    role: 'assistant',
    content: reply.reply,
    meta: { onboard: true, stage: reply.stage, options: reply.options, draft: reply.draft ?? null }
  })
}

/** 开书首轮 */
export async function onboardStart(bookId: string): Promise<OnboardReply> {
  const book = getBook(bookId)
  if (!book) throw new Error('书不存在')
  const reply = await ask(book, 'premise')
  saveTurn(bookId, null, reply)
  return reply
}

/** 作者作答/确认/改 */
export async function onboardAnswer(bookId: string, answer: string): Promise<OnboardReply> {
  const book = getBook(bookId)
  if (!book) throw new Error('书不存在')
  const msgs = listMessages(bookId, { limit: 30 })
  const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.meta?.onboard)
  if (!last) throw new Error('引导未开始，请先调用 onboard:start')
  const stage = (last.meta?.stage as OnboardStage) ?? 'premise'
  const lastDraft = (last.meta?.draft ?? null) as OnboardReply['draft']

  // 待确认草案 + 作者说「就这么定/书名N/直接点书名文本」 → 入库推进
  const answerTrim = answer.trim()
  const titleHit =
    lastDraft && 'titles' in lastDraft
      ? lastDraft.titles.findIndex((t) => t.title === answerTrim || answerTrim.includes(t.title))
      : -1
  if (
    lastDraft &&
    (/^(就这么定|确认|定 了|第一个|第二个|第三个|书名[123一二三])/u.test(answerTrim) ||
      titleHit >= 0)
  ) {
    return await confirmDraft(book, stage, lastDraft, answerTrim)
  }

  const reply = await ask(book, stage, answer)
  saveTurn(bookId, answer, reply)
  return reply
}

/** 草案确认入库 + 推进下一阶段 */
async function confirmDraft(
  book: Book,
  stage: OnboardStage,
  draft: NonNullable<OnboardReply['draft']>,
  answer: string
): Promise<OnboardReply> {
  const bookId = book.id
  if (stage === 'world' && 'cards' in draft) {
    for (const c of draft.cards) {
      saveCard({
        lineId: book.activeLineId,
        kind: c.kind,
        title: c.title,
        readerText: c.readerText,
        authorText: c.authorText,
        revealPlan: c.revealPlan
      })
    }
    const reply = await ask(book, 'characters')
    saveTurn(bookId, answer, reply)
    return reply
  }
  if (stage === 'characters' && 'characters' in draft) {
    for (const c of draft.characters) {
      saveCharacter({
        lineId: book.activeLineId,
        name: c.name,
        role: c.role,
        card: c.card,
        state: c.state,
        relations: c.relations
      })
    }
    const reply = await ask(book, 'title')
    saveTurn(bookId, answer, reply)
    return reply
  }
  if (stage === 'title' && 'titles' in draft) {
    const idx = (() => {
      const byName = draft.titles.findIndex((t) => answer.includes(t.title))
      if (byName >= 0) return byName
      return /第二个|2|二|书名2|书名二/u.test(answer)
        ? 1
        : /第三个|3|三|书名3|书名三/u.test(answer)
          ? 2
          : 0
    })()
    const picked = draft.titles[idx] ?? draft.titles[0]
    if (!picked) throw new Error('书名草案为空')
    updateBook(bookId, {
      title: picked.title,
      intro: picked.intro,
      styleName: draft.styleName,
      styleNotes: draft.styleNotes,
      targetWords: draft.targetWords,
      redlines: draft.redlines
    })
    const reply: OnboardReply = {
      reply: `书已立好：《${picked.title}》\n\n文风：${draft.styleName}\n红线：${draft.redlines.join('；') || '无'}\n单章目标：${draft.targetWords} 字\n\n【终局方向感】${draft.skeleton.ending}\n\n【前 3 章概要】\n${draft.skeleton.firstThree.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n去写第一章吧。`,
      options: [],
      stage: 'done',
      done: true
    }
    saveTurn(bookId, answer, reply)
    return reply
  }
  // 无草案阶段（premise）的确认当普通回答处理
  const reply = await ask(book, stage, answer)
  saveTurn(bookId, answer, reply)
  return reply
}
