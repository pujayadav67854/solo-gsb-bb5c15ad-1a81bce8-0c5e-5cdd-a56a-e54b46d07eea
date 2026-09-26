import { useMemo, useState } from 'react'
import { buildLeaseImport } from '../lib/leaseImport'
import {
  buildMigration,
  migrationPlanText,
  type MigrationStep,
} from '../lib/migration'
import type { HostAssignment, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  /** 与「⑩ 静态租约批量导入」共用的原始 CSV 文本（合并预览的唯一输入） */
  csv: string
}

let migCounter = 0
function migUid(): string {
  migCounter += 1
  return `mig-${Date.now()}-${migCounter}`
}

/** 复制到剪贴板；非安全上下文（无 navigator.clipboard）时回退到临时 textarea */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到回退方案
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

const STEP_LABEL: Record<MigrationStep['kind'], string> = {
  move: '改址',
  add: '新增',
  temp: '临时迁出',
  final: '闭合环路',
}

const STEP_CLASS: Record<MigrationStep['kind'], string> = {
  move: 'mig-step move',
  add: 'mig-step add',
  temp: 'mig-step temp',
  final: 'mig-step final',
}

/**
 * 迁移执行编排面板：复用上方「静态租约批量导入」的当前登记 + 无冲突 CSV 合并预览，
 * 生成按序执行时不产生瞬时重复 IPv4 的逐步改址清单。
 * 纯只读：冲突 / 阻止时不生成结果，任何情况下都不改动主机登记。
 */
export default function MigrationPanel({ result, assignments, csv }: Props) {
  const [copied, setCopied] = useState(false)
  const invalid = result.inputErrors.length > 0

  // 与导入面板同一份 CSV / 登记 / 规划：任一变化都实时重算（先复用合并快照，再编排）
  const importBuilt = useMemo(
    () => (invalid ? null : buildLeaseImport(csv, assignments, result, migUid)),
    [csv, assignments, result, invalid],
  )

  const migration = useMemo(() => {
    if (!importBuilt) return null
    // 合并预览存在表头错误 / 行冲突 / 无数据行时不生成迁移清单，也绝不改动登记
    if (!importBuilt.canApply) return { status: 'conflict' as const }
    return buildMigration(assignments, importBuilt.merged, result)
  }, [importBuilt, assignments, result])

  const hasCsv = csv.trim() !== ''

  async function handleCopy() {
    if (!migration || migration.status !== 'ready') return
    const ok = await copyText(migrationPlanText(migration))
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="panel migration-panel">
      <h2>⑪ 迁移执行编排</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        复用上方<strong>静态租约批量导入</strong>的 CSV 与「现有登记 + 导入」<strong>无冲突合并预览</strong>，
        以<strong>旧地址占用关系</strong>建立依赖图，生成按序执行时
        <strong>不会产生任何瞬时重复 IPv4</strong> 的逐步改址清单：无环部分按可执行顺序输出；
        <strong>互换或多设备环路</strong>先把一台设备迁到其<strong>原网段内最低的临时可用地址</strong>
        （已排除当前占用与全部目标地址），再沿环完成改址并释放临时地址；找不到临时地址时
        <strong>明确阻止该环</strong>。本面板只读规划 / 登记 / CSV，<strong>不改动任何登记</strong>；
        CSV、规划或登记变化后实时重算。
      </p>

      {invalid && (
        <div className="summary-disabled-note">
          输入非法（请先修正左侧错误），迁移执行编排已暂停；合并预览恢复后清单自动重算。
        </div>
      )}

      {!invalid && (!hasCsv || !importBuilt || importBuilt.rows.length === 0) && (
        <p className="summary-empty">
          尚无可用的合并预览：请先在上方「⑩ 静态租约批量导入」粘贴 CSV 并保证至少一行数据。
          CSV、规划或主机登记变化后，这里的改址清单会实时重算。
        </p>
      )}

      {!invalid && importBuilt && importBuilt.rows.length > 0 && !importBuilt.canApply && (
        <div className="opt121-error-box">
          <strong>合并预览存在冲突，迁移清单不生成：</strong>
          <ul>
            {importBuilt.headerErrors.map((m, i) => (
              <li key={`h${i}`}>{m}</li>
            ))}
            {importBuilt.hasConflicts && (
              <li>
                逐行预览中有 {importBuilt.counts.conflict} 行冲突；请先在上方修正全部标红行
                （冲突预览不会改动任何登记）。
              </li>
            )}
          </ul>
        </div>
      )}

      {migration && migration.status === 'idle' && (
        <div className="dnsmasq-empty">{migration.message}</div>
      )}

      {migration && migration.status === 'blocked' && (
        <div className="opt121-error-box">
          <strong>迁移被阻止，未生成任何执行步骤：</strong>
          <ul>
            {migration.blockedCycles.map((c) => (
              <li key={c.index}>
                <div>
                  <strong>环 {c.index}</strong>：
                  {c.members
                    .map((m) => `“${m.name}”（${m.oldIp} → ${m.targetIp}）`)
                    .join('、')}
                </div>
                <ul className="lease-row-errors">
                  {c.reasons.map((reason) => (
                    <li key={reason.deviceId}>
                      设备“{reason.deviceName}”在网段 {reason.segmentCidr}：{reason.message}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {migration.stationaryBlockers.map((b) => (
              <li key={b.deviceId}>
                设备“{b.deviceName}”的目标地址 {b.targetIp} 被不参与本次改址的设备“{b.holderName}”占用：
                依赖无法满足，请把该设备一并纳入导入或更换目标地址。
              </li>
            ))}
          </ul>
          <div className="lease-blocked-hint">
            请在对应网段腾出一个可用主机地址（或调整 CSV / 规划）后，清单会自动重算；在此之前不要执行改址。
          </div>
        </div>
      )}

      {migration && migration.status === 'ready' && (
        <>
          <div className="lease-summary-row">
            <span className="rdns-chip">
              涉及设备 <strong>{migration.counts.devices}</strong>
            </span>
            <span className="rdns-chip">
              新增 <strong>{migration.counts.adds}</strong>
            </span>
            <span className="rdns-chip">
              无环改址 <strong>{migration.counts.acyclic}</strong>
            </span>
            <span className="rdns-chip lease-chip-update">
              地址环路 <strong>{migration.counts.cycles}</strong>
            </span>
            <span className="rdns-chip">
              总步骤数 <strong>{migration.steps.length}</strong>
            </span>
            <button className="primary" onClick={handleCopy} title="复制逐步改址清单（TSV，可直接粘贴到表格）">
              {copied ? '✓ 已复制' : '📋 复制清单'}
            </button>
            <span className="opt121-toolbar-hint">
              每一步完成后再执行下一步，全程不会出现两台设备占用同一 IPv4
            </span>
          </div>

          <div className="table-scroll">
            <table className="host-table migration-table">
              <thead>
                <tr>
                  <th className="mig-seq">步骤</th>
                  <th>环</th>
                  <th>操作</th>
                  <th className="host-device-name">设备</th>
                  <th className="host-addr">原地址</th>
                  <th className="host-addr">目标地址</th>
                  <th className="host-addr">临时地址</th>
                  <th>所属网段</th>
                  <th>原因 / 执行说明</th>
                </tr>
              </thead>
              <tbody>
                {migration.steps.map((s) => (
                  <tr key={s.seq} className={`mig-row-${s.kind}`}>
                    <td className="mono mig-seq">{s.seq}</td>
                    <td className="mono">{s.cycle === null ? '—' : `环 ${s.cycle}`}</td>
                    <td>
                      <span className={STEP_CLASS[s.kind]}>{STEP_LABEL[s.kind]}</span>
                    </td>
                    <td className="host-device-name">{s.deviceName}</td>
                    <td className="mono host-addr">{s.fromIp ?? '—'}</td>
                    <td className="mono host-addr">{s.ip}</td>
                    <td className="mono host-addr">
                      {s.kind === 'temp' ? (
                        <span className="mig-temp-ip">{s.ip}</span>
                      ) : s.tempIp ? (
                        <span className="mig-temp-ip">{s.tempIp}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="mono mig-cidr">{s.segmentCidr}</td>
                    <td className="host-reason mig-reason">{s.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
