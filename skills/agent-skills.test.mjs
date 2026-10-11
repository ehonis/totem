import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSkillCatalog, defaultSkillRoots, findMentions, parseAgentSkill, skillMentionBlock } from './agent-skills.mjs'

async function skill(root, rel, text) {
  await mkdir(join(root, rel), { recursive: true })
  await writeFile(join(root, rel, 'SKILL.md'), text)
}

test('parses quoted, folded and literal descriptions', () => {
  assert.equal(parseAgentSkill('---\nname: a\ndescription: "say \\"hi\\""\n---\nbody').meta.description, 'say "hi"')
  const folded = parseAgentSkill('---\nname: b\ndescription: >\n  one\n  two\nother: x\n---\n\nBody here')
  assert.equal(folded.meta.description, 'one two')
  assert.equal(folded.meta.other, 'x')
  assert.equal(folded.body, 'Body here')
  assert.equal(parseAgentSkill('---\ndescription: |\n  l1\n  l2\n---\n').meta.description, 'l1\nl2')
  assert.deepEqual(parseAgentSkill('no frontmatter').meta, {})
})

test('finds skills across roots, nested and symlinked; first root wins a name', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-skills-'))
  const claude = join(base, 'claude'), codex = join(base, 'codex'), repo = join(base, 'repo')
  await skill(repo, 'grilling', '---\nname: grilling\ndescription: Grill the plan.\n---\nAsk hard questions.')
  await mkdir(claude, { recursive: true })
  await symlink(join(repo, 'grilling'), join(claude, 'grilling'))
  await skill(claude, 'synced/bucket/pdf', '---\nname: pdf\ndescription: PDFs.\n---\nRead PDFs.')
  await skill(claude, '.trash/old', '---\nname: old\n---\ngone')
  await skill(codex, 'grilling', '---\nname: grilling\ndescription: Codex copy.\n---\nOther.')
  await skill(codex, 'wrangler', '---\ndescription: CLI.\n---\nUse wrangler.')

  const cat = createAgentSkillCatalog({ roots: [{ dir: claude, source: 'Claude Code' }, { dir: codex, source: 'Codex' }, { dir: join(base, 'missing'), source: 'X' }] })
  const list = await cat.list()
  assert.deepEqual(list.map((s) => [s.slug, s.source]), [['grilling', 'Claude Code'], ['pdf', 'Claude Code'], ['wrangler', 'Codex']])
  assert.equal(list[0].command, '/grilling')
  assert.equal(list[0].body, undefined, 'the list leaves bodies out')
  assert.equal((await cat.get('grilling')).body, 'Ask hard questions.')
  assert.equal(await cat.get('old'), null)
})

test('roots honour CLAUDE_CONFIG_DIR, CODEX_HOME and AGENT_SKILL_DIRS', () => {
  const roots = defaultSkillRoots({ env: { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x', AGENT_SKILL_DIRS: '/a:/b' }, home: '/h', cwd: '/w' })
  assert.deepEqual(roots.slice(0, 4).map((r) => r.dir), ['/a', '/b', '/c/skills', '/x/skills'])
  assert.ok(roots.some((r) => r.dir === '/w/.claude/skills'))
})

test('mentions: anywhere in the text, never a path', () => {
  assert.deepEqual(findMentions('/grilling this, then use $morning and (/pdf). /grilling again'), [
    { prefix: '/', name: 'grilling' }, { prefix: '$', name: 'morning' }, { prefix: '/', name: 'pdf' },
  ])
  assert.deepEqual(findMentions('see /home/owner/x and and/or, a/b'), [])
})

test('the prompt block carries each skill and says the message leads', () => {
  assert.equal(skillMentionBlock([]), '')
  const block = skillMentionBlock([{ name: 'grilling', source: 'Claude Code', path: '/s/grilling/SKILL.md', body: 'Ask hard questions.' }], { owner: 'Sam' })
  assert.match(block, /^Sam cited a skill/)
  assert.match(block, /<skill name="grilling" source="Claude Code" path="\/s\/grilling\/SKILL.md">\nAsk hard questions.\n<\/skill>/)
  assert.match(block, /take precedence/)
})
