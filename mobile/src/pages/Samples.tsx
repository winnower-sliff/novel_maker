import { PageShell } from '../components/PageShell'
import { SampleLib } from './Settings'

/**
 * 范文页（底部导航第二项）。本次只挂入口：内容仍是设置页原来的范文库段，
 * 把它迁出设置页并换成与首页一致的卡片风格由后续提交完成。
 */
export default function Samples() {
  return (
    <PageShell title="范文" subtitle="写作时供导演翻阅的参考书">
      <div className="rounded-2xl border border-orange-100 bg-white p-4">
        <SampleLib />
      </div>
    </PageShell>
  )
}
