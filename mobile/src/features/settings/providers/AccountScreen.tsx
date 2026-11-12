// Settings → Providers › one account (web ProvidersView.tsx ProviderDetail): its
// name and accent, the sign-in command and a test, streaming, its models, and
// what runs on the box (binary, config directories, arguments, environment).
import React, { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import { ApiError, testAi } from '../../../lib/api'
import {
  Hi, ChevronDownIcon, ChevronRightIcon, ClipboardIcon, EllipsisHorizontalIcon,
  LockClosedIcon, PlusIcon, StarIcon, StarSolidIcon, TrashIcon, type IconType,
} from '../../../lib/icons'
import { plainError } from '../../../lib/sources/plainError'
import { driverAccent } from '../../../lib/providers'
import { alpha, colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Press } from '../../../ui/kit'
import { ProviderLogo } from '../../chat/ui'
import { MenuView } from '@react-native-menu/menu'
import { tap } from '../../../ui/haptics'
import {
  accountLine, ensureModels, loadProviders, modelActions, patchInstance, removeAccount, toggleStreaming, useProviders,
  type Model, type Provider,
} from '../providers/store'
import { Code, Field, Loading, Notice, PaneScroll, Pill, Row, Section, Switch, copy } from '../ui'

const ACCENT_SWATCHES = ['', '#d97757', '#5b8cff', '#40c463', '#e3b341', '#f0506e', '#7c5cff', '#2dd4bf']

// Codex and Claude Code publish a closed catalog, and the bridge drops any saved
// model outside it (resolveModelChoice in bridge.mjs), so they get no add box.
const CLOSED_CATALOG: Record<string, string> = {
  codex: 'Codex publishes its own catalog, so this list is whatever ChatGPT serves this account. Nothing else can be added or run.',
  claude: 'Claude Code has no model list command, so these are its aliases; each always resolves to the latest version of that model.',
}

/**
 * A text field that saves when it loses focus, not per keystroke (the bridge
 * re-reads the file every request). Return blurs a one-line field, so it saves
 * too, once: handling Return as well sent every edit twice.
 */
function DraftField({ value, placeholder, disabled, onCommit, mono = true, label }: {
  value: string
  placeholder?: string
  disabled?: boolean
  onCommit: (next: string) => void
  mono?: boolean
  label: string
}) {
  const [draft, setDraft] = useState(value || '')
  const focused = useRef(false)
  // Follow the server, except while being typed in: a save's answer must not undo newer typing.
  useEffect(() => { if (!focused.current) setDraft(value || '') }, [value])
  const commit = () => { focused.current = false; if (draft !== (value || '')) onCommit(draft) }
  return (
    <Field
      mono={mono}
      value={draft}
      placeholder={placeholder}
      editable={!disabled}
      accessibilityLabel={label}
      onChangeText={setDraft}
      onFocus={() => { focused.current = true }}
      onBlur={commit}
      returnKeyType="done"
      style={disabled ? { opacity: 0.55 } : undefined}
    />
  )
}

function IconButton({ icon, label, onPress, disabled, color = colors.muted }: { icon: IconType; label: string; onPress: () => void; disabled?: boolean; color?: string }) {
  return (
    <Press haptic onPress={onPress} disabled={disabled} hitSlop={6} accessibilityRole="button" accessibilityLabel={label} style={{ padding: 8 }}>
      <Hi icon={icon} size={17} color={color} />
    </Press>
  )
}

function Accents({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (hex: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }} accessibilityRole="radiogroup">
      {ACCENT_SWATCHES.map((hex) => {
        const on = (value || '') === hex
        return (
          <Press
            key={hex || 'none'}
            haptic
            disabled={disabled}
            onPress={() => onChange(hex)}
            hitSlop={7}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={hex ? `Accent ${hex}` : 'Use the provider colour'}
            style={{
              width: 30, height: 30, borderRadius: 15,
              backgroundColor: hex || 'transparent',
              borderWidth: on ? 2.5 : 1, borderColor: on ? colors.text : colors.line,
              borderStyle: hex ? 'solid' : 'dashed',
            }}
          />
        )
      })}
    </View>
  )
}

function Models({ provider, models, saving }: { provider: Provider; models?: Model[]; saving: boolean }) {
  const [draft, setDraft] = useState('')
  const closed = CLOSED_CATALOG[provider.driver]
  const count = models?.length || 0
  const shown = (models || []).filter((m) => !m.hidden).length
  return (
    <Section
      id="models"
      title="Models"
      description={models === undefined ? undefined : `${count} model${count === 1 ? '' : 's'}, ${shown} shown in the chat picker. A star pins one to the top.${closed ? ` ${closed}` : ''}`}
    >
      {models === undefined ? <Row title="Loading models…" /> : null}
      {models && !count ? <Row title={closed ? 'No models available' : 'No models yet'} description={closed ? 'Check this account is signed in.' : 'Add one below.'} /> : null}
      {(models || []).map((m, i) => (
        <Row
          key={m.id}
          title={<T size={15} weight={500} color={m.hidden ? colors.muted : undefined}>{m.name}</T>}
          accessibilityLabel={m.name}
          description={[m.id !== m.name ? m.id : '', m.recommended ? 'recommended' : '', m.current ? 'current' : '', m.custom ? 'custom' : '', m.hidden ? 'hidden from the picker' : ''].filter(Boolean).join(' · ') || undefined}
          control={
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <IconButton icon={m.favorite ? StarSolidIcon : StarIcon} color={m.favorite ? colors.amber : colors.muted} label={m.favorite ? `Unfavorite ${m.name}` : `Favorite ${m.name}`} disabled={saving} onPress={() => void modelActions.favorite(provider, m.id)} />
              {/* The rarer edits in one system menu, not four more buttons a thumb has to hit. */}
              <MenuView
                shouldOpenOnLongPress={false}
                themeVariant="dark"
                title={m.name}
                onPressAction={({ nativeEvent }) => {
                  tap()
                  if (nativeEvent.event === 'up') modelActions.move(provider, m.id, -1)
                  else if (nativeEvent.event === 'down') modelActions.move(provider, m.id, 1)
                  else if (nativeEvent.event === 'hide') void modelActions.hide(provider, m.id)
                  else if (nativeEvent.event === 'remove') void modelActions.remove(provider, m.id)
                }}
                actions={[
                  { id: 'up', title: 'Move up', attributes: i === 0 ? { disabled: true } : undefined },
                  { id: 'down', title: 'Move down', attributes: i === count - 1 ? { disabled: true } : undefined },
                  { id: 'hide', title: m.hidden ? 'Show in the chat picker' : 'Hide from the chat picker' },
                  ...(m.custom ? [{ id: 'remove', title: 'Remove', attributes: { destructive: true } }] : []),
                ]}
              >
                <View accessible accessibilityRole="button" accessibilityLabel={`More for ${m.name}`} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: saving ? 0.45 : 1 }}>
                  <Hi icon={EllipsisHorizontalIcon} size={18} color={colors.muted} />
                </View>
              </MenuView>
            </View>
          }
        />
      ))}
      {models && !closed ? (
        <Row
          title="Add a model"
          stacked
          control={
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Field style={{ flex: 1 }} mono value={draft} onChangeText={setDraft} placeholder="Model id, e.g. composer-2.5" editable={!saving} accessibilityLabel="Model id" returnKeyType="done"
                onSubmitEditing={() => { if (draft.trim()) { modelActions.add(provider, draft); setDraft('') } }} />
              <Btn icon={PlusIcon} title="Add" disabled={saving || !draft.trim()} onPress={() => { modelActions.add(provider, draft); setDraft('') }} />
            </View>
          }
        />
      ) : null}
    </Section>
  )
}

/**
 * Per-account environment. A variable marked sensitive is stored in the clear
 * like every other secret on this box, but the bridge stops sending its value
 * back, so an empty value here means "unchanged", not "cleared".
 */
function Environment({ env, disabled, onChange }: { env: any[]; disabled: boolean; onChange: (next: any[]) => void }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim())
  const add = () => {
    const key = name.trim()
    if (!valid) return
    onChange([...env.filter((v) => v.name !== key), { name: key, value, sensitive: false }])
    setName('')
    setValue('')
  }
  return (
    <Section id="environment" title="Environment" description={env.length ? 'A lock marks a value sensitive: the server stops sending it back here.' : 'No variables: the CLI inherits Totem’s own environment.'}>
      {env.map((v) => (
        <Row
          key={v.name}
          title={<T size={13.5} style={{ fontFamily: 'Menlo' }}>{v.name}</T>}
          accessibilityLabel={v.name}
          stacked
          control={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ flex: 1 }}>
                <DraftField
                  label={`${v.name} value`}
                  value={v.valueRedacted ? '' : v.value}
                  placeholder={v.valueRedacted ? 'hidden, type to replace' : 'value'}
                  disabled={disabled}
                  onCommit={(next) => onChange(env.map((x) => (x.name === v.name ? { ...x, value: next, valueRedacted: false } : x)))}
                />
              </View>
              <IconButton icon={LockClosedIcon} color={v.sensitive ? colors.accent : colors.muted} label={v.sensitive ? `Unmark ${v.name} sensitive` : `Mark ${v.name} sensitive`} disabled={disabled}
                onPress={() => onChange(env.map((x) => (x.name === v.name ? { ...x, sensitive: !x.sensitive } : x)))} />
              <IconButton icon={TrashIcon} color={colors.red} label={`Remove ${v.name}`} disabled={disabled} onPress={() => onChange(env.filter((x) => x.name !== v.name))} />
            </View>
          }
        />
      ))}
      {!disabled ? (
        <Row
          title="Add a variable"
          stacked
          control={
            <View style={{ gap: 8 }}>
              <Field mono value={name} onChangeText={(t) => setName(t.toUpperCase())} placeholder="VARIABLE_NAME" accessibilityLabel="Variable name" />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Field mono style={{ flex: 1 }} value={value} onChangeText={setValue} placeholder="value" accessibilityLabel="Variable value" returnKeyType="done" onSubmitEditing={add} />
                <Btn icon={PlusIcon} title="Add" disabled={!valid} onPress={add} />
              </View>
            </View>
          }
        />
      ) : null}
    </Section>
  )
}

function Detail({ provider }: { provider: Provider }) {
  const { saving, models } = useProviders()
  const [test, setTest] = useState<{ ok: boolean; ms: number; reply?: string; error?: string } | 'running' | null>(null)
  const [advanced, setAdvanced] = useState(false)
  useEffect(() => { setTest(null) }, [provider.id])
  useEffect(() => { if (provider.supportsModelPicker) ensureModels(provider.id) }, [provider.id, provider.supportsModelPicker])

  async function runTest() {
    setTest('running')
    try { setTest(await testAi(provider.id)) }
    catch (e: any) { setTest({ ok: false, ms: 0, error: e instanceof ApiError ? e.message : String(e?.message || e) }) }
  }

  const busy = saving === provider.id
  const isCodex = provider.driver === 'codex'
  // What runs on the box; the server only accepts changes with TOTEM_ALLOW_UI_EXEC_CONFIG.
  const locked = provider.execConfigEditable === false
  const patchConfig = (key: string, value: string) => patchInstance(provider, { config: { ...provider.config, [key]: value } })
  const accent = driverAccent(provider)

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20, paddingHorizontal: 4 }}>
        <View style={{ width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(accent, 0.16), borderWidth: 1, borderColor: alpha(accent, 0.4) }}>
          <ProviderLogo driver={provider.driver} name={provider.name} size={24} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <T size={18} weight={600} numberOfLines={1}>{provider.name}</T>
          <T size={12.5} muted numberOfLines={2}>{accountLine(provider)}</T>
          {provider.default || provider.streaming || !provider.ready ? (
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 3 }}>
              {provider.default ? <Pill label="Default" tone="ok" /> : null}
              {provider.streaming ? <Pill label="Streaming" /> : null}
              {!provider.ready ? <Pill label="Not ready" tone="warn" /> : null}
            </View>
          ) : null}
        </View>
      </View>

      <Section>
        <Row
          id="display-name"
          title="Display name"
          description="What this account is called in chats, totems and on the Usage page."
          stacked
          control={<DraftField label="Display name" mono={false} value={provider.name} placeholder={provider.cli} disabled={busy} onCommit={(next) => void patchInstance(provider, { displayName: next })} />}
        />
        <Row
          id="accent"
          title="Accent"
          description="Colours this account’s row, so two logins of one CLI are told apart at a glance."
          stacked
          control={<Accents value={provider.accentColor} disabled={busy} onChange={(hex) => void patchInstance(provider, { accentColor: hex })} />}
        />
        <Row
          id="sign-in"
          title="Sign-in"
          description={provider.authenticated === false
            ? 'Run this in a terminal on the server, then Test.'
            : 'Run this on the server to sign in again. Test sends one tiny prompt to see that it reaches its model.'}
          status={test && test !== 'running'
            ? <T size={12.5} lineHeight={17} color={test.ok ? colors.green : colors.red}>{test.ok ? `Test answered in ${(test.ms / 1000).toFixed(1)}s.` : `Test failed: ${plainError(test.error || test.reply) || 'no reply'}`}</T>
            : undefined}
          stacked
          control={
            <View style={{ gap: 8 }}>
              {provider.authCommand ? <Code>{provider.authCommand}</Code> : null}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {provider.authCommand ? <Btn compact icon={ClipboardIcon} title="Copy command" onPress={() => void copy(provider.authCommand, 'Sign-in command copied')} /> : null}
                <Btn compact title={test === 'running' ? 'Testing…' : 'Test'} loading={test === 'running'} disabled={!provider.installed} onPress={() => void runTest()} />
              </View>
            </View>
          }
        />
        {provider.supportsStreaming ? (
          <Row
            id="streaming"
            title="Streaming"
            description={provider.streaming ? 'Tokens and tool activity appear live in chat.' : 'Replies arrive in one block when finished.'}
            control={<Switch label={`Streaming for ${provider.name}`} value={!!provider.streaming} disabled={!provider.installed || busy} onChange={() => toggleStreaming(provider)} />}
          />
        ) : null}
      </Section>

      {provider.supportsModelPicker ? <Models provider={provider} models={models[provider.id]} saving={saving === `models:${provider.id}`} /> : null}

      {/* Rarely touched, and locked unless the server allows it. */}
      <Section>
        <Row
          id="runtime"
          title="Runtime and environment"
          description={locked ? 'Read-only' : 'Binary, config directory, arguments, variables'}
          onPress={() => setAdvanced((v) => !v)}
          accessory={<Hi icon={advanced ? ChevronDownIcon : ChevronRightIcon} size={15} color={colors.muted} strokeWidth={2} />}
        />
      </Section>
      {advanced ? (
        <>
          {locked ? (
            <Notice>
              Runtime and environment settings are read-only here. Edit data/provider-config.json on the box, or set TOTEM_ALLOW_UI_EXEC_CONFIG=true and restart Totem.
            </Notice>
          ) : null}
          <Section title="Runtime">
            <Row title="Binary path" description={`Path to the ${provider.cli} binary used by this account.`} stacked
              control={<DraftField label="Binary path" value={provider.config?.binaryPath} placeholder={provider.binaryPath || provider.cli} disabled={busy || locked} onCommit={(v) => void patchConfig('binaryPath', v)} />} />
            {/* Only Claude and Codex read a config directory Totem can point elsewhere. */}
            {provider.multiAccount ? (
              <Row
                title={isCodex ? 'CODEX_HOME path' : 'CLAUDE_CONFIG_DIR path'}
                description={isCodex
                  ? 'Shared Codex home. Sessions, skills and MCP servers live here and are shared by every Codex account.'
                  : 'This account’s own config directory, which makes it a separate login. Leave empty for the CLI default.'}
                stacked
                control={<DraftField label="Config directory" value={provider.config?.homePath} placeholder={provider.homes?.sharedHome || provider.homes?.configDir || '~'} disabled={busy || locked} onCommit={(v) => void patchConfig('homePath', v)} />}
              />
            ) : null}
            {isCodex ? (
              <Row
                title="Shadow home path"
                description={provider.isDefaultInstance
                  ? 'Optional. Leave empty and this account signs in to the shared home directly.'
                  : 'This account’s own Codex home. Keeps auth.json separate while everything else links back to the shared home.'}
                stacked
                control={<DraftField label="Shadow home path" value={provider.config?.shadowHomePath} placeholder={provider.isDefaultInstance ? 'none, uses the shared home' : '~/.codex-totem/work'} disabled={busy || locked} onCommit={(v) => void patchConfig('shadowHomePath', v)} />}
              />
            ) : null}
            <Row title="Launch arguments" description="Extra CLI arguments passed on every run of this account." stacked
              control={<DraftField label="Launch arguments" value={provider.config?.launchArgs} placeholder="e.g. --chrome" disabled={busy || locked} onCommit={(v) => void patchConfig('launchArgs', v)} />} />
            {provider.auth?.length ? (
              <Row title="Credentials" description="Where this account’s login is read from." stacked
                control={<Code>{provider.auth.map((a: any) => `${a.exists ? '✓' : '—'} ${String(a.path).replace(/^\/(home|Users)\/[^/]+/, '~')}`).join('\n')}</Code>} />
            ) : null}
          </Section>
          <Environment env={provider.env || []} disabled={busy || locked} onChange={(next) => void patchInstance(provider, { env: next })} />
        </>
      ) : null}

      {!provider.isDefaultInstance ? (
        <Section
          description={provider.default
            ? 'This is the default account. Make another account the default before removing it.'
            : 'Removing forgets the account here. Its config directory and login stay on disk.'}
        >
          <Row
            title="Remove account"
            tone="danger"
            icon={<Hi icon={TrashIcon} size={16} color={colors.red} />}
            disabled={busy || provider.default}
            onPress={() => { void removeAccount(provider).then((ok) => { if (ok) router.back() }) }}
          />
        </Section>
      ) : null}
    </>
  )
}

export default function ProviderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { data, error } = useProviders()
  useEffect(() => { if (!data) void loadProviders() }, [data])
  const provider = (data?.providers || []).find((p: Provider) => p.id === id) || null
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: provider?.name || 'Account' }} />
      <PaneScroll>
        {provider ? <Detail provider={provider} /> : <Loading error={data ? 'This account is no longer on the server.' : error || undefined} />}
      </PaneScroll>
    </View>
  )
}
