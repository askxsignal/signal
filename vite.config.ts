import { defineConfig, type Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// OG / twitter images need an absolute URL. On Netlify, URL is set at build time; SITE_URL wins for custom domains.
const siteUrl = (): Plugin => ({
  name: 'site-url',
  transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', (process.env.SITE_URL || process.env.URL || 'https://asksignal.chat').replace(/\/$/, '')),
})

// `npm run build` → normal multi-file build for Netlify.
// `npm run build:preview` → one self-contained HTML (demo backend) for quick previews.
export default defineConfig(({ mode }) => ({
  plugins: [siteUrl(), ...(mode === 'preview' ? [viteSingleFile()] : [])],
  build: { outDir: mode === 'preview' ? 'dist-preview' : 'dist', target: 'es2020' },
}))
