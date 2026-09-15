import { Document, HeadingLevel, Packer, Paragraph } from 'docx'
import type { ExportFormat } from '../shared/types'
import * as store from './store'

interface ExportOptions {
  projectId: string
  format: ExportFormat
  scope: 'all' | 'single'
  outlineId?: string
}

export interface BuiltExport {
  filename: string
  mime: string
  data: Buffer
  words: number
}

const MIME: Record<ExportFormat, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

export async function buildExport(opts: ExportOptions): Promise<BuiltExport> {
  const project = store.listProjects().find((p) => p.id === opts.projectId)
  if (!project) throw new Error('项目不存在')
  const outlines = store.listOutlines(opts.projectId)
  const chosen =
    opts.scope === 'single' ? outlines.filter((o) => o.id === opts.outlineId) : outlines
  const entries = chosen
    .map((o) => ({ outline: o, chapter: store.getChapterByOutline(o.id) }))
    .filter((x) => x.chapter && x.chapter.content.trim().length > 0)
  if (entries.length === 0) throw new Error('所选范围没有可导出的正文')

  const words = entries.reduce((a, x) => a + (x.chapter?.wordCount ?? 0), 0)
  const suffix = opts.scope === 'single' ? `-第${entries[0].outline.chapterNo}章` : ''
  const filename = `${project.title}${suffix}.${opts.format}`

  let data: Buffer
  if (opts.format === 'txt') {
    const text = entries
      .map((x) => `第${x.outline.chapterNo}章 ${x.outline.title}\n\n${x.chapter?.content ?? ''}`)
      .join('\n\n\n')
    data = Buffer.from(text, 'utf-8')
  } else if (opts.format === 'md') {
    const md = [
      `# ${project.title}`,
      '',
      ...entries.flatMap((x) => [
        `## 第${x.outline.chapterNo}章 ${x.outline.title}`,
        '',
        x.chapter?.content ?? '',
        ''
      ])
    ].join('\n')
    data = Buffer.from(md, 'utf-8')
  } else {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: project.title, heading: HeadingLevel.TITLE }),
            ...entries.flatMap((x) => [
              new Paragraph({
                text: `第${x.outline.chapterNo}章 ${x.outline.title}`,
                heading: HeadingLevel.HEADING_1
              }),
              ...x.chapter!.content
                .split(/\n+/)
                .map((p) => new Paragraph({ text: p.trim() }))
            ])
          ]
        }
      ]
    })
    data = await Packer.toBuffer(doc)
  }
  return { filename, mime: MIME[opts.format], data, words }
}
