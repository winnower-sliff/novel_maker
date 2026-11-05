import type {
  Book,
  ChatMessage,
  ContentBlock,
  LintReport,
  Scene,
  ToolDef
} from '../../shared/types.js'
import { callRaw } from '../director/callJson.js'
import { bookBasics, directorPersona, redlineBlock, wordListBlock } from '../director/prompts.js'
import { autoFixDraft, genDraft, genRevise, selfCheck } from '../director/steps.js'
import { lintChapter, stripHtmlComments } from '../lint.js'
import * as store from '../store.js'
import { execTool, type ToolCtx, type ToolResult } from './tools.js'

/**
 * M6 agent 主循环：自由 LLM 工具循环（用户拍板「全面 agent 化」）。
 * - 普通工具（CRUD）走 execTool；三个拦截工具在本文件：
 *   write_chapter_draft（流式写正文+lint+自动修一轮）/ commit_chapter（落章）/ finish（收工）。
 * - 工具卡=messages 表独立行（meta={kind:'tool',jobId,name,summary}），聊天流即工作日志。
 * - 每轮系统提示重新注入红线/正负词/文风（防长程遗忘）。
 */

export interface LoopOpts {
  jobId: string
  bookId: string
  /** 给 agent 的任务指令（写章/聊天/自由任务） */
  task: string
  /** 对话历史（ChatMessage 文本投影；写章任务通常为空） */
  history: ChatMessage[]
  /** agent 可用工具（含拦截工具的 ToolDef） */
  tools: ToolDef[]
  /** 场景：写章（有 commit 链）或自由（无 commit） */
  mode: 'chapter' | 'free'
  maxTurns?: number
  /** 流式 delta 广播（正文/改章） */
  onDelta: (t: string) => void
  /** 落一条 assistant 消息（agent 白话/工具卡） */
  say: (content: string, meta?: Record<string, unknown>) => void
  /** 落章后回调（note chapter 消息/recap 进 payload/记忆压缩/审计排队——jobs.ts 注入） */
  onChapterCommitted?: (
    chapter: { id: string; title: string; wordCount: number; orderNo: number; content: string },
    extra: { summary: string; quickActions: Array<{ label: string; instruction: string }> }
  ) => void
}

export interface LoopResult {
  /** agent 最终白话（finish 的 message 或最后一轮文本） */
  text: string
  turns: number
  /** 本次会话写章次数 */
  chaptersCommitted: number
}

/** 拦截工具的 ToolDef（拼在普通工具后） */
export function interceptorDefs(mode: 'chapter' | 'free'): ToolDef[] {
  const defs: ToolDef[] = [
    {
      name: 'finish',
      description:
        '任务完成时调用：带一句给作者的收尾白话（写完章=汇报本章成果+下一步建议；聊天=你的回答已说清则直接 finish）。',
      input_schema: {
        type: 'object',
        properties: { message: { type: 'string', description: '给作者的收尾白话' } },
        required: ['message']
      }
    },
    {
      name: 'revise_chapter',
      description:
        '按指令改已有章（整章或选段）。传章 id+自然语言改稿指令；流式重写后自动替换旧版（旧版进历史版本可回看）。',
      input_schema: {
        type: 'object',
        properties: {
          chapterId: { type: 'string' },
          instruction: {
            type: 'string',
            description: '改稿指令（如「更狠：把打斗写实，收尾更冷」）'
          },
          segment: { type: 'string', description: '可选：只改这段原文（选段改）' }
        },
        required: ['chapterId', 'instruction']
      }
    }
  ]
  if (mode === 'chapter') {
    defs.unshift(
      {
        name: 'write_chapter_draft',
        description:
          '写本章正文：传你拟好的章题+梗概+3-6 拍点（可选分镜）。系统会流式写作+自动自检（负向词/接缝/穿帮/字数），不过自动修一轮。返回最终稿与报告，你审阅后决定 commit_chapter 或重写。',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '章题' },
            synopsis: { type: 'string', description: '本章梗概（150-300字）' },
            beats: {
              type: 'array',
              items: { type: 'string' },
              description: '拍点序列（3-6 拍）'
            },
            scenes: {
              type: 'array',
              description: '可选分镜 [{summary,viewpoint,pace}]',
              items: {
                type: 'object',
                properties: {
                  summary: { type: 'string' },
                  viewpoint: { type: 'string' },
                  pace: { type: 'string' }
                },
                required: ['summary']
              }
            }
          },
          required: ['title', 'synopsis', 'beats']
        }
      },
      {
        name: 'commit_chapter',
        description:
          '正文定稿入书（调它之前必须已有一稿通过或你判断可接受的 write_chapter_draft）。传入本章 100-200 字纪要。',
        input_schema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '本章纪要（100-200字，进滚动记忆）' }
          },
          quickActions: {
            type: 'array',
            description: '2-3 个本章专属快捷改章建议 [{label:4-8字, instruction:具体指令}]',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, instruction: { type: 'string' } },
              required: ['label', 'instruction']
            }
          },
          required: ['summary']
        }
      }
    )
  }
  return defs
}

/** agent 系统提示（每轮重建，红线/正负词/文风随库内最新值注入） */
function sampleBlock(book: Book): string {
  if (!book.styleSampleSource) return ''
  const s = store.getSample(book.styleSampleSource)
  if (!s) return ''
  return `

## 绑定范文
- 本书绑定范文《${s.name}》（全文 ${s.chars} 字），用 read_sample 节选翻阅（默认开头 4000 字，offsetPct 翻页）。
- 用途：模仿它的句式/节奏/叙事腔调——绝不抄内容、不搬人物情节。动笔前先翻一段找语感。`
}

function agentSystem(book: Book, mode: 'chapter' | 'free'): string {
  const chapterDiscipline =
    mode === 'chapter'
      ? `

## 写章任务纪律（当前处于写章流程，作者已选定走向）
1. 先 get_write_context 拿上下文（钉选设定/伏笔/人物现状/近章），再动笔。${book.styleSampleSource ? '动笔前先 read_sample 翻一段范文找语感。' : ''}
2. write_chapter_draft 一次成型；报告有问题而你判断可修→再 draft 一次；系统已自动修过一轮仍 major 的字数/接缝问题，若你判断无法两全→commit 前在 finish 里说明，或与作者商量（作者接受瑕疵）。
3. commit_chapter 后立即做沉淀：新设定 save_card、人物动向 patch_character_state、伏笔三态 save_foreshadow。这是纪律，不许跳过。
4. 全部做完 finish 收尾（汇报+建议下一章走向）。`
      : `

## 自由任务纪律
- 你没有 commit_chapter/write_chapter_draft 权限（写新章走「写下一章」流程，作者会先选走向）。
- 作者要在已有章上改稿→revise_chapter；维护设定/人物/伏笔/红线/正负词→对应工具。
- 作者要写新章→白话引导他点「写下一章」按钮。`
  return `${directorPersona()}

${bookBasics(book)}
${redlineBlock(book)}
${wordListBlock(book)}
${sampleBlock(book)}
${chapterDiscipline}

## 工具纪律
- 每次工具调用都会以小卡形式给作者看，大方用。
- 删除类工具已自动快照兜底，但删除前仍要确认作者意图。
- 工具结果太长会被截断，需要细节就用读类工具分页看。`
}

const MAX_DATA = 30000
const N = '\n'

function clipData(s: string): string {
  return s.length > MAX_DATA ? `${s.slice(0, MAX_DATA)}\n…（结果过长已截断）` : s
}

export async function runAgentLoop(opts: LoopOpts): Promise<LoopResult> {
  const { jobId, bookId, task, mode } = opts
  const maxTurns = opts.maxTurns ?? 30
  const ctx: ToolCtx = { bookId }

  let book: Book
  {
    const initial = store.getBook(bookId)
    if (!initial) throw new Error('书不存在')
    book = initial
  }

  // 写章会话内暂存的最近草稿（commit_chapter 用）
  let lastDraft: {
    title: string
    synopsis: string
    beats: string[]
    content: string
    report: LintReport
  } | null = null
  let chaptersCommitted = 0
  let finishText = ''
  let lastFinishMessage = ''

  const messages: ChatMessage[] = [...opts.history, { role: 'user', content: task }]

  for (let turn = 0; turn < maxTurns; turn++) {
    book = store.getBook(bookId) ?? book // 每轮重读（agent 可能改了配置/切了线）
    const res = await callRaw(
      {
        slot: 'director',
        system: agentSystem(book, mode),
        user: task,
        jsonHint: '',
        params: {
          messages,
          tools: opts.tools,
          responseFormat: 'text',
          maxTokens: 4000
        }
      },
      opts.onDelta
    )

    // 白话（有 tool_use 时通常为空，跳过落消息避免噪音）
    if (res.text.trim() && !res.toolUses.length) {
      opts.say(res.text.trim(), { kind: 'chat', jobId })
    }
    finishText = res.text.trim() || finishText

    if (res.toolUses.length) {
      // 重建 assistant blocks（text + tool_use），供下轮回灌
      const blocks: ContentBlock[] = []
      if (res.text.trim()) blocks.push({ type: 'text', text: res.text.trim() })
      for (const tu of res.toolUses) {
        blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
      }
      messages.push({ role: 'assistant', content: blocks })
    }
    if (!res.toolUses.length) {
      return { text: finishText || '（导演没有说话）', turns: turn + 1, chaptersCommitted }
    }

    // 执行工具
    const resultBlocks: ContentBlock[] = []
    let finished = false
    for (const tu of res.toolUses) {
      let result: ToolResult
      if (tu.inputError || typeof tu.input !== 'object' || tu.input === null) {
        result = {
          ok: false,
          summary: `${tu.name} 参数无效`,
          data: `参数 JSON ${tu.inputError === 'truncated' ? '被截断' : '解析失败'}，请重发完整参数`
        }
      } else {
        result = await runOne(tu.name, tu.input as Record<string, unknown>)
      }
      // 工具卡（作者可见的工作日志；content 截 2000 字防膨胀，全文走 resultBlocks 给 LLM）
      opts.say(result.data.slice(0, 2000), {
        kind: 'tool',
        jobId,
        tool: tu.name,
        summary: result.summary,
        ok: result.ok
      })
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.ok ? clipData(result.data) : `失败：${result.data}`,
        is_error: !result.ok
      } as ContentBlock)
      if (tu.name === 'finish' && result.ok) finished = true
    }

    messages.push({ role: 'user', content: resultBlocks })

    if (finished) {
      const finishMsg = lastFinishMessage
      return {
        text: finishMsg || finishText || '完成',
        turns: turn + 1,
        chaptersCommitted
      }
    }
  }
  opts.say(`已到最大轮数（${maxTurns}），我先停在这里。`, { kind: 'chat', jobId })
  return { text: finishText || '到达最大轮数', turns: maxTurns, chaptersCommitted }

  // ── 单工具执行（拦截工具内联） ──────────────────────────────────────────
  async function runOne(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'finish': {
        lastFinishMessage = String(input.message ?? '')
        return { ok: true, summary: '收工', data: '已收尾' }
      }
      case 'write_chapter_draft': {
        const b = store.getBook(bookId) ?? book
        const line = store.activeLine(b)
        if (!line) return { ok: false, summary: '没有激活线', data: '当前书没有激活线' }
        const direction = (opts.task.match(/走向[：:]\s*(.+)/)?.[1] ?? opts.task).slice(0, 200)
        const input2 = {
          book: b,
          lineId: line.id,
          outline: {
            title: String(input.title ?? '未命名'),
            synopsis: String(input.synopsis ?? ''),
            beats: (input.beats as string[]) ?? ['']
          },
          scenes: (input.scenes as Scene[] | undefined) ?? null,
          direction: { source: 'free' as const, text: direction }
        }
        let draft = await genDraft(input2, opts.onDelta)
        let report = selfCheck(b, line.id, draft, tailOf(line.id))
        if (report.issues.some((i) => i.level === 'major')) {
          // 自动修一轮（W6 纪律）
          draft = await autoFixDraft(input2, draft, report, opts.onDelta)
          report = selfCheck(b, line.id, draft, tailOf(line.id))
        }
        lastDraft = {
          title: input2.outline.title,
          synopsis: input2.outline.synopsis,
          beats: input2.outline.beats,
          content: draft,
          report
        }
        const majors = report.issues.filter((i) => i.level === 'major')
        const wordCount = draft.replace(/\s/g, '').length
        return {
          ok: true,
          summary: `写《${input2.outline.title}》${wordCount} 字（${majors.length ? `仍有 ${majors.length} 个 major 问题` : '自检通过'}）`,
          data:
            `《${input2.outline.title}》草稿完成（约 ${wordCount} 字）。自检报告：${N}` +
            (report.issues.length
              ? report.issues
                  .map(
                    (i) => `[${i.level}/${i.rule}] ${i.quote ? `「${i.quote}」` : ''}${i.advice}`
                  )
                  .join(N)
              : '全部通过') +
            `${N}${N}正文全文：${N}${draft}`
        }
      }
      case 'commit_chapter': {
        if (!lastDraft) {
          return {
            ok: false,
            summary: '没有可入书的草稿',
            data: '先 write_chapter_draft 再 commit_chapter'
          }
        }
        const b = store.getBook(bookId) ?? book
        const line = store.activeLine(b)
        if (!line) return { ok: false, summary: '没有激活线', data: '当前书没有激活线' }
        const prev = store.previousChapter(line.id)
        const clean = stripHtmlComments(lastDraft.content)
        const chapter = store.insertChapter({
          lineId: line.id,
          parentChapterId: prev?.id ?? '',
          title: lastDraft.title,
          content: clean,
          summary: '',
          meta: {
            direction: { source: 'free', text: opts.task.slice(0, 500) },
            outline: {
              title: lastDraft.title,
              synopsis: lastDraft.synopsis,
              beats: lastDraft.beats
            }
          }
        })
        const summary = String(input.summary ?? '')
        if (summary) store.updateChapterSummary(chapter.id, summary)
        const quickActions = Array.isArray(input.quickActions)
          ? (input.quickActions as Array<{ label: string; instruction: string }>).filter(
              (a) => a && typeof a.label === 'string' && typeof a.instruction === 'string'
            )
          : []
        chaptersCommitted++
        lastDraft = null
        opts.onChapterCommitted?.(chapter, { summary, quickActions })
        return {
          ok: true,
          summary: `《${chapter.title}》已入书`,
          data: `已入书：第 ${chapter.orderNo} 章《${chapter.title}》（${chapter.wordCount} 字）。纪要已记录。继续沉淀（save_card/patch_character_state/save_foreshadow），完成后 finish。`
        }
      }
      case 'revise_chapter': {
        const chapterId = String(input.chapterId ?? '')
        const chapter = store.getChapter(chapterId)
        if (!chapter) return { ok: false, summary: '章节不存在', data: `章节 ${chapterId} 不存在` }
        const instruction = String(input.instruction ?? '')
        const segment = typeof input.segment === 'string' ? input.segment : undefined
        const rewritten = await genRevise(
          {
            book: store.getBook(bookId) ?? book,
            lineId: chapter.lineId,
            chapter,
            instruction,
            segment
          },
          opts.onDelta
        )
        const clean = stripHtmlComments(rewritten)
        const report = lintChapter(clean, {
          bannedWords: (store.getBook(bookId) ?? book).negativeWords
        })
        store.replaceChapterContent(chapterId, clean, `agent 改章：${instruction.slice(0, 80)}`)
        return {
          ok: true,
          summary: `改好《${chapter.title}》`,
          data: `《${chapter.title}》已按「${briefOf(instruction)}」改写并替换（旧版进历史版本）。lint：${report.issues.length ? report.issues.map((i) => `[${i.rule}]${i.advice}`).join('；') : '干净'}`
        }
      }
      default:
        return execTool(name, input, ctx)
    }
  }
}

function tailOf(lineId: string): string | undefined {
  const prev = store.previousChapter(lineId)
  return prev?.content.slice(-500)
}

function briefOf(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}
