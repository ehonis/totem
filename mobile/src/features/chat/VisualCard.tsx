// A chart or visual the agent rendered with `html_render`, drawn where it sits in
// the reply as the web draws it (web/src/chat/VisualFrame.tsx): a WebView on the
// chat's background, fitted to the height the page reports, which until then
// holds the height the agent measured. The corner button opens it full screen.
//
// It used to be a card that opened the page in the in-app browser, which cannot
// send the app's Cloudflare Access token, so behind Access it showed Access's
// sign-in page instead of the chart (#260). ui/BridgeWebView.tsx holds the rules;
// height reports and the full-screen view are this card's.
import React, { useCallback, useState } from 'react'
import { Modal, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { VisualPart } from '../../lib/chat/types'
import { getBaseUrl } from '../../lib/connection'
import { T } from '../../ui/Text'
import { Press, Spinner } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { colors } from '../../theme'
import { TI, vc } from './ui'
import { IconArrowsMaximize, IconChartBar, IconRefresh, IconX } from './icons'
import BridgeWebView from '../../ui/BridgeWebView'
import { visualPagePath } from './visualPage'

type State = 'loading' | 'shown' | 'failed' | 'left'

export default function VisualCard({ part }: { part: VisualPart }) {
  // The first URL stays: a re-signed copy of the message must not reload the page.
  const [src] = useState(() => visualPagePath(part.url, getBaseUrl()))
  const [height, setHeight] = useState(part.height)
  const [state, setState] = useState<State>('loading')
  const [attempt, setAttempt] = useState(0)
  const [full, setFull] = useState(false)
  const title = part.title || 'Chart'

  const onLoaded = useCallback(() => setState((s) => (s === 'loading' ? 'shown' : s)), [])
  const onFail = useCallback(() => setState('failed'), [])
  const onLeave = useCallback(() => setState('left'), [])

  if (state === 'left') return <T size={14} color={vc.faint} style={st.note}>“{title}” reloaded or tried to open another page, so it was closed.</T>
  if (!src || state === 'failed') {
    const retry = src ? () => { tap(); setState('loading'); setAttempt((n) => n + 1) } : undefined
    return <ChartNote title={title} line={src ? "Couldn't load the chart · tap to retry" : 'Chart'} onPress={retry} />
  }

  return (
    <View style={[st.figure, { height }]}>
      <BridgeWebView key={attempt} target={src} style={{ height }} onHeight={setHeight} onLoaded={onLoaded} onFail={onFail} onLeave={onLeave} />
      {state === 'loading' ? <View style={st.cover} pointerEvents="none"><Spinner style={{ paddingVertical: 0 }} /></View> : null}
      {state === 'shown' ? (
        <Press onPress={() => { tap(); setFull(true) }} style={st.open} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Open ${title} full screen`}>
          <TI icon={IconArrowsMaximize} size={15} />
        </Press>
      ) : null}
      {full ? <FullScreen src={src} title={title} onClose={() => setFull(false)} /> : null}
    </View>
  )
}

function ChartNote({ title, line, onPress }: { title: string; line: string; onPress?: () => void }) {
  const inner = (
    <>
      <View style={st.icon}><TI icon={onPress ? IconRefresh : IconChartBar} size={22} color="#8fb0ff" /></View>
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <T size={15} weight={500} numberOfLines={1}>{title}</T>
        <T size={13} color={vc.faint}>{line}</T>
      </View>
    </>
  )
  return onPress ? <Press onPress={onPress} style={st.card}>{inner}</Press> : <View style={st.card}>{inner}</View>
}

// Its own page load, scrolling inside, under the same rules; a page that leaves closes the view.
function FullScreen({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  const [state, setState] = useState<State>('loading')
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      <View style={[st.full, { paddingTop: insets.top }]}>
        <View style={st.bar}>
          <T size={16} weight={600} numberOfLines={1} style={{ flex: 1 }}>{title}</T>
          <Press onPress={() => { tap(); onClose() }} style={st.close} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
            <TI icon={IconX} size={20} color={vc.text} />
          </Press>
        </View>
        {state === 'failed' || state === 'left' ? (
          <T size={14} color={vc.faint} style={[st.note, { paddingHorizontal: 16 }]}>
            {state === 'left' ? `“${title}” reloaded or tried to open another page, so it was closed.` : "Couldn't load the chart."}
          </T>
        ) : (
          <View style={{ flex: 1, paddingBottom: insets.bottom }}>
            <BridgeWebView target={src} scroll style={{ flex: 1 }} onLoaded={() => setState('shown')} onFail={() => setState('failed')} onLeave={() => setState('left')} />
            {state === 'loading' ? <View style={st.cover} pointerEvents="none"><Spinner style={{ paddingVertical: 0 }} /></View> : null}
          </View>
        )}
      </View>
    </Modal>
  )
}

const st = StyleSheet.create({
  // The web's .vc-visual: the reply's width plus 8px each side, the page's own 8px gutter inside.
  figure: { marginHorizontal: -8, alignSelf: 'stretch', minWidth: 0, overflow: 'hidden' },
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  open: { position: 'absolute', top: 8, right: 8, width: 30, height: 30, borderRadius: 8, borderWidth: 1, borderColor: vc.line, backgroundColor: vc.raise, alignItems: 'center', justifyContent: 'center', opacity: 0.9 },
  note: { paddingVertical: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 72, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 16, backgroundColor: vc.surface, borderWidth: 1, borderColor: vc.line },
  icon: { width: 40, height: 40, borderRadius: 10, backgroundColor: '#5b8cff1f', alignItems: 'center', justifyContent: 'center' },
  full: { flex: 1, backgroundColor: colors.bg },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 52, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: vc.line },
  close: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: vc.raise },
})
