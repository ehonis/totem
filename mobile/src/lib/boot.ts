// Imported first by the root layout, before anything that touches storage.
//
// The modules ported from the web (chat store, settings, outbox) read and write
// localStorage synchronously, some at import time. expo-sqlite installs a real,
// persistent, synchronous localStorage, so that code runs here unchanged.
import 'expo-sqlite/localStorage/install'
