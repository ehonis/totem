// A page the bridge serves, drawn in a WebView with the app's credentials and
// nothing else (rules in lib/bridgePage.ts). Charts in replies use it
// (features/chat/VisualCard.tsx); so can any screen that shows a bridge page.
//
// - `target` is a bridge path or URL; anything off the bridge renders nothing and
//   calls onFail, so no credential is built for another site.
// - The Cloudflare Access token rides the first request only, as the source's headers (a page's script cannot read
//   request headers). The source is built once per mount: a re-render, a new
//   `target` or a refreshed token never reloads it; remount (a `key`) to retry.
// - `incognito` (a non-persistent data store): whatever cookie Access sets lives
//   only as long as this view and never reaches the app's cookie jar. No shared or
//   third-party cookies, no cache, no link previews, data detectors or file access.
// - No script unless `onHeight` is given; then one script reports the page's
//   height. The only message read is that height.
// - Every navigation reaches bridgeNavigation (originWhitelist '*', or the library
//   would hand any other scheme to Linking.openURL before asking): the source URL
//   loads once; a redirect before it has loaded is a failure, and the source URL
//   again (a reload, even mid-parse) or any page after it closes the view.
// - A link opens through window.open, which WebKit allows only on a tap, in the
//   in-app browser, and only to another site.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { ShouldStartLoadRequest, WebViewOpenWindowEvent } from 'react-native-webview/lib/WebViewTypes'
import * as WebBrowser from 'expo-web-browser'
import { getConnection } from '../lib/connection'
import { PAGE_HEIGHT_SCRIPT, bridgeNavigation, bridgeSource, linkOpensOutside, pageHeightFrom, type NavPhase } from '../lib/bridgePage'
import { colors } from '../theme'

export type BridgeWebViewProps = {
  /** A bridge path ("/api/…") or an absolute URL under the bridge's base. Read once per mount. */
  target: string
  /** Scroll inside the view. Off for a view fitted to its page's height. */
  scroll?: boolean
  style?: StyleProp<ViewStyle>
  /** The page's height as it changes (80–8,000 px). Given, a measuring script is injected. */
  onHeight?: (height: number) => void
  onLoaded?: () => void
  /** The page could not load: off the bridge, an HTTP error, a redirect, a crashed web process. */
  onFail?: () => void
  /** The page reloaded itself or tried to go to another page, and was stopped. */
  onLeave?: () => void
}

export default function BridgeWebView({ target, scroll = false, style, onHeight, onLoaded, onFail, onLeave }: BridgeWebViewProps) {
  const [source] = useState(() => bridgeSource(target, getConnection()))
  const phase = useRef<NavPhase>('new')
  const ended = useRef(false)
  const end = useCallback((then?: () => void) => { if (!ended.current) { ended.current = true; then?.() } }, [])
  const src = source?.uri || ''

  const onShouldStart = useCallback((req: ShouldStartLoadRequest) => {
    const decision = bridgeNavigation(req, src, phase.current)
    if (decision === 'allow' && phase.current === 'new' && req.isTopFrame !== false) phase.current = 'loading'
    if (decision === 'fail') end(onFail)
    else if (decision === 'leave') end(onLeave)
    return decision === 'allow'
  }, [src, end, onFail, onLeave])

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    const h = pageHeightFrom(e.nativeEvent.data)
    if (h != null) onHeight?.(h)
  }, [onHeight])

  const onOpenWindow = useCallback((e: WebViewOpenWindowEvent) => {
    const url = e.nativeEvent.targetUrl
    if (linkOpensOutside(url, getConnection().baseUrl)) WebBrowser.openBrowserAsync(url, { controlsColor: colors.accent }).catch(() => {})
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the source built at mount
  useEffect(() => { if (!source) end(onFail) }, [])
  if (!source) return null

  return (
    <WebView
      source={source}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={onShouldStart}
      onLoadEnd={(e) => { if (phase.current !== 'loaded' && !ended.current && !e.nativeEvent.loading) { phase.current = 'loaded'; onLoaded?.() } }}
      onError={() => end(onFail)}
      onHttpError={() => { if (phase.current !== 'loaded') end(onFail) }}
      onContentProcessDidTerminate={() => end(onFail)}
      {...(onHeight ? { onMessage, injectedJavaScript: PAGE_HEIGHT_SCRIPT, injectedJavaScriptForMainFrameOnly: true } : {})}
      onOpenWindow={onOpenWindow}
      javaScriptCanOpenWindowsAutomatically={false}
      incognito
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      allowsLinkPreview={false}
      allowsBackForwardNavigationGestures={false}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction
      dataDetectorTypes="none"
      allowFileAccess={false}
      scrollEnabled={scroll}
      bounces={scroll}
      showsVerticalScrollIndicator={scroll}
      showsHorizontalScrollIndicator={false}
      overScrollMode="never"
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      opaque={false}
      style={[st.view, style]}
      containerStyle={st.container}
    />
  )
}

const st = StyleSheet.create({
  view: { backgroundColor: 'transparent' },
  container: { backgroundColor: 'transparent' },
})
