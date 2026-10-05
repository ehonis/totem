// The icons a chat can wear. The title model reads the first message and picks
// one of these names alongside the title, the same way it picks the title, so
// the sidebar shows a bike beside "Plan Ohio Erie Canal Trip" and a receipt
// beside "Split Dinner Bill".
//
// Each name is a Tabler icon slug (`bike` → IconBike). This list is the one
// source of truth: `node scripts/build-thread-icons.mjs` writes the browser's
// per-icon imports from it (web/src/chat/threadIcons.gen.ts) and refuses a
// name Tabler doesn't have. Grouped only to make it easy to read and extend;
// the model sees one flat list.
export const THREAD_ICONS = [
  // Talk and writing
  'message', 'messages', 'bulb', 'question-mark', 'pencil', 'writing', 'notebook', 'book', 'books', 'news',
  'article', 'quote', 'language', 'mail', 'send', 'phone', 'speakerphone', 'microphone', 'clipboard-text', 'notes',
  // Planning and work
  'checklist', 'list-check', 'calendar', 'calendar-event', 'clock', 'alarm', 'hourglass', 'target', 'flag', 'trophy',
  'briefcase', 'building', 'building-store', 'presentation', 'chart-bar', 'chart-line', 'chart-pie', 'report-analytics', 'table', 'file-spreadsheet',
  'file-text', 'files', 'folder', 'archive', 'inbox', 'stack-2', 'adjustments', 'settings', 'tool', 'tools',
  'users', 'user', 'users-group', 'heart-handshake', 'school', 'certificate', 'gavel', 'scale', 'shield-check',
  // Money
  'coin', 'cash', 'credit-card', 'receipt', 'receipt-tax', 'pig-money', 'wallet', 'chart-candle', 'businessplan', 'shopping-cart',
  'shopping-bag', 'gift', 'tag', 'discount', 'building-bank', 'package', 'truck-delivery', 'diamond',
  // Code and tech
  'code', 'terminal-2', 'bug', 'git-branch', 'git-pull-request', 'brand-github', 'api', 'database', 'server', 'cloud',
  'cpu', 'device-desktop', 'device-laptop', 'device-mobile', 'device-tablet', 'device-watch', 'wifi', 'router', 'lock', 'key',
  'shield', 'robot', 'brain', 'headset', 'sparkles', 'wand', 'puzzle', 'plug', 'world', 'world-www', 'link',
  'photo', 'camera', 'video', 'movie', 'palette', 'brush', 'typography', 'layout', 'color-swatch', 'vector',
  // Health and fitness
  'bike', 'run', 'walk', 'barbell', 'swimming', 'yoga', 'stretching', 'trekking', 'mountain', 'ball-football',
  'ball-basketball', 'ball-tennis', 'golf', 'heartbeat', 'heart', 'stethoscope', 'pill', 'dental', 'eye', 'bed',
  'moon', 'zzz', 'scale-outline', 'apple', 'salad', 'droplet', 'mood-smile', 'mood-sad', 'leaf', 'flower',
  // Food and home
  'tools-kitchen-2', 'chef-hat', 'coffee', 'cup', 'beer', 'glass-full', 'pizza', 'cake', 'bread', 'egg',
  'fish', 'meat', 'carrot', 'home', 'sofa', 'armchair', 'bath', 'wash-machine', 'bulb-filled', 'plant',
  'plant-2', 'tree', 'shovel', 'hammer', 'paint', 'ruler', 'trash', 'recycle', 'dog', 'cat',
  'paw', 'baby-carriage', 'shirt', 'hanger',
  // Travel and getting around
  'plane', 'car', 'bus', 'train', 'ship', 'gas-station', 'map', 'map-pin', 'route', 'compass',
  'tent', 'beach', 'luggage', 'e-passport', 'building-skyscraper', 'road', 'parking', 'steering-wheel', 'motorbike', 'scooter',
  // Weather and nature
  'sun', 'cloud-rain', 'snowflake', 'umbrella', 'temperature', 'wind', 'flame', 'bolt', 'planet', 'telescope',
  // Fun and culture
  'music', 'headphones', 'guitar-pick', 'device-gamepad-2', 'dice', 'chess', 'confetti', 'balloon', 'ticket', 'masks-theater',
  'microphone-2', 'brand-youtube', 'brand-spotify', 'device-tv', 'book-2', 'pokeball', 'cards', 'puzzle-2',
  // Science and learning
  'flask', 'atom', 'dna', 'math', 'calculator', 'abacus', 'microscope', 'globe', 'history', 'infinity',
  // Misc
  'alert-triangle', 'info-circle', 'search', 'star', 'bookmark', 'pin', 'bell', 'calendar-heart', 'cake-roll', 'christmas-tree',
]

/** Tabler's component name for a slug: `tools-kitchen-2` → `IconToolsKitchen2`. */
export const tablerName = (slug) => 'Icon' + slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('')

const known = new Set(THREAD_ICONS)

/** A model's answer → one of THREAD_ICONS, or '' when it named something else. */
export function cleanIcon(raw) {
  const slug = String(raw || '').trim().toLowerCase()
    .replace(/^icon[\s:_-]*/, '').replace(/[`"'*.]/g, '').replace(/[\s_]+/g, '-')
  return known.has(slug) ? slug : ''
}

/** "Title: Plan Bike Trip\nIcon: bike" → { title, icon }; a bare first line still counts as the title. */
export function parseTitleReply(raw) {
  // Models dress the labels up (**Title:**); drop the asterisks before reading.
  const lines = String(raw || '').split('\n').map((l) => l.replace(/\*\*/g, '').trim()).filter(Boolean)
  const tagged = (key) => lines.find((l) => new RegExp(`^${key}\\s*:`, 'i').test(l))?.replace(/^[^:]*:\s*/, '')
  const title = (tagged('title') ?? lines.find((l) => !/^icon\s*:/i.test(l)) ?? '')
    .replace(/^["'“”*]+|["'“”.*]+$/g, '').trim().slice(0, 80)
  return { title, icon: cleanIcon(tagged('icon')) }
}
