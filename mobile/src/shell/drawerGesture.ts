// The drawer's own pan gesture, kept so a swipeable row inside the drawer can
// block it: a chat row swiped left shows its actions instead of closing the
// drawer. The drawer hands its pan over through `configureGestureHandler`.
import type { PanGesture } from 'react-native-gesture-handler'

let pan: PanGesture | undefined

export function keepDrawerPan(gesture: PanGesture) {
  pan = gesture
  return gesture
}

export const drawerPan = () => pan
