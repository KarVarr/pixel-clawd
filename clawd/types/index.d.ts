export type Scene = 'shell' | 'thread' | 'confetti' | 'volcano' | 'error' | 'night' | 'rain' | 'matrix'
export type Anim = {
  tick: number
  active: boolean
  leave: number
  phrase: string
  scene: Scene
}

declare module 'claude-code' {
  interface PluginState {
    clawd: { anim: Anim; enabled: boolean }
  }
}
