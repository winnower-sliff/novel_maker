import type { Api } from '../../../preload/index'

declare global {
  interface Window {
    api: Api
  }
}

export type { DonePayload } from '../../../preload/index'

// 流式实现已抽到共享包 src/wizard/pipeline.ts（桌面与移动端共用），此处保持原导出路径
export { chatStream, runPipeline, startPipeline, subscribeStream } from '../../../wizard/pipeline'
