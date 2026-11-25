import { errorText } from '../lib/toastStore'

/**
 * 拉取失败的占位：一句人话 + 重试。
 * 调用方约定：出错且手里没有数据时才渲染它——已有数据（哪怕是旧的）照常显示，
 * 不让一次后台刷新失败把正在看的内容清空；点重试后由调用方的加载态接管。
 */
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="py-10 text-center text-sm text-stone-600">
      <div className="px-4 leading-relaxed">{errorText(error)}</div>
      {onRetry && (
        <button
          type="button"
          className="mt-4 rounded-xl border border-orange-200 px-6 py-2 active:bg-orange-50"
          onClick={onRetry}
        >
          重试
        </button>
      )}
    </div>
  )
}
