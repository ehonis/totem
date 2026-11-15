// Sheet detents: [1] (formSheet, grabber, corner radius 22; registered in src/app/_layout.tsx).
//
// A file from a chat that isn't text (FileSheet reads those): the phone's take on
// the web's canvas. A picture shows here, drawn with the app's credentials; a PDF
// in the app's one web view (ui/BridgeWebView.tsx), which sends the Access token
// with its first request only and no bearer (the URL is signed); any other file,
// and one the web view can't show, is offered to the share sheet (Save to Files,
// AirDrop, another app), downloaded with the same credentials. The in-app browser
// used to open these, and behind Cloudflare Access it showed Access's login page.
//
// The bearer and the Access token go only to the bridge's own origin
// (lib/links.ts headersFor; bridgeFetch refuses any other). The `url` param can
// arrive by deep link, so only a `/`-relative bridge path is taken (bridgePath).
import React, { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import { authHeaders } from '../../lib/api'
import { bridgeUrl, getBaseUrl } from '../../lib/connection'
import { linkOpensOutside } from '../../lib/bridgePage'
import { bridgePath, fileView, headProvesGone, headersFor, webViewSource } from '../../lib/links'
import { openUrl } from '../../lib/siblingApps'
import { T } from '../../ui/Text'
import { Btn, Press, Spinner } from '../../ui/kit'
import BridgeWebView from '../../ui/BridgeWebView'
import { tap } from '../../ui/haptics'
import { colors } from '../../theme'
import { TI, formatBytes, vc } from './ui'
import { IconDownload, IconFileOff, IconFileText, IconFileTypePdf, IconFileZip, IconPhoto, IconRefresh, IconWorld } from './icons'
import { HEAD_TIMEOUT_MS, headWithin, refusal, shareFile } from './openLink'

type Probe =
  | { state: 'checking' }
  | { state: 'ok'; size?: number; type: string }
  | { state: 'gone'; message: string }
  | { state: 'unreachable' }

export default function FileViewer() {
  const params = useLocalSearchParams<{ name?: string; mime?: string; url?: string }>()
  const name = params.name || 'File'
  const mime = params.mime || ''
  const url = bridgePath(params.url)
  const insets = useSafeAreaInsets()
  const view = fileView(name, mime)
  const [probe, setProbe] = useState<Probe>({ state: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const [imageFailed, setImageFailed] = useState(false)
  const [pageFailed, setPageFailed] = useState(false)
  const [pageLoaded, setPageLoaded] = useState(false)
  const [pageKey, setPageKey] = useState(0)
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState('')

  // A HEAD first, so a file that has gone says so here rather than as a blank page.
  useEffect(() => {
    if (!url) return
    let live = true
    setProbe({ state: 'checking' })
    headWithin(url, HEAD_TIMEOUT_MS)
      .then((r) => {
        if (!live) return
        if (r.status === 403 || r.status === 401 || headProvesGone(url, r.status)) setProbe({ state: 'gone', message: refusal({ status: r.status }, name) })
        else setProbe({ state: 'ok', size: Number(r.headers.get('content-length')) || undefined, type: r.ok ? r.headers.get('content-type') || '' : '' })
      })
      .catch(() => { if (live) setProbe({ state: 'unreachable' }) })
    return () => { live = false }
  }, [url, name, attempt])

  const share = async () => {
    if (!url) return
    tap()
    setSharing(true)
    setShareError('')
    try { await shareFile(url, name) } catch (e) { setShareError((e as Error)?.message || `Couldn’t download ${name}.`) } finally { setSharing(false) }
  }

  // A tap on a link inside the PDF stops the web view (it never leaves the file):
  // reload the file, and open the link in the in-app browser if it goes to another site.
  const onLeave = (to?: string) => {
    setPageLoaded(false)
    setPageKey((k) => k + 1)
    if (to && linkOpensOutside(to, getBaseUrl())) void openUrl(to)
  }

  const abs = url ? bridgeUrl(url) : ''
  const page = pageFailed || !url ? null : webViewSource(view, abs, getBaseUrl(), probe.state === 'ok' ? probe.type : '')
  const icon = view === 'image' ? IconPhoto : view === 'pdf' ? IconFileTypePdf
    : view === 'html' ? IconWorld : /zip|compressed|tar|gzip/i.test(mime) || /\.(zip|tgz|gz|tar)$/i.test(name) ? IconFileZip : IconFileText
  const size = probe.state === 'ok' ? probe.size : undefined
  const gone = !url ? `${name} can’t be opened from this link.`
    : probe.state === 'gone' ? probe.message : imageFailed ? `Couldn’t show ${name}.` : ''
  // The header's Save or share sits over a picture or a PDF; the card below has its own.
  const shown = !gone && probe.state === 'ok' && (view === 'image' || !!page)

  return (
    <View style={[st.root, { paddingBottom: insets.bottom + 16 }]}>
      <View style={st.head}>
        <T size={15} weight={600} numberOfLines={1} style={{ flex: 1 }}>{name}</T>
        {shown ? (
          <Press style={st.btn} onPress={share} disabled={sharing} accessibilityLabel={sharing ? 'Preparing' : 'Save or share'}>
            <TI icon={IconDownload} size={18} color={colors.text} />
          </Press>
        ) : null}
      </View>
      {shareError && shown ? <T size={13} color={colors.red} style={[st.note, { paddingHorizontal: 16 }]}>{shareError}</T> : null}
      {gone ? (
        <View style={st.center} accessibilityLiveRegion="polite">
          <TI icon={IconFileOff} size={40} color={vc.faint} />
          <T size={15} color={vc.soft} style={st.note}>{gone}</T>
        </View>
      ) : probe.state === 'checking' ? (
        <Spinner style={{ flex: 1, justifyContent: 'center' }} />
      ) : probe.state === 'unreachable' ? (
        <View style={st.center} accessibilityLiveRegion="polite">
          <T size={15} color={vc.soft} style={st.note}>{`Totem didn’t answer, so ${name} couldn’t be opened.`}</T>
          <Btn icon={IconRefresh} title="Retry" onPress={() => { tap(); setAttempt((a) => a + 1) }} style={{ marginTop: 12 }} />
        </View>
      ) : view === 'image' ? (
        <Image
          source={{ uri: abs, headers: headersFor(abs, getBaseUrl(), authHeaders()) }}
          style={{ flex: 1 }}
          contentFit="contain"
          accessibilityLabel={name}
          onError={() => setImageFailed(true)}
        />
      ) : page ? (
        <View style={{ flex: 1 }}>
          <BridgeWebView key={pageKey} target={page} scroll style={{ flex: 1 }} onLoaded={() => setPageLoaded(true)} onFail={() => setPageFailed(true)} onLeave={onLeave} />
          {!pageLoaded ? <Spinner style={StyleSheet.absoluteFill} /> : null}
        </View>
      ) : (
        <View style={st.center}>
          {pageFailed ? <T size={14} color={vc.soft} style={st.note}>{`Couldn’t show ${name} here.`}</T> : null}
          <View style={st.fileIcon}><TI icon={icon} size={34} color="#8fb0ff" /></View>
          <T size={16} weight={500} numberOfLines={2} style={st.note}>{name}</T>
          <T size={13} color={vc.faint}>{[mime || null, size ? formatBytes(size) : null].filter(Boolean).join(' · ')}</T>
          {view === 'html' ? <T size={13} color={vc.soft} style={st.note}>Open it on the dashboard, or save it to view in Files.</T> : null}
          <Btn kind="primary" icon={IconDownload} title={sharing ? 'Preparing…' : 'Save or share'} onPress={share} disabled={sharing} loading={sharing} style={{ marginTop: 18 }} />
          {shareError ? <T size={13} color={colors.red} style={st.note}>{shareError}</T> : null}
        </View>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 18, paddingBottom: 8, paddingHorizontal: 16 },
  btn: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: vc.line, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 32 },
  fileIcon: { width: 72, height: 72, borderRadius: 18, backgroundColor: '#1a1f2b', alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  note: { textAlign: 'center' },
})
