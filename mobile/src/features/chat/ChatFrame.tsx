// The conversation's scroller and the dock under it, keyboard-aware the way T3
// Code's ThreadDetailScreen is: a LegendList that ends in a spacer as tall as the
// composer, a composer that rides the keyboard (KeyboardStickyView),
// and the list lifting with the keyboard only while it is at the end (ChatGPT's
// behaviour; scrolled up to read, it stays put). While a reply streams the list
// stays pinned to the end, until a finger scrolls it away.
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { KeyboardAvoidingView, KeyboardStickyView } from 'react-native-keyboard-controller'
import { KeyboardAwareLegendList } from '@legendapp/list/keyboard'
import { LinearGradient } from 'expo-linear-gradient'
import type { LegendListRef } from '@legendapp/list/react-native'
import { useIsFocused } from 'expo-router'
import { setToastFloor } from '../../ui/toastFloor'

export interface ChatFrameHandle { scrollToEnd: (animated?: boolean) => void }

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
}

function Frame<T>({ listKey, data, keyExtractor, renderItem, extraData, empty, dock, dockBottom, onAtEndChange }: ChatFrameProps<T>, ref: React.Ref<ChatFrameHandle>) {
  const listRef = useRef<LegendListRef>(null)
  const atEnd = useRef(true)
  const [dockHeight, setDockHeight] = useState(120)
  useImperativeHandle(ref, () => ({ scrollToEnd: (animated = true) => { listRef.current?.scrollToEnd({ animated }).catch?.(() => {}) } }), [])
  // Toasts stack just above the dock, so they never cover the composer.
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    setToastFloor({ dock: dockHeight, lift: Math.max(0, dockBottom - 8) })
    return () => setToastFloor({ dock: 0, lift: 0 })
  }, [focused, dockHeight, dockBottom])

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement, contentInset } = e.nativeEvent
    const distance = contentSize.height + (contentInset?.bottom || 0) - (contentOffset.y + layoutMeasurement.height)
    const next = distance < 80
    if (next !== atEnd.current) { atEnd.current = next; onAtEndChange?.(next) }
  }

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
          initialScrollAtEnd
          maintainScrollAtEnd={{ animated: false, on: { dataChange: true, itemLayout: true, layout: true } }}
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
          onLayout={(e) => setDockHeight(Math.round(e.nativeEvent.layout.height))}
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

const SCRIM = ['rgba(15, 17, 21, 0)', 'rgba(15, 17, 21, 0.74)', 'rgba(15, 17, 21, 0.94)'] as const
const st = { scrim: { position: 'absolute', left: 0, right: 0, top: -56, bottom: 0 } } as const

const Inner = forwardRef(Frame) as <T>(p: ChatFrameProps<T> & { ref?: React.Ref<ChatFrameHandle> }) => React.ReactElement

// The KeyboardProvider this needs is in the root layout.
export default forwardRef(function ChatFrame<T>(props: ChatFrameProps<T>, ref: React.Ref<ChatFrameHandle>) {
  return <Inner {...props} ref={ref} />
}) as <T>(p: ChatFrameProps<T> & { ref?: React.Ref<ChatFrameHandle> }) => React.ReactElement
