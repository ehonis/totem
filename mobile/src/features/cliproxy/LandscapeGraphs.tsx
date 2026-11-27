// A pool's chart turned sideways, full screen: the long side of the phone for
// the time axis, a drag to walk the crosshair, two fingers to zoom and slide.
//
// The app is portrait-only (app.json), so nothing native rotates: the view is
// drawn a quarter turn round and the owner turns the phone to match. That keeps
// it a JavaScript change (an over-the-air update, no new build), and no other
// screen can end up sideways by accident. Which way it is turned is the owner's
// pick (the rotate button), kept on this phone; the safe areas follow it, so the
// Dynamic Island and the home bar stay clear on either side.
import React, { useEffect, useState } from 'react'
import { Modal, StyleSheet, View, useWindowDimensions } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import IconX from '@tabler/icons-react-native/dist/esm/icons/IconX.mjs'
import IconRotate2 from '@tabler/icons-react-native/dist/esm/icons/IconRotate2.mjs'
import { EVENT_KINDS, poolCardStats, poolHeadline, poolRangeText, shownFable, type PoolCardData } from '../../lib/cliproxy/pool/poolCards'
import { POOL_WINDOWS, type PoolWindow } from '../../lib/cliproxy/pool/poolSettings'
import { poolText } from '../../lib/cliproxy/pool/poolText'
import type { PoolChartMode } from '../../lib/cliproxy/pool/poolChartLayout'
import type { TimeView } from '../../lib/cliproxy/pool/poolZoom'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { PoolChart } from './PoolChart'
import { accentOf, CardLogo, Choice, CornerButton, FABLE_COLOR, RangeButtons } from './parts'
import type { PoolGraphs } from './QuotaGraphs'
import { turnedInsets, type Turn } from './chartGestures'

const { t } = poolText
const TURN_KEY = 'totem.quotaGraph.sideways'

function readTurn(): Turn {
  try {
    return globalThis.localStorage?.getItem(TURN_KEY) === 'right' ? -1 : 1
  } catch {
    return 1
  }
}

function writeTurn(turn: Turn) {
  try {
    globalThis.localStorage?.setItem(TURN_KEY, turn === -1 ? 'right' : 'left')
  } catch {
    // Storage blocked: the choice lasts while the app runs.
  }
}

export function LandscapeGraphs({ graphs, initial, onClose, onTouching }: { graphs: PoolGraphs; initial: PoolCardData['type']; onClose: () => void; onTouching: (on: boolean) => void }) {
  const { width: W, height: H } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const [turn, setTurn] = useState<Turn>(readTurn)
  const [type, setType] = useState(initial)
  const [plot, setPlot] = useState<{ width: number; height: number } | null>(null)
  // As many of the card's figures as fit between the pool switch and the range
  // buttons, whole: a value cut to "Fri 2:1…" says nothing. About 112 pt each;
  // zooming adds a button. (The title bar has no room to spare once the Dynamic
  // Island's and home bar's insets are taken, so the pool switch lives down here.)
  const [statsW, setStatsW] = useState(0)
  const { settings, cards, now, range, view, zoomed, history, patch } = graphs
  // Together or Separate changes which cards there are; stay on the same one where it still is.
  const card = cards.find((c) => c.type === type) ?? cards[0]
  useEffect(() => { if (card && card.type !== type) setType(card.type) }, [card, type])
  if (!card) return null

  const pad = turnedInsets(turn, insets)
  const { name, stats } = poolCardStats(card, { window: settings.window, now, historyLoading: history.status === 'loading' })
  const headline = poolHeadline(card.model)
  const fable = shownFable(card, settings)
  const flip = () => { tap(); const next: Turn = turn === 1 ? -1 : 1; setTurn(next); writeTurn(next) }
  const rangeText = poolRangeText({ window: settings.window, range, view, zoomed })

  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} supportedOrientations={['portrait']}>
      {/* A modal is its own native root: gestures need their own root view inside it. */}
      <GestureHandlerRootView style={st.root}>
        <View
          accessibilityViewIsModal
          style={[
            st.turned,
            {
              width: H,
              height: W,
              left: (W - H) / 2,
              top: (H - W) / 2,
              paddingLeft: pad.left + 8,
              paddingRight: pad.right + 8,
              paddingTop: pad.top + 8,
              paddingBottom: pad.bottom + 6,
              transform: [{ rotate: turn === 1 ? '90deg' : '-90deg' }],
            },
          ]}
        >
          <View style={st.bar}>
            <CornerButton icon={IconX} label="Close" onPress={onClose} />
            <View style={st.title}>
              <CardLogo card={card} size={16} />
              <T size={15} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>{name}</T>
              <T size={20} weight={600} style={st.num}>{headline.current}</T>
              <T size={12} muted numberOfLines={1}>{headline.of}</T>
            </View>
            <Choice<PoolWindow>
              label={t('quota_management.pool_window')}
              value={settings.window}
              onChange={(window) => patch({ window, offset: 0, zoom: null })}
              options={POOL_WINDOWS.map((value) => ({
                value,
                label: t(value === 'weekly' ? 'quota_management.pool_window_weekly' : value === 'five-hour' ? 'quota_management.pool_window_five_hour' : 'quota_management.pool_window_combined'),
              }))}
            />
            <Choice<PoolChartMode>
              label={t('quota_management.pool_view')}
              value={settings.mode}
              onChange={(mode) => patch({ mode })}
              options={[
                { value: 'remaining', label: t('quota_management.pool_mode_remaining') },
                { value: 'rate', label: t('quota_management.pool_mode_rate') },
              ]}
            />
            <CornerButton icon={IconRotate2} label="Turn the other way" onPress={flip} />
          </View>

          <View style={st.bar}>
            {cards.length > 1 ? (
              <Choice
                label="Pool"
                value={card.type}
                onChange={(v) => setType(v)}
                options={cards.map((c) => ({ value: c.type, label: c.type === 'claude' ? 'Claude' : c.type === 'codex' ? 'Codex' : t('quota_management.pool_all_providers') }))}
              />
            ) : null}
            <View style={st.stats} onLayout={(e) => setStatsW(e.nativeEvent.layout.width)}>
              {stats.slice(0, Math.max(1, Math.min(4, Math.floor(statsW / 112)))).map((s) => (
                <View key={s.label} style={st.stat}>
                  <T size={11} muted numberOfLines={1}>{s.label}</T>
                  <T size={12.5} numberOfLines={1} color={s.warn ? colors.amber : colors.text} style={st.num}>
                    {s.lead ? `${s.lead} ${s.value}` : s.value}
                  </T>
                </View>
              ))}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <T size={11.5} muted numberOfLines={1}>{rangeText}</T>
              <RangeButtons settings={settings} range={range} view={view} zoomed={zoomed} onChange={patch} compact />
            </View>
          </View>

          <View style={{ flex: 1 }} onLayout={(e) => setPlot({ width: Math.floor(e.nativeEvent.layout.width), height: Math.floor(e.nativeEvent.layout.height) })}>
            {plot && plot.height > 80 ? (
              <PoolChart
                model={card.model}
                mode={settings.mode}
                hourly={settings.window === 'five-hour'}
                startMs={view.startMs}
                endMs={view.endMs}
                bounds={range}
                onViewChange={(zoom: TimeView | null) => patch({ zoom })}
                now={now}
                showAccounts={settings.showAccounts}
                idle={graphs.idle}
                minResetLabel={settings.window === 'combined' ? card.model.capacity / 4 : 0}
                eventKinds={EVENT_KINDS[settings.window]}
                overlay={fable ? { label: 'Fable', model: fable } : null}
                accent={accentOf(card)}
                overlayAccent={FABLE_COLOR}
                width={plot.width}
                height={plot.height}
                scrub="drag"
                onTouching={onTouching}
                label={name}
              />
            ) : null}
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  turned: { position: 'absolute', gap: 8, backgroundColor: colors.bg },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  num: { fontVariant: ['tabular-nums'] },
  stats: { flex: 1, flexDirection: 'row', gap: 14 },
  stat: { flexShrink: 1, minWidth: 0, gap: 1 },
})
