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
 * An IFC model takes the same door with a different reader: a model is one file,
 * so the page reads its bytes here and mounts `IfcBody` — the same viewport the
 * Files tab opens by address. A modeling-session archive is a folder: its
 * `session.json` is the candidate to open, and `SessionBody` reads the newest
 * snapshot and commit record from the same drop's file table.
 *
 * The component owns three states: an empty drop zone, a picker when one drop
 * carries several models, and the viewport. A drop can arrive at any of them —
 * the document-level listener in `sidebar-drop.js` offers it to the page tab
 * whether it is already open or is being opened right now.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { UsdPreviewGlyph } from './artwork.jsx'
import { collectDropped, defaultModel, subscribeDropped, takePendingDropped } from './dropped.js'
import { IfcBody } from './IfcBody.jsx'
import { openStage } from './s3open.js'
import { SessionBody } from './SessionBody.jsx'
import { UsdBody } from './UsdBody.jsx'
import {
  ACCENT, BASE, BORDER, BORDER_STRONG, ERROR, FONT, LABEL, LABEL_DIM, LAYER, PRIMARY_FILL, PRIMARY_INK, SURFACE,
} from './tokens.js'

const SHELL = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: BASE,
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
  borderColor: BORDER_STRONG,
  background: LAYER,
  textAlign: 'center',
}

const ZONE_TITLE = { fontSize: 14, fontWeight: 600, color: LABEL }
const ZONE_TEXT = { lineHeight: 1.7, color: LABEL_DIM }
const ZONE_ACTIONS = { display: 'flex', gap: 8, marginTop: 2 }
const S3_ROW = {
  display: 'flex',
  gap: 6,
  width: '100%',
  marginTop: 4,
}

const S3_INPUT = {
  flex: '1 1 auto',
  minWidth: 0,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid ' + BORDER,
  background: BASE,
  color: LABEL,
  font: 'inherit',
  fontSize: 11,
}

const PICKER = { display: 'flex', flexDirection: 'column', gap: 6, width: '100%', marginTop: 4, maxHeight: 240, overflow: 'auto' }

const STATUS = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: 20,
  textAlign: 'center',
}

/**
 * Dictionary lookup with a literal fallback: copy must never be the reason a
 * viewport fails to render.
 * @param t - locale binding (absent outside the shell).
 * @param key - dictionary key.
 * @param fallback - the copy used when the dictionary has no entry.
 * @returns the localized string.
 */
function labeled(t, key, fallback) {
  if (typeof t !== 'function') return fallback
  try {
    const value = t(key)
    return value === undefined || value === null || value === key ? fallback : value
  } catch {
    return fallback
  }
}

/**
 * The button look the viewport toolbar uses, so the drop zone reads as the same
 * surface rather than as a second design.
 * @param primary - whether this is the suggested action.
 * @returns the inline style.
 */
function buttonStyle(primary) {
  const filled = primary === true
  return {
    padding: '4px 10px',
    borderRadius: 6,
    border: `1px solid ${filled ? PRIMARY_FILL : BORDER}`,
    background: filled ? PRIMARY_FILL : SURFACE,
    color: filled ? PRIMARY_INK : LABEL,
    font: 'inherit',
    fontSize: 11,
    cursor: 'pointer',
  }
}

/** A model key shortened to the name the user recognises. */
function modelName(key) {
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
  const [uri, setUri] = useState('')
  const [uriBusy, setUriBusy] = useState(false)
  const [uriError, setUriError] = useState(null)
  const fileInput = useRef(null)
  const directoryInput = useRef(null)

  const label = useCallback((key, fallback) => labeled(t, key, fallback), [t])

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

  // Opening by address: the page reads the root layer and hands the engine the
  // readers for every reference the stage names, so relative layers, sublayers
  // and s3:// payloads resolve exactly as they do for a dropped folder.
  const openUri = useCallback(async () => {
    const value = uri.trim()
    if (value.length === 0 || uriBusy) return
    setUriBusy(true)
    setUriError(null)
    try {
      const result = await openStage(value)
      setDrop({ remoteStage: result, models: [{ key: result.label, kind: 'usd' }] })
      setChosen(undefined)
    } catch (error) {
      setUriError(typeof error?.message === 'string' ? error.message : String(error))
    } finally {
      setUriBusy(false)
    }
  }, [uri, uriBusy])

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

  const models = drop?.models ?? []
  // One shallowest model is the one to open; two at the same depth are a choice.
  const activeKey = chosen ?? defaultModel(models)
  const active = activeKey === undefined ? undefined : models.find(model => model.key === activeKey)
  const remote = drop?.remoteStage !== undefined
  // An address-opened stage carries no file map, so only a real model has a kind.
  const ready = remote || active !== undefined
  const header = ready === false ? null : (
    <div style={HEADER}>
      <span style={NAME} title={activeKey}>{modelName(activeKey ?? '')}</span>
      <button type="button" style={buttonStyle(false)} onClick={reset}>{label('openAnother', 'Open another asset')}</button>
    </div>
  )

  // One drop carried several models: let the user choose which one to open.
  if (drop !== undefined && ready === false && models.length > 1) {
    return (
      <div style={SHELL}>
        <div style={ZONE_WRAP}>
          <div style={{ ...ZONE, alignItems: 'stretch', textAlign: 'left' }}>
            <span style={ZONE_TITLE}>{label('chooseModel', 'Choose the model to open')}</span>
            <div style={PICKER} data-drop-picker>
              {models.map(model => (
                <button
                  key={model.key}
                  type="button"
                  style={{ ...buttonStyle(false), textAlign: 'left' }}
                  data-drop-model={model.key}
                  data-drop-kind={model.kind}
                  onClick={() => setChosen(model.key)}
                >
                  {model.key}
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

  // A drop that carried no model at all (a folder of images, a mixed selection).
  const uriErrorText = uriError === null
    ? null
    : (uriError === 's3-bad-uri' ? label('s3BadUri', 'Bad s3:// URI')
      : uriError === 's3-not-found' ? label('s3NotFound', 'Object not found')
      : uriError === 's3-gateway-down' ? label('s3NotConfigured', 'The host has no asset library configured and the local gateway is down')
      : uriError === 's3-read-failed' ? label('s3ReadFailed', 'Read failed: object storage error')
      : uriError === 'http-not-found' ? label('httpNotFound', 'HTTP 404: object not found')
      : uriError === 'http-fetch-failed' ? label('httpFetchFailed', 'HTTP read failed')
      : uriError === 'stage-bad-uri' ? label('stageBadUri', 'Unrecognized address')
      : label('openUriFailed', 'Could not open the address') + ': ' + uriError)

  const empty = ready === false

  return (
    <div style={SHELL}>
      {header}
      <div style={VIEWPORT}>
        {empty ? (
          <div style={ZONE_WRAP}>
            <div style={ZONE} data-drop-zone>
              <span style={{ color: ACCENT, lineHeight: 0 }}><UsdPreviewGlyph size={34} /></span>
              <span style={ZONE_TITLE}>{label('dropTitle', 'Drop a USD asset or IFC model here')}</span>
              <span style={ZONE_TEXT}>
                {drop !== undefined && models.length === 0
                  ? label('noModel', 'That drop held no USD asset or IFC model.')
                  : label('dropHint', 'Drag .usd, .usda, .usdc, .usdz, .ifc or .ifczip from your desktop onto this panel, or pick a file or a folder — a folder brings the layers and textures a stage references.')}
              </span>
              <div style={ZONE_ACTIONS}>
                <button type="button" style={buttonStyle(true)} onClick={() => fileInput.current?.click()}>
                  {label('pickFile', 'Choose file')}
                </button>
                <button type="button" style={buttonStyle(false)} onClick={() => directoryInput.current?.click()}>
                  {label('pickFolder', 'Choose folder')}
                </button>
              </div>
              <span style={{ ...ZONE_TEXT, fontSize: 11 }}>{label('s3Hint', 'Direct s3:// URI')}</span>
              <div style={S3_ROW}>
                <input
                  type="text"
                  value={uri}
                  spellCheck={false}
                  onChange={event => setUri(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') void openUri() }}
                  placeholder="s3://bucket/path/stage.usda or https://host/path/stage.usda"
                  style={S3_INPUT}
                  aria-label={label('openUri', 'Open URI')}
                />
                <button type="button" style={buttonStyle(true)} disabled={uriBusy} onClick={() => void openUri()}>
                  {uriBusy ? label('openUriBusy', 'Reading…') : label('openUri', 'Open URI')}
                </button>
              </div>
              {uriErrorText === null ? null : <span style={{ color: ERROR, lineHeight: 1.5, maxWidth: 420 }}>{uriErrorText}</span>}
              <span style={{ color: LABEL_DIM }}>{label('dropLocal', 'Read in this browser only — nothing is uploaded.')}</span>
            </div>
          </div>
        ) : remote ? (
          <UsdBody t={t} remoteStage={drop.remoteStage} />
        ) : active.kind === 'session' ? (
          <SessionBody t={t} droppedFiles={drop.files} droppedRootKey={active.key} />
        ) : active.kind === 'ifc' ? (
          <DroppedIfcBody t={t} file={drop.files?.get(active.key)} name={modelName(active.key)} />
        ) : (
          <UsdBody t={t} droppedFiles={drop.files} droppedRootKey={active.key} />
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".usd,.usda,.usdc,.usdz,.ifc,.ifczip,.json"
        onChange={onPicked}
        style={{ display: 'none' }}
      />
      <input ref={directoryInput} type="file" multiple onChange={onPicked} style={{ display: 'none' }} />
    </div>
  )
}

/**
 * The viewport for one IFC model a drop carried.
 *
 * A dropped model has no address, so the page reads the file's bytes itself and
 * hands them to the same `IfcBody` the document seat mounts when the model is
 * opened from the Files tab. The content object is memoised on purpose: the body
 * reparses whenever that object's identity changes, and one per render would read
 * the model again on every paint.
 * @param props.file - the dropped model file.
 * @param props.name - the name to show for it.
 * @param props.t - locale binding.
 * @returns the IFC viewport, or the byte read's loading/failure state.
 */
function DroppedIfcBody({ file, name, t }) {
  const [state, setState] = useState({ kind: 'loading' })

  useEffect(() => {
    if (file === undefined) {
      setState({ kind: 'failed', error: new Error('the drop did not carry this model') })
      return undefined
    }
    let cancelled = false
    setState({ kind: 'loading' })
    void file.arrayBuffer().then((buffer) => {
      if (cancelled === true) return
      setState({ kind: 'ready', data: new Uint8Array(buffer) })
    }, (error) => {
      if (cancelled === true) return
      setState({ kind: 'failed', error })
    })
    return () => { cancelled = true }
  }, [file])

  const content = useMemo(
    () => (state.kind === 'ready' ? { kind: 'bytes', data: state.data } : undefined),
    [state],
  )

  if (state.kind === 'failed') {
    return (
      <div style={STATUS} role="alert">
        <span style={{ color: ERROR, fontWeight: 600 }}>{labeled(t, 'ifcFailed', 'This IFC file could not be read.')}</span>
        <span style={{ color: LABEL_DIM, wordBreak: 'break-word' }}>{String(state.error?.message ?? state.error)}</span>
      </div>
    )
  }
  if (content === undefined) return <div style={STATUS}>{labeled(t, 'ifcLoading', 'Reading the IFC model…')}</div>
  return <IfcBody t={t} content={content} resourceAddress={name} />
}
