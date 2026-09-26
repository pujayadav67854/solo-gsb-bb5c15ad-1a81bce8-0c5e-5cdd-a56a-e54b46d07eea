import { useMemo, useState } from 'react'
import AddressBar from './components/AddressBar'
import BaselinePanel from './components/BaselinePanel'
import DhcpPoolPanel from './components/DhcpPoolPanel'
import HostAddressPanel from './components/HostAddressPanel'
import LeaseImportPanel from './components/LeaseImportPanel'
import Option121Panel from './components/Option121Panel'
import { ReflowSummaryBar } from './components/ReflowReport'
import ReverseDnsPanel from './components/ReverseDnsPanel'
import RouteSummaryPanel from './components/RouteSummaryPanel'
import SegmentDetail from './components/SegmentDetail'
import SegmentTable from './components/SegmentTable'
import SummaryCards from './components/SummaryCards'
import {
  buildBaseline,
  clearStoredBaseline,
  compareWithBaseline,
  loadBaseline,
  saveBaseline,
} from './lib/baseline'
import { downloadJson } from './lib/exporter'
import { formatCidr, parseCidr } from './lib/ip'
import { plan } from './lib/planner'
import type {
  Baseline,
  DhcpExclusionInput,
  HostAssignment,
  Option121RouteInput,
  RequirementInput,
  ReservedInput,
} from './lib/types'

let counter = 0
function uid(): string {
  counter += 1
  return `id-${Date.now()}-${counter}`
}

const DEMO = {
  parentCidr: '192.168.10.0/24',
  reservations: [{ id: 'r1', name: '核心交换链路保留', cidr: '192.168.10.0/28' }],
  requirements: [
    { id: 'q1', name: '办公区 VLAN', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房 VLAN', hosts: 40, cidr: '' },
    { id: 'q3', name: '监控固定段', hosts: 25, cidr: '192.168.10.32/27' },
    { id: 'q4', name: '设备管理', hosts: 2, cidr: '' },
  ] satisfies RequirementInput[],
}

export default function App() {
  const [parentCidr, setParentCidr] = useState('')
  const [reservations, setReservations] = useState<ReservedInput[]>([])
  const [requirements, setRequirements] = useState<RequirementInput[]>([])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  // 基线只存在于当前浏览器会话（sessionStorage），挂载时恢复
  const [baseline, setBaseline] = useState<Baseline | null>(() => loadBaseline())
  // 「基线优先重排」模式开关：仅在存在基线且父网段与基线一致时可用
  const [reflowEnabled, setReflowEnabled] = useState(false)
  // 主机地址登记仅在当前会话内存中保留；与规划引擎、基线、汇总、导出完全解耦
  const [hostAssignments, setHostAssignments] = useState<HostAssignment[]>([])
  // DHCP Option 121：客户端网段（需求稳定 ID）+ 路由录入（行内稳定 ID，规划变化后保留并重新校验）
  const [option121ClientId, setOption121ClientId] = useState('')
  const [option121Routes, setOption121Routes] = useState<Option121RouteInput[]>([])
  // 反向 DNS 区域文件：所选网段（需求稳定 ID）；登记复用主机地址分配面板数据，只读不修改
  const [reverseDnsOwnerId, setReverseDnsOwnerId] = useState('')
  // DHCP 动态地址池：宿主网段（需求稳定 ID）+ 多段手工排除区间（行内稳定 ID，规划变化后保留并重新校验）
  const [dhcpPoolOwnerId, setDhcpPoolOwnerId] = useState('')
  const [dhcpPoolExclusions, setDhcpPoolExclusions] = useState<DhcpExclusionInput[]>([])
  // 静态租约批量导入：原始 CSV 文本始终保留在页面内存中，规划/登记变化后实时重算预览
  const [leaseImportCsv, setLeaseImportCsv] = useState('')

  // 重排生效条件：有基线、父网段为规范 CIDR 且与基线完全一致（输入非法/父网段变化时禁用）
  const parentForReflow = useMemo(() => {
    const raw = parentCidr.trim()
    if (!raw) return null
    const parsed = parseCidr(raw, true)
    return parsed && !('error' in parsed) ? formatCidr(parsed.network, parsed.prefix) : null
  }, [parentCidr])
  const reflowAvailable =
    baseline !== null && parentForReflow !== null && parentForReflow === baseline.parentCidr
  const reflowActive = reflowEnabled && reflowAvailable

  const result = useMemo(
    () => plan({ parentCidr, reservations, requirements, baseline: reflowActive ? baseline : null }),
    [parentCidr, reservations, requirements, baseline, reflowActive],
  )

  // 输入非法时保留基线但暂停对比
  const comparison = useMemo(
    () =>
      baseline && result.inputErrors.length === 0 && result.segments.length > 0
        ? compareWithBaseline(baseline, result)
        : null,
    [baseline, result],
  )

  function handleSaveBaseline() {
    if (result.inputErrors.length > 0 || result.segments.length === 0) return
    const snapshot = buildBaseline(result)
    setBaseline(snapshot)
    saveBaseline(snapshot)
  }

  function handleClearBaseline() {
    setBaseline(null)
    clearStoredBaseline()
    setReflowEnabled(false)
  }

  // 网段明细表使用的 需求ID -> 变化 映射
  const changesById = useMemo(() => {
    if (!comparison) return undefined
    const map = new Map(comparison.rows.map((r) => [r.id, r]))
    return map
  }, [comparison])

  // 重新规划后，选中索引可能失效（保留上一次仍在范围内的选择）
  const safeSelected =
    selectedIndex !== null && selectedIndex < result.segments.length ? selectedIndex : null

  function patchReservation(id: string, patch: Partial<ReservedInput>) {
    setReservations((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  function patchRequirement(id: string, patch: Partial<RequirementInput>) {
    setRequirements((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function loadDemo() {
    setParentCidr(DEMO.parentCidr)
    setReservations(DEMO.reservations.map((r) => ({ ...r })))
    setRequirements(DEMO.requirements.map((r) => ({ ...r })))
    setSelectedIndex(null)
    setHostAssignments([])
    setOption121ClientId('')
    setOption121Routes([])
    setReverseDnsOwnerId('')
    setDhcpPoolOwnerId('')
    setDhcpPoolExclusions([])
    setLeaseImportCsv('')
  }

  function clearAll() {
    setParentCidr('')
    setReservations([])
    setRequirements([])
    setSelectedIndex(null)
    setHostAssignments([])
    setOption121ClientId('')
    setOption121Routes([])
    setReverseDnsOwnerId('')
    setDhcpPoolOwnerId('')
    setDhcpPoolExclusions([])
    setLeaseImportCsv('')
  }

  const hasInput =
    parentCidr.trim() !== '' ||
    reservations.some((r) => r.cidr.trim() || r.name.trim()) ||
    requirements.some((r) => r.name.trim() || r.hosts !== '' || r.cidr.trim())

  return (
    <div className="app">
      <h1>IPv4 VLSM 地址规划台</h1>
      <p className="subtitle">
        本地运行、纯前端计算。自动网段按「可用主机数 = 地址数 − 2」取最小对齐分块（最小 /30），
        从大到小、同规模按录入顺序，在保留区与固定网段之外选取最低对齐空闲地址。
      </p>

      <div className="grid-2">
        {/* 输入区 */}
        <div>
          <div className="panel">
            <h2>① 父 CIDR</h2>
            <input
              type="text"
              value={parentCidr}
              placeholder="例如 192.168.10.0/24"
              onChange={(e) => {
                setParentCidr(e.target.value)
                setSelectedIndex(null)
              }}
            />
            <div className="btn-row">
              <button onClick={loadDemo}>载入示例</button>
              <button onClick={clearAll} disabled={!hasInput}>
                清空
              </button>
            </div>
          </div>

          <div className="panel">
            <h2>② 保留区（不参与需求分配）</h2>
            {reservations.length === 0 && <p className="subtitle">暂无保留区</p>}
            {reservations.map((r) => (
              <div className="row-inputs reservation" key={r.id}>
                <input
                  type="text"
                  placeholder="名称，如 核心链路"
                  value={r.name}
                  onChange={(e) => patchReservation(r.id, { name: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="CIDR，如 10.0.0.0/30"
                  value={r.cidr}
                  onChange={(e) => {
                    patchReservation(r.id, { cidr: e.target.value })
                    setSelectedIndex(null)
                  }}
                />
                <button
                  className="icon"
                  title="删除"
                  onClick={() => {
                    setReservations((list) => list.filter((x) => x.id !== r.id))
                    setSelectedIndex(null)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="btn-row">
              <button
                onClick={() =>
                  setReservations((list) => [...list, { id: uid(), name: '', cidr: '' }])
                }
              >
                + 添加保留区
              </button>
            </div>
          </div>

          <div className="panel">
            <h2>③ 需求（主机数 + 可选固定网段）</h2>
            {requirements.map((q) => (
              <div className="row-inputs" key={q.id}>
                <input
                  type="text"
                  placeholder="名称，如 办公区 VLAN"
                  value={q.name}
                  onChange={(e) => patchRequirement(q.id, { name: e.target.value })}
                />
                <input
                  type="number"
                  min={1}
                  placeholder="主机数"
                  value={q.hosts}
                  onChange={(e) => {
                    const v = e.target.value
                    patchRequirement(q.id, { hosts: v === '' ? '' : Math.max(1, Math.floor(Number(v))) })
                    setSelectedIndex(null)
                  }}
                />
                <input
                  type="text"
                  placeholder="固定网段（可选），如 192.168.10.64/28"
                  value={q.cidr}
                  onChange={(e) => {
                    patchRequirement(q.id, { cidr: e.target.value })
                    setSelectedIndex(null)
                  }}
                />
                <button
                  className="icon"
                  title="删除"
                  onClick={() => {
                    setRequirements((list) => list.filter((x) => x.id !== q.id))
                    setSelectedIndex(null)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="btn-row">
              <button
                onClick={() =>
                  setRequirements((list) => [
                    ...list,
                    { id: uid(), name: '', hosts: '', cidr: '' },
                  ])
                }
              >
                + 添加需求
              </button>
            </div>
          </div>
        </div>

        {/* 结果区 */}
        <div>
          {result.inputErrors.length > 0 && (
            <div className="error-list">
              <strong>输入存在问题：</strong>
              <ul>
                {result.inputErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {result.failures.length > 0 && (
            <div className="fail-box">
              <strong>以下需求无法分配：</strong>
              <ul>
                {result.failures.map((f) => (
                  <li key={f.id}>
                    {f.name}（需 {f.hosts} 台）：{f.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {reflowActive && result.reflow && (
            <ReflowSummaryBar report={result.reflow} />
          )}

          {result.segments.length > 0 && (
            <>
              <div className="panel">
                <div className="header-row">
                  <h2 style={{ marginBottom: 0 }}>分配结果 · {result.parentCidr}</h2>
                  <button className="primary" onClick={() => downloadJson(result, { parentCidr })}>
                    ⬇ 导出 JSON
                  </button>
                </div>
                <div style={{ height: 12 }} />
                <AddressBar
                  segments={result.segments}
                  totalCapacity={result.parentSize}
                  selectedIndex={safeSelected}
                  onSelect={setSelectedIndex}
                />
                {safeSelected !== null && (
                  <SegmentDetail segment={result.segments[safeSelected]} />
                )}
              </div>

              <div className="panel">
                <h2>统计</h2>
                <SummaryCards result={result} />
              </div>
            </>
          )}
        </div>
      </div>

      <BaselinePanel
        baseline={baseline}
        result={result}
        comparison={comparison}
        onSave={handleSaveBaseline}
        onClear={handleClearBaseline}
        reflowEnabled={reflowEnabled}
        onReflowChange={setReflowEnabled}
        reflowAvailable={reflowAvailable}
      />

      <RouteSummaryPanel result={result} />

      <HostAddressPanel
        result={result}
        assignments={hostAssignments}
        onAssignmentsChange={setHostAssignments}
      />

      <Option121Panel
        result={result}
        clientId={option121ClientId}
        routes={option121Routes}
        onClientChange={setOption121ClientId}
        onRoutesChange={setOption121Routes}
      />

      <ReverseDnsPanel
        result={result}
        assignments={hostAssignments}
        ownerId={reverseDnsOwnerId}
        onOwnerChange={setReverseDnsOwnerId}
      />

      <DhcpPoolPanel
        result={result}
        assignments={hostAssignments}
        ownerId={dhcpPoolOwnerId}
        exclusions={dhcpPoolExclusions}
        onOwnerChange={setDhcpPoolOwnerId}
        onExclusionsChange={setDhcpPoolExclusions}
      />

      <LeaseImportPanel
        result={result}
        assignments={hostAssignments}
        csv={leaseImportCsv}
        onCsvChange={setLeaseImportCsv}
        onAssignmentsChange={setHostAssignments}
      />

      {result.segments.length > 0 && (
        <div className="panel">
          <h2>
            网段明细（点击行查看/高亮）
            {baseline && comparison && (
              <span className="baseline-meta mono">
                基线 {baseline.parentCidr}（{comparison.baseline.createdAt.slice(0, 10)}）→ 当前{' '}
                {result.parentCidr}
              </span>
            )}
          </h2>
          <SegmentTable
            segments={result.segments}
            selectedIndex={safeSelected}
            onSelect={setSelectedIndex}
            changesById={changesById}
            showReflow={reflowActive}
          />
        </div>
      )}
    </div>
  )
}
