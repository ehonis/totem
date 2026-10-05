// Productivity → Journal: a red button, and the entries under it.
//
// The shape is iOS Voice Memos on purpose — record, list by day, tap to open —
// because that is the thing his thumb already knows at 6:40 in the morning. What
// Voice Memos does not have is the second half: each entry is transcribed on the
// box, and ten minutes after Save the digest folds it into the brain, logs habits,
// and stages everything else in the Inbox. The card carries that countdown and the
// one button that matters during it, "Don't ingest".
//
// The recording itself is never kept. The card says so in the audio chip.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AuthError, createJournalText, deleteJournalAudio, deleteJournalEntry, getJournal, ingestJournalNow,
  journalAudioUrl, keepJournalAudio, retryJournalTranscription, skipJournalIngest, updateJournalEntry,
  updateJournalSettings, uploadJournalAudio,
} from '../api'
import {
  ArrowPathIcon, ArrowTopRightOnSquareIcon, BookmarkIcon, CheckCircleIcon, ChevronRightIcon, ClockIcon,
  Cog6ToothIcon, ExclamationTriangleIcon, Hi, InboxStackIcon, MicrophoneIcon, NoSymbolIcon, PauseIcon,
  PencilIcon, PencilSquareIcon, PlayIcon, SparklesIcon, StopSolidIcon, TrashIcon,
} from '../icons'
import { COMMANDS } from '../shortcuts'
import { useCommand } from '../useShortcuts'
import { pushError, pushSuccess } from '../toast'
import { notifyInboxChanged } from '../useInboxCount'
import {
  audioLabel, audioTitle, cardState, entryTitle, fmtBytes, fmtClock, groupByDay, msUntil, pollIntervalMs, timeOfDay,
} from '../journal/format'
import type { CardState } from '../journal/format'
import { useRecorder } from '../journal/useRecorder'
import Waveform from '../journal/Waveform'
import EntryMenu from '../journal/EntryMenu'
import type { MenuItem } from '../journal/EntryMenu'
import JournalSettingsModal from '../journal/JournalSettings'
import type { JournalEngine, JournalEntry, JournalSettings } from '../journal/types'

interface Props { onAuthError: () => void }

/** A clock that ticks once a second only while something on screen needs it. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

export default function JournalView({ onAuthError }: Props) {
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [engine, setEngine] = useState<JournalEngine | null>(null)
  const [settings, setSettings] = useState<JournalSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [typing, setTyping] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const recorder = useRecorder()

  const fail = useCallback((e: unknown, fallback: string) => {
    if (e instanceof AuthError) return onAuthError()
    pushError(e instanceof Error ? e.message : fallback)
  }, [onAuthError])

  const load = useCallback(async () => {
    try {
      const data = await getJournal()
      setEntries(data.entries)
      setEngine(data.engine)
      setSettings(data.settings)
    } catch (e) {
      fail(e, 'The journal could not load.')
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => { void load() }, [load])

  // Poll while an entry is transcribing, counting down, or being digested; the
  // cadence comes from the same state function the cards render from.
  const now = useNow(entries.some((e) => ['transcribing', 'waiting', 'due', 'digesting'].includes(cardState(e, Date.now()))))
  useEffect(() => {
    const ms = pollIntervalMs(entries, Date.now())
    const t = window.setTimeout(() => { void load() }, ms)
    return () => window.clearTimeout(t)
  }, [entries, load, now])
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  // `g j j` — go to Journal and start recording.
  useCommand(COMMANDS.journalRecord, () => { if (recorder.state === 'idle') void recorder.start() })

  const patchEntry = (next: JournalEntry) => setEntries((list) => list.map((e) => (e.id === next.id ? next : e)))

  const act = useCallback(async (entry: JournalEntry, run: () => Promise<{ entry?: JournalEntry } | unknown>, done?: string) => {
    setBusyId(entry.id)
    try {
      const res = (await run()) as { entry?: JournalEntry } | undefined
      if (res?.entry) patchEntry(res.entry)
      else await load()
      if (done) pushSuccess(done)
    } catch (e) {
      fail(e, 'That did not work.')
    } finally {
      setBusyId(null)
    }
  }, [fail, load])

  const save = useCallback(async () => {
    const r = recorder.result
    if (!r) return
    setSaving(true)
    try {
      const { entry } = await uploadJournalAudio(r.blob, { recordedAt: r.startedAt, durationSec: r.durationSec })
      setEntries((list) => [entry, ...list])
      recorder.reset()
      pushSuccess(`Saved — transcribing. Digest in ${settings?.ingestDelayMinutes ?? 10} min unless you say otherwise.`)
    } catch (e) {
      fail(e, 'The recording could not be saved. It is still here — try again.')
    } finally {
      setSaving(false)
    }
  }, [recorder, settings, fail])

  const saveText = useCallback(async (text: string) => {
    setSaving(true)
    try {
      const { entry } = await createJournalText(text)
      setEntries((list) => [entry, ...list])
      setTyping(false)
      pushSuccess(`Saved. Digest in ${settings?.ingestDelayMinutes ?? 10} min unless you say otherwise.`)
    } catch (e) {
      fail(e, 'The entry could not be saved.')
    } finally {
      setSaving(false)
    }
  }, [settings, fail])

  const groups = useMemo(() => groupByDay(entries), [entries])
  const waiting = entries.filter((e) => cardState(e, now) === 'waiting').length

  return (
    <div className="view journal">
      <div className="view-head">
        <h1>Journal {entries.length ? <span className="muted">· {entries.length}</span> : null}</h1>
        <div className="view-head-actions">
          {engine && <EnginePill engine={engine} />}
          <button className="btn compact" onClick={() => void load()} title="Refresh" aria-label="Refresh"><Hi icon={ArrowPathIcon} size={15} /></button>
          <button
            className={`btn compact${showSettings ? ' on' : ''}`}
            onClick={() => setShowSettings((v) => !v)}
            title="Journal settings" aria-label="Journal settings" aria-expanded={showSettings}
          ><Hi icon={Cog6ToothIcon} size={15} /></button>
        </div>
      </div>

      {showSettings && settings && (
        <JournalSettingsModal
          settings={settings}
          busy={savingSettings}
          onClose={() => setShowSettings(false)}
          onSave={async (patch) => {
            setSavingSettings(true)
            try {
              const { settings: next } = await updateJournalSettings(patch)
              setSettings(next)
              setShowSettings(false)
              pushSuccess('Journal settings saved.')
            } catch (e) { fail(e, 'Settings could not be saved.') }
            finally { setSavingSettings(false) }
          }}
        />
      )}

      <RecorderPanel
        recorder={recorder}
        saving={saving}
        engineReady={engine ? engine.ready : true}
        onSave={save}
        typing={typing}
        onToggleTyping={() => setTyping((v) => !v)}
        onSaveText={saveText}
        delayMinutes={settings?.ingestDelayMinutes ?? 10}
      />

      {waiting > 0 && (
        <p className="journal-lede muted">
          <Hi icon={ClockIcon} size={13} />
          <span>{waiting === 1 ? 'One entry is' : `${waiting} entries are`} waiting to be digested. Tap <b>Don’t ingest</b> on a card to keep it out of the brain.</span>
        </p>
      )}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="empty journal-empty">
          <Hi icon={MicrophoneIcon} size={26} />
          <p>No entries yet. Hit the red button and talk about your day — yesterday counts.</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.date} className="journal-day">
            <h4 className="journal-day-label">{g.label} <span className="muted">· {g.date}</span></h4>
            <div className="journal-list">
              {g.entries.map((e) => (
                <EntryCard
                  key={e.id} entry={e} now={now} busy={busyId !== null}
                  onSkip={() => act(e, () => skipJournalIngest(e.id), 'Kept out of the brain.')}
                  onIngest={() => act(e, () => ingestJournalNow(e.id))}
                  onRetry={() => act(e, () => retryJournalTranscription(e.id))}
                  onRename={(title) => act(e, () => updateJournalEntry(e.id, { title }))}
                  onEditTranscript={(transcript) => act(e, () => updateJournalEntry(e.id, { transcript }))}
                  onKeepAudio={(keep) => act(e, () => keepJournalAudio(e.id, keep), keep ? 'Recording kept indefinitely.' : 'Recording back on the clock.')}
                  onDeleteAudio={() => {
                    if (!window.confirm('Delete the recording? The transcript stays — only the audio goes, and it cannot be recovered.')) return
                    void act(e, () => deleteJournalAudio(e.id), 'Recording deleted. The transcript is untouched.')
                  }}
                  onDelete={() => {
                    if (!window.confirm('Delete this entry? The transcript goes with it; anything already digested into the brain stays.')) return
                    void act(e, async () => { await deleteJournalEntry(e.id); setEntries((l) => l.filter((x) => x.id !== e.id)); return { entry: undefined } })
                  }}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

// ---- header chrome -------------------------------------------------------------

function EnginePill({ engine }: { engine: JournalEngine }) {
  if (engine.ready) {
    return <span className="pill pill-ok" title={`whisper.cpp ${engine.model}, ${engine.threads} threads, on this box`}>whisper {engine.model}</span>
  }
  return (
    <span className="pill pill-error" title={`${engine.missing.join(', ')} — ${engine.fix || ''}`}>
      <Hi icon={ExclamationTriangleIcon} size={12} /> transcription not installed
    </span>
  )
}

// ---- the button -----------------------------------------------------------------

interface RecorderPanelProps {
  recorder: ReturnType<typeof useRecorder>
  saving: boolean
  engineReady: boolean
  onSave: () => void
  typing: boolean
  onToggleTyping: () => void
  onSaveText: (text: string) => void
  delayMinutes: number
}

function RecorderPanel({ recorder, saving, engineReady, onSave, typing, onToggleTyping, onSaveText, delayMinutes }: RecorderPanelProps) {
  const { state, elapsed, levelRef, samplesRef, result, error } = recorder
  const live = state === 'recording' || state === 'paused'
  const [text, setText] = useState('')
  const textRef = useRef<HTMLTextAreaElement>(null)
  // The waveform loop writes --level straight onto the stage, so the halo breathes
  // without React re-rendering sixty times a second.
  const stageRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (typing) textRef.current?.focus() }, [typing])

  // Playback of the take before saving. The URL is revoked when the take goes.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!result) { setPreviewUrl(null); return }
    const url = URL.createObjectURL(result.blob)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [result])

  const mainLabel = state === 'recording' ? 'Stop recording' : state === 'paused' ? 'Stop recording' : state === 'requesting' ? 'Starting…' : 'Start recording'
  const onMain = () => {
    if (state === 'idle' || state === 'denied') void recorder.start()
    else if (live) recorder.stop()
  }

  return (
    <div className={`journal-rec${live ? ' live' : ''}${state === 'stopped' ? ' review' : ''}`}>
      {state === 'unsupported' ? (
        <div className="journal-rec-unsupported">
          <Hi icon={ExclamationTriangleIcon} size={16} />
          <span>This browser can’t record audio here. Recording needs a secure (https) page and a browser with MediaRecorder — on iPhone, open Totem from the Home Screen icon. You can still type an entry below.</span>
        </div>
      ) : state !== 'stopped' ? (
        <>
          <div className="rec-stage" ref={stageRef}>
            <div className="rec-ring" aria-hidden="true" />
            <button
              type="button"
              className={`rec-btn${live ? ' live' : ''}${state === 'requesting' ? ' busy' : ''}`}
              onClick={onMain}
              disabled={state === 'requesting'}
              aria-label={mainLabel}
              title={mainLabel}
            >
              {live ? <Hi icon={StopSolidIcon} size={30} /> : <span className="rec-dot" />}
            </button>
          </div>
          <div className="rec-readout">
            <div className={`rec-timer${state === 'paused' ? ' paused' : ''}`} aria-live="off">{fmtClock(elapsed)}</div>
            <div className="rec-wave">
              <Waveform
                samplesRef={samplesRef} levelRef={levelRef} haloRef={stageRef}
                live={live} paused={state === 'paused'} height={56}
                label={live ? 'Live microphone level — the bars move while you talk' : 'Microphone level'}
              />
            </div>
            <div className="rec-hint muted">
              {state === 'recording' && 'Recording — tap the square when you’re done.'}
              {state === 'paused' && 'Paused.'}
              {state === 'requesting' && 'Waiting for the microphone…'}
              {(state === 'idle' || state === 'denied') && (engineReady
                ? 'Tap to record. Talk about yesterday; it’s transcribed here, then digested into your brain.'
                : 'Transcription isn’t installed on the bridge yet — recordings will wait as failed until it is. Typing works now.')}
            </div>
            {live && (
              <div className="rec-controls">
                {state === 'recording'
                  ? <button className="btn compact" onClick={recorder.pause}><Hi icon={PauseIcon} size={14} /> Pause</button>
                  : <button className="btn compact" onClick={recorder.resume}><Hi icon={PlayIcon} size={14} /> Resume</button>}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="rec-review">
          <div className="rec-review-head">
            <Hi icon={MicrophoneIcon} size={18} />
            <div>
              <div className="rec-review-title">{fmtClock(result?.durationSec ?? 0)} recorded</div>
              <div className="muted rec-review-sub">Save to transcribe. The digest runs {delayMinutes} min later unless you press <b>Don’t ingest</b> on the entry.</div>
            </div>
          </div>
          <div className="rec-wave review">
            <Waveform samples={result?.waveform || []} height={64} label="Waveform of the recording you just made" />
          </div>
          {previewUrl && <audio className="rec-preview" controls preload="metadata" src={previewUrl} />}
          <div className="rec-review-actions">
            <button className="btn danger compact" onClick={recorder.reset} disabled={saving}><Hi icon={TrashIcon} size={14} /> Discard</button>
            <button className="btn primary" onClick={onSave} disabled={saving}>
              {saving ? <><Hi icon={ArrowPathIcon} size={14} className="spin" /> Saving…</> : <><Hi icon={CheckCircleIcon} size={16} /> Save</>}
            </button>
          </div>
        </div>
      )}

      {error && <div className="journal-rec-error"><Hi icon={ExclamationTriangleIcon} size={14} /> {error}</div>}

      {!live && state !== 'stopped' && (
        <div className="rec-type">
          {typing ? (
            <form className="rec-type-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSaveText(text.trim()); setText('') } }}>
              <textarea
                ref={textRef} rows={4} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="What happened yesterday? Type it the way you’d say it."
                disabled={saving}
              />
              <div className="rec-type-actions">
                <button type="button" className="btn compact" onClick={onToggleTyping} disabled={saving}>Cancel</button>
                <button type="submit" className="btn compact primary" disabled={saving || !text.trim()}>
                  {saving ? 'Saving…' : 'Save entry'}
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="link-btn inline rec-type-toggle" onClick={onToggleTyping}>
              <Hi icon={PencilIcon} size={12} /> Type an entry instead
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---- one entry ----------------------------------------------------------------------

interface EntryCardProps {
  entry: JournalEntry
  now: number
  busy: boolean
  onSkip: () => void
  onIngest: () => void
  onRetry: () => void
  onRename: (title: string) => void
  onEditTranscript: (transcript: string) => void
  onKeepAudio: (keep: boolean) => void
  onDeleteAudio: () => void
  onDelete: () => void
}

const STATE_LABEL: Record<CardState, string> = {
  transcribing: 'Transcribing…',
  'transcribe-failed': 'Transcription failed',
  waiting: 'Digest in',
  due: 'Digesting soon…',
  digesting: 'Digesting…',
  digested: 'Digested',
  skipped: 'Not ingested',
  'ingest-failed': 'Digest failed',
}

function EntryCard({ entry, now, busy, onSkip, onIngest, onRetry, onRename, onEditTranscript, onKeepAudio, onDeleteAudio, onDelete }: EntryCardProps) {
  const state = cardState(entry, now)
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(entry.title || '')
  const [textDraft, setTextDraft] = useState(entry.transcript?.text || '')
  useEffect(() => { setTitleDraft(entry.title || '') }, [entry.title])
  useEffect(() => { setTextDraft(entry.transcript?.text || '') }, [entry.transcript?.text])

  const remaining = msUntil(entry.ingest.at, now)
  const result = entry.ingest.result
  const spinning = state === 'transcribing' || state === 'digesting' || state === 'due'
  const tone = state === 'digested' ? 'ok' : state.endsWith('failed') ? 'err' : state === 'skipped' ? 'muted' : state === 'waiting' ? 'warn' : 'info'
  // With no title of its own the headline is already the opening sentence, so the
  // excerpt picks up after it rather than saying the same thing twice.
  const excerpt = useMemo(() => {
    const text = entry.transcript?.text?.trim()
    if (!text) return null
    const rest = entry.title ? text : text.slice((text.split(/(?<=[.!?])\s+/)[0] || '').length).trim()
    if (!rest) return null
    return rest.length > 180 ? `${rest.slice(0, 178).trimEnd()}…` : rest
  }, [entry.transcript?.text, entry.title])
  const paragraphs = useMemo(() => splitParagraphs(entry.transcript?.text || ''), [entry.transcript?.text])

  // What the ⋯ menu offers depends on where the entry is in its life. Built here
  // rather than in EntryMenu so the menu component stays ignorant of journal state.
  const hasAudio = Boolean(entry.audio?.kept)
  const menuItems: MenuItem[] = []
  if (state === 'waiting' || state === 'due') {
    menuItems.push({ key: 'now', label: 'Digest now', icon: SparklesIcon, onSelect: onIngest, disabled: state === 'due', title: 'Skip the rest of the countdown' })
  } else if (state === 'skipped') {
    menuItems.push({ key: 'ingest', label: 'Digest it after all', icon: SparklesIcon, onSelect: onIngest })
  } else if (state === 'ingest-failed') {
    menuItems.push({ key: 'retry-digest', label: 'Retry digest', icon: ArrowPathIcon, onSelect: onIngest })
  } else if (state === 'transcribe-failed') {
    menuItems.push({
      key: 'retry-transcribe', label: 'Retry transcription', icon: ArrowPathIcon, onSelect: onRetry,
      disabled: !hasAudio, title: hasAudio ? 'Run whisper over the recording again' : 'The recording is gone, so there is nothing to transcribe',
    })
  } else if (state === 'digested') {
    menuItems.push({ key: 'again', label: 'Digest again', icon: ArrowPathIcon, onSelect: onIngest, title: 'Run the digest again. The transcript is not written to the brain twice.' })
  }
  if (entry.status === 'transcribed') {
    menuItems.push({ key: 'rename', label: 'Rename', icon: PencilIcon, onSelect: () => setRenaming(true), separated: menuItems.length > 0 })
  }
  if (entry.source === 'voice') {
    menuItems.push(
      hasAudio
        ? {
          key: 'keep', label: entry.audio?.pinned ? 'Stop keeping the recording' : 'Keep the recording',
          icon: BookmarkIcon, separated: true, onSelect: () => onKeepAudio(!entry.audio?.pinned),
          title: entry.audio?.pinned ? 'Let it expire on the normal schedule again' : 'Never delete this recording on a timer',
        }
        : { key: 'gone', label: 'Recording deleted', icon: MicrophoneIcon, onSelect: () => {}, disabled: true, separated: true, title: audioTitle(entry.audio, now) },
    )
    if (hasAudio) {
      menuItems.push({ key: 'delete-audio', label: 'Delete the recording', icon: TrashIcon, danger: true, onSelect: onDeleteAudio, title: 'Delete the audio now and keep the transcript' })
    }
  }
  menuItems.push({ key: 'delete', label: 'Delete entry', icon: TrashIcon, danger: true, onSelect: onDelete, separated: true })

  return (
    <article className={`journal-entry state-${state}${open ? ' open' : ''}`}>
      <div className="journal-entry-row">
        <div className="journal-entry-main">
          <div className="journal-entry-top">
            <span className="journal-time">{timeOfDay(entry.recordedAt)}</span>
            {entry.durationSec != null && <span className="journal-dur muted">{fmtClock(entry.durationSec)}</span>}
            <span
              className={`journal-src muted${entry.audio?.pinned ? ' pinned' : ''}`}
              title={entry.source === 'voice' ? audioTitle(entry.audio, now) : 'Typed entry'}
            >
              <Hi icon={entry.source === 'voice' ? MicrophoneIcon : PencilSquareIcon} size={12} />
              {entry.source === 'voice' ? audioLabel(entry.audio, now) : 'typed'}
            </span>
            <span className={`journal-state ${tone}`}>
              {spinning ? <Hi icon={ArrowPathIcon} size={12} className="spin" />
                : state === 'digested' ? <Hi icon={SparklesIcon} size={12} />
                : state === 'skipped' ? <Hi icon={NoSymbolIcon} size={12} />
                : state === 'waiting' ? <Hi icon={ClockIcon} size={12} />
                : <Hi icon={ExclamationTriangleIcon} size={12} />}
              {STATE_LABEL[state]}
              {state === 'waiting' && <b className="journal-countdown">{fmtClock(Math.ceil(remaining / 1000))}</b>}
            </span>
          </div>

          {renaming ? (
            <form className="journal-rename" onSubmit={(e) => { e.preventDefault(); onRename(titleDraft); setRenaming(false) }}>
              <input autoFocus value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} placeholder="Title" maxLength={120} />
              <button type="submit" className="btn compact primary">Save</button>
              <button type="button" className="btn compact" onClick={() => { setRenaming(false); setTitleDraft(entry.title || '') }}>Cancel</button>
            </form>
          ) : (
            <h3 className="journal-title">
              {entryTitle(entry)}
              {entry.status === 'transcribed' && (
                <button className="journal-rename-btn" onClick={() => setRenaming(true)} title="Rename" aria-label="Rename entry"><Hi icon={PencilIcon} size={12} /></button>
              )}
            </h3>
          )}

          {!open && excerpt && <p className="journal-excerpt">{excerpt}</p>}
          {state === 'transcribe-failed' && entry.error && <p className="journal-err">{entry.error}</p>}
          {state === 'ingest-failed' && entry.ingest.error && <p className="journal-err">{entry.ingest.error}</p>}

          {result && state === 'digested' && (
            <div className="journal-result">
              {result.summary && <p className="journal-summary">{result.summary}</p>}
              <div className="journal-chips">
                {result.memory.length > 0 && <span className="journal-chip" title={result.memory.join('\n')}>{result.memory.length} memory {result.memory.length === 1 ? 'update' : 'updates'}</span>}
                {result.habits.length > 0 && <span className="journal-chip" title={result.habits.join(', ')}>{result.habits.length} {result.habits.length === 1 ? 'habit' : 'habits'} logged</span>}
                {result.proposals.length > 0 && (
                  <a className="journal-chip link" href="/inbox" onClick={() => notifyInboxChanged()} title={result.proposals.join(', ')}>
                    <Hi icon={InboxStackIcon} size={12} /> {result.proposals.length} in Inbox
                  </a>
                )}
                {result.mood && <span className="journal-chip muted">{result.mood}</span>}
                {!result.parsed && <span className="journal-chip muted" title="The agent did not report what it changed">unstructured reply</span>}
              </div>
            </div>
          )}

          {entry.transcript && (
            <button type="button" className={`inbox-disclose${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              <Hi icon={ChevronRightIcon} size={13} className="inbox-disclose-chevron" />
              {open ? 'Hide transcript' : 'Show transcript'}
            </button>
          )}
        </div>

        <div className="journal-actions">
          {/* The one action with a deadline keeps a real button. Everything else is
              in the menu — a permanent Delete next to a permanent Again was the
              action wanted least often sitting where it is easiest to hit. */}
          {(state === 'waiting' || state === 'due') && (
            <button className="btn compact danger journal-skip" disabled={busy || state === 'due'} onClick={onSkip} title="Keep this entry out of the brain">
              <Hi icon={NoSymbolIcon} size={14} /> Don’t ingest
            </button>
          )}
          <EntryMenu label={`Actions for this entry`} disabled={busy} items={menuItems} />
        </div>
      </div>

      {open && entry.transcript && (
        <div className="journal-transcript">
          <AudioPlayback entry={entry} />
          {editing ? (
            <form onSubmit={(e) => { e.preventDefault(); onEditTranscript(textDraft); setEditing(false) }}>
              <textarea value={textDraft} onChange={(e) => setTextDraft(e.target.value)} rows={Math.min(18, Math.max(6, Math.ceil(textDraft.length / 90)))} />
              <div className="journal-transcript-actions">
                <button type="button" className="btn compact" onClick={() => { setEditing(false); setTextDraft(entry.transcript?.text || '') }}>Cancel</button>
                <button type="submit" className="btn compact primary" disabled={!textDraft.trim()}>Save transcript</button>
              </div>
            </form>
          ) : (
            <>
              {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
              <div className="journal-transcript-meta muted">
                {entry.transcript.model && <span>whisper {entry.transcript.model}</span>}
                {entry.transcript.ms > 0 && <span>{Math.round(entry.transcript.ms / 1000)} s to transcribe</span>}
                {entry.transcript.editedAt && <span>edited</span>}
                {entry.ingest.journalFile && <span>brain: {entry.ingest.journalFile}</span>}
                {entry.status === 'transcribed' && (
                  <button type="button" className="link-btn inline" onClick={() => setEditing(true)}><Hi icon={PencilSquareIcon} size={12} /> Fix the transcript</button>
                )}
              </div>
            </>
          )}
          {result?.reply && (
            <details className="journal-reply">
              <summary>What the digest said</summary>
              <pre className="inbox-command muted">{result.reply}</pre>
            </details>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * Play back a kept recording.
 *
 * The bytes are fetched rather than handed to `<audio src>` because every API route
 * is bearer authed and an audio element cannot send the header. Loaded on demand —
 * a list of twenty entries must not pull twenty recordings — and the object URL is
 * revoked when the card closes.
 */
function AudioPlayback({ entry }: { entry: JournalEntry }) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  if (!entry.audio?.kept) return null
  if (url) {
    return (
      <div className="journal-audio">
        <audio controls preload="metadata" src={url} className="rec-preview" />
        <a className="link-btn inline" href={url} download={`${entry.date}-journal.${(entry.audio.mime.split('/')[1] || 'm4a').replace('mpeg', 'mp3')}`}>
          <Hi icon={ArrowTopRightOnSquareIcon} size={12} /> Save a copy
        </a>
      </div>
    )
  }
  return (
    <div className="journal-audio">
      <button
        type="button" className="btn compact" disabled={loading}
        onClick={() => {
          setLoading(true); setError('')
          journalAudioUrl(entry.id)
            .then(setUrl)
            .catch((e) => setError(e instanceof Error ? e.message : 'That recording could not be loaded.'))
            .finally(() => setLoading(false))
        }}
      >
        <Hi icon={loading ? ArrowPathIcon : PlayIcon} size={14} className={loading ? 'spin' : ''} />
        {loading ? 'Loading…' : `Play the recording (${fmtBytes(entry.audio.bytes)})`}
      </button>
      <span className="muted journal-audio-note">{audioTitle(entry.audio)}</span>
      {error && <span className="journal-err">{error}</span>}
    </div>
  )
}

/** Client-side paragraphing for display; the brain page gets the real thing. */
function splitParagraphs(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  if (text.includes('\n\n')) return text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  const sentences = clean.split(/(?<=[.!?]["')]?)\s+/)
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    const t = s.trim()
    if (!t) continue
    if (cur && cur.length + t.length > 600) { out.push(cur); cur = t } else cur = cur ? `${cur} ${t}` : t
  }
  if (cur) out.push(cur)
  return out
}
