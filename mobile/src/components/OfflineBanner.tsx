/**
 * 断网但手里还有旧数据时的一句提醒：内容照常显示，只是让作者知道「看到的不是最新的」。
 * 调用方约定：查询出错且已有数据时渲染；连接恢复、数据刷新成功后自然不再渲染。
 */
export function OfflineBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800"
    >
      <svg
        aria-hidden="true"
        className="shrink-0"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path
          d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>连不上电脑端，显示的是之前的内容</span>
    </div>
  )
}
