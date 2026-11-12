// Settings → Connections › Add a connection, as a sheet: the catalog apps not
// added yet (web CatalogFold/ConnectForm), and a custom server (web
// CustomConnectionForm). `?custom=1` opens on the custom form.
import React, { useEffect, useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AuthError, addMcpConnection, getMcpCatalog, getMcpSettings } from '../../../lib/api'
import { isRemote } from '../../../lib/connections/state'
import { Hi, ChevronDownIcon } from '../../../lib/icons'
import { pushSuccess } from '../../../lib/toast'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn } from '../../../ui/kit'
import { success } from '../../../ui/haptics'
import { Field, Loading, Note, Picker, Pill, Row, Section } from '../ui'
import { ConnectionIcon, errorText, splitCatalog } from './shared'

const AUTH_BADGE: Record<string, string> = { oauth: 'OAuth', apikey: 'API key', open: 'No auth', advanced: 'Setup' }

/** "KEY=value" lines as the {key, value} list the bridge takes for env and headers. */
function parsePairs(text = '') {
  return text.split('\n').map((line) => {
    const i = line.indexOf('=')
    return i < 0 ? null : { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }
  }).filter((p): p is { key: string; value: string } => !!p && !!p.key)
}

function Caret({ open }: { open: boolean }) {
  return <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Hi icon={ChevronDownIcon} size={15} color={colors.muted} /></View>
}

function Labelled({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 4 }}>
      <T size={12.5} muted>{label}</T>
      {children}
      {help ? <T size={11.5} muted lineHeight={16}>{help}</T> : null}
    </View>
  )
}

function CatalogRow({ app, open, busy, onOpen, onAdd }: { app: any; open: boolean; busy: boolean; onOpen: () => void; onAdd: (values: any) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => ({ url: app.url || '' }))
  const set = (k: string) => (v: string) => setValues((x) => ({ ...x, [k]: v }))
  return (
    <Row
      title={app.name}
      icon={<ConnectionIcon id={app.id} name={app.name} size={26} />}
      description={<T size={12.5} muted numberOfLines={open ? undefined : 2} lineHeight={17}>{app.description}</T>}
      onPress={onOpen}
      accessory={<><Pill label={AUTH_BADGE[app.auth] || 'Add'} /><Caret open={open} /></>}
    >
      {open ? (
        <View style={{ gap: 10 }}>
          {isRemote(app) ? (
            <Labelled label="Endpoint URL">
              <Field value={values.url || ''} onChangeText={set('url')} keyboardType="url" accessibilityLabel="Endpoint URL" />
            </Labelled>
          ) : null}
          {(app.fields || []).map((f: any) => (
            <Labelled key={f.key} label={f.label} help={f.help}>
              <Field value={values[f.key] || ''} onChangeText={set(f.key)} secureTextEntry={!!f.secret} placeholder={f.placeholder || ''} accessibilityLabel={f.label} />
            </Labelled>
          ))}
          <Btn kind="primary" title="Connect" loading={busy} style={{ alignSelf: 'flex-start' }} onPress={() => onAdd(values)} />
        </View>
      ) : null}
    </Row>
  )
}

const EMPTY = { id: '', name: '', transport: 'http', url: '', command: '', args: '', pairs: '' }

function CustomForm({ busy, onAdd }: { busy: boolean; onAdd: (custom: any) => void }) {
  const [form, setForm] = useState(EMPTY)
  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const http = form.transport === 'http'
  const submit = () => onAdd({
    id: form.id.trim(),
    name: form.name.trim() || form.id.trim(),
    transport: form.transport,
    url: http ? form.url.trim() : '',
    command: http ? '' : form.command.trim(),
    args: form.args.trim(),
    env: http ? [] : parsePairs(form.pairs),
    headers: http ? parsePairs(form.pairs) : [],
  })
  return (
    <Section
      id="custom"
      title="Custom MCP server"
      description="Any URL or local command. It joins the gateway like a catalog app."
      footer={<Btn kind="primary" title="Connect" disabled={!form.id.trim()} loading={busy} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={submit} />}
    >
      <Row title="ID" stacked description="Letters, numbers, dash, underscore. Used as the MCP server name.">
        <Field value={form.id} onChangeText={set('id')} placeholder="my-server" accessibilityLabel="ID" />
      </Row>
      <Row title="Display name" stacked>
        <Field value={form.name} onChangeText={set('name')} placeholder="My Server" autoCapitalize="words" accessibilityLabel="Display name" />
      </Row>
      <Row
        title="Transport"
        control={<Picker label="Transport" value={form.transport} onChange={set('transport')} options={[{ value: 'http', label: 'Remote (HTTP / SSE)' }, { value: 'stdio', label: 'Local (stdio command)' }]} />}
      />
      {http ? (
        <Row title="Endpoint URL" stacked>
          <Field value={form.url} onChangeText={set('url')} keyboardType="url" placeholder="https://mcp.example.com/mcp" accessibilityLabel="Endpoint URL" />
        </Row>
      ) : (
        <>
          <Row title="Command" stacked>
            <Field value={form.command} onChangeText={set('command')} placeholder="npx" mono accessibilityLabel="Command" />
          </Row>
          <Row title="Arguments" stacked>
            <Field value={form.args} onChangeText={set('args')} placeholder="-y @scope/mcp-server" mono accessibilityLabel="Arguments" />
          </Row>
        </>
      )}
      <Row title={http ? 'Headers' : 'Environment'} stacked description="KEY=value, one per line.">
        <Field value={form.pairs} onChangeText={set('pairs')} multiline mono placeholder={http ? 'Authorization=Bearer …' : 'API_KEY=…'} accessibilityLabel={http ? 'Headers' : 'Environment'} />
      </Row>
    </Section>
  )
}

export default function AddConnection() {
  const { custom } = useLocalSearchParams<{ custom?: string }>()
  const insets = useSafeAreaInsets()
  const [available, setAvailable] = useState<any[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    Promise.all([getMcpCatalog(), getMcpSettings({ verify: false })])
      .then(([cat, settings]) => setAvailable(splitCatalog(cat, settings).available))
      .catch((e) => { if (!(e instanceof AuthError)) setError(errorText(e)) })
  }, [])

  async function add(key: string, body: any, name: string) {
    setBusy(key); setError('')
    try {
      await addMcpConnection(body)
      success()
      pushSuccess(`Added ${name}. Sign in from its row if it asks.`)
      router.back()
    } catch (e) {
      if (!(e instanceof AuthError)) setError(errorText(e))
      setBusy(null)
    }
  }

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out: Record<string, any[]> = {}
    for (const app of available || []) {
      if (needle && !`${app.name} ${app.category} ${app.description}`.toLowerCase().includes(needle)) continue
      ;(out[app.category || 'Other'] ||= []).push(app)
    }
    return Object.entries(out).sort(([a], [b]) => a.localeCompare(b))
  }, [available, q])

  const customForm = <CustomForm busy={busy === 'custom'} onAdd={(c) => void add('custom', { custom: c }, c.name || c.id)} />

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg2 }}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 22, paddingBottom: insets.bottom + 28 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <T size={20} weight={600} style={{ marginBottom: 14, paddingHorizontal: 4 }} accessibilityRole="header">Add a connection</T>
      {error ? <Note text={error} error style={{ marginBottom: 10 }} /> : null}
      {custom === '1' ? customForm : null}
      {available === null ? <Loading error={error || undefined} /> : (
        <>
          <Field value={q} onChangeText={setQ} placeholder={`Filter ${available.length} apps`} returnKeyType="search" accessibilityLabel="Filter the catalog" style={{ marginBottom: 18 }} />
          {groups.map(([cat, apps]) => (
            <Section key={cat} title={cat}>
              {apps.map((app) => (
                <CatalogRow
                  key={app.id}
                  app={app}
                  open={open === app.id}
                  busy={busy === app.id}
                  onOpen={() => setOpen(open === app.id ? null : app.id)}
                  onAdd={(values) => void add(app.id, { id: app.id, values }, app.name)}
                />
              ))}
            </Section>
          ))}
          {!groups.length ? <T muted style={{ textAlign: 'center', paddingVertical: 18 }}>{available.length ? 'Nothing in the catalog matches. Add it as a custom server.' : 'Everything in the catalog is added.'}</T> : null}
        </>
      )}
      {custom === '1' ? null : customForm}
    </ScrollView>
  )
}
