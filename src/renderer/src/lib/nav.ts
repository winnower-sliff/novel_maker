export type Page =
  | 'projects'
  | 'premise'
  | 'agent'
  | 'graph'
  | 'writing'
  | 'outline'
  | 'characters'
  | 'worldbuild'
  | 'foreshadows'
  | 'playground'
  | 'skills'
  | 'usage'
  | 'settings'

export type Navigate = (page: Page, focusOutlineId?: string, graphNodeId?: string) => void
