// The web preview's bridge page: react-native-webview has no web build, so the
// page is drawn the way the dashboard draws a chart (web/src/chat/VisualFrame.tsx),
// in a frame sandboxed to scripts only (no headers can be sent; the page must be
// signed), sized from the height the page posts. iOS never loads this file.
import React, { createElement, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { getConnection } from '../lib/connection'
import { bridgeSource } from '../lib/bridgePage'
import { readVisualMessage } from '../lib/chat/visuals'
import type { BridgeWebViewProps } from './BridgeWebView'

export default function BridgeWebView({ target, scroll = false, style, onHeight, onLoaded, onFail, onLeave }: BridgeWebViewProps) {
  const [source] = useState(() => bridgeSource(target, getConnection()))
  const frame = useRef<{ contentWindow: unknown } | null>(null)
  const loads = useRef(0)
  useEffect(() => { if (!source) onFail?.() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!onHeight) return
    const onMessage = (e: { source: unknown; data: unknown }) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const msg = readVisualMessage(e.data)
      if (msg?.kind === 'size') onHeight(msg.height)
    }
    const w = globalThis as unknown as { addEventListener: (t: string, f: (e: any) => void) => void; removeEventListener: (t: string, f: (e: any) => void) => void }
    w.addEventListener('message', onMessage)
    return () => w.removeEventListener('message', onMessage)
  }, [onHeight])
  if (!source) return null
  return (
    <View style={style}>
      {createElement('iframe', {
        ref: frame,
        src: source.uri,
        sandbox: 'allow-scripts',
        referrerPolicy: 'no-referrer',
        scrolling: scroll ? 'yes' : 'no',
        style: { border: 0, width: '100%', height: '100%', background: 'transparent', colorScheme: 'dark' },
        onLoad: () => { if (++loads.current > 1) onLeave?.(); else onLoaded?.() },
      })}
    </View>
  )
}
