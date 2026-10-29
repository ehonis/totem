// The chat's Tabler glyphs: everything lib/chat/icons.ts has (the web's set),
// plus the few only the app draws (camera, the picker's stars, the usage
// sheet's refresh). Deep imports, one file per icon, so the package tree-shakes.
export * from '../../lib/chat/icons'
export { default as IconCamera } from '@tabler/icons-react-native/dist/esm/icons/IconCamera.mjs'
export { default as IconStar } from '@tabler/icons-react-native/dist/esm/icons/IconStar.mjs'
export { default as IconStarFilled } from '@tabler/icons-react-native/dist/esm/icons/IconStarFilled.mjs'
export { default as IconAlarm } from '@tabler/icons-react-native/dist/esm/icons/IconAlarm.mjs'
