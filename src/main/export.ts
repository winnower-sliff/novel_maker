import { writeFile } from 'node:fs/promises'
import { dialog } from 'electron'
import { Document, HeadingLevel, Packer, Paragraph } from 'docx'
import type { ExportFormat } from '../shared/types'
import * as store from './store'

interface ExportOptions {
  projectId: string
  format: ExportFormat
  scope: 'all' | 'single'
  outlineId?: string
}

export async function exportProject(opts: ExportOptions): Promise<{ path: string; words: number }> {
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
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出',
    defaultPath: `${project.title}${suffix}.${opts.format}`,
    filters: [{ name: opts.format.toUpperCase(), extensions: [opts.format] }]
  })
  if (canceled || !filePath) throw new Error('已取消导出')

  if (opts.format === 'txt') {
    const text = entries
      .map((x) => `第${x.outline.chapterNo}章 ${x.outline.title}\n\n${x.chapter?.content ?? ''}`)
      .join('\n\n\n')
    await writeFile(filePath, text, 'utf-8')
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
    await writeFile(filePath, md, 'utf-8')
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
    const buf = await Packer.toBuffer(doc)
    await writeFile(filePath, buf)
  }
  return { path: filePath, words }
}
