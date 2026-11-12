/** AI 页统一标签表：agent 工具/运行阶段/走向类型（展示层唯一来源） */

/** agent 工具 → 中文名（缺省裸名兜底） */
export const TOOL_LABEL: Record<string, string> = {
  get_book_config: '看书配置',
  list_chapters: '翻章节',
  read_chapter: '读章',
  list_cards: '翻设定',
  get_card: '看设定',
  list_characters: '翻人物',
  list_foreshadows: '翻伏笔',
  get_write_context: '备上下文',
  list_samples: '翻范文库',
  read_sample: '读范文',
  search_project: '检索',
  list_lines: '看剧情线',
  get_character: '看人物详情',
  save_card: '存设定卡',
  save_character: '存人物',
  update_character_tags: '改人物标签',
  update_character_data: '改人设',
  patch_character_state: '更新人物状态',
  save_foreshadow: '记伏笔',
  update_book_config: '改书配置',
  fork_line: '开新线',
  switch_line: '切线',
  delete_card: '删设定卡',
  delete_character: '删人物',
  delete_foreshadow: '删伏笔',
  delete_last_chapter: '删末章',
  write_chapter_draft: '写正文草稿',
  commit_chapter: '定稿入书',
  revise_chapter: '改章',
  spawn_subagent: '派调查员',
  finish: '收工'
}

/** job 运行阶段 → 概括文案 */
export const RUN_LABEL: Record<string, string> = {
  proposal: '导演正在构思走向…',
  agent: '导演自主工作中',
  report: '出报告中…',
  draft: '改章中',
  finalize: '收尾中…'
}
