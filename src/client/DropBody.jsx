/**
 * The external-asset page tab: a drop target in the right Sidebar, and the
 * viewport for whatever was dropped.
 *
 * The workspace path opens a stage by address (the Files tab claims the tab);
 * this path opens one by bytes, because a file dragged in from the desktop has
 * no address the workspace Remote could read. Nothing is uploaded and nothing is
 * written: the dropped files live in this component's state for as long as the
 * tab does, and the WASM engine composes the stage from them in a worker.
 *
 * The component owns three states: an empty drop zone, a picker when one drop
 * carries several stages, and the viewport. A drop can arrive at any of them —
 * the document-level listener in `sidebar-drop.js` offers it to the page tab
 * whether it is already open or is being opened right now.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { UsdPreviewGlyph } from './artwork.jsx'
import { collectDropped, defaultStage, subscribeDropped, takePendingDropped } from './dropped.js'
import { UsdBody } from './UsdBody.jsx'

const LABEL = 'var(--dsw-alias-label-primary, #e6e8ec)'
const LABEL_DIM = 'var(--dsw-alias-label-secondary, #a9b0bd)'
const ACCENT = 'var(--dsw-alias-brand-primary, #4d8dff)'
const BORDER = 'var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.14))'
const SURFACE = 'var(--dsw-alias-bg-overlay, rgba(24, 26, 32, 0.86))'
const ERROR = 'var(--dsw-alias-state-error-primary, #ff6b6b)'
const FONT = 'var(--dsw-font-ui, system-ui, sans-serif)'

const SHELL = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-base, #14161a)',
  color: LABEL,
  fontFamily: FONT,
  fontSize: 12,
}

const HEADER = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderBottom: `1px solid ${BORDER}`,
  background: SURFACE,
}

const NAME = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: LABEL,
}

const VIEWPORT = { position: 'relative', flex: '1 1 auto', minHeight: 0 }

const ZONE_WRAP = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
}

const ZONE = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 10,
  maxWidth: 420,
  padding: '26px 20px',
  borderRadius: 12,
  borderWidth: 1.5,
  borderStyle: 'dashed',
  borderColor: 'var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.24))',
  background: 'var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.03))',
  textAlign: 'center',
}

const ZONE_TITLE = { fontSize: 14, fontWeight: 600, color: LABEL }
const ZONE_TEXT = { lineHeight: 1.7, color: LABEL_DIM }
const ZONE_ACTIONS = { display: 'flex', gap: 8, marginTop: 2 }
const PICKER = { display: 'flex', flexDirection: 'column', gap: 6, width: '100%', marginTop: 4, maxHeight: 240, overflow: 'auto' }

/**
 * The button look the viewport toolbar uses, so the drop zone reads as the same
 * surface rather than as a second design.
 * @param primary - whether this is the suggested action.
 * @returns the inline style.
 */
function buttonStyle(primary) {
  return {
    padding: '4px 10px',
    borderRadius: 6,
    border: `1px solid ${primary === true ? ACCENT : BORDER}`,
    background: primary === true ? ACCENT : SURFACE,
    color: primary === true ? '#fff' : LABEL,
    font: 'inherit',
    fontSize: 11,
    cursor: 'pointer',
  }
}

/** A stage key shortened to the name the user recognises. */
function stageName(key) {
  return key.slice(key.lastIndexOf('/') + 1)
}

/**
 * The external-asset page body.
 * @param props - framework props for the tab body (only copy is used here).
 * @returns the drop zone, a stage picker, or the viewport.
 */
export function UsdDropBody(props) {
  const t = props.t
  const [drop, setDrop] = useState(() => takePendingDropped())
  const [chosen, setChosen] = useState(undefined)
  const fileInput = useRef(null)
  const directoryInput = useRef(null)

  const label = useCallback((key, fallback) => {
    if (typeof t !== 'function') return fallback
    try {
      const value = t(key)
      return value === undefined || value === null || value === key ? fallback : value
    } catch {
      return fallback
    }
  }, [t])

  // A drop offered later — while this tab is already the open one — arrives here.
  useEffect(() => subscribeDropped(() => {
    setDrop(takePendingDropped())
    setChosen(undefined)
  }), [])

  // A directory picker is an attribute, not a JSX prop React knows.
  useEffect(() => {
    directoryInput.current?.setAttribute('webkitdirectory', '')
    directoryInput.current?.setAttribute('directory', '')
  }, [])

  const adopt = useCallback((collected) => {
    setDrop(collected)
    setChosen(undefined)
  }, [])

  const onPicked = useCallback(async (event) => {
    // Snapshot before clearing: emptying the input empties the live FileList too,
    // and the files are read asynchronously after this handler returns.
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (files.length === 0) return
    try {
      adopt(await collectDropped({ files }))
    } catch {
      // A picker the browser refuses leaves the zone as it was.
    }
  }, [adopt])

  const reset = useCallback(() => {
    setDrop(undefined)
    setChosen(undefined)
  }, [])

  const stages = drop?.stages ?? []
  // One shallowest layer is the stage; two at the same depth are a choice.
  const activeRoot = chosen ?? defaultStage(stages)
  const header = activeRoot === undefined ? null : (
    <div style={HEADER}>
      <span style={NAME} title={activeRoot}>{stageName(activeRoot)}</span>
      <button type="button" style={buttonStyle(false)} onClick={reset}>{label('openAnother', 'Open another asset')}</button>
    </div>
  )

  // One drop carried several stages: let the user choose which one to open.
  if (drop !== undefined && activeRoot === undefined && stages.length > 1) {
    return (
      <div style={SHELL}>
        <div style={ZONE_WRAP}>
          <div style={{ ...ZONE, alignItems: 'stretch', textAlign: 'left' }}>
            <span style={ZONE_TITLE}>{label('chooseStage', 'Choose the stage to open')}</span>
            <div style={PICKER}>
              {stages.map(key => (
                <button key={key} type="button" style={{ ...buttonStyle(false), textAlign: 'left' }} onClick={() => setChosen(key)}>
                  {key}
                </button>
              ))}
            </div>
            <button type="button" style={{ ...buttonStyle(false), alignSelf: 'center' }} onClick={reset}>
              {label('openAnother', 'Open another asset')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // A drop that carried no stage at all (a folder of images, a mixed selection).
  const empty = drop === undefined || activeRoot === undefined

  return (
    <div style={SHELL}>
      {header}
      <div style={VIEWPORT}>
        {empty ? (
          <div style={ZONE_WRAP}>
            <div style={ZONE}>
              <span style={{ color: ACCENT, lineHeight: 0 }}><UsdPreviewGlyph size={34} /></span>
              <span style={ZONE_TITLE}>{label('dropTitle', 'Drop a USD asset here')}</span>
              <span style={ZONE_TEXT}>
                {drop !== undefined && stages.length === 0
                  ? label('noStage', 'That drop held no USD file (.usd, .usda, .usdc, .usdz).')
                  : label('dropHint', 'Drag .usd, .usda, .usdc or .usdz from your desktop onto this panel, or pick a file or a folder — a folder brings the layers and textures it references.')}
              </span>
              <div style={ZONE_ACTIONS}>
                <button type="button" style={buttonStyle(true)} onClick={() => fileInput.current?.click()}>
                  {label('pickFile', 'Choose file')}
                </button>
                <button type="button" style={buttonStyle(false)} onClick={() => directoryInput.current?.click()}>
                  {label('pickFolder', 'Choose folder')}
                </button>
              </div>
              <span style={{ color: LABEL_DIM }}>{label('dropLocal', 'Read in this browser only — nothing is uploaded.')}</span>
            </div>
          </div>
        ) : (
          <UsdBody t={t} droppedFiles={drop.files} droppedRootKey={activeRoot} />
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".usd,.usda,.usdc,.usdz"
        onChange={onPicked}
        style={{ display: 'none' }}
      />
      <input ref={directoryInput} type="file" multiple onChange={onPicked} style={{ display: 'none' }} />
    </div>
  )
}
