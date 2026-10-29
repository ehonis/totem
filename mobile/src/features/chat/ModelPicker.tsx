// Sheet detents: [0.5, 1] (formSheet, grabber, corner radius 22; registered in src/app/_layout.tsx).
//
// The composer's model chip and its picker (web chat/ModelPicker.tsx, after T3
// Code). The picker is the only way a chat chooses its account and model. On a
// phone it is a half sheet: the accounts across the top (favourites, then one
// logo and name per account, the default first), a search box, and the models
// as large rows with their source underneath, a star and a check on the current
// one. Models the Providers tab hides fold under "Legacy models", so nothing that
// can run is unreachable. Below the list sit the chosen model's thinking effort
// and the chat's access, the two dials the web keeps beside the chip.
import React, { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChat, ensureModels, providerById, toggleFavorite } from '../../lib/chat/store'
import { EFFORT_LABELS, settingsForPick, visibleModels } from '../../lib/chat/models'
import { handoffNote } from '../../lib/chat/handoff'
import type { Access, ModelRow, ModelSettings } from '../../lib/chat/types'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { ACCESS_MODES, hintFor } from './controls'
import { TI, ProviderLogo, vc } from './ui'
import { IconChevronDown, IconChevronRight, IconSearch, IconCheck, IconStar, IconStarFilled, IconX } from './icons'

type Tab = 'favorites' | string

interface Row {
  key: string
  provider: string
  model?: ModelRow
  title: string
  source: string
  sourceDriver?: string
  badge?: string
}

/** The sheet's own colour: one step above the chat, as iOS raises a sheet. */
const SHEET_BG = colors.bg2

export function chipLabel(settings: ModelSettings, provider: string, models: Record<string, ModelRow[]>) {
  const row = providerById(provider)
  const m = (models[provider] || []).find((x) => x.id === settings.modelId)
  return m?.name || row?.name || provider
}

// --- the request the sheet answers ----------------------------------------------------
// The sheet is its own route, so the chat hands it what to show and where the
// answer goes before pushing it.
export interface PickerRequest {
  provider: string
  settings: ModelSettings
  /** The chat has started: picking another account hands it over (lib/chat/handoff.ts). */
  started: boolean
  /** A started temporary chat: the bridge holds it to the default account. */
  locked?: boolean
  onChange: (patch: { provider: string; modelSettings: ModelSettings }) => void
}
let request: PickerRequest | null = null
export function openModelPicker(r: PickerRequest) {
  request = r
  tap()
  router.push('/chat/model')
}

/** The chip in the composer: the account's logo and the model's name. */
export function ModelChip({ provider, settings, onChange, started = false, locked = false }: PickerRequest) {
  const models = useChat((s) => s.models)
  const row = providerById(provider)
  const label = chipLabel(settings, provider, models)
  return (
    <Press
      onPress={() => openModelPicker({ provider, settings, started, locked, onChange })}
      accessibilityLabel={`Model: ${label}. Choose a model`}
      style={st.chip}
    >
      <ProviderLogo driver={row?.driver} name={row?.name} size={16} />
      <T size={14} color={vc.text} numberOfLines={1} style={{ flexShrink: 1 }}>{label}</T>
      <TI icon={IconChevronDown} size={14} color={vc.faint} />
    </Press>
  )
}

export default function ModelPickerSheet() {
  const req = request
  const insets = useSafeAreaInsets()
  const [settings, setSettings] = useState<ModelSettings | null>(req?.settings || null)
  const [provider, setProvider] = useState(req?.provider || '')
  const providers = useChat((s) => s.providers)
  const models = useChat((s) => s.models)
  const caps = useChat((s) => s.caps)
  const defaultProvider = useChat((s) => s.defaultProvider)
  const defaultModel = useChat((s) => s.defaultModel)
  const lockedTo: null | string = req?.locked ? provider : null
  const ordered = useMemo(() => [...providers]
    .sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0))
    .filter((p) => !lockedTo || p.id === lockedTo), [providers, lockedTo])
  const [tab, setTab] = useState<Tab>(() => (providerById(provider) ? provider : ordered[0]?.id || 'favorites'))
  const [q, setQ] = useState('')
  const [legacy, setLegacy] = useState(false)

  // Every account's catalogue, so favourites and search span all of them.
  useEffect(() => { for (const p of providers) ensureModels(p.id) }, [providers])

  if (!req || !settings) {
    // Reopened from a cold start with no chat behind it: nothing to choose for.
    return (
      <ScrollView style={{ backgroundColor: SHEET_BG }} contentContainerStyle={{ padding: 24 }}>
        <T muted>Open a chat to choose its model.</T>
      </ScrollView>
    )
  }

  function modelRows(pid: string, list: ModelRow[]): Row[] {
    const pr = providerById(pid)
    if (!pr) return []
    if (!pr.supportsModelPicker) return [{ key: `${pid}:default`, provider: pid, title: `${pr.name} default`, source: pr.name, sourceDriver: pr.driver }]
    const configured = pid === defaultProvider ? (defaultModel || '').split('[')[0] : ''
    return list.map((m) => ({
      key: `${pid}:${m.id}`, provider: pid, model: m, title: m.name || m.id, source: pr.name, sourceDriver: pr.driver,
      badge: m.id === configured ? 'Default' : m.recommended ? 'Recommended' : undefined,
    }))
  }

  const term = q.trim().toLowerCase()
  let rows: Row[] = []
  let legacyRows: Row[] = []
  if (term) {
    rows = ordered.flatMap((p) => modelRows(p.id, models[p.id] || [])).filter((r) => `${r.title} ${r.source} ${r.model?.id || ''}`.toLowerCase().includes(term))
  } else if (tab === 'favorites') {
    rows = ordered.flatMap((p) => modelRows(p.id, (models[p.id] || []).filter((m) => m.favorite)))
  } else {
    const all = models[tab] || []
    rows = modelRows(tab, visibleModels(all))
    legacyRows = modelRows(tab, all.filter((m) => m.hidden))
    if (!providerById(tab)?.supportsModelPicker) { rows = modelRows(tab, []); legacyRows = [] }
  }

  function apply(patch: { provider: string; modelSettings: ModelSettings }) {
    req!.onChange(patch)
    setProvider(patch.provider)
    setSettings(patch.modelSettings)
  }

  function choose(r: Row) {
    tap()
    // Picking a model builds its settings afresh; the chat's access stays.
    apply({ provider: r.provider, modelSettings: { ...settingsForPick(providerById(r.provider), r.model?.id, defaultProvider, defaultModel), ...(settings!.access ? { access: settings!.access } : {}) } })
    router.back()
  }

  const isCurrent = (r: Row) => r.provider === provider && (!r.model || r.model.id === settings.modelId)

  // The chosen model's own effort levels (web ThinkingControl), when it has any.
  const current = visibleModels(models[provider]).concat(models[provider] || []).find((x) => x.id === settings.modelId)
  const efforts = current?.efforts || []
  const effort = settings.effort && settings.effort !== 'default' ? settings.effort : (current?.defaultEffort || efforts[0])
  const access = ACCESS_MODES.find((m) => m.id === settings.access) || ACCESS_MODES[3]

  const renderRow = (r: Row) => {
    const on = isCurrent(r)
    return (
      <Press key={r.key} onPress={() => choose(r)} style={[st.row, on && st.rowOn]} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`${r.title}, ${r.source}${r.badge ? `, ${r.badge}` : ''}`}>
        <View style={st.check}>{on ? <TI icon={IconCheck} size={18} color={colors.accent} stroke={2.4} /> : null}</View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={st.rowTitle}>
            <T size={16} weight={on ? 600 : 500} numberOfLines={1} style={{ flexShrink: 1 }}>{r.title}</T>
            {r.badge ? <View style={st.badge}><T size={11} weight={500} color={vc.soft}>{r.badge}</T></View> : null}
          </View>
          <View style={st.rowSource}>
            <ProviderLogo driver={r.sourceDriver} name={r.source} size={13} />
            <T size={13} color={vc.faint} numberOfLines={1} style={{ flexShrink: 1 }}>{r.source}</T>
          </View>
          {r.model?.note ? <T size={12.5} lineHeight={17} color={vc.faint} numberOfLines={2}>{r.model.note}</T> : null}
        </View>
        {r.model ? (
          <Press
            hitSlop={6}
            onPress={() => { tap(); toggleFavorite(r.provider, r.model!.id) }}
            accessibilityLabel={r.model.favorite ? `Unstar ${r.title}` : `Star ${r.title}`}
            accessibilityState={{ selected: !!r.model.favorite }}
            style={st.star}
          >
            <TI icon={r.model.favorite ? IconStarFilled : IconStar} size={20} color={r.model.favorite ? colors.amber : vc.faint} />
          </Press>
        ) : null}
      </Press>
    )
  }

  const Source = ({ id, label, children }: { id: Tab; label: string; children: React.ReactNode }) => {
    const on = tab === id && !term
    const state = id === 'favorites' ? undefined : caps?.providers?.[id]?.state
    return (
      <Press
        onPress={() => { tap(); setTab(id); setQ(''); setLegacy(false) }}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        accessibilityLabel={label}
        style={[st.source, on && st.sourceOn, !!state && state !== 'ready' && state !== 'unknown' && { opacity: 0.45 }]}
      >
        {children}
      </Press>
    )
  }

  const empty = tab === 'favorites' && !term ? 'Star a model to keep it here.' : term ? `Nothing matches “${q}”.` : 'Loading models…'

  return (
    <ScrollView
      style={{ backgroundColor: SHEET_BG }}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      stickyHeaderIndices={[1]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <View style={st.head}>
        <T size={17} weight={600}>Model</T>
        <T size={13} color={vc.faint} numberOfLines={1} style={{ flexShrink: 1 }}>
          {providerById(provider)?.name || provider}
        </T>
      </View>

      {/* Accounts and search stay pinned while the models scroll under them. */}
      <View style={{ backgroundColor: SHEET_BG }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.sources} keyboardShouldPersistTaps="handled">
          <Source id="favorites" label="Favourites">
            <TI icon={IconStarFilled} size={17} color={colors.amber} />
            <T size={14} weight={500}>Favourites</T>
          </Source>
          {ordered.map((p) => (
            <Source key={p.id} id={p.id} label={p.name}>
              <ProviderLogo driver={p.driver} name={p.name} size={18} />
              <T size={14} weight={500} numberOfLines={1}>{p.name}</T>
            </Source>
          ))}
        </ScrollView>
        <View style={st.search}>
          <TI icon={IconSearch} size={17} color={vc.faint} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search models…"
            placeholderTextColor={vc.faint}
            keyboardAppearance="dark"
            selectionColor={colors.accent}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            accessibilityLabel="Search models"
            style={st.searchInput}
          />
          {q ? (
            <Press hitSlop={8} onPress={() => setQ('')} accessibilityLabel="Clear search" style={st.clear}>
              <TI icon={IconX} size={12} color={SHEET_BG} stroke={2.5} />
            </Press>
          ) : null}
        </View>
      </View>

      <View style={st.list}>
        {!rows.length ? <T size={14} color={vc.faint} style={{ paddingHorizontal: 16, paddingVertical: 18 }}>{empty}</T> : null}
        {rows.map(renderRow)}
        {!term && legacyRows.length > 0 ? (
          <Press onPress={() => { tap(); setLegacy((l) => !l) }} style={st.row} accessibilityState={{ expanded: legacy }}>
            <View style={st.check} />
            <View style={{ flex: 1, gap: 3 }}>
              <T size={16} weight={500}>Legacy models</T>
              <T size={13} color={vc.faint}>{legacyRows.length} model{legacyRows.length === 1 ? '' : 's'}</T>
            </View>
            <TI icon={IconChevronRight} size={17} color={vc.faint} style={legacy ? { transform: [{ rotate: '90deg' }] } : undefined} />
          </Press>
        ) : null}
        {legacy && !term ? legacyRows.map(renderRow) : null}
      </View>

      {lockedTo ? (
        <T size={12.5} lineHeight={18} color={vc.faint} style={st.lock}>
          {`A temporary chat stays on ${providerById(lockedTo)?.name || lockedTo}. Start a regular chat to use another account.`}
        </T>
      ) : req.started && provider !== req.provider ? (
        <T size={12.5} lineHeight={18} color={vc.faint} style={st.lock}>
          {handoffNote(providerById(req.provider)?.name || req.provider, providerById(provider)?.name || provider)}
        </T>
      ) : null}

      {efforts.length ? (
        <Section title="Thinking effort">
          {efforts.map((e) => (
            <Choice
              key={e}
              on={e === effort}
              title={EFFORT_LABELS[e] || e}
              hint={hintFor(e)}
              onPress={() => apply({ provider, modelSettings: { ...settings, effort: e } })}
            />
          ))}
        </Section>
      ) : null}

      <Section title="Access">
        {ACCESS_MODES.map((m) => (
          <Choice
            key={m.id}
            on={m.id === access.id}
            icon={m.icon}
            title={m.label}
            hint={m.hint}
            onPress={() => apply({ provider, modelSettings: { ...settings, access: m.id as Access } })}
          />
        ))}
      </Section>
    </ScrollView>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={st.section}>
      <T size={12.5} weight={600} color={vc.faint} style={st.sectionTitle}>{title.toUpperCase()}</T>
      <View style={st.group}>{children}</View>
    </View>
  )
}

/** One choice in a grouped list: its name, what it costs, a check when chosen. Stays open on tap. */
function Choice({ on, title, hint, icon, onPress }: { on: boolean; title: string; hint?: string; icon?: any; onPress: () => void }) {
  return (
    <Press onPress={() => { tap(); onPress() }} style={st.choice} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={hint ? `${title}. ${hint}` : title}>
      {icon ? <TI icon={icon} size={18} color={on ? colors.text : vc.soft} /> : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={15.5} weight={on ? 600 : 400}>{title}</T>
        {hint ? <T size={12.5} lineHeight={17} color={vc.faint}>{hint}</T> : null}
      </View>
      {on ? <TI icon={IconCheck} size={18} color={colors.accent} stroke={2.4} /> : null}
    </Press>
  )
}

const st = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, maxWidth: 170, paddingHorizontal: 8, borderRadius: 999, flexShrink: 1 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 4 },
  sources: { gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  source: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 14, borderRadius: 999,
    borderWidth: 1, borderColor: vc.line, backgroundColor: 'transparent', maxWidth: 220,
  },
  sourceOn: { backgroundColor: '#262a36', borderColor: '#3a4152' },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 8, height: 42, paddingHorizontal: 12,
    borderRadius: 12, backgroundColor: '#1d2029',
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 16, fontFamily: fonts[400], paddingVertical: 0 },
  clear: { width: 18, height: 18, borderRadius: 9, backgroundColor: vc.faint, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: 8, paddingTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 60, paddingVertical: 10, paddingLeft: 4, paddingRight: 6, borderRadius: 14 },
  rowOn: { backgroundColor: '#1f2330' },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowSource: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  check: { width: 28, alignItems: 'center' },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: vc.raise },
  star: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  lock: { marginHorizontal: 16, marginTop: 10, padding: 12, borderRadius: 12, backgroundColor: '#1a1d26', overflow: 'hidden' },
  section: { marginTop: 22, paddingHorizontal: 16 },
  sectionTitle: { letterSpacing: 0.4, marginBottom: 8, marginLeft: 4 },
  group: { borderRadius: 14, backgroundColor: '#1c1f28', overflow: 'hidden' },
  choice: {
    flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: vc.line,
  },
})
