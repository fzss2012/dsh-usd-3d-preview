/** Copy owned by the USD preview; keys are shared by both dictionaries. */

/** Chinese dictionary. */
export const zh = {
  title: 'USD 三维预览',
  loading: '正在解析 USD 文件…',
  failed: '无法解析这个 USD 文件',
  noGeometry: '这个 USD 文件里没有可显示的几何体',
  crateOnly: 'crate 图层自身不含几何体（常见于只做组合的单元文件）：它引用的几何在别的图层里。WASM 引擎会沿着 references 把被引用图层读回来；若仍为空，检查引用路径是否在工作区内。',
  degenerate: '几何体尺度异常（退化包围盒），可能是空舞台或只有元数据',
  engineFallback: 'WASM 引擎不可用，已回退到 three 解析：',
  reset: '重置视角',
  grid: '网格',
  spin: '自动旋转',
  wireframe: '线框',
  layers: '图层',
  engine: '引擎',
  warnings: '提示',
  meshes: '网格',
  triangles: '三角面',
  instances: '实例',
  size: '尺寸',
  format: '容器',
  help: '左键旋转 · 滚轮缩放 · 右键平移',
}

/** English dictionary with the same keys. */
export const en = {
  title: 'USD 3D preview',
  loading: 'Parsing the USD file…',
  failed: 'This USD file could not be parsed.',
  noGeometry: 'This USD file has no drawable geometry.',
  crateOnly: 'This crate layer carries no geometry of its own (a composition-only unit file): the geometry lives in the layers it references. The WASM engine follows those references and reads them back; if the stage is still empty, check that the referenced paths are inside the workspace.',
  degenerate: 'The geometry has a degenerate extent — an empty stage, or metadata only.',
  engineFallback: 'The WASM engine was unavailable; fell back to the three.js parser:',
  reset: 'Reset view',
  grid: 'Grid',
  spin: 'Auto-rotate',
  wireframe: 'Wireframe',
  layers: 'Layers',
  engine: 'Engine',
  warnings: 'Warnings',
  meshes: 'Meshes',
  triangles: 'Triangles',
  instances: 'Instances',
  size: 'Size',
  format: 'Container',
  help: 'Drag to orbit · wheel to zoom · right-drag to pan',
}
