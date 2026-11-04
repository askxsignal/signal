import './styles.css'
import { Orbit } from './space/engine'
import { App } from './app'
import { apiBackend } from './backend/api'
import { demoBackend } from './backend/demo'
import { boot } from './boot'

// VITE_BACKEND=api is set in netlify.toml for production builds. Everything else runs in DEMO mode.
const live = import.meta.env.VITE_BACKEND === 'api'
const backend = live ? apiBackend() : demoBackend()

const orbit = new Orbit(document.getElementById('sky') as HTMLCanvasElement)
orbit.start()
boot().then(() => new App(backend, orbit).start())

// For the curious: a hello in the console.
console.log(
  '%c\n      |\n   [==#==]=[####|####]\n      o\n\n%cyou opened the service panel. signal keeps a few secrets. ask it.\n',
  'font: 12px/1.2 monospace; color: #4f7d64',
  'font: 13px/1.5 monospace; color: #0b7a43',
)
