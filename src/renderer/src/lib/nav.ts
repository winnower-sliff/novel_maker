export type Page =
  | 'projects'
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

export type Navigate = (page: Page, focusOutlineId?: string) => void
