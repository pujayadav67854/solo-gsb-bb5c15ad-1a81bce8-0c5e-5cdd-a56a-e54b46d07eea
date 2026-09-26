// 迁移执行编排：在「现有登记 + 无冲突 CSV 导入」的合并快照（复用 leaseImport.ts
// 的统一校验口径）之上，生成一份按序执行时不会产生任何「瞬时重复 IPv4」的逐步改址清单。
//
// 依赖图（以旧地址占用关系建立）：
//   - 对每台需要改址 / 新增的设备 v，若其目标地址当前被设备 u 占用，则 v → u
//     （v 必须等待 u 让出该地址后才能迁入）；
//   - 无环部分做拓扑排序：目标地址已空（新设备或迁入未占用地址）的设备先执行，
//     被依赖者按让出顺序依次执行；
//   - 互换（2 环）或多设备环路（强连通分量大小 ≥ 2）无法直接解开：
//     先把环中一台设备（pivot）迁到其【原网段】内最低的临时可用主机地址
//     （临时地址须排除：① 当前全部占用 ② 合并快照中的全部目标地址），
//     随后沿环完成其余设备的改址，最后把 pivot 迁到其目标地址（同时释放临时地址）；
//   - 环内每台设备的原网段都找不到满足条件的临时地址时，明确阻止该环（不生成步骤）。
//
// 本模块与其他生成模块一样是纯函数、只读：不修改规划、基线、路由汇总、主机登记与导出。

import { intToIp } from './ip'
import { allocatableSegments, type AllocSegment } from './hosts'
import type { HostAssignment, PlanResult } from './types'

/* ---------- 结果模型 ---------- */

export type MigrationStatus = 'idle' | 'conflict' | 'ready' | 'blocked'

export type MigrationKind = 'add' | 'move'

/** 一台参与迁移的设备（改址设备或新增设备） */
export interface MigrationDevice {
  /** 现有登记 ID（改址设备）；新增设备使用合并快照中由导入模块生成的临时 ID */
  id: string
  name: string
  kind: MigrationKind
  /** 原 IPv4 数值 / 文本（新增设备为 undefined） */
  oldAddress?: number
  oldIp?: string
  /** 目标 IPv4 数值 / 文本 */
  targetAddress: number
  targetIp: string
  /** 原所在网段（新增设备为 undefined；用于环路临时地址选取） */
  oldSegment?: AllocSegment
  oldSegmentCidr?: string
  /** 目标所在网段 */
  targetSegment: AllocSegment
  targetSegmentCidr: string
  /** 目标网段是否与原网段不同（跨网段迁移） */
  crossSegment: boolean
  /** 原登记 MAC（展示 / 复制用，可空） */
  mac?: string
}

export type MigrationStepKind = 'move' | 'add' | 'temp' | 'final'

/** 一条逐步改址指令 */
export interface MigrationStep {
  /** 全局步骤序号（从 1 开始） */
  seq: number
  /** 所属环编号（从 1 开始）；非环路步骤为 null */
  cycle: number | null
  kind: MigrationStepKind
  deviceId: string
  deviceName: string
  /** 迁入地址（数值）：move/add/temp/final 各自的落点 */
  address: number
  ip: string
  /** move/temp 步骤的原地址（add 无原地址；final 的原地址为临时地址） */
  fromAddress?: number
  fromIp?: string
  /** 该步完成后释放的地址（move/final 释放旧地址；add 无释放；temp 不释放） */
  releasedAddress?: number
  releasedIp?: string
  /** final 步骤释放的临时地址（与 releasedAddress 相同，单独保留语义） */
  tempAddress?: number
  tempIp?: string
  /** 落点网段 CIDR */
  segmentCidr: string
  reason: string
}

/** 一个被阻止的环（找不到任何可用临时地址） */
export interface BlockedCycle {
  /** 环编号（按环内最低旧地址排序，从 1 开始） */
  index: number
  /** 环上设备（按依赖顺序，从最低旧地址设备开始） */
  members: MigrationDevice[]
  /** 逐设备给出找不到临时地址的原因（设备名 / 原网段 / 已被占用或已是目标地址） */
  reasons: { deviceId: string; deviceName: string; segmentCidr: string; message: string }[]
}

export interface MigrationUnitCount {
  /** 无环改址 / 新增设备数 */
  acyclic: number
  /** 环（互换 / 多设备环路）数 */
  cycles: number
  /** 被阻止的环数 */
  blocked: number
  /** 涉及设备总数 */
  devices: number
  /** 新增设备数 */
  adds: number
}

/** 一个可执行环的编排单元 */
interface CycleUnit {
  /** 环编号（按环内最低旧地址排序，从 1 开始） */
  index: number
  /** 环上设备（按旧地址升序，用于稳定展示与编号） */
  members: MigrationDevice[]
  /** 被选中先迁临时地址的设备 */
  pivot: MigrationDevice
  /** pivot 的临时地址 */
  temp: number
  tempSegment: AllocSegment
}

export interface MigrationPlan {
  status: MigrationStatus
  /** status === 'ready' 时存在：按执行顺序排列的全部步骤 */
  steps: MigrationStep[]
  blockedCycles: BlockedCycle[]
  /** 目标地址被不参与本次改址的静止设备占用、无法满足的依赖（防御性：无冲突合并快照下通常为空） */
  stationaryBlockers: { deviceId: string; deviceName: string; targetIp: string; holderName: string }[]
  devices: MigrationDevice[]
  counts: MigrationUnitCount
  /** status !== 'ready' 时面向用户的说明（冲突 / 空 / 阻止摘要） */
  message: string
}

/* ---------- 主入口 ---------- */

/**
 * 基于「现有登记 + 合并快照（必须已通过 leaseImport 的统一校验、无冲突）」编排迁移步骤。
 *
 * @param existing 当前主机登记（迁移前状态）
 * @param merged   应用 CSV 后的完整登记快照（要求：与现有登记等长或更长，ID 稳定、
 *                 每台现有设备最多被一条快照条目替换，快照内地址在所属网段内唯一合法）
 * @param result   当前规划结果（输入须合法）
 */
export function buildMigration(
  existing: HostAssignment[],
  merged: HostAssignment[],
  result: PlanResult,
): MigrationPlan {
  const segs = allocatableSegments(result)
  const segByOwner = new Map<string, AllocSegment>()
  for (const seg of segs) segByOwner.set(seg.ownerId, seg)

  /** 包含某数值地址的已分配网段（网段互不重叠，命中即唯一） */
  function segmentContaining(addr: number): AllocSegment | undefined {
    return segs.find((s) => addr >= s.start && addr <= s.end)
  }

  const existingById = new Map(existing.map((a) => [a.id, a]))

  /* ---------- 1. 构造参与迁移的设备节点 ---------- */

  const devices: MigrationDevice[] = []
  const deviceById = new Map<string, MigrationDevice>()

  for (const next of merged) {
    const prev = existingById.get(next.id)
    const targetSegment = segByOwner.get(next.ownerId)
    if (!targetSegment) continue // 防御：合并快照不应含无宿主登记

    if (prev) {
      const changed = prev.ownerId !== next.ownerId || prev.address !== next.address
      if (!changed) continue
      const oldSegment =
        segByOwner.get(prev.ownerId) ?? segmentContaining(prev.address) ?? undefined
      const device: MigrationDevice = {
        id: next.id,
        name: next.name,
        kind: 'move',
        oldAddress: prev.address,
        oldIp: intToIp(prev.address),
        targetAddress: next.address,
        targetIp: intToIp(next.address),
        ...(oldSegment ? { oldSegment, oldSegmentCidr: oldSegment.cidr } : {}),
        targetSegment,
        targetSegmentCidr: targetSegment.cidr,
        crossSegment: prev.ownerId !== next.ownerId,
        ...(next.mac ? { mac: next.mac } : {}),
      }
      devices.push(device)
      deviceById.set(device.id, device)
    } else {
      const device: MigrationDevice = {
        id: next.id,
        name: next.name,
        kind: 'add',
        targetAddress: next.address,
        targetIp: intToIp(next.address),
        targetSegment,
        targetSegmentCidr: targetSegment.cidr,
        crossSegment: false,
        ...(next.mac ? { mac: next.mac } : {}),
      }
      devices.push(device)
      deviceById.set(device.id, device)
    }
  }

  if (devices.length === 0) {
    return {
      status: 'idle',
      steps: [],
      blockedCycles: [],
      stationaryBlockers: [],
      devices: [],
      counts: { acyclic: 0, cycles: 0, blocked: 0, devices: 0, adds: 0 },
      message: '当前登记与无冲突导入合并后没有任何地址变化，无需迁移。',
    }
  }

  /* ---------- 2. 以旧地址占用关系建立依赖 ---------- */

  // 迁移前全部登记的实际占用：数值地址 -> 节点（只关心占用者是否为参与迁移的设备）
  // （异常同址重复登记时保留录入最早的一条，与 reconcile 口径一致）
  const oldHolder = new Map<number, MigrationDevice | 'stationary'>()
  for (const a of existing) {
    if (!oldHolder.has(a.address)) {
      const node = deviceById.get(a.id)
      oldHolder.set(a.address, node ?? 'stationary')
    }
  }

  // 合并快照中的全部目标地址（临时地址必须避开）
  const targetAddresses = new Set<number>(merged.map((a) => a.address))

  // 迁移前全部占用（临时地址必须避开；含失效登记与重复登记的实际占用）
  const occupiedAddresses = new Set<number>(existing.map((a) => a.address))

  // 每个节点等待的对象：目标地址的当前占用者
  // edge(v) = u 表示 v 依赖 u（u 先迁、v 后迁）
  const edgeTo = new Map<string, MigrationDevice | 'stationary'>()
  const stationaryBlockers: { device: MigrationDevice; holderName: string }[] = []
  for (const v of devices) {
    const holder = oldHolder.get(v.targetAddress)
    if (holder === undefined) continue // 目标地址当前空闲（新增设备 / 迁入空洞）
    if (holder === 'stationary') {
      edgeTo.set(v.id, 'stationary')
      const stationary = existing.find(
        (a) => a.address === v.targetAddress && !deviceById.has(a.id),
      )
      stationaryBlockers.push({ device: v, holderName: stationary?.name || '未命名' })
    } else if (holder.id !== v.id) {
      edgeTo.set(v.id, holder)
    }
  }

  /* ---------- 3. 强连通分量（Tarjan）识别环路 ---------- */

  // out 邻接（仅节点 -> 节点的边；stationary 边不参与成环）
  const out = new Map<string, string[]>()
  for (const v of devices) {
    const to = edgeTo.get(v.id)
    if (to && to !== 'stationary') {
      out.set(v.id, [to.id])
    } else {
      out.set(v.id, [])
    }
  }

  const indexOf = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let dfsIndex = 0
  const sccs: MigrationDevice[][] = []

  const strongConnect = (vId: string) => {
    indexOf.set(vId, dfsIndex)
    lowlink.set(vId, dfsIndex)
    dfsIndex += 1
    stack.push(vId)
    onStack.add(vId)

    for (const wId of out.get(vId) ?? []) {
      if (!indexOf.has(wId)) {
        strongConnect(wId)
        lowlink.set(vId, Math.min(lowlink.get(vId)!, lowlink.get(wId)!))
      } else if (onStack.has(wId)) {
        lowlink.set(vId, Math.min(lowlink.get(vId)!, indexOf.get(wId)!))
      }
    }

    if (lowlink.get(vId) === indexOf.get(vId)) {
      const component: string[] = []
      let wId: string | undefined
      do {
        wId = stack.pop()!
        onStack.delete(wId)
        component.push(wId)
      } while (wId !== vId)
      // 自环不可能出现（改址设备 oldAddress !== targetAddress），大小 ≥ 2 才是环
      if (component.length >= 2) sccs.push(component.map((id) => deviceById.get(id)!).reverse())
    }
  }

  for (const v of devices) {
    if (!indexOf.has(v.id)) strongConnect(v.id)
  }

  /** 设备排序键：优先旧地址，其次目标地址（全部为数值，确定性排序） */
  const orderKey = (d: MigrationDevice): number => d.oldAddress ?? d.targetAddress

  const cycleNodeIds = new Set<string>()
  const cycleUnits: CycleUnit[] = []
  const blockedCycles: BlockedCycle[] = []

  // 环按其最低旧地址排序后再编号（新增设备不可能在环中，环内必有旧地址）
  const sortedSccs = sccs
    .map((members) => ({ members, minKey: Math.min(...members.map(orderKey)) }))
    .sort((a, b) => a.minKey - b.minKey)

  for (const { members } of sortedSccs) {
    members.forEach((d) => cycleNodeIds.add(d.id))
    const orderedMembers = members.slice().sort((a, b) => orderKey(a) - orderKey(b))

    // 临时地址在已解开的环之间也视为占用，避免不同环抢同一个临时地址
    const pivot = pickPivot(members, occupiedAddresses, targetAddresses)
    if (!pivot) {
      blockedCycles.push({
        index: blockedCycles.length + 1,
        members: orderedMembers,
        reasons: orderedMembers.map((d) => ({
          deviceId: d.id,
          deviceName: d.name,
          segmentCidr: d.oldSegmentCidr ?? '—',
          message: d.oldSegment
            ? `原网段 ${d.oldSegment.cidr}（可用主机 ${d.oldSegment.firstUsable} ~ ${d.oldSegment.lastUsable}）内没有同时避开当前占用与全部目标地址的空闲主机地址`
            : '原网段已不在当前规划中，无法在其原网段内安排临时地址',
        })),
      })
      continue
    }
    cycleUnits.push({
      index: cycleUnits.length + 1,
      members: orderedMembers,
      pivot: pivot.device,
      temp: pivot.temp,
      tempSegment: pivot.segment,
    })
    occupiedAddresses.add(pivot.temp)
  }

  // 存在无法解开的环或静止占用依赖时，整体阻止（不生成任何步骤，避免半截清单误导执行）
  if (blockedCycles.length > 0 || stationaryBlockers.length > 0) {
    return {
      status: 'blocked',
      steps: [],
      blockedCycles,
      stationaryBlockers: stationaryBlockers.map(({ device, holderName }) => ({
        deviceId: device.id,
        deviceName: device.name,
        targetIp: device.targetIp,
        holderName,
      })),
      devices,
      counts: countUnits(devices, cycleNodeIds, cycleUnits, blockedCycles),
      message: blockedMessage(blockedCycles, stationaryBlockers),
    }
  }

  /* ---------- 4. 无环节点在「单元依赖图」上做拓扑排序 ---------- */

  // 单元：无环节点各自一个单元；环整体一个单元（包装对象只构造一次，保证引用一致）
  type Unit = { kind: 'node'; device: MigrationDevice } | { kind: 'cycle'; unit: CycleUnit }
  const nodeUnit = new Map<string, Unit>()
  const cycleWrapperByMember = new Map<string, Unit>()
  const units: Unit[] = []
  for (const d of devices) {
    if (cycleNodeIds.has(d.id)) continue
    const u: Unit = { kind: 'node', device: d }
    nodeUnit.set(d.id, u)
    units.push(u)
  }
  for (const unit of cycleUnits) {
    const wrapper: Unit = { kind: 'cycle', unit }
    units.push(wrapper)
    for (const d of unit.members) cycleWrapperByMember.set(d.id, wrapper)
  }

  const unitKey = (u: Unit): number => {
    if (u.kind === 'node') return orderKey(u.device)
    return Math.min(...u.unit.members.map(orderKey))
  }

  // 单元 -> 它依赖的前置单元（v 依赖 holder 先迁）
  const deps = new Map<Unit, Set<Unit>>()
  for (const u of units) deps.set(u, new Set())
  for (const d of devices) {
    if (cycleNodeIds.has(d.id)) continue
    const holder = edgeTo.get(d.id)
    if (!holder || holder === 'stationary') continue
    const from = nodeUnit.get(d.id)!
    const targetUnit = cycleWrapperByMember.get(holder.id) ?? nodeUnit.get(holder.id)
    if (targetUnit && targetUnit !== from) deps.get(from)!.add(targetUnit)
  }

  const indegree = new Map<Unit, number>()
  const dependents = new Map<Unit, Unit[]>()
  for (const u of units) {
    indegree.set(u, 0)
    dependents.set(u, [])
  }
  for (const u of units) {
    for (const dep of deps.get(u)!) {
      indegree.set(u, (indegree.get(u) ?? 0) + 1)
      dependents.get(dep)!.push(u)
    }
  }

  // Kahn：每轮在入度为 0 的单元中取排序键最小者，保证输出确定
  const ordered: Unit[] = []
  const ready: Unit[] = units.filter((u) => (indegree.get(u) ?? 0) === 0)
  while (ready.length > 0) {
    ready.sort((a, b) => unitKey(a) - unitKey(b))
    const u = ready.shift()!
    ordered.push(u)
    for (const w of dependents.get(u) ?? []) {
      const left = (indegree.get(w) ?? 0) - 1
      indegree.set(w, left)
      if (left === 0) ready.push(w)
    }
  }

  /* ---------- 6. 展开为逐步指令 ---------- */

  const steps: MigrationStep[] = []

  function emit(partial: Omit<MigrationStep, 'seq' | 'reason'> & { reason?: string }): MigrationStep {
    const step: MigrationStep = {
      seq: steps.length + 1,
      reason: partial.reason ?? '',
      ...partial,
    } as MigrationStep
    steps.push(step)
    return step
  }

  for (const u of ordered) {
    if (u.kind === 'node') {
      const d = u.device
      if (d.kind === 'add') {
        emit({
          cycle: null,
          kind: 'add',
          deviceId: d.id,
          deviceName: d.name,
          address: d.targetAddress,
          ip: d.targetIp,
          segmentCidr: d.targetSegmentCidr,
        })
      } else {
        emit({
          cycle: null,
          kind: 'move',
          deviceId: d.id,
          deviceName: d.name,
          address: d.targetAddress,
          ip: d.targetIp,
          fromAddress: d.oldAddress,
          fromIp: d.oldIp,
          releasedAddress: d.oldAddress,
          releasedIp: d.oldIp,
          segmentCidr: d.targetSegmentCidr,
        })
      }
      continue
    }

    // 环单元：① pivot 迁临时 -> ② 沿依赖链其余设备依次改址 -> ③ pivot 落到目标
    const { unit } = u
    const { pivot, temp } = unit
    emit({
      cycle: unit.index,
      kind: 'temp',
      deviceId: pivot.id,
      deviceName: pivot.name,
      address: temp,
      ip: intToIp(temp),
      fromAddress: pivot.oldAddress,
      fromIp: pivot.oldIp,
      segmentCidr: unit.tempSegment.cidr,
    })

    // 环内顺序：从「目标地址 == pivot 旧地址」的设备开始，
    // 每台设备迁入上一台让出的地址，沿「目标地址 -> 设备」映射走完环上其余设备
    const byTarget = new Map<number, MigrationDevice>()
    for (const d of unit.members) byTarget.set(d.targetAddress, d)

    const chain: MigrationDevice[] = []
    let cursorAddr: number | undefined = pivot.oldAddress
    const guard = new Set<number>()
    while (cursorAddr !== undefined && !guard.has(cursorAddr)) {
      guard.add(cursorAddr)
      const node = byTarget.get(cursorAddr)
      if (!node || node.id === pivot.id) break
      chain.push(node)
      cursorAddr = node.oldAddress
    }

    for (const d of chain) {
      emit({
        cycle: unit.index,
        kind: 'move',
        deviceId: d.id,
        deviceName: d.name,
        address: d.targetAddress,
        ip: d.targetIp,
        fromAddress: d.oldAddress,
        fromIp: d.oldIp,
        releasedAddress: d.oldAddress,
        releasedIp: d.oldIp,
        segmentCidr: d.targetSegmentCidr,
      })
    }

    emit({
      cycle: unit.index,
      kind: 'final',
      deviceId: pivot.id,
      deviceName: pivot.name,
      address: pivot.targetAddress,
      ip: pivot.targetIp,
      fromAddress: temp,
      fromIp: intToIp(temp),
      releasedAddress: temp,
      releasedIp: intToIp(temp),
      tempAddress: temp,
      tempIp: intToIp(temp),
      segmentCidr: pivot.targetSegmentCidr,
    })
  }

  /* ---------- 7. 回填每步原因（引用其他步骤的最终序号） ---------- */

  const stepAtAddress = new Map<number, MigrationStep>()
  for (const s of steps) {
    if (s.releasedAddress !== undefined) stepAtAddress.set(s.releasedAddress, s)
  }

  for (const s of steps) {
    const d = deviceById.get(s.deviceId)!
    if (s.kind === 'add') {
      s.reason = `新增设备：目标地址 ${s.ip} 当前未被占用，直接登记，不产生地址冲突。`
    } else if (s.kind === 'move' && s.cycle === null) {
      const wait = stepAtAddress.get(s.address)
      s.reason = wait
        ? `改址：等待设备“${wait.deviceName}”在第 ${wait.seq} 步迁出并释放 ${s.ip} 后迁入${
            d.crossSegment ? `（由原网段 ${d.oldSegmentCidr ?? '—'} 跨网段迁入 ${s.segmentCidr}）` : ''
          }，原地址 ${s.fromIp} 同时释放。`
        : `改址：目标地址 ${s.ip} 当前已空闲${
            d.crossSegment ? `（跨网段：${d.oldSegmentCidr ?? '—'} → ${s.segmentCidr}）` : ''
          }，直接迁入并释放原地址 ${s.fromIp}。`
    } else if (s.kind === 'temp') {
      s.reason = `打破地址环路：先把设备“${s.deviceName}”临时迁到其原网段 ${s.segmentCidr} 内最低可用地址 ${s.ip}（已排除当前全部占用与全部目标地址），为环内其他设备让出 ${s.fromIp}；临时地址将在最后一步释放。`
    } else if (s.kind === 'move' && s.cycle !== null) {
      const wait = stepAtAddress.get(s.address)
      s.reason = wait
        ? `沿环路改址：设备“${wait.deviceName}”已在第 ${wait.seq} 步离开 ${s.ip}，随即迁入并释放原地址 ${s.fromIp}。`
        : `沿环路改址：迁入 ${s.ip}，释放原地址 ${s.fromIp}。`
    } else if (s.kind === 'final') {
      s.reason = `闭合环路并释放临时地址：环内设备已全部到位、目标地址 ${s.ip} 已空，把设备“${s.deviceName}”从临时地址 ${s.tempIp} 迁到 ${s.ip}，临时地址 ${s.tempIp} 随即释放。`
    }
  }

  /* ---------- 8. 模拟执行：断言全程不存在瞬时重复 IPv4 ---------- */

  simulate(existing, steps, result, devices)

  return {
    status: 'ready',
    steps,
    blockedCycles: [],
    stationaryBlockers: [],
    devices,
    counts: countUnits(devices, cycleNodeIds, cycleUnits, []),
    message: '',
  }
}

/* ---------- 辅助 ---------- */

/**
 * 网段内最低临时可用主机地址：
 * 严格落在可用主机范围（network+1 .. broadcast-1），
 * 且既不在「当前占用」集合，也不在「全部目标地址」集合。
 */
function lowestTempAddress(
  segment: AllocSegment,
  occupied: Set<number>,
  targets: Set<number>,
): number | null {
  for (let addr = segment.start + 1; addr <= segment.end - 1; addr++) {
    const a = addr >>> 0
    if (!occupied.has(a) && !targets.has(a)) return a
  }
  return null
}

/** 环的 pivot 选择结果（环内旧地址最低且原网段有临时地址的设备） */
interface PivotChoice {
  device: MigrationDevice
  segment: AllocSegment
  temp: number
}

/** 选择环中 pivot：原网段存在、能取到临时地址，且旧地址最低的设备 */
function pickPivot(
  members: MigrationDevice[],
  occupied: Set<number>,
  targets: Set<number>,
): PivotChoice | null {
  const choices: PivotChoice[] = []
  for (const d of members) {
    if (!d.oldSegment || d.oldAddress === undefined) continue
    const temp = lowestTempAddress(d.oldSegment, occupied, targets)
    if (temp !== null) choices.push({ device: d, segment: d.oldSegment, temp })
  }
  choices.sort((a, b) => a.device.oldAddress! - b.device.oldAddress!)
  return choices[0] ?? null
}

function countUnits(
  devices: MigrationDevice[],
  cycleNodeIds: Set<string>,
  cycleUnits: { members: MigrationDevice[] }[],
  blockedCycles: BlockedCycle[],
): MigrationUnitCount {
  return {
    acyclic: devices.filter((d) => !cycleNodeIds.has(d.id)).length,
    cycles: cycleUnits.length + blockedCycles.length,
    blocked: blockedCycles.length,
    devices: devices.length,
    adds: devices.filter((d) => d.kind === 'add').length,
  }
}

function blockedMessage(
  blocked: BlockedCycle[],
  stationary: { device: MigrationDevice; holderName: string }[],
): string {
  const parts: string[] = []
  for (const c of blocked) {
    const names = c.members.map((m) => `“${m.name}”(${m.oldIp}→${m.targetIp})`).join('、')
    parts.push(
      `环 ${c.index}（${names}）无法解开：环内每台设备的原网段都找不到同时避开当前占用与全部目标地址的临时主机地址，请先在对应网段腾出地址或调整规划 / CSV。`,
    )
  }
  for (const { device, holderName } of stationary) {
    parts.push(
      `设备“${device.name}”的目标地址 ${device.targetIp} 被不参与本次改址的设备“${holderName}”占用且未在 CSV 中更新，依赖无法满足；请把该设备一并纳入导入或更换目标地址。`,
    )
  }
  return parts.join(' ')
}

/**
 * 按步骤模拟执行，验证不变量：
 * 每一步完成后，所有仍在线的地址两两不重复（无瞬时重复 IPv4），
 * 且最终占用集合恰好等于合并快照的目标地址集合。
 * 仅在内部逻辑被破坏时抛出（正常输入不应触发）。
 */
function simulate(
  existing: HostAssignment[],
  steps: MigrationStep[],
  result: PlanResult,
  devices: MigrationDevice[],
): void {
  const segs = allocatableSegments(result)
  const segByOwner = new Map(segs.map((s) => [s.ownerId, s]))

  // 在线记录：设备 ID -> 当前地址（初始为迁移前登记；重复登记按最早一条保留）
  const live = new Map<string, number>()
  for (const a of existing) {
    if (!live.has(a.id)) live.set(a.id, a.address)
  }

  const assertNoDup = (at: number) => {
    const seen = new Set<number>()
    for (const addr of live.values()) {
      if (seen.has(addr)) {
        throw new Error(`迁移编排内部错误：第 ${at} 步后出现瞬时重复地址 ${intToIp(addr)}`)
      }
      seen.add(addr)
    }
  }

  for (const s of steps) {
    if (s.kind === 'add') {
      live.set(s.deviceId, s.address)
    } else {
      live.set(s.deviceId, s.address) // move/temp/final：同一设备换址（自动释放旧地址）
    }
    assertNoDup(s.seq)
  }

  // 最终集合校验：每台参与设备都在其目标网段的目标地址上
  for (const d of devices) {
    const got = live.get(d.id)
    if (got !== d.targetAddress) {
      throw new Error(`迁移编排内部错误：设备“${d.name}”最终地址 ${got ? intToIp(got) : '缺失'} ≠ 目标 ${d.targetIp}`)
    }
    const seg = segByOwner.get(d.targetSegment.ownerId)
    if (!seg || got < seg.start + 1 || got > seg.end - 1) {
      throw new Error(`迁移编排内部错误：设备“${d.name}”最终地址不在目标网段可用范围内`)
    }
  }
}

/* ---------- 复制清单文本 ---------- */

/** 生成可一键复制的纯文本逐步改址清单（TSV：步骤/设备/原地址/目标地址/临时地址/所属网段/原因） */
export function migrationPlanText(plan: MigrationPlan): string {
  if (plan.status !== 'ready') return ''
  const header = ['步骤', '环', '操作', '设备', '原地址', '迁入地址', '临时地址', '所属网段', '原因']
  const lines = [header.join('\t')]
  const kindLabel: Record<MigrationStepKind, string> = {
    move: '改址',
    add: '新增',
    temp: '临时迁出',
    final: '迁入目标并释放临时地址',
  }
  for (const s of plan.steps) {
    lines.push(
      [
        String(s.seq),
        s.cycle === null ? '—' : `环${s.cycle}`,
        kindLabel[s.kind],
        s.deviceName,
        s.fromIp ?? '—',
        s.ip,
        s.kind === 'temp' || s.kind === 'final' ? (s.tempIp ?? (s.kind === 'temp' ? s.ip : '')) : '—',
        s.segmentCidr,
        s.reason,
      ].join('\t'),
    )
  }
  return lines.join('\n')
}
