// Botify build of mineflayer-pathfinder 2.4.5 index.js.
// Installed over node_modules/mineflayer-pathfinder/index.js by scripts/patch-pathfinder.js.
// Differences from upstream:
//  - rolling planning: a search that times out does not fail the route. The bot walks the best
//    part found so far while the next segment is planned from its end, and the result is appended;
//  - weighted A* heuristic for faster searches on long routes;
//  - path nodes are copies: post-processing never mutates nodes that A* is still expanding;
//  - movement never stops to turn: keys (W, W+A, A, ...) are chosen relative to the current
//    head yaw while the smooth look controller turns the head;
//  - look-ahead on flat ground: the bot heads for the farthest node reachable in a clear
//    straight corridor instead of visiting every block center;
//  - dropping down: a lower node counts as reached while falling into it, so the bot walks
//    off edges instead of stopping at them;
//  - chunk loads and block changes that do not affect walking no longer reset the route;
//  - stopping only releases keys (no velocity reset or recentering).
const { performance } = require('perf_hooks')

const AStar = require('./lib/astar')
const Move = require('./lib/move')
const Movements = require('./lib/movements')
const gotoUtil = require('./lib/goto')
const Lock = require('./lib/lock')

const Vec3 = require('vec3').Vec3

const Physics = require('./lib/physics')
const { PlayerState } = require('prismarine-physics')
const nbt = require('prismarine-nbt')
const interactableBlocks = require('./lib/interactable.json')

const HEURISTIC_WEIGHT = 1.4 // >1 trades a little path length for far fewer expanded nodes
const PURSUIT_NODES = 8 // how many nodes ahead the look-ahead may skip
const PURSUIT_RANGE = 7 // blocks
const MIN_SEGMENT_PROGRESS = 1 // a continued search must get at least this much closer
const MAX_FRESH_PLANS = 3 // replans from the bot position without getting closer
const MAX_SEARCH_BUDGET = 8 // a segment without progress may think up to 8× thinkTimeout
// Server position corrections (setbacks): keys are released until the bot stands still on the
// ground, sprint and corner-cutting stay off for a while, and a spot corrected twice is avoided.
const RECOVER_TICKS = 4
const CAREFUL_MS = 3000
const AVOID_COST = 100
const MAX_CORRECTIONS = 6 // without getting closer to the goal
const HAZARDS = /^(water|lava|fire|soul_fire|cobweb|powder_snow|sweet_berry_bush|cactus|magma_block|campfire|soul_campfire)$/
const LIQUIDS = /^(water|lava|bubble_column)$/
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a))

function inject (bot) {
  const waterType = bot.registry.blocksByName.water.id
  const ladderId = bot.registry.blocksByName.ladder.id
  const vineId = bot.registry.blocksByName.vine.id
  let stateMovements = new Movements(bot)
  let stateGoal = null
  let astarContext = null
  let dynamicGoal = false
  let path = []
  // Planning state. `search` runs a few ms per tick; its nodes are the last `liveCount` of `path`.
  let search = null
  let liveCount = 0
  let failure = null // status of a finished search that could not get closer
  let gaveUp = false
  let freshPlans = 0
  let lastFreshPos = null
  let bestH = Infinity
  let walkedAny = false
  // Correction recovery (see RECOVER_TICKS).
  let recoverTicks = 0
  let recoverAir = 0
  let carefulUntil = 0
  let correctionsSinceProgress = 0
  let recentCorrections = []
  const avoided = new Map() // "x,z" -> feet y
  const avoidStep = block => {
    const y = avoided.get(`${block.position.x},${block.position.z}`)
    return y !== undefined && block.position.y >= y - 1 && block.position.y <= y + 2 ? AVOID_COST : 0
  }
  let digging = false
  let placing = false
  let placingBlock = null
  let lastNodeTime = performance.now()
  let returningPos = null
  let stopPathing = false
  const physics = new Physics(bot)
  // Simulations use the same "reached" rule as execution (including falling into a lower node).
  physics.getReached = nodes => state => reachedNode(state.pos, nodes[0], nodes.length === 1, state.onGround)
  // Path shortcuts must not slide along walls: a wall brush costs speed and sprint.
  physics.canStraightLineBetween = (n1, n2) => {
    const reached = state => {
      const delta = n2.minus(state.pos)
      return (delta.x * delta.x + delta.z * delta.z) <= 0.15 * 0.15 && Math.abs(delta.y) < 0.001 && (state.onGround || state.isInWater)
    }
    let collided = false
    const steer = physics.getController(n2, false, true)
    const state = new PlayerState(bot, { ...bot.controlState })
    state.pos.update(n1)
    physics.simulateUntil(s => reached(s) || collided, (s, tick) => {
      steer(s, tick)
      if (tick > 0 && s.isCollidedHorizontally) collided = true
    }, Math.floor(5 * n1.distanceTo(n2)), state)
    return !collided && reached(state)
  }
  const lockPlaceBlock = new Lock()
  const lockEquipItem = new Lock()
  const lockUseBlock = new Lock()

  bot.pathfinder = {}

  bot.pathfinder.thinkTimeout = 5000 // ms, per planned segment
  bot.pathfinder.tickTimeout = 40 // ms, amount of thinking per tick (max 50 ms)
  bot.pathfinder.searchRadius = -1 // in blocks, limits of the search area, -1: don't limit the search
  bot.pathfinder.enablePathShortcut = false // disabled by default as it can cause bugs in specific configurations
  bot.pathfinder.LOSWhenPlacingBlocks = true
  bot.pathfinder.lookAhead = true // head for the farthest clearly reachable node on flat ground
  bot.pathfinder.failureReason = null // 'corrections' when the server kept correcting the bot
  bot.pathfinder.humanMode = false // test walking mode: look where walking, W only (boolean or () => boolean)
  // External driver (src/route-walker.js): it reads the planned route before physics and, when it
  // steers this tick, sets `driven` so the pathfinder only tracks nodes and does not press keys.
  bot.pathfinder.driven = null // { progress: boolean } for the current tick, or null
  bot.pathfinder.getPath = () => path
  bot.pathfinder.skipNodes = count => {
    if (count <= 0 || digging || placing) return
    consume(Math.min(count, path.length))
    lastNodeTime = performance.now()
  }
  bot.pathfinder.recoveryState = () => ({ recovering: recoverTicks > 0, careful: performance.now() < carefulUntil })
  bot.pathfinder.debugState = null // the last movement decision, for movement diagnostics

  bot.pathfinder.bestHarvestTool = (block) => {
    const availableTools = bot.inventory.items()
    const effects = bot.entity.effects

    let fastest = Number.MAX_VALUE
    let bestTool = null
    for (const tool of availableTools) {
      const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : []
      const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, effects)
      if (digTime < fastest) {
        fastest = digTime
        bestTool = tool
      }
    }

    return bestTool
  }

  function startMoveAt (startPos, movements) {
    const p = startPos.floored()
    const dy = startPos.y - p.y
    const b = bot.blockAt(p) // The block we are standing in
    // Offset the floored bot position by one if we are standing on a block that has not the full height but is solid
    const offset = (b && dy > 0.001 && bot.entity.onGround && !stateMovements.emptyBlocks.has(b.type)) ? 1 : 0
    return new Move(p.x, p.y + offset, p.z, movements.countScaffoldingItems(), 0)
  }

  bot.pathfinder.getPathTo = (movements, goal, timeout) => {
    const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout })
    const { value: { result, astarContext: context } } = generator.next()
    astarContext = context
    return result
  }

  bot.pathfinder.getPathFromTo = function * (movements, startPos, goal, options = {}) {
    const optimizePath = options.optimizePath ?? true
    const resetEntityIntersects = options.resetEntityIntersects ?? true
    const timeout = options.timeout ?? bot.pathfinder.thinkTimeout
    const tickTimeout = options.tickTimeout ?? bot.pathfinder.tickTimeout
    const searchRadius = options.searchRadius ?? bot.pathfinder.searchRadius
    const start = options.startMove ?? startMoveAt(startPos, movements)
    if (movements.allowEntityDetection) {
      if (resetEntityIntersects) {
        movements.clearCollisionIndex()
      }
      movements.updateCollisionIndex()
    }
    const astarContext = new AStar(start, movements, goal, timeout, tickTimeout, searchRadius)
    const finish = result => {
      result.path = result.path.map(toPathNode)
      if (optimizePath) result.path = postProcessPath(result.path, startPos)
      return result
    }
    let result = finish(astarContext.compute())
    yield { result, astarContext }
    while (result.status === 'partial') {
      result = finish(astarContext.compute())
      yield { result, astarContext }
    }
  }

  Object.defineProperties(bot.pathfinder, {
    goal: {
      get () {
        return stateGoal
      }
    },
    movements: {
      get () {
        return stateMovements
      }
    }
  })

  function detectDiggingStopped () {
    digging = false
    bot.removeAllListeners('diggingAborted', detectDiggingStopped)
    bot.removeAllListeners('diggingCompleted', detectDiggingStopped)
  }

  function resetPath (reason, clearStates = true) {
    if (!stopPathing && path.length > 0) bot.emit('path_reset', reason)
    path = []
    search = null
    liveCount = 0
    failure = null
    if (digging) {
      bot.on('diggingAborted', detectDiggingStopped)
      bot.on('diggingCompleted', detectDiggingStopped)
      bot.stopDigging()
    }
    placing = false
    astarContext = null
    lockEquipItem.release()
    lockPlaceBlock.release()
    lockUseBlock.release()
    stateMovements.clearCollisionIndex()
    if (clearStates) bot.clearControlStates()
    if (stopPathing) return stop()
  }

  bot.pathfinder.setGoal = (goal, dynamic = false) => {
    stateGoal = goal
    dynamicGoal = dynamic
    gaveUp = false
    freshPlans = 0
    lastFreshPos = null
    bestH = Infinity
    walkedAny = false
    correctionsSinceProgress = 0
    recentCorrections = []
    clearAvoided()
    bot.pathfinder.failureReason = null
    bot.emit('goal_updated', goal, dynamic)
    resetPath('goal_updated')
  }

  function clearAvoided () {
    avoided.clear()
    const i = stateMovements.exclusionAreasStep.indexOf(avoidStep)
    if (i >= 0) stateMovements.exclusionAreasStep.splice(i, 1)
  }

  bot.pathfinder.setMovements = (movements) => {
    clearAvoided()
    stateMovements = movements
    gaveUp = false
    freshPlans = 0
    resetPath('movements_updated')
  }

  bot.pathfinder.isMoving = () => path.length > 0
  bot.pathfinder.isMining = () => digging
  bot.pathfinder.isBuilding = () => placing

  bot.pathfinder.goto = (goal) => {
    return gotoUtil(bot, goal)
  }

  bot.pathfinder.stop = () => {
    stopPathing = true
  }

  bot.on('physicsTick', monitorMovement)

  // A* returns its own Move objects; it may still expand them. Execution works on copies.
  function toPathNode (move) {
    const node = new Vec3(move.x, move.y, move.z)
    node.raw = move
    node.hash = move.hash
    node.cost = move.cost
    node.remainingBlocks = move.remainingBlocks
    node.toBreak = move.toBreak.slice()
    node.toPlace = move.toPlace.slice()
    node.parkour = move.parkour
    return node
  }

  function postProcessPath (path, from = bot.entity.position) {
    for (let i = 0; i < path.length; i++) {
      const curPoint = path[i]
      if (curPoint.toBreak.length > 0 || curPoint.toPlace.length > 0) break
      const b = bot.blockAt(new Vec3(curPoint.x, curPoint.y, curPoint.z))
      if (b && (b.type === waterType || ((b.type === ladderId || b.type === vineId) && i + 1 < path.length && path[i + 1].y < curPoint.y))) {
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = Math.floor(curPoint.y)
        curPoint.z = Math.floor(curPoint.z) + 0.5
        continue
      }
      let np = getPositionOnTopOf(b)
      if (np === null) np = getPositionOnTopOf(bot.blockAt(new Vec3(curPoint.x, curPoint.y - 1, curPoint.z)))
      if (np) {
        curPoint.x = np.x
        curPoint.y = np.y
        curPoint.z = np.z
      } else {
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = curPoint.y - 1
        curPoint.z = Math.floor(curPoint.z) + 0.5
      }
    }

    if (!bot.pathfinder.enablePathShortcut || stateMovements.exclusionAreasStep.length !== 0 || path.length === 0) return path

    // Simulated shortcuts are expensive: only the near part is merged; look-ahead covers the rest.
    const window = Math.min(path.length, 32)
    const newPath = []
    let lastNode = from
    for (let i = 1; i < window; i++) {
      const node = path[i]
      if (Math.abs(node.y - lastNode.y) > 0.5 || node.toBreak.length > 0 || node.toPlace.length > 0 || !physics.canStraightLineBetween(lastNode, node)) {
        newPath.push(path[i - 1])
        lastNode = path[i - 1]
      }
    }
    newPath.push(path[window - 1])
    for (let i = window; i < path.length; i++) newPath.push(path[i])
    return newPath
  }

  function pathFromPlayer (path) {
    if (path.length === 0) return
    let minI = 0
    let minDistance = 1000
    for (let i = 0; i < path.length; i++) {
      const node = path[i]
      if (node.toBreak.length !== 0 || node.toPlace.length !== 0) break
      const dist = bot.entity.position.distanceSquared(node)
      if (dist < minDistance) {
        minDistance = dist
        minI = i
      }
    }
    // check if we are between 2 nodes
    const n1 = path[minI]
    // check if node already reached
    const dx = n1.x - bot.entity.position.x
    const dy = n1.y - bot.entity.position.y
    const dz = n1.z - bot.entity.position.z
    const reached = Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < 1
    if (minI + 1 < path.length && n1.toBreak.length === 0 && n1.toPlace.length === 0) {
      const n2 = path[minI + 1]
      const d2 = bot.entity.position.distanceSquared(n2)
      const d12 = n1.distanceSquared(n2)
      minI += d12 > d2 || reached ? 1 : 0
    }

    path.splice(0, minI)
  }

  function consume (count) {
    path.splice(0, count)
    liveCount = Math.min(liveCount, path.length)
  }

  // Intermediate nodes below the bot count as reached while it falls into their column:
  // A* only plans drops through a free column. The final node still needs the bot to land.
  function reachedNode (pos, node, last, onGround) {
    const dx = node.x - pos.x
    const dy = node.y - pos.y
    const dz = node.z - pos.z
    if (Math.abs(dx) > 0.35 || Math.abs(dz) > 0.35) return false
    if (Math.abs(dy) < 1) return true
    return !last && !onGround && dy < 0 && dy > -(stateMovements.maxDropDown + 1.5)
  }

  function isPositionNearPath (pos, path) {
    let prevNode = null
    for (const node of path) {
      let comparisonPoint = null
      if (
        prevNode === null ||
        (
          Math.abs(prevNode.x - node.x) <= 2 &&
          Math.abs(prevNode.y - node.y) <= 2 &&
          Math.abs(prevNode.z - node.z) <= 2
        )
      ) {
        // Unoptimized path, or close enough to last point
        // to just check against the current point
        comparisonPoint = node
      } else {
        // Optimized path - the points are far enough apart
        //   that we need to check the space between them too

        // First, a quick check - if point it outside the path
        // segment's AABB, then it isn't near.
        const minBound = prevNode.min(node)
        const maxBound = prevNode.max(node)
        if (
          pos.x - 0.5 < minBound.x - 1 ||
          pos.x - 0.5 > maxBound.x + 1 ||
          pos.y - 0.5 < minBound.y - 2 ||
          pos.y - 0.5 > maxBound.y + 2 ||
          pos.z - 0.5 < minBound.z - 1 ||
          pos.z - 0.5 > maxBound.z + 1
        ) {
          continue
        }

        comparisonPoint = closestPointOnLineSegment(pos, prevNode, node)
      }

      const dx = Math.abs(comparisonPoint.x - pos.x - 0.5)
      const dy = Math.abs(comparisonPoint.y - pos.y - 0.5)
      const dz = Math.abs(comparisonPoint.z - pos.z - 0.5)
      if (dx <= 1 && dy <= 2 && dz <= 1) return true

      prevNode = node
    }

    return false
  }

  function closestPointOnLineSegment (point, segmentStart, segmentEnd) {
    const segmentLength = segmentEnd.minus(segmentStart).norm()

    if (segmentLength === 0) {
      return segmentStart
    }

    // t is like an interpolation from segmentStart to segmentEnd
    //  for the closest point on the line
    let t = (point.minus(segmentStart)).dot(segmentEnd.minus(segmentStart)) / segmentLength

    // bound t to be on the segment
    t = Math.max(0, Math.min(1, t))

    return segmentStart.plus(segmentEnd.minus(segmentStart).scaled(t))
  }

  // Return the average x/z position of the highest standing positions
  // in the block.
  function getPositionOnTopOf (block) {
    if (!block || block.shapes.length === 0) return null
    const p = new Vec3(0.5, 0, 0.5)
    let n = 1
    for (const shape of block.shapes) {
      const h = shape[4]
      if (h === p.y) {
        p.x += (shape[0] + shape[3]) / 2
        p.z += (shape[2] + shape[5]) / 2
        n++
      } else if (h > p.y) {
        n = 2
        p.x = 0.5 + (shape[0] + shape[3]) / 2
        p.y = h
        p.z = 0.5 + (shape[2] + shape[5]) / 2
      }
    }
    p.x /= n
    p.z /= n
    return block.position.plus(p)
  }

  /**
   * Release movement controls and let physics handle the remaining inertia.
   */
  function fullStop () {
    // Botify: release keys; only physics may change position or velocity when stopping.
    bot.clearControlStates()
  }

  function moveToEdge (refBlock, edge) {
    // If allowed turn instantly should maybe be a bot option
    const allowInstantTurn = false
    function getViewVector (pitch, yaw) {
      const csPitch = Math.cos(pitch)
      const snPitch = Math.sin(pitch)
      const csYaw = Math.cos(yaw)
      const snYaw = Math.sin(yaw)
      return new Vec3(-snYaw * csPitch, snPitch, -csYaw * csPitch)
    }
    // Target viewing direction while approaching edge
    // The Bot approaches the edge while looking in the opposite direction from where it needs to go
    // The target Pitch angle is roughly the angle the bot has to look down for when it is in the position
    // to place the next block
    const targetBlockPos = refBlock.offset(edge.x + 0.5, edge.y, edge.z + 0.5)
    const targetPosDelta = bot.entity.position.clone().subtract(targetBlockPos)
    const targetYaw = Math.atan2(-targetPosDelta.x, -targetPosDelta.z)
    const targetPitch = -1.421
    const viewVector = getViewVector(targetPitch, targetYaw)
    // While the bot is not in the right position rotate the view and press back while crouching
    if (bot.entity.position.distanceTo(refBlock.clone().offset(edge.x + 0.5, 1, edge.z + 0.5)) > 0.4) {
      bot.lookAt(bot.entity.position.offset(viewVector.x, viewVector.y, viewVector.z), allowInstantTurn)
      bot.setControlState('sneak', true)
      bot.setControlState('back', true)
      return false
    }
    bot.setControlState('back', false)
    return true
  }

  function moveToBlock (pos) {
    // minDistanceSq = Min distance sqrt to the target pos were the bot is centered enough to place blocks around him
    const minDistanceSq = 0.2 * 0.2
    const targetPos = pos.clone().offset(0.5, 0, 0.5)
    if (bot.entity.position.distanceSquared(targetPos) > minDistanceSq) {
      bot.lookAt(targetPos)
      bot.setControlState('forward', true)
      return false
    }
    bot.setControlState('forward', false)
    return true
  }

  function stop () {
    stopPathing = false
    stateGoal = null
    path = []
    search = null
    liveCount = 0
    failure = null
    bot.emit('path_stop')
    fullStop()
  }

  // ---- planning ----

  function beginSearch (start, from, continuation, budget = 1) {
    const goal = stateGoal
    // Inflated heuristic only inside A*; progress checks use the real goal heuristic.
    const weighted = { isEnd: node => goal.isEnd(node), heuristic: node => goal.heuristic(node) * HEURISTIC_WEIGHT }
    if (!continuation && stateMovements.allowEntityDetection) {
      stateMovements.clearCollisionIndex()
      stateMovements.updateCollisionIndex()
    }
    const ctx = new AStar(start, stateMovements, weighted, bot.pathfinder.thinkTimeout * budget, bot.pathfinder.tickTimeout, bot.pathfinder.searchRadius)
    search = { ctx, start, from, startH: goal.heuristic(start), continuation, budget }
    astarContext = ctx
  }

  function beginFreshSearch () {
    freshPlans++
    lastFreshPos = bot.entity.position.clone()
    path = []
    liveCount = 0
    failure = null
    beginSearch(startMoveAt(bot.entity.position, stateMovements), bot.entity.position, false)
  }

  function continueFrom (node) {
    const raw = node.raw
    beginSearch(new Move(raw.x, raw.y, raw.z, stateMovements.countScaffoldingItems(), 0), node, true)
  }

  function emitUpdate (result, status) {
    bot.emit('path_update', {
      status,
      cost: result.cost,
      time: result.time,
      visitedNodes: result.visitedNodes,
      generatedNodes: result.generatedNodes,
      path,
      context: result.context
    })
  }

  function pumpSearch () {
    const s = search
    const result = s.ctx.compute()
    const nodes = postProcessPath(result.path.map(toPathNode), s.from)
    const fixedCount = path.length - liveCount
    if (fixedCount <= 0) {
      // Nothing fixed left ahead of us: the live result starts where the bot is now.
      pathFromPlayer(nodes)
      path = nodes
    } else {
      path = path.slice(0, fixedCount).concat(nodes)
    }
    liveCount = fixedCount <= 0 ? path.length : nodes.length
    if (nodes.length) walkedAny = true

    if (result.status === 'partial') {
      if (path.length) emitUpdate(result, 'partial')
      return
    }

    search = null
    liveCount = 0
    if (result.status === 'success') {
      emitUpdate(result, 'success')
      return
    }
    // Timed out or exhausted: keep walking what we have and plan the next segment from its end.
    const end = result.path.length ? result.path[result.path.length - 1] : null
    if (end && s.startH - stateGoal.heuristic(end) >= MIN_SEGMENT_PROGRESS && path.length) {
      continueFrom(path[path.length - 1])
      emitUpdate(result, 'partial')
      return
    }
    // Out of time before getting closer (e.g. a long detour around a wall): think longer.
    // The A* state is intact after a timeout, so the same search simply continues.
    if (result.status === 'timeout' && s.budget < MAX_SEARCH_BUDGET) {
      s.budget *= 2
      s.ctx.timeout *= 2
      search = s
      liveCount = nodes.length
      return
    }
    failure = result.status
    if (path.length) emitUpdate(result, 'partial')
  }

  // Keep the next couple of nodes and plan the rest again while walking them.
  function softReplan (reason, keep = 2) {
    if (digging || placing || path.length <= keep || path.slice(0, keep).some(n => n.toBreak.length || n.toPlace.length)) {
      resetPath(reason, false)
      return
    }
    path = path.slice(0, keep)
    liveCount = 0
    failure = null
    continueFrom(path[keep - 1])
  }

  function noteProgress () {
    if (!stateGoal) return
    const h = stateGoal.heuristic(bot.entity.position.floored())
    if (h < bestH - 2) {
      bestH = h
      freshPlans = 0
      correctionsSinceProgress = 0
    }
  }

  // The server put the bot back (anticheat setback or a plugin teleport). Never repeat the
  // rejected movement blindly: stop, settle, replan; a spot corrected twice is routed around.
  bot.on('botifyCorrection', correction => {
    if (!stateGoal || !bot.entity) return
    const now = performance.now()
    recoverTicks = RECOVER_TICKS
    recoverAir = 0
    carefulUntil = now + CAREFUL_MS
    const to = new Vec3(correction.to.x, correction.to.y, correction.to.z)
    const from = new Vec3(correction.from.x, correction.from.y, correction.from.z)
    recentCorrections = recentCorrections.filter(c => now - c.time < 15000)
    const repeated = recentCorrections.some(c => c.to.distanceTo(to) < 1.5)
    recentCorrections.push({ time: now, to })
    if (repeated) avoidAround(from, to)
    if (++correctionsSinceProgress >= MAX_CORRECTIONS) {
      bot.pathfinder.failureReason = 'corrections'
      resetPath('corrections')
      gaveUp = true
      bot.emit('path_update', { status: 'noPath', cost: 0, time: 0, visitedNodes: 0, generatedNodes: 0, path: [bot.entity.position.floored()] })
      return
    }
    // Replanning after being put back is not a failed search: MAX_CORRECTIONS limits it instead.
    freshPlans = 0
    lastFreshPos = null
    gaveUp = false
    if (path.length || search) resetPath('correction')
    else fullStop()
  })

  // Mark the cells the rejected movement was entering, not the one the bot was put back into.
  function avoidAround (from, to) {
    const dx = from.x - to.x
    const dz = from.z - to.z
    const len = Math.hypot(dx, dz)
    const start = `${Math.floor(to.x)},${Math.floor(to.z)}`
    const y = Math.floor(to.y + 1e-6)
    const points = [from]
    if (len > 0.05) points.push(from.offset(dx / len * 0.6, 0, dz / len * 0.6))
    for (const p of points) {
      const key = `${Math.floor(p.x)},${Math.floor(p.z)}`
      if (key !== start) avoided.set(key, y)
    }
    if (avoided.size && !stateMovements.exclusionAreasStep.includes(avoidStep)) stateMovements.exclusionAreasStep.push(avoidStep)
  }

  function walkable (block) {
    return block ? block.boundingBox + '|' + LIQUIDS.test(block.name) + '|' + JSON.stringify(block.shapes) : 'null'
  }

  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock || oldBlock.type === newBlock.type) return
    // Grass, flowers, crops etc. changing does not affect the route.
    if (walkable(oldBlock) === walkable(newBlock) && !stateMovements.blocksToAvoid?.has(newBlock.type)) return
    if (isPositionNearPath(oldBlock.position, path)) {
      resetPath('block_updated', false)
    }
  })

  bot.on('chunkColumnLoad', (chunk) => {
    // A running search may have hit the edge of the loaded world: restart it from the same start.
    // A finished route is kept; its end replans anyway once the bot gets there.
    if (search && !search.restarted) {
      const cx = chunk.x >> 4
      const cz = chunk.z >> 4
      const visited = search.ctx.visitedChunks
      if (visited.has(`${cx - 1},${cz}`) || visited.has(`${cx},${cz - 1}`) ||
          visited.has(`${cx + 1},${cz}`) || visited.has(`${cx},${cz + 1}`)) {
        const { start, from, continuation } = search
        beginSearch(start, from, continuation)
        search.restarted = true
      }
    }
  })

  // ---- execution ----

  function blockReader () {
    const cache = new Map()
    return pos => {
      const key = `${pos.x},${pos.y},${pos.z}`
      if (!cache.has(key)) cache.set(key, bot.blockAt(pos, false))
      return cache.get(key)
    }
  }

  // Conservative straight corridor on one level: the whole body is free and both feet stay
  // supported at the same height. Unknown blocks, hazards and liquids fail the check.
  function clearCorridor (from, to, getBlock) {
    if (Math.abs(to.y - from.y) > 0.05) return false
    const length = Math.hypot(to.x - from.x, to.z - from.z)
    if (length > PURSUIT_RANGE) return false
    const half = (bot.physics?.playerHalfWidth || 0.3) + 0.03
    const height = bot.physics?.playerHeight || 1.8
    const steps = Math.max(1, Math.ceil(length / 0.2))
    const at = new Vec3(0, 0, 0)
    const bad = b => !b || HAZARDS.test(b.name) || stateMovements.blocksToAvoid?.has(b.type)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const px = from.x + (to.x - from.x) * t
      const py = from.y
      const pz = from.z + (to.z - from.z) * t
      for (let x = Math.floor(px - half); x <= Math.floor(px + half); x++) {
        for (let z = Math.floor(pz - half); z <= Math.floor(pz + half); z++) {
          for (let y = Math.floor(py); y <= Math.floor(py + height); y++) {
            const b = getBlock(at.set(x, y, z))
            if (bad(b)) return false
            if (b.shapes.some(s => x + s[3] > px - half && x + s[0] < px + half &&
              z + s[5] > pz - half && z + s[2] < pz + half &&
              y + s[4] > py + 1e-6 && y + s[1] < py + height - 1e-6)) return false
          }
        }
      }
      for (const ox of [-0.25, 0.25]) {
        for (const oz of [-0.25, 0.25]) {
          const fx = px + ox; const fy = py - 1e-4; const fz = pz + oz
          const bx = Math.floor(fx); const by = Math.floor(fy); const bz = Math.floor(fz)
          const b = getBlock(at.set(bx, by, bz))
          if (bad(b)) return false
          if (!b.shapes.some(s => fx >= bx + s[0] && fx <= bx + s[3] &&
            fz >= bz + s[2] && fz <= bz + s[5] && Math.abs(by + s[4] - py) <= 0.05)) return false
        }
      }
    }
    return true
  }

  // Skip nodes on the same level that can be reached in a clear straight line from here.
  function lookAhead () {
    if (!bot.pathfinder.lookAhead || path.length < 2 || performance.now() < carefulUntil) return
    if (!bot.entity.onGround || bot.entity.isInWater || bot.entity.isInLava) return
    if (stateMovements.exclusionAreasStep.length !== 0) return
    const p = bot.entity.position
    const getBlock = blockReader()
    let best = 0
    const last = Math.min(path.length - 1, PURSUIT_NODES)
    for (let k = 0; k <= last; k++) {
      const n = path[k]
      if (n.toBreak.length || n.toPlace.length || n.parkour) break
      if (Math.abs(n.y - p.y) > 0.05) break
      if (k === 0) continue
      if (!clearCorridor(p, n, getBlock)) break
      best = k
    }
    if (best > 0) {
      consume(best)
      lastNodeTime = performance.now()
    }
  }

  // A* allows diagonal steps past a wall corner. Walking that line clips the corner and kills
  // speed, so aim through the free side cell until the direct line is clear.
  function cornerWaypoint (node) {
    if (!bot.entity.onGround || bot.entity.isInWater) return null
    if (performance.now() < carefulUntil) return null
    const p = bot.entity.position
    if (Math.abs(node.y - p.y) > 0.05) return null
    const cx = Math.floor(p.x); const cz = Math.floor(p.z)
    const nx = Math.floor(node.x); const nz = Math.floor(node.z)
    if (Math.abs(nx - cx) !== 1 || Math.abs(nz - cz) !== 1) return null
    const getBlock = blockReader()
    if (clearCorridor(p, node, getBlock)) return null
    for (const [x, z] of [[nx, cz], [cx, nz]]) {
      const via = new Vec3(x + 0.5, p.y, z + 0.5)
      if (clearCorridor(p, via, getBlock) && clearCorridor(via, node, getBlock)) return via
    }
    return null
  }

  // W/A/S/D relative to the CURRENT head yaw: movement continues while the head turns.
  function steer (desiredYaw) {
    const delta = wrap(desiredYaw - bot.entity.yaw)
    const sector = (Math.round(delta / (Math.PI / 4)) + 8) % 8
    return {
      delta,
      forward: sector === 7 || sector === 0 || sector === 1,
      back: sector === 3 || sector === 4 || sector === 5,
      left: sector === 1 || sector === 2 || sector === 3,
      right: sector === 5 || sector === 6 || sector === 7
    }
  }

  // ---- test walking mode (bot.pathfinder.humanMode): walk like a player at the keyboard ----
  // The head faces the way the bot walks, yaw and pitch: it looks at the route a few blocks
  // ahead (up a staircase, down a drop). Only W (+Ctrl, Space) is used; no strafing or
  // walking backwards. A large turn is made on the spot before walking on.
  const HUMAN_LOOK_DISTANCE = 4 // blocks along the route
  const HUMAN_LOOK_HEIGHT = 1 // above the route's feet level: about chest height ahead
  const HUMAN_WALK_ANGLE = 50 * Math.PI / 180
  const HUMAN_SPRINT_ANGLE = 25 * Math.PI / 180

  function isHumanMode () {
    const mode = bot.pathfinder.humanMode
    return typeof mode === 'function' ? !!mode() : !!mode
  }

  function lookPitch (aim) {
    const p = bot.entity.position
    let from = p
    let left = HUMAN_LOOK_DISTANCE
    let point = aim
    for (const node of [aim, ...path.slice(aim === path[0] ? 1 : 0, PURSUIT_NODES)]) {
      const step = Math.hypot(node.x - from.x, node.z - from.z)
      if (step >= left) {
        const t = step > 1e-9 ? left / step : 0
        point = new Vec3(from.x + (node.x - from.x) * t, from.y + (node.y - from.y) * t, from.z + (node.z - from.z) * t)
        left = 0
        break
      }
      left -= step
      from = node
      point = node
    }
    const eyeY = p.y + (bot.entity.eyeHeight ?? 1.62)
    const dx = point.x - p.x
    const dz = point.z - p.z
    return Math.atan2(point.y + HUMAN_LOOK_HEIGHT - eyeY, Math.max(Math.hypot(dx, dz), 1))
  }

  function humanKeys (desiredYaw) {
    const delta = wrap(desiredYaw - bot.entity.yaw)
    const forward = Math.abs(delta) <= HUMAN_WALK_ANGLE
    return { delta, forward, back: false, left: false, right: false, sprintable: Math.abs(delta) <= HUMAN_SPRINT_ANGLE }
  }

  function applyKeys (keys, jump, sprint, branch) {
    sprint = sprint && keys.forward && keys.sprintable !== false && performance.now() >= carefulUntil
    let forward = keys.forward
    // Vanilla keeps sprinting after Ctrl is released while W is held (LocalPlayer.aiStep).
    // To walk, a player lets go of W for a tick; do the same instead of a Ctrl-only stop.
    if (forward && !sprint && bot.entity.botifySprinting) {
      forward = false
      jump = false
      branch += '+stop_sprint'
    }
    bot.setControlState('forward', forward)
    bot.setControlState('back', keys.back)
    bot.setControlState('left', keys.left)
    bot.setControlState('right', keys.right)
    bot.setControlState('jump', jump)
    bot.setControlState('sprint', sprint)
    if (bot.pathfinder.debugState) bot.pathfinder.debugState.branch = branch
  }

  function monitorMovement () {
    // Test freemotion
    if (stateMovements && stateMovements.allowFreeMotion && stateGoal && stateGoal.entity) {
      const target = stateGoal.entity
      if (physics.canStraightLine([target.position])) {
        bot.lookAt(target.position.offset(0, 1.6, 0))

        if (target.position.distanceSquared(bot.entity.position) > stateGoal.rangeSq) {
          bot.setControlState('forward', true)
        } else {
          bot.clearControlStates()
        }
        return
      }
    }
    if (stateGoal) {
      if (!stateGoal.isValid()) {
        stop()
      } else if (stateGoal.hasChanged()) {
        // A moved target is a new problem: earlier failures do not count against it.
        gaveUp = false
        freshPlans = 0
        lastFreshPos = null
        softReplan('goal_moved')
      }
    }

    if (stateGoal && search) pumpSearch()

    // After a correction: keys stay released until a few ticks have passed and the bot is
    // standing (or swimming), so the next attempt starts from the server's state.
    if (recoverTicks > 0) {
      const settled = bot.entity.onGround || bot.entity.isInWater || ++recoverAir > 40
      if (settled) recoverTicks--
      fullStop()
      lastNodeTime = performance.now()
      bot.pathfinder.debugState = { branch: 'recover' }
      return
    }

    if (bot.pathfinder.LOSWhenPlacingBlocks && returningPos) {
      if (!moveToBlock(returningPos)) return
      returningPos = null
    }

    if (path.length === 0) {
      lastNodeTime = performance.now()
      if (stateGoal && stateMovements) {
        const floored = bot.entity.position.floored()
        if (stateGoal.isEnd(floored)) {
          if (!dynamicGoal) {
            bot.emit('goal_reached', stateGoal)
            stateGoal = null
            fullStop()
          }
        } else if (!search && !gaveUp && (bot.entity.onGround || bot.entity.isInWater)) {
          noteProgress()
          // A failed plan is only retried from a different place (new chunks/terrain in view).
          const moved = !lastFreshPos || lastFreshPos.distanceTo(bot.entity.position) > 1.5
          if (freshPlans < MAX_FRESH_PLANS && (failure === null || moved)) {
            // First plan, end of a route that could not be continued, or a landing off-route.
            beginFreshSearch()
            pumpSearch()
          } else {
            const status = failure || 'noPath'
            gaveUp = true
            failure = null
            fullStop()
            // Same contract as upstream: a failure with a found route rejects goto(),
            // an empty result means "nothing better than where we stand".
            bot.emit('path_update', { status, cost: 0, time: 0, visitedNodes: 0, generatedNodes: 0, path: walkedAny ? [bot.entity.position.floored()] : [] })
          }
        }
      }
    }

    if (path.length === 0) {
      return
    }

    let nextPoint = path[0]
    const p = bot.entity.position

    // Handle digging
    if (digging || nextPoint.toBreak.length > 0) {
      if (!digging && bot.entity.onGround) {
        digging = true
        const b = nextPoint.toBreak.shift()
        const block = bot.blockAt(new Vec3(b.x, b.y, b.z), false)
        const tool = bot.pathfinder.bestHarvestTool(block)
        fullStop()

        const digBlock = () => {
          bot.dig(block, true)
            .catch(_ignoreError => {
              resetPath('dig_error')
            })
            .then(function () {
              lastNodeTime = performance.now()
              digging = false
            })
        }

        if (!tool) {
          digBlock()
        } else {
          bot.equip(tool, 'hand')
            .catch(_ignoreError => {})
            .then(() => digBlock())
        }
      }
      return
    }
    // Handle block placement
    // TODO: sneak when placing or make sure the block is not interactive
    if (placing || nextPoint.toPlace.length > 0) {
      if (!placing) {
        placing = true
        placingBlock = nextPoint.toPlace.shift()
        fullStop()
      }

      // Open gates or doors
      if (placingBlock?.useOne) {
        if (!lockUseBlock.tryAcquire()) return
        bot.activateBlock(bot.blockAt(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z))).then(() => {
          lockUseBlock.release()
          placingBlock = nextPoint.toPlace.shift()
        }, err => {
          console.error(err)
          lockUseBlock.release()
        })
        return
      }
      const block = stateMovements.getScaffoldingItem()
      if (!block) {
        resetPath('no_scaffolding_blocks')
        return
      }
      if (bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.y === bot.entity.position.floored().y - 1 && placingBlock.dy === 0) {
        if (!moveToEdge(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z), new Vec3(placingBlock.dx, 0, placingBlock.dz))) return
      }
      let canPlace = true
      if (placingBlock.jump) {
        bot.setControlState('jump', true)
        canPlace = placingBlock.y + 1 < bot.entity.position.y
      }
      if (canPlace) {
        if (!lockEquipItem.tryAcquire()) return
        bot.equip(block, 'hand')
          .then(function () {
            lockEquipItem.release()
            const refBlock = bot.blockAt(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z), false)
            if (!lockPlaceBlock.tryAcquire()) return
            if (interactableBlocks.includes(refBlock.name)) {
              bot.setControlState('sneak', true)
            }
            bot.placeBlock(refBlock, new Vec3(placingBlock.dx, placingBlock.dy, placingBlock.dz))
              .then(function () {
                // Dont release Sneak if the block placement was not successful
                bot.setControlState('sneak', false)
                if (bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.returnPos) returningPos = placingBlock.returnPos.clone()
              })
              .catch(_ignoreError => {
                resetPath('place_error')
              })
              .then(() => {
                lockPlaceBlock.release()
                placing = false
                lastNodeTime = performance.now()
              })
          })
          .catch(_ignoreError => {})
      }
      return
    }

    if (reachedNode(p, nextPoint, path.length === 1, bot.entity.onGround)) {
      // arrived at next point
      lastNodeTime = performance.now()
      noteProgress()
      if (stopPathing) {
        stop()
        return
      }
      consume(1)
      if (path.length === 0) { // done or waiting for the next segment
        // If the block the bot is standing on is not a full block only checking for the floored position can fail as
        // the distance to the goal can get greater then 0 when the vector is floored.
        if (!dynamicGoal && stateGoal && (stateGoal.isEnd(p.floored()) || stateGoal.isEnd(p.floored().offset(0, 1, 0)))) {
          bot.emit('goal_reached', stateGoal)
          stateGoal = null
        }
        fullStop()
        return
      }
      // not done yet
      nextPoint = path[0]
      if (nextPoint.toBreak.length > 0 || nextPoint.toPlace.length > 0) {
        fullStop()
        return
      }
    }

    // The route walker steered this tick (keys and head already set before physics).
    const driven = bot.pathfinder.driven
    if (driven) {
      if (driven.progress) lastNodeTime = performance.now()
      bot.pathfinder.debugState = { branch: 'walker', nodes: path.length }
      if (performance.now() - lastNodeTime > 3500) resetPath('stuck')
      return
    }

    lookAhead()
    nextPoint = path[0]

    // Botify: spin follows the same planned nodes with keys resolved before physics.
    if (bot._botifySpinNavigation) {
      bot._botifySpinNavigation.route(nextPoint, path, physics)
      if (performance.now() - lastNodeTime > 3500) resetPath('stuck')
      return
    }
    const aim = cornerWaypoint(nextPoint) || nextPoint
    const desiredYaw = Math.atan2(-(aim.x - p.x), -(aim.z - p.z))
    const human = isHumanMode() && !!bot.smoothLook?.navigate
    // Botify: navigation has a relaxed heading target; block interactions keep precise aim.
    if (human) bot.smoothLook.navigate(desiredYaw, lookPitch(aim))
    else if (bot.smoothLook?.navigate) bot.smoothLook.navigate(desiredYaw)
    else bot.look(desiredYaw, 0)

    const keys = human ? humanKeys(desiredYaw)
      : bot.smoothLook ? steer(desiredYaw) : { delta: 0, forward: true, back: false, left: false, right: false }
    // Parkour jumps need the head on the line before taking off.
    if (nextPoint.parkour && Math.abs(keys.delta) > 10 * Math.PI / 180) {
      bot.clearControlStates()
      return
    }

    bot.pathfinder.debugState = {
      next: { x: nextPoint.x, y: nextPoint.y, z: nextPoint.z, parkour: !!nextPoint.parkour },
      aim: aim === nextPoint ? null : { x: aim.x, y: aim.y, z: aim.z },
      nodes: path.length,
      branch: null
    }
    // Sprinting off high ledges overshoots the landing node; up to 2 blocks it is harmless.
    const bigDrop = nextPoint.y < p.y - 2.5
    if (bot.entity.isInWater) {
      // Botify: no blind swim-up (waterfall walls); src/water-nav.js decides.
      applyKeys(keys, bot._botifySwimJump ? bot._botifySwimJump(nextPoint) : true, false, 'water')
    } else if (aim !== nextPoint) {
      // Rounding a wall corner on flat ground: both legs were checked as clear corridors.
      applyKeys(keys, false, stateMovements.allowSprinting, 'corner')
    } else if (stateMovements.allowSprinting && !bigDrop && physics.canStraightLine(path, true)) {
      applyKeys(keys, false, true, 'sprint')
    } else if (stateMovements.allowSprinting && !bigDrop && physics.canSprintJump(path)) {
      applyKeys(keys, keys.forward, true, 'sprint_jump')
    } else if (physics.canStraightLine(path)) {
      applyKeys(keys, false, false, 'walk')
    } else if (physics.canWalkJump(path)) {
      applyKeys(keys, keys.forward, false, 'walk_jump')
    } else if (!nextPoint.parkour && nextPoint.y <= p.y + 0.5) {
      // Flat or downward node the short simulation did not confirm (e.g. still turning): keep walking.
      applyKeys(keys, false, false, 'walk_unconfirmed')
    } else {
      applyKeys({ forward: false, back: false, left: false, right: false }, false, false, 'wait')
    }

    // check for futility
    if (performance.now() - lastNodeTime > 3500) {
      // should never take this long to go to the next node
      resetPath('stuck')
    }
  }
}

module.exports = {
  pathfinder: inject,
  Movements: require('./lib/movements'),
  goals: require('./lib/goals')
}
