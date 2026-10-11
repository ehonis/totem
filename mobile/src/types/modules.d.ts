// Tabler is imported deep and per icon (one file each, a default export) so the
// 6,000-icon package never lands in the bundle whole. The package only types its root.
declare module '@tabler/icons-react-native/dist/esm/icons/*.mjs' {
  import type { ComponentType } from 'react'
  import type { ColorValue, StyleProp, ViewStyle } from 'react-native'
  const Icon: ComponentType<{ size?: number; color?: ColorValue; strokeWidth?: number; fill?: ColorValue; style?: StyleProp<ViewStyle> }>
  export default Icon
}
