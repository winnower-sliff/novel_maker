import { useQuery } from '@tanstack/react-query'
import type { Book, Card, Chapter, Character, Foreshadow, Job, StatusCard, StoryLine } from '@shared/types'

/**
 * 数据层：全部经 window.api（bridge 装配的契约客户端，多参展开形态）。
 * qk 前缀 key；写后按前缀 invalidate；job:update SSE 事件驱动失效（App.tsx 接线）。
 */
export const qk = {
  books: ['books'] as const,
  book: (id: string) => ['book', id] as const,
  statusCard: (id: string) => ['statusCard', id] as const,
  chapter: (id: string) => ['chapter', id] as const,
  cards: (lineId: string) => ['cards', lineId] as const,
  characters: (lineId: string) => ['characters', lineId] as const,
  foreshadows: (lineId: string) => ['foreshadows', lineId] as const,
  jobs: (bookId: string) => ['jobs', bookId] as const,
  messages: (bookId: string) => ['messages', bookId] as const
}

export function useBooks() {
  return useQuery({
    queryKey: qk.books,
    queryFn: async (): Promise<Book[]> => window.api.book.list()
  })
}

export interface BookDetail {
  book: Book
  lines: StoryLine[]
  chapters: Array<
    Pick<Chapter, 'id' | 'lineId' | 'orderNo' | 'title' | 'wordCount' | 'updatedAt'>
  >
}

export function useBook(bookId: string | null) {
  return useQuery({
    queryKey: qk.book(bookId ?? ''),
    queryFn: async (): Promise<BookDetail> => window.api.book.get(bookId as string),
    enabled: !!bookId
  })
}

export function useStatusCard(bookId: string | null) {
  return useQuery({
    queryKey: qk.statusCard(bookId ?? ''),
    queryFn: async (): Promise<StatusCard | null> => window.api.book.statusCard(bookId as string),
    enabled: !!bookId
  })
}

export function useChapter(chapterId: string | null) {
  return useQuery({
    queryKey: qk.chapter(chapterId ?? ''),
    queryFn: async (): Promise<Chapter | null> => window.api.chapter.get(chapterId as string),
    enabled: !!chapterId
  })
}

export function useCards(lineId: string | null) {
  return useQuery({
    queryKey: qk.cards(lineId ?? ''),
    queryFn: async (): Promise<Card[]> => window.api.card.list(lineId as string),
    enabled: !!lineId
  })
}

export function useCharacters(lineId: string | null) {
  return useQuery({
    queryKey: qk.characters(lineId ?? ''),
    queryFn: async (): Promise<Character[]> => window.api.character.list(lineId as string),
    enabled: !!lineId
  })
}

export function useForeshadows(lineId: string | null) {
  return useQuery({
    queryKey: qk.foreshadows(lineId ?? ''),
    queryFn: async (): Promise<Foreshadow[]> => window.api.foreshadow.list(lineId as string),
    enabled: !!lineId
  })
}

/** 该书 job 流：active=最近未终态（含 revise/review 等子任务，恢复用）；lastDone=最近完成的写作任务（纪要卡回看） */
export function useJobFlow(bookId: string | null) {
  return useQuery({
    queryKey: qk.jobs(bookId ?? ''),
    queryFn: async (): Promise<{ active: Job | null; lastDone: Job | null }> => {
      const jobs = await window.api.job.list(bookId as string)
      return {
        active:
          jobs.find(
            (j) => j.state !== 'done' && j.state !== 'failed' && j.state !== 'cancelled'
          ) ?? null,
        // listJobs 按 created_at DESC，首个 done 的写作任务即最近完成的一章
        lastDone: jobs.find((j) => j.kind === 'write' && j.state === 'done') ?? null
      }
    },
    enabled: !!bookId,
    refetchInterval: 15_000 // SSE 断连时的兜底轮询
  })
}

/** 最近完成的审读/审计/诊断报告（新→旧） */
export function useReports(bookId: string | null) {
  return useQuery({
    queryKey: [...qk.jobs(bookId ?? ''), 'reports'],
    queryFn: async (): Promise<Job[]> => {
      const jobs = await window.api.job.list(bookId as string)
      return jobs.filter(
        (j) =>
          (j.kind === 'review' || j.kind === 'audit' || j.kind === 'diagnose') &&
          j.state === 'done' &&
          j.payload.report
      )
    },
    enabled: !!bookId
  })
}
