// quickask 窗口渲染层：回车提交 → 主进程 headless 运行 → 结果回填。
// 注意：本窗口无 nodeIntegration，通过 window.quickAsk 桥（quickask-preload）通信。
const q = document.getElementById('q')
const st = document.getElementById('st')

q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { window.close(); return }
  if (e.key !== 'Enter') return
  const text = q.value.trim()
  if (!text) return
  q.disabled = true
  st.textContent = '已提交，Agent 后台运行中…（完成会弹系统通知）'
  window.quickAsk.submit(text)
})

window.quickAsk.onResult((r) => {
  q.disabled = false
  if (r.ok) {
    st.textContent = r.output || '（无输出）'
  } else {
    st.textContent = '失败：' + (r.output || '未知错误')
  }
})