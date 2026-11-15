// The conversation's scroller and the dock under it, keyboard-aware the way T3
// Code's ThreadDetailScreen is: a LegendList that ends in a spacer as tall as the
// composer, a composer that rides the keyboard (KeyboardStickyView),
// and the list lifting with the keyboard only while it is at the end (ChatGPT's
// behaviour; scrolled up to read, it stays put). While a reply streams the list
// stays pinned to the end, until a finger scrolls it away.
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { KeyboardAvoidingView, KeyboardStickyView } from 'react-native-keyboard-controller'
import { KeyboardAwareLegendList } from '@legendapp/list/keyboard'
import { LinearGradient } from 'expo-linear-gradient'
import type { LegendListRef } from '@legendapp/list/react-native'
import { useIsFocused } from 'expo-router'
import { setToastFloor } from '../../ui/toastFloor'
import { anchorAt } from '../../lib/chat/scrollMemory'

/** Where a chat opens: its end (following it), a message it was left on, or its top. */
export type OpenAt = { mode: 'end' } | { mode: 'anchor'; index: number; offset: number } | { mode: 'top' }

/** Where the owner is in the chat, as scrollMemory keeps it. */
export interface ChatPosition { atEnd: boolean; anchorId?: string; offset?: number }

// The dock's height as last measured: a chat opens with its end above the
// composer at once rather than a guessed 120 pt corrected a frame later.
let lastDockHeight = 120
// For this long after a chat opens at its end, a row measuring taller than its
// estimate pulls the list back to the end, so a miss never strands it short.
const SETTLE_MS = 1500

export interface ChatFrameHandle {
  scrollToEnd: (animated?: boolean) => void
  /** Bring one message into view (a search hit landing on it). */
  scrollToIndex: (index: number, animated?: boolean) => void
}

export interface ChatFrameProps<T> {
  data: T[]
  /** A new key remounts the list, so another chat opens at its end. */
  listKey?: string
  keyExtractor: (item: T) => string
  renderItem: (item: T, index: number) => React.ReactElement
  extraData?: unknown
  /** Shown instead of the list when there are no messages (the greeting). */
  empty: React.ReactNode | null
  /** The composer and what sits on it. Its height is the list's bottom inset. */
  dock: React.ReactNode
  /** How far the dock keeps off the bottom edge with the keyboard down. */
  dockBottom: number
  onAtEndChange?: (atEnd: boolean) => void
  /**
   * False while a search hit lands on an older message (src/lib/landing.ts): the list
   * opened at its end, and holding the end through an image or code block growing
   * the log would pull it back down from the message (the web's chat/follow.ts).
   */
  followEnd?: boolean
  /** Where to open (scrollMemory's restorePlan). Read once per `listKey`. */
  openAt?: OpenAt
  /** Above the first message: "Load earlier messages". */
  header?: React.ReactElement | null
  /** The owner moved (throttled): where he is now. */
  onPosition?: (p: ChatPosition) => void
}

function Frame<T>({ listKey, data, keyExtractor, renderItem, extraData, empty, dock, dockBottom, onAtEndChange, followEnd = true, openAt, header, onPosition }: ChatFrameProps<T>, ref: React.Ref<ChatFrameHandle>) {
  const listRef = useRef<LegendListRef>(null)
  // Where this chat opened, fixed for the list's life: a new listKey remounts it,
  // and so does the list taking over from the greeting or the loading state.
  const listShown = !empty
  const opened = useMemo<OpenAt>(() => openAt || { mode: 'end' }, [listKey, listShown]) // eslint-disable-line react-hooks/exhaustive-deps
  const atEnd = useRef(opened.mode === 'end')
  // Opened up in the chat: the end isn't held until he scrolls back down to it.
  const [holdEnd, setHoldEnd] = useState(opened.mode === 'end')
  useEffect(() => { setHoldEnd(opened.mode === 'end'); atEnd.current = opened.mode === 'end' }, [opened])
  const mountedAt = useRef(Date.now())
  const dragged = useRef(false)
  useEffect(() => { mountedAt.current = Date.now(); dragged.current = false }, [listKey, listShown])
  const [dockHeight, setDockHeight] = useState(lastDockHeight)
  useImperativeHandle(ref, () => ({
    scrollToEnd: (animated = true) => { listRef.current?.scrollToEnd({ animated }).catch?.(() => {}) },
    scrollToIndex: (index: number, animated = true) => { listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated })?.catch?.(() => {}) },
  }), [])
  // Toasts stack just above the dock, so they never cover the composer.
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    setToastFloor({ dock: dockHeight, lift: Math.max(0, dockBottom - 8) })
    return () => setToastFloor({ dock: 0, lift: 0 })
  }, [focused, dockHeight, dockBottom])

  const lastSaved = useRef(0)
  const report = (force = false) => {
    if (!onPosition || (!force && Date.now() - lastSaved.current < 250)) return
    lastSaved.current = Date.now()
    if (atEnd.current) { onPosition({ atEnd: true }); return }
    const ls = listRef.current?.getState?.()
    if (!ls) return
    const ids = data.map(keyExtractor)
    const a = anchorAt(ids, ls.start, ls.scroll, ls.positionAtIndex)
    if (a) onPosition({ atEnd: false, ...a })
  }
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement, contentInset } = e.nativeEvent
    const distance = contentSize.height + (contentInset?.bottom || 0) - (contentOffset.y + layoutMeasurement.height)
    const next = distance < 80
    if (next !== atEnd.current) {
      atEnd.current = next
      onAtEndChange?.(next)
      // Back at the end: follow it again, as a chat opened there does.
      if (next) { setHoldEnd(true); report(true); return }
    }
    if (dragged.current) report()
  }
  // A row measured: while the chat is still settling at its end, stay there.
  const onItemSizeChanged = () => {
    if (opened.mode !== 'end' || dragged.current || !followEnd || Date.now() - mountedAt.current > SETTLE_MS) return
    listRef.current?.scrollToEnd({ animated: false })?.catch?.(() => {})
  }
  // Opened on a message: once the real heights are in, put it back where it was.
  useEffect(() => {
    if (opened.mode !== 'anchor') return
    const again = () => { if (!dragged.current) listRef.current?.scrollToIndex({ index: opened.index, viewOffset: -opened.offset, animated: false })?.catch?.(() => {}) }
    const timers = [setTimeout(again, 120), setTimeout(again, 450), setTimeout(again, 1000)]
    return () => timers.forEach(clearTimeout)
  }, [opened])

  // One tree for both states, so the composer (and the keyboard) survive the first send.
  return (
    <View style={{ flex: 1 }}>
      {empty ? (
        // The greeting sits at the bottom, just above the composer, and lifts with the keyboard.
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', paddingBottom: dockHeight }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
            {empty}
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <KeyboardAwareLegendList
          key={listKey}
          ref={listRef}
          data={data}
          extraData={extraData}
          keyExtractor={keyExtractor}
          renderItem={({ item, index }: { item: T; index: number }) => renderItem(item, index)}
          estimatedItemSize={160}
          drawDistance={600}
          alignItemsAtEnd
          initialScrollAtEnd={opened.mode === 'end'}
          initialScrollIndex={opened.mode === 'anchor' ? { index: opened.index, viewOffset: -opened.offset } : undefined}
          maintainScrollAtEnd={followEnd && holdEnd ? MAINTAIN_END : false}
          // "Load earlier" puts older messages in front: the one on screen stays put.
          maintainVisibleContentPosition={KEEP_IN_PLACE}
          ListHeaderComponent={header || undefined}
          onItemSizeChanged={onItemSizeChanged}
          onScrollBeginDrag={() => { dragged.current = true }}
          onMomentumScrollEnd={() => report(true)}
          onScrollEndDrag={() => report(true)}
          keyboardLiftBehavior="whenAtEnd"
          // The composer floats over the list, so the list ends in room for it: the
          // last message stops just above the composer. (The library's composer
          // inset only extends the scroll range by how much the composer grows,
          // never by its own height, so the end sat underneath it.)
          ListFooterComponent={<View style={{ height: dockHeight + 12 }} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={onScroll}
          scrollEventThrottle={32}
          contentContainerStyle={{ paddingTop: 8 }}
          style={{ flex: 1 }}
        />
      )}
      <KeyboardStickyView
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        // Up with the keyboard, keeping 8 pt above it rather than the home-indicator gap.
        offset={{ closed: 0, opened: Math.max(0, dockBottom - 8) }}
      >
        <View
          onLayout={(e) => { const h = Math.round(e.nativeEvent.layout.height); lastDockHeight = h; setDockHeight(h) }}
          style={{ paddingBottom: dockBottom }}
        >
          {/* A scrim under the composer, so it stands off the chat's glow and the text behind it. */}
          <LinearGradient pointerEvents="none" colors={SCRIM} locations={[0, 0.4, 1]} style={st.scrim} />
          {dock}
        </View>
      </KeyboardStickyView>
    </View>
  )
}

const MAINTAIN_END = { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
const KEEP_IN_PLACE = { data: true }
const SCRIM = ['rgba(15, 17, 21, 0)', 'rgba(15, 17, 21, 0.74)', 'rgba(15, 17, 21, 0.94)'] as const
const st = { scrim: { position: 'absolute', left: 0, right: 0, top: -56, bottom: 0 } } as const

const Inner = forwardRef(Frame) as <T>(p: ChatFrameProps<T> & { ref?: React.Ref<ChatFrameHandle> }) => React.ReactElement

// The KeyboardProvider this needs is in the root layout.
export default forwardRef(function ChatFrame<T>(props: ChatFrameProps<T>, ref: React.Ref<ChatFrameHandle>) {
  return <Inner {...props} ref={ref} />
}) as <T>(p: ChatFrameProps<T> & { ref?: React.Ref<ChatFrameHandle> }) => React.ReactElement
