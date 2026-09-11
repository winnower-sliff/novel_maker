import type { Api } from '../../../preload/index'

declare global {
  interface Window {
    api: Api
  }
}

export type { DonePayload } from '../../../preload/index'
