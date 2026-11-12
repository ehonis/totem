// The app's entry. The notification background task has to be defined before
// anything else runs, because a silent push launches the bundle headless, with
// no screen mounted (src/shell/pushDismiss.ts).
import './src/shell/pushDismiss'
// Storage before the router: theme.ts reads the chosen background when the screens import it.
import './src/lib/boot'
import 'expo-router/entry'
