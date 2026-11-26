import { errorText } from '../lib/toastStore'

/**
 * 拉取失败的占位：一句人话 + 重试。
 * 调用方约定：出错且手里没有数据时才渲染它——已有数据（哪怕是旧的）照常显示，
 * 不让一次后台刷新失败把正在看的内容清空；点重试后由调用方的加载态接管。
 * dark：落在深色底上时用（阅读页夜间主题），换成浅色字。
 */
export function ErrorBox({
  error,
  onRetry,
  dark = false
}: {
  error: unknown
  onRetry?: () => void
  dark?: boolean
}) {
  return (
    <div className={`py-10 text-center text-sm ${dark ? 'text-stone-300' : 'text-stone-600'}`}>
      <div className="px-4 leading-relaxed">{errorText(error)}</div>
      {onRetry && (
        // 视觉仍是原来的按钮，命中区域撑到 40px 高（负 margin 抵消占位，位置不变）
        <button
          type="button"
          className="group -mb-px mt-[15px] inline-flex min-h-10 items-center justify-center"
          onClick={onRetry}
        >
          <span
            className={`rounded-xl border px-6 py-2 ${
              dark
                ? 'border-stone-600 group-active:bg-white/10'
                : 'border-orange-200 group-active:bg-orange-50'
            }`}
          >
            重试
          </span>
        </button>
      )}
    </div>
  )
}
