// The web preview's conversation frame: the same list and dock without the
// keyboard integration (a desktop browser has no soft keyboard to ride).
// iOS never loads this file.
import React, { forwardRef, useImperativeHandle, useRef } from 'react'
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { LegendList, type LegendListRef } from '@legendapp/list/react-native'
import type { ChatFrameHandle, ChatFrameProps } from './ChatFrame'

function Frame<T>({ listKey, data, keyExtractor, renderItem, extraData, empty, dock, dockBottom, onAtEndChange }: ChatFrameProps<T>, ref: React.Ref<ChatFrameHandle>) {
  const listRef = useRef<LegendListRef>(null)
  const atEnd = useRef(true)
  useImperativeHandle(ref, () => ({ scrollToEnd: (animated = true) => { listRef.current?.scrollToEnd({ animated }) } }), [])
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    const next = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 80
    if (next !== atEnd.current) { atEnd.current = next; onAtEndChange?.(next) }
  }
  return (
    <View style={{ flex: 1 }}>
      {empty ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}>{empty}</ScrollView>
      ) : (
        <LegendList
          key={listKey}
          ref={listRef}
          data={data}
          extraData={extraData}
          keyExtractor={keyExtractor}
          renderItem={({ item, index }) => renderItem(item, index)}
          estimatedItemSize={160}
          alignItemsAtEnd
          initialScrollAtEnd
          maintainScrollAtEnd
          onScroll={onScroll}
          scrollEventThrottle={32}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: 12 }}
          style={{ flex: 1 }}
        />
      )}
      <View style={{ paddingBottom: dockBottom }}>{dock}</View>
    </View>
  )
}

export default forwardRef(Frame) as <T>(p: ChatFrameProps<T> & { ref?: React.Ref<ChatFrameHandle> }) => React.ReactElement
export type { ChatFrameHandle, ChatFrameProps }
