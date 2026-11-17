/**
 * The prim-path tree behind the panel in UsdBody.
 *
 * A USD path is a hierarchy: /World/Geometry/Body names a prim under
 * /Geometry under /World. The panel used to render a flat, sorted list that
 * repeated the same prefix on every row and hid the structure the stage has.
 * This module turns paths into a tree with natural ordering,
 * ancestor-preserving filtering, and a bounded flatten for rendering.
 *
 * It is deliberately free of React and three: the tests exercise the whole
 * structure in Node, and the component only decides how a row looks.
 *
 * @module dsh-usd-3d-preview/prim-tree
 */

/**
 * @typedef {object} PrimNode
 * @property {string} name - the segment name, e.g. Geometry.
 * @property {string} path - the full USD path, e.g. /World/Geometry.
 * @property {boolean} prim - whether this node is itself a path to copy.
 * @property {Map<string, PrimNode>} children - named child nodes.
 */

/**
 * Compare two prim names the way a reader expects: link_2 before link_10.
 * Plain localeCompare would sort those the other way round.
 * @param {string} a - first name.
 * @param {string} b - second name.
 * @returns {number} negative, zero or positive.
 */
export function comparePrimNames(a, b) {
  const partsA = String(a).split(/(\d+)/)
  const partsB = String(b).split(/(\d+)/)
  const shared = Math.min(partsA.length, partsB.length)
  for (let i = 0; i < shared; i += 1) {
    const left = partsA[i]
    const right = partsB[i]
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
      const difference = Number(left) - Number(right)
      if (difference !== 0) return difference
    } else {
      const order = left.localeCompare(right)
      if (order !== 0) return order
    }
  }
  return partsA.length - partsB.length
}

/**
 * Build a tree from a set of absolute prim paths.
 *
 * Every node on the way to a collected prim is marked as a prim too: in USD an
 * ancestor of a prim is itself a prim, and the collector only records paths that
 * carry drawable data. Marking ancestors keeps every rendered row copyable.
 * @param {Iterable<string>} paths - absolute USD paths.
 * @returns {PrimNode} the root; its path is the empty string.
 */
export function buildPrimTree(paths) {
  const root = { name: '', path: '', prim: false, children: new Map() }
  for (const path of paths) {
    if (typeof path !== 'string' || path.startsWith('/') !== true) continue
    const segments = path.split('/').filter(segment => segment !== '')
    let node = root
    let cursor = ''
    for (const name of segments) {
      cursor += '/' + name
      let child = node.children.get(name)
      if (child === undefined) {
        child = { name, path: cursor, prim: false, children: new Map() }
        node.children.set(name, child)
      }
      node = child
    }
    node.prim = true
  }

  /** Sort one subtree and promote its folders to copyable prim paths. */
  function normalize(node) {
    node.children = new Map(
      [...node.children.entries()].sort((left, right) => comparePrimNames(left[0], right[0])),
    )
    for (const child of node.children.values()) {
      normalize(child)
      child.prim = true
    }
  }
  normalize(root)
  return root
}

/**
 * Filter a tree by path substring.
 *
 * A match keeps its whole subtree and every ancestor, so the path stays
 * readable; non-matching siblings are dropped.
 * @param {PrimNode} root - the unfiltered tree.
 * @param {string} needle - raw filter text.
 * @returns {{ tree: PrimNode, active: boolean }} the tree to render and whether
 *   a filter is in effect. When inactive the original tree is returned.
 */
export function filterPrimTree(root, needle) {
  const query = String(needle ?? '').trim().toLowerCase()
  if (query === '') return { tree: root, active: false }

  /** @returns {PrimNode | undefined} the kept subtree, or nothing. */
  function visit(node) {
    const matched = node.path.toLowerCase().includes(query)
    const children = []
    for (const child of node.children.values()) {
      const kept = matched === true ? { ...child } : visit(child)
      if (kept !== undefined) children.push(kept)
    }
    if (matched !== true && children.length === 0) return undefined
    return { ...node, children: new Map(children.map(child => [child.name, child])) }
  }

  const tree = visit(root)
  return {
    tree: tree === undefined ? { ...root, children: new Map() } : tree,
    active: true,
  }
}

/**
 * Count the prim paths a tree carries, including promoted folder nodes.
 * @param {PrimNode} root - the tree to count.
 * @returns {number} prim paths in the tree.
 */
export function countPrimNodes(root) {
  let count = 0
  /** @param {PrimNode} node - current node. */
  function visit(node) {
    for (const child of node.children.values()) {
      if (child.prim === true) count += 1
      visit(child)
    }
  }
  visit(root)
  return count
}

/**
 * Every folder path in a tree, for the initial all-expanded view.
 * @param {PrimNode} root - the tree to walk.
 * @returns {Set<string>} paths whose children should be visible.
 */
export function allFolderPaths(root) {
  const paths = new Set()
  /** @param {PrimNode} node - current node. */
  function visit(node) {
    for (const child of node.children.values()) {
      if (child.children.size > 0) paths.add(child.path)
      visit(child)
    }
  }
  visit(root)
  return paths
}

/**
 * The folders leading to a prim, so a picked path can be revealed.
 * @param {string | null} path - an absolute USD path.
 * @returns {string[]} ancestor paths, outermost first.
 */
export function ancestorsOf(path) {
  if (typeof path !== 'string' || path.startsWith('/') !== true) return []
  const segments = path.split('/').filter(segment => segment !== '')
  const ancestors = []
  let cursor = ''
  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor += '/' + segments[i]
    ancestors.push(cursor)
  }
  return ancestors
}

/**
 * Flatten the expanded part of a tree into renderable rows.
 *
 * The cap bounds both DOM size and work: a big instancer can name tens of
 * thousands of paths. total counts every node in the tree; truncated says
 * whether the visible rows were clipped by the cap.
 * @param {PrimNode} root - the tree to walk.
 * @param {Set<string>} expanded - folder paths whose children are visible.
 * @param {object} [options] - rendering bounds.
 * @param {number} [options.limit] - maximum rows to return.
 * @param {boolean} [options.forcedOpen] - ignore expanded (filter mode).
 * @returns {{ rows: Array<{node: PrimNode, depth: number}>, total: number, truncated: boolean }}
 */
export function flattenPrimTree(root, expanded, { limit = Infinity, forcedOpen = false } = {}) {
  const rows = []
  let visible = 0

  /** @param {PrimNode} node - current node. @param {number} depth - indent level. */
  function walk(node, depth) {
    for (const child of node.children.values()) {
      visible += 1
      if (rows.length >= limit) return
      rows.push({ node: child, depth })
      if (child.children.size > 0 && (forcedOpen === true || expanded.has(child.path) === true)) {
        walk(child, depth + 1)
      }
    }
  }
  walk(root, 0)
  return { rows, total: countPrimNodes(root), truncated: visible > rows.length }
}
