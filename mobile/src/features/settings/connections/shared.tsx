// Pieces the Connections pane and its detail screens share (web McpSettingsView.tsx,
// WhoopConnection.tsx, StravaConnection.tsx): the connection marks, the Google
// account APIs, Bushido's grant states, and finishing an OAuth sign-in from the phone.
import React, { useEffect, useState } from 'react'
import { Linking, View } from 'react-native'
import { Image } from 'expo-image'
import * as Clipboard from 'expo-clipboard'
import {
  getCalendarAccounts, renameCalendarAccount, removeCalendarAccount, startCalendarAccountAuth,
  getGmailAccounts, renameGmailAccount, removeGmailAccount, startGmailAccountAuth,
  getDriveAccounts, renameDriveAccount, removeDriveAccount, startDriveAccountAuth,
  authHeaders,
} from '../../../lib/api'
import { bridgeFetch, getBaseUrl } from '../../../lib/connection'
import { uploadUrl } from '../../../lib/chat/api'
import { THREAD_ICONS } from '../../../lib/chat/threadIcons.gen'
import { useConnectionIcon } from '../../../lib/connections/icons'
import type { ServerState } from '../../../lib/connections/state'
import { getSourceRuns, since, type SourceRun } from '../../../lib/sources/health'
import { plainError } from '../../../lib/sources/plainError'
import { Hi, type IconType } from '../../../lib/icons'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn } from '../../../ui/kit'
import { success } from '../../../ui/haptics'
import { Field, Note, Notice, copy } from '../ui'

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

// The web's bundled full-colour logos the app also ships. Other connections get
// a letter on a colour derived from their id, as the web's fallback does (the web's
// simple-icons glyphs are not in the app).
const LOGOS: Record<string, number> = {
  'google-calendar': require('../../../../assets/images/connection-icons/google-calendar.png'),
  plaud: require('../../../../assets/images/connection-icons/plaud.png'),
  slack: require('../../../../assets/images/connection-icons/slack.png'),
  canva: require('../../../../assets/images/connection-icons/canva.png'),
}

/** The brand hue for marks the web draws from simple-icons. */
const HUES: Record<string, string> = {
  gmail: '#ea4335', 'google-drive': '#1fa463', github: '#24292f', linear: '#5e6ad2', notion: '#2f2f2f',
  sentry: '#362d59', vercel: '#111111', stripe: '#635bff', airtable: '#18bfff', asana: '#f06a6a',
}

export function accentFor(id = '') {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return `hsl(${h}, 55%, 45%)`
}

export function ConnectionIcon({ id, name, size = 30, icon, color }: { id: string; name?: string; size?: number; icon?: IconType; color?: string }) {
  // The owner's pick from the dashboard (a chat icon, a picture or a site's icon)
  // wins over the logo; rows that pass their own glyph are Totem's, not a connection's.
  const pick = useConnectionIcon(id)
  const picked = icon ? undefined : pick
  const pickedIcon = !picked?.imageUrl && picked?.icon ? THREAD_ICONS[picked.icon] : undefined
  const logo = LOGOS[id]
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.24) }
  if (picked?.image && picked.imageUrl) {
    return (
      <View style={[box, { alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' }]}>
        <Image source={{ uri: uploadUrl(picked.image, { url: picked.imageUrl }), headers: authHeaders() }} style={{ width: Math.round(size * 0.7), height: Math.round(size * 0.7) }} contentFit="contain" accessibilityIgnoresInvertColors />
      </View>
    )
  }
  if (logo && !pickedIcon) return <Image source={logo} style={[box, { backgroundColor: '#fff' }]} accessibilityIgnoresInvertColors />
  const glyph = icon || pickedIcon
  return (
    <View style={[box, { alignItems: 'center', justifyContent: 'center', backgroundColor: color || HUES[id] || accentFor(id) }]}>
      {glyph ? <Hi icon={glyph} size={Math.round(size * 0.56)} color="#fff" />
        : <T size={Math.round(size * 0.46)} weight={700} color="#fff">{(name || id || '?').slice(0, 1).toUpperCase()}</T>}
    </View>
  )
}

export function hostOf(app: any) {
  if (app.url) {
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(app.url)
    return m ? m[1] : app.url
  }
  return [app.command, app.package].filter(Boolean).join(' ') || 'Local command'
}

export const errorText = (e: any) => e?.message || String(e)

// ---------------------------------------------------------------------------
// Google accounts (Calendar, Gmail and Drive each keep their own token store)
// ---------------------------------------------------------------------------

export interface GoogleAccountsApi {
  id: string
  name: string
  summary: string
  about: string
  list: () => Promise<any>
  rename: (from: string, to: string) => Promise<any>
  remove: (label: string) => Promise<any>
  start: (label: string) => Promise<any>
  /** What stops working when an account is disconnected, for the confirm. */
  removes: string
}

export const GOOGLE: Record<'gmail' | 'drive' | 'calendar', GoogleAccountsApi> = {
  gmail: {
    id: 'gmail', name: 'Gmail', summary: 'Search, read, label and draft. Never sends.',
    about: 'Agents get gmail__* tools for every account here. An email they write waits in your Inbox for you to send. The same sign-in adds the account’s calendar. Uses Calendar’s Google OAuth client with the Gmail API enabled (docs/gmail.md).',
    list: getGmailAccounts, rename: renameGmailAccount, remove: removeGmailAccount, start: startGmailAccountAuth,
    removes: 'Agents lose access to its mail, and Totem asks Google to revoke the grant.',
  },
  drive: {
    id: 'google-drive', name: 'Google Drive', summary: 'Find, read and organise files. Edit Sheets and Docs.',
    about: 'Agents get drive__* tools for every account here, shared drives included. They cannot share a file or delete one for good. Uses Calendar’s Google OAuth client with the Drive, Sheets and Docs APIs enabled (docs/drive.md).',
    list: getDriveAccounts, rename: renameDriveAccount, remove: removeDriveAccount, start: startDriveAccountAuth,
    removes: 'Agents lose access to its files, and Totem asks Google to revoke the grant.',
  },
  calendar: {
    id: 'google-calendar', name: 'Google Calendar', summary: 'The calendars on Overview and in Calendar.',
    about: 'Each account’s calendars sync into Totem. Gmail’s sign-in adds an account’s calendar too.',
    list: getCalendarAccounts, rename: renameCalendarAccount, remove: removeCalendarAccount, start: startCalendarAccountAuth,
    removes: 'Its calendar stops syncing here.',
  },
}

// ---------------------------------------------------------------------------
// WHOOP and Strava: Bushido holds both grants (whoop/remote.mjs, strava/remote.mjs)
// ---------------------------------------------------------------------------

export const GRANT_TONE: Record<string, 'ok' | 'warn' | 'error'> = {
  ready: 'ok', 'missing-scopes': 'warn', 'needs-reauth': 'error', disconnected: 'warn', unconfigured: 'error', unreachable: 'error',
}
export const GRANT_LABEL: Record<string, string> = {
  ready: 'Connected', 'missing-scopes': 'Needs more access', 'needs-reauth': 'Reconnect needed', disconnected: 'Not connected', unconfigured: 'Not set up', unreachable: 'Bushido unreachable',
}
/** Grant states that need the owner to act, in Bushido. */
export const GRANT_PROBLEMS = new Set(['needs-reauth', 'unreachable', 'missing-scopes'])

export function grantState(s: any): string {
  if (!s) return 'disconnected'
  if (s.state) return s.state
  if (!s.configured) return 'unconfigured'
  if (!s.connected) return 'disconnected'
  if (s.needsReauth) return 'needs-reauth'
  if (s.missingScopes?.length) return 'missing-scopes'
  return 'ready'
}

// ---------------------------------------------------------------------------
// Finishing an OAuth sign-in from the phone
// ---------------------------------------------------------------------------

// Every sign-in Totem starts redirects to http://localhost:<port>/<kind>-oauth/callback,
// which only the server can load. On a laptop the web has you swap the host in the
// address bar; on the phone you copy the address Safari could not open and the app
// loads the same path on the bridge. These routes take no bearer: the unguessable
// `state` in the query is their guard (bridge.mjs), so nothing else may be replayed.
const CALLBACKS = ['/mcp-oauth/callback', '/gcal-oauth/callback', '/gmail-oauth/callback', '/drive-oauth/callback']

/** The bridge path for a pasted localhost callback, or null if it is not one. */
export function callbackPath(pasted: string): string | null {
  const m = /^\s*https?:\/\/[^/?#]+(\/[^?#\s]*)(\?[^#\s]*)?/i.exec(pasted || '')
  if (!m || !CALLBACKS.includes(m[1])) return null
  return `${m[1]}${m[2] || ''}`
}

/** Load a pasted callback on the bridge. Resolves to the page's own message. */
export async function finishCallback(pasted: string): Promise<{ ok: boolean; message: string }> {
  const path = callbackPath(pasted)
  if (!path) return { ok: false, message: 'That is not a Totem sign-in address. Copy the whole address Safari could not open.' }
  try {
    const r = await bridgeFetch(path)
    const html = await r.text().catch(() => '')
    const text = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    return { ok: r.ok, message: r.ok ? 'Signed in.' : (text.slice(0, 200) || `HTTP ${r.status}`) }
  } catch (e) {
    return { ok: false, message: errorText(e) }
  }
}

/**
 * The sign-in walkthrough: open the provider's page in Safari, approve, then copy
 * the address Safari cannot open back into the app. `onDone` refreshes the caller.
 */
export function SignInHelper({ authUrl, redirect, onDone, onCancel }: {
  authUrl: string
  /** host:port the provider sends the browser back to (the server's localhost). */
  redirect?: string | null
  onDone: () => void
  onCancel?: () => void
}) {
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const host = getBaseUrl().replace(/^https?:\/\//, '')

  async function finish(text = pasted) {
    setBusy(true)
    setNote(null)
    const r = await finishCallback(text)
    setBusy(false)
    setNote({ text: r.message, error: !r.ok })
    if (r.ok) { success(); setPasted(''); onDone() }
  }

  async function pasteAndFinish() {
    const text = await Clipboard.getStringAsync().catch(() => '')
    setPasted(text)
    if (callbackPath(text)) void finish(text)
    else setNote({ text: 'The clipboard holds no Totem sign-in address yet.', error: true })
  }

  return (
    <Notice tone="info">
      <View style={{ gap: 4 }}>
        <T size={13} lineHeight={19}>1. Open the sign-in page in Safari and approve.</T>
        <T size={13} lineHeight={19}>2. Safari then can’t load {redirect || 'localhost'}. That is expected: tap its address bar and copy the whole address.</T>
        <T size={13} lineHeight={19}>3. Come back and paste it here. Totem finishes the sign-in through {host || 'the server'}.</T>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Btn compact kind="primary" title="Open in Safari" onPress={() => { void Linking.openURL(authUrl) }} />
        <Btn compact title="Copy link" onPress={() => void copy(authUrl, 'Link copied')} />
        {onCancel ? <Btn compact kind="ghost" title="Cancel" onPress={onCancel} /> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field
          style={{ flex: 1 }}
          value={pasted}
          onChangeText={setPasted}
          placeholder="http://localhost:…/…-oauth/callback?…"
          keyboardType="url"
          accessibilityLabel="The address Safari could not open"
          returnKeyType="go"
          onSubmitEditing={() => { if (pasted.trim()) void finish() }}
        />
        {pasted.trim()
          ? <Btn title="Finish" loading={busy} onPress={() => void finish()} />
          : <Btn title="Paste" loading={busy} onPress={() => void pasteAndFinish()} />}
      </View>
      {note ? <Note text={note.text} error={note.error} style={{ paddingHorizontal: 0 }} /> : null}
    </Notice>
  )
}

/** A dot in a state's colour, for source and server rows. */
export function Dot({ color, dim }: { color: string; dim?: boolean }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, opacity: dim ? 0.55 : 1 }} />
}

// ---------------------------------------------------------------------------
// The pane's pieces its screens reuse
// ---------------------------------------------------------------------------

/** One source's newest runs, loaded when shown. Also used by a server's screen (`mcp:<id>`). */
export function SourceRuns({ source }: { source: string }) {
  const [runs, setRuns] = useState<SourceRun[] | null>(null)
  useEffect(() => {
    let alive = true
    getSourceRuns(source, 10).then((r) => { if (alive) setRuns(r.runs) }).catch(() => { if (alive) setRuns([]) })
    return () => { alive = false }
  }, [source])
  if (runs === null) return <T size={12.5} muted>Loading recent checks…</T>
  if (!runs.length) return <T size={12.5} muted>No checks in the log yet.</T>
  return (
    <View style={{ gap: 5 }} accessibilityLabel="Recent checks">
      {runs.map((r, i) => (
        <View key={`${r.finishedAt}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Dot color={r.ok ? colors.green : colors.red} />
          <T size={12.5} muted style={{ width: 64 }}>{since(r.finishedAt)}</T>
          <T size={12.5} style={{ flex: 1 }} numberOfLines={2}>{r.ok ? (r.rows != null ? `${r.rows} rows` : 'OK') : plainError(r.error)}</T>
        </View>
      ))}
    </View>
  )
}

/** Installed servers (catalog entries merged in) apart from the catalog apps not added yet. */
export function splitCatalog(catalog: any, data: any) {
  const connections: any[] = data?.connections || []
  const byId = Object.fromEntries(connections.map((c) => [c.id, c]))
  const installed: any[] = []
  const available: any[] = []
  for (const entry of (catalog?.catalog || [])) {
    const conn = byId[entry.id]
    if (conn) installed.push({ ...entry, ...conn, enabled: conn.enabled !== false, custom: false })
    else available.push(entry)
  }
  const ids = new Set((catalog?.catalog || []).map((c: any) => c.id))
  for (const conn of connections) {
    if (!ids.has(conn.id)) installed.push({ ...conn, enabled: conn.enabled !== false, custom: true, category: conn.category || 'Custom' })
  }
  return { installed, available }
}

export const STATE_CHIP: Record<ServerState, { label: string; tone?: 'ok' | 'warn' | 'error' }> = {
  signin: { label: 'Needs sign-in', tone: 'warn' },
  error: { label: 'Not working', tone: 'error' },
  checking: { label: 'Not checked' },
  live: { label: 'Live', tone: 'ok' },
  off: { label: 'Off' },
}
