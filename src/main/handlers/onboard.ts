import { onboardAnswer, onboardStart } from '../director/onboard.js'
import type { HandlerTable } from './types.js'

/** 开书引导（B1-B4）：premise→world→characters→title 四阶段，确认入库 */

type Domain = Pick<HandlerTable, 'onboard:start' | 'onboard:answer'>

export const onboardHandlers: Domain = {
  'onboard:start': (_ctx, [bookId]) => onboardStart(bookId),
  'onboard:answer': (_ctx, [bookId, answer]) => onboardAnswer(bookId, answer)
}
