import assert from 'node:assert/strict'
import test from 'node:test'

const quickPanels = await import('../quickPanels.ts').catch(() => null)

test('g u opens limits immediately and keeps the nested quick panels reachable', () => {
  assert.ok(quickPanels, 'quick-panel shortcut registry exists')
  if (!quickPanels) return

  const limits = quickPanels.QUICK_PANEL_SHORTCUTS.find(({ panel }) => panel === 'limits')
  assert.equal(limits?.command, 'quick-panel.limits')
  assert.equal(limits?.binding, 'u')
  assert.equal(limits?.chainable, true)
  assert.deepEqual(
    quickPanels.QUICK_PANEL_SHORTCUTS
      .filter(({ binding }) => binding.startsWith('u') && binding !== 'u')
      .map(({ command, binding }) => [command, binding]),
    [
      ['quick-panel.activity', 'ua'],
      ['quick-panel.repositories', 'ur'],
    ],
  )
})
