import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Teaches the hand-written service worker about this build's output.
 *
 * Vite emits hashed filenames, which public/sw.js cannot know in advance. On a
 * first visit the page's own assets are requested before the worker is
 * controlling the page, so runtime caching alone would leave a duka owner with
 * a blank screen the first time they open the app with no network. Injecting
 * the emitted file list means one online visit is enough to be fully offline
 * capable, and the content hash doubles as the cache version so a deploy
 * retires the old caches.
 */
function serviceWorkerPrecache() {
  return {
    name: 'biashara-sw-precache',
    apply: 'build',
    async writeBundle(options, bundle) {
      const assets = Object.keys(bundle)
        .filter((file) => file !== 'sw.js')
        .map((file) => `/${file}`)
        .sort()

      const swPath = join(options.dir, 'sw.js')
      let source
      try {
        source = await readFile(swPath, 'utf8')
      } catch {
        this.warn('sw.js not found in the build output; skipping precache injection')
        return
      }

      const version = createHash('sha256').update(assets.join('|')).digest('hex').slice(0, 12)

      const injected = source
        .replace('self.__PRECACHE_ASSETS__ = []', `self.__PRECACHE_ASSETS__ = ${JSON.stringify(assets)}`)
        .replace("const VERSION = 'dev'", `const VERSION = '${version}'`)

      await writeFile(swPath, injected)
      console.log(`  sw.js precache: ${assets.length} asset(s), cache version ${version}`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), serviceWorkerPrecache()],
})
