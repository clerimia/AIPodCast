// 写稿大师会话（ADR-0005：一集一个会话，kind=writer）。M3 落地 PI SDK 进程内嵌入；
// M2 只落 ChangeSet→会话通知的编排点（docs/modules-and-phasing.md 关键 wiring 决策 2：
// script 服务不 import writer，依赖方向单向，避免环）。
export interface ChangeSetNotice {
  id: string
  summary: string | null
}

/**
 * 用户提交改动后把一条紧凑 ChangeSet 追加进会话上下文（ADR-0002）：
 * 会话存在且 idle 时 `sendCustomMessage({ customType:'change_set', display:false,
 * content:'<system-reminder>脚本已更新（本次提交）：…</system-reminder>' }, { triggerTurn:false })`。
 * M3 前无会话运行时，空实现（调用方不需感知）。
 */
export async function notifyChangeSet(_episodeId: string, _changeSet: ChangeSetNotice): Promise<void> {
  // M3：查 conversations 行 → SessionManager.open(session_file) → idle 才追加，不触发回合
}
