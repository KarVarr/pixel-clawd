import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Anim, Scene } from '../types'

const anim = atom(
  { plugin: 'clawd', key: 'anim' } as const,
  { tick: 0, active: false, leave: 0, phrase: '', scene: 'thread' } as Anim,
)
const enabled = atom({ plugin: 'clawd', key: 'enabled' } as const, true)

const ROWS = 8
const PX = ROWS * 2
const SPRITE_W = 14
const SPRITE_H = 7
const MIN_COLUMNS = 34
const DESKTOP_COLUMNS = 80
const SWAP_TICKS = 10 // 10 ticks of 200 ms: a new phrase or scene at most every 2 s
const HOLD_ERROR_TICKS = 25
const NONE = -1
const DEFAULT = 0x01000000
const ORANGE = 0xd97757
const DARK = 0x2b1410

const LABELS: Record<Scene, string> = {
  shell: 'shell',
  thread: 'thread',
  confetti: 'patch',
  volcano: 'agent',
  error: 'error backoff',
  night: 'read',
  rain: 'web',
  matrix: 'search',
}

const hash = (n: number) => {
  let x = (n * 2654435761) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 2246822519) >>> 0
  return (x ^ (x >>> 13)) >>> 0
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const base = (p: unknown) => String(p ?? '').split(/[\\/]/).pop() || 'файл'

const sceneOf = (tool: string): Scene => {
  if (tool === 'Bash' || tool === 'PowerShell') return 'shell'
  if (tool === 'Read') return 'night'
  if (tool === 'Grep' || tool === 'Glob') return 'matrix'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'rain'
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'confetti'
  if (tool === 'Agent' || tool === 'Task' || tool.startsWith('mcp__')) return 'volcano'
  return 'thread'
}

const COMMANDS: [RegExp, string][] = [
  [/\b(jest|vitest|pytest|mocha)\b|\b(npm|pnpm|yarn) (run )?test\b|\bplugin test\b/, 'Гоняю тесты'],
  [/\bplugin validate\b/, 'Проверяю плагин'],
  [/\bgit commit\b/, 'Делаю коммит'],
  [/\bgit push\b/, 'Отправляю изменения'],
  [/\bgit (status|diff|log|show)\b/, 'Смотрю историю git'],
  [/\b(npm|pnpm|yarn|pip) (i|install|add)\b/, 'Ставлю зависимости'],
  [/\b(tsc|webpack|esbuild)\b|\b(npm|pnpm|yarn) run build\b|\bvite build\b/, 'Собираю проект'],
  [/\b(eslint|prettier|lint)\b/, 'Проверяю стиль кода'],
  [/\b(curl|wget)\b/, 'Качаю данные'],
  [/\b(mkdir|rm|mv|cp)\b/, 'Навожу порядок в файлах'],
  [/\b(ls|dir|cat|head|tail|find|tree)\b/, 'Смотрю, что лежит в папках'],
]

// text from the event when the API gives it, a canned phrase per tool type otherwise
const phraseOf = (e: any): string => {
  const tool = String(e.tool)
  const first = (s: unknown) => String(s ?? '').split('\n')[0].trim()
  let text: string
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = first(e.command)
    const known = COMMANDS.find(([re]) => re.test(String(e.command ?? '')))
    text = known ? known[1] : first(e.description) || (cmd ? '$ ' + cmd : 'Запускаю команду')
  } else if (tool === 'Read') text = 'Читаю ' + base(e.file_path)
  else if (tool === 'Edit' || tool === 'MultiEdit') text = 'Правлю ' + base(e.file_path)
  else if (tool === 'Write') text = 'Создаю ' + base(e.file_path)
  else if (tool === 'NotebookEdit') text = 'Правлю ноутбук'
  else if (tool === 'Grep') text = first(e.pattern) ? `Ищу «${first(e.pattern)}»` : 'Ищу по коду'
  else if (tool === 'Glob') text = first(e.pattern) ? `Ищу файлы ${first(e.pattern)}` : 'Ищу файлы'
  else if (tool === 'WebSearch') text = first(e.query) ? `Гуглю «${first(e.query)}»` : 'Ищу в сети'
  else if (tool === 'WebFetch') text = 'Открываю ' + (/^https?:\/\/([^/]+)/.exec(first(e.url))?.[1] ?? 'страницу')
  else if (tool === 'Agent' || tool === 'Task') text = first(e.description) || 'Зову помощника'
  else text = 'Работаю: ' + tool.replace(/^mcp__/, '').replace(/__/g, ' / ')
  return clip(text, 60)
}

type Canvas = {
  w: number
  px: number[]
  ch: string[]
  fg: number[]
  bg: number[]
  occ: boolean[]
}

const newCanvas = (w: number): Canvas => ({
  w,
  px: new Array(w * PX).fill(NONE),
  ch: new Array(w * ROWS).fill(''),
  fg: new Array(w * ROWS).fill(DEFAULT),
  bg: new Array(w * ROWS).fill(NONE),
  occ: new Array(w * ROWS).fill(false),
})

const dot = (c: Canvas, x: number, y: number, color: number) => {
  if (x >= 0 && x < c.w && y >= 0 && y < PX) c.px[y * c.w + x] = color
}

// a glyph on empty ground; `force` paints over anything (the bubble)
const put = (c: Canvas, x: number, r: number, ch: string, fg: number, bg = NONE, force = false) => {
  if (x < 0 || x >= c.w || r < 0 || r >= ROWS) return
  const i = r * c.w + x
  if (!force && c.occ[i]) return
  c.ch[i] = ch
  c.fg[i] = fg
  c.bg[i] = bg
}

const write = (c: Canvas, x: number, r: number, s: string, fg: number, bg = NONE, force = false) => {
  for (let i = 0; i < s.length; i++) put(c, x + i, r, s[i], fg, bg, force)
}

const frame = (c: Canvas, x: number, r: number, w: number, h: number, label: string, color: number) => {
  if (x < 0 || x + w > c.w) return
  write(c, x, r, '┌' + '─'.repeat(w - 2) + '┐', color)
  write(c, x + 1, r, label, color)
  for (let i = 1; i < h - 1; i++) {
    put(c, x, r + i, '│', color)
    put(c, x + w - 1, r + i, '│', color)
  }
  write(c, x, r + h - 1, '└' + '─'.repeat(w - 2) + '┘', color)
}

const waves = (c: Canvas, tick: number, top: number, bottom: number) => {
  for (let x = 0; x < c.w; x++) {
    const h = 1 + Math.round(1.2 * (1 + Math.sin((x + tick) * 0.45)))
    for (let k = 0; k < h; k++) dot(c, x, bottom - k, k === h - 1 ? top : 0x3f86a8)
  }
}

const drawScene = (c: Canvas, scene: Scene, tick: number) => {
  const w = c.w
  if (scene === 'shell') {
    const palette = [0x2f6f8a, 0x2a8f8f, 0x2b4f9c, 0x3a9a9a]
    for (let i = 0; i < Math.floor(w / 3); i++) {
      const x = (hash(i) % w + (tick >> 1) * (1 + (i % 2))) % w
      dot(c, x, 3 + (hash(i + 99) % 9), palette[i % 4])
    }
    waves(c, tick, 0x5aa6c4, PX - 1)
    for (let i = 0; i < 6; i++) {
      const x = (hash(i + 7) % w + (tick >> 2)) % w
      const r = 6 - ((tick >> 1) + i * 2) % 6
      put(c, x, r, ['o', '°', '.'][i % 3], 0x9fd8f0)
    }
  } else if (scene === 'thread') {
    const palette = [0x4a3f9a, 0x3a4aa8, 0x5b3f8f, 0x2f3f8a]
    for (let i = 0; i < Math.floor(w * 0.9); i++) {
      const x = (hash(i) % w + (tick >> 2)) % w
      dot(c, x, hash(i + 31) % (PX - 2), palette[i % 4])
    }
    for (let x = 0; x < Math.floor(w * 0.75); x++) dot(c, x, PX - 1, 0x7a6fa8)
  } else if (scene === 'confetti') {
    const palette = [0x6a4fd0, 0x3f7fe0, 0xd05f9a, 0x2fb0a0, 0xe0b040, 0x8f5fe0]
    const seed = tick >> 1
    for (let i = 0; i < Math.floor(w * 2.2); i++) {
      dot(c, hash(i + seed * 131) % w, hash(i * 7 + seed * 17) % PX, palette[i % 6])
    }
  } else if (scene === 'volcano') {
    const vx = Math.max(2, w - 22)
    for (let x = 0; x < w; x++) dot(c, x, PX - 3, 0xa09040)
    waves(c, tick, 0x5aa6c4, PX - 1)
    for (let r = 0; r < 9; r++) {
      const half = 1 + Math.round(r * 0.8)
      for (let x = -half; x <= half; x++) dot(c, vx + 7 + x, PX - 12 + r + (r === 0 ? 0 : 0), r < 1 ? 0xd9583a : 0x6b3f2a)
    }
    for (let i = 0; i < 3; i++) dot(c, vx + 5 + ((tick + i * 3) % 5), PX - 14 + ((tick + i * 2) % 3), 0xe8a838)
  } else if (scene === 'night') {
    for (let i = 0; i < Math.floor(w / 4); i++) {
      dot(c, hash(i) % w, hash(i + 11) % (PX - 4), (tick + i) % 6 < 3 ? 0xf0e8b0 : 0x6a6a90)
    }
    const mx = w - 10
    for (let y = -3; y <= 3; y++) {
      for (let x = -3; x <= 3; x++) if (x * x + y * y <= 9) dot(c, mx + x, 5 + y, x > 1 ? 0xb8b088 : 0xe8e0b0)
    }
    const t = (tick * 2) % (w + 24)
    for (let k = 0; k < 4; k++) dot(c, t - 8 - k, Math.floor((t - 8 - k) / 3), k === 0 ? 0xffffff : 0x8a8ab8)
    for (let x = 0; x < w; x++) dot(c, x, PX - 1, 0x3a3a5a)
  } else if (scene === 'rain') {
    for (let i = 0; i < Math.floor(w / 2); i++) {
      const x = hash(i) % w
      const y = (tick * 2 + (hash(i + 1) % PX)) % (PX + 3)
      dot(c, x, y, 0x7ac4e0)
      dot(c, x, y - 1, 0x4a84a8)
      dot(c, x, y - 2, 0x2a4f70)
    }
    waves(c, tick, 0x5aa6c4, PX - 1)
  } else if (scene === 'matrix') {
    const glyphs = '01#$/<>'
    for (let i = 0; i < Math.floor(w / 3); i++) {
      const x = hash(i) % w
      const r = (tick + (hash(i + 3) % ROWS) * 2) % (ROWS + 3)
      put(c, x, r, glyphs[(tick + i) % glyphs.length], 0xb0ffb0)
      put(c, x, r - 1, glyphs[(tick + i + 3) % glyphs.length], 0x3fa05a)
      put(c, x, r - 2, glyphs[(tick + i + 5) % glyphs.length], 0x1f5f35)
    }
  } else {
    const palette = [0x5a1f2a, 0x8a2f3f, 0x3f1f4a]
    for (let i = 0; i < Math.floor(w / 3); i++) {
      dot(c, (hash(i) % w + (tick >> 2)) % w, hash(i + 5) % (PX - 2), palette[i % 3])
    }
    if (w >= 46) {
      frame(c, w - 14, 3, 12, 4, '', 0xe0506a)
      write(c, w - 12, 4, 'error', 0xe0506a)
      write(c, w - 12, 5, 'lines', 0xe0506a)
    }
  }
  if (scene !== 'thread' && scene !== 'error' && w >= 60) {
    const l = LABELS[scene]
    write(c, w - l.length - 14, 1, '┌' + l + '┐', 0xe8e0c8)
  }
}

const drawClawd = (c: Canvas, tick: number) => {
  const range = Math.max(1, c.w - SPRITE_W - 1)
  const period = 2 * (range + 3)
  const t = tick % period
  let x = 0
  let dir = 1
  let turning = false
  if (t < range) x = t
  else if (t < range + 3) {
    x = range
    turning = true
  } else if (t < 2 * range + 3) {
    x = range - (t - range - 3)
    dir = -1
  } else turning = true
  const blink = tick % 25 === 0
  const alt = (tick >> 1) % 2 === 0
  const y0 = PX - SPRITE_H
  const px = (dx: number, dy: number, color: number) => {
    dot(c, x + dx, y0 + dy, color)
    const r = (y0 + dy) >> 1
    if (r >= 0 && r < ROWS && x + dx >= 0 && x + dx < c.w) c.occ[r * c.w + x + dx] = true
  }
  // body 10x5 (two rows above and below the arm row), 1px arms in the middle,
  // eyes 1x2 rising from the arm row, legs 2px (one of each pair 1px while walking)
  const left = turning ? 3 : 2
  const right = turning ? 10 : 11
  for (let dy = 0; dy < 5; dy++) for (let dx = left; dx <= right; dx++) px(dx, dy, ORANGE)
  for (const dx of turning ? [1, 2, 11, 12] : [0, 1, 12, 13]) px(dx, 2, ORANGE)
  const eyes = turning ? [5, 8] : dir > 0 ? [5, 10] : [3, 8]
  for (const dx of eyes) {
    px(dx, 2, DARK)
    if (!blink) px(dx, 1, DARK)
  }
  for (const [i, dx] of [3, 5, 8, 10].entries()) {
    const long = turning ? true : (i % 2 === 0) === alt
    for (let dy = 5; dy < (long ? 7 : 6); dy++) px(dx, dy, ORANGE)
  }
  return x + 7
}

const bubble = (c: Canvas, text: string, centre: number) => {
  const inner = Math.min(30, c.w - 4)
  const words = text.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const word of words) {
    if (cur && (cur + ' ' + word).length > inner) {
      lines.push(cur)
      cur = word
    } else cur = cur ? cur + ' ' + word : word
  }
  lines.push(cur)
  const shown = lines.slice(0, 2).map((l, i) => (i === 1 && lines.length > 2 ? clip(l + '…', inner) : clip(l, inner)))
  const bw = Math.max(...shown.map(l => l.length)) + 4
  const bx = Math.max(0, Math.min(c.w - bw, centre - (bw >> 1)))
  const edge = 0xe8a998
  const fill = 0x2a0f12
  write(c, bx, 0, '╭' + '─'.repeat(bw - 2) + '╮', edge, NONE, true)
  for (let i = 0; i < 2; i++) {
    put(c, bx, 1 + i, '│', edge, NONE, true)
    put(c, bx + bw - 1, 1 + i, '│', edge, NONE, true)
    write(c, bx + 1, 1 + i, ' ' + (shown[i] ?? '').padEnd(bw - 3), 0xffffff, fill, true)
  }
  write(c, bx, 3, '╰' + '─'.repeat(bw - 2) + '╯', edge, NONE, true)
}

const cellAt = (c: Canvas, r: number, x: number) => {
  const i = r * c.w + x
  const top = c.px[2 * r * c.w + x]
  const bot = c.px[(2 * r + 1) * c.w + x]
  if (c.ch[i]) return { cp: c.ch[i].codePointAt(0) as number, fg: c.fg[i], bg: c.bg[i] === NONE ? DEFAULT : c.bg[i] }
  if (top !== NONE && bot !== NONE) return { cp: 0x2580, fg: top, bg: bot }
  if (top !== NONE) return { cp: 0x2580, fg: top, bg: DEFAULT }
  if (bot !== NONE) return { cp: 0x2584, fg: bot, bg: DEFAULT }
  return { cp: 0x20, fg: DEFAULT, bg: DEFAULT }
}

// terminal: one Raster, cells packed as [codePoint, fg, bg] u32 triplets
const toCells = (c: Canvas, rows: number) => {
  const words = new Uint32Array(c.w * rows * 3)
  const skip = ROWS - rows
  for (let r = skip; r < ROWS; r++) {
    for (let x = 0; x < c.w; x++) {
      const { cp, fg, bg } = cellAt(c, r, x)
      const o = ((r - skip) * c.w + x) * 3
      words[o] = cp
      words[o + 1] = fg
      words[o + 2] = bg
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}

// desktop: the same cells as an SVG (a cell is CELL px wide and 2 CELL tall; a half block is one square)
const CELL = 7
const hex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0')
const esc = (ch: string) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch)

const toSvg = (c: Canvas, rows: number) => {
  const skip = ROWS - rows
  const out: string[] = []
  const rect = (x: number, y: number, h: number, color: number) =>
    out.push(`<rect x="${x * CELL}" y="${y}" width="${CELL}" height="${h}" fill="${hex(color)}"/>`)
  for (let r = skip; r < ROWS; r++) {
    const y = (r - skip) * 2 * CELL
    for (let x = 0; x < c.w; x++) {
      const { cp, fg, bg } = cellAt(c, r, x)
      if (cp === 0x2580) {
        rect(x, y, CELL, fg)
        if (bg !== DEFAULT) rect(x, y + CELL, CELL, bg)
      } else if (cp === 0x2584) rect(x, y + CELL, CELL, fg)
      else if (cp !== 0x20) {
        if (bg !== DEFAULT) rect(x, y, 2 * CELL, bg)
        const ch = String.fromCodePoint(cp)
        out.push(
          `<text x="${x * CELL}" y="${y + 1.4 * CELL}" font-family="Consolas,Menlo,monospace" font-size="${CELL * 1.5}" fill="${fg === DEFAULT ? '#cccccc' : hex(fg)}">${esc(ch)}</text>`,
        )
      } else if (bg !== DEFAULT) rect(x, y, 2 * CELL, bg)
    }
  }
  const w = c.w * CELL
  const h = rows * 2 * CELL
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${out.join('')}</svg>`
}

export const register: Register = on => {
  let tickN = 0
  let active = false
  let leaveLeft = 0
  let curPhrase = ''
  let curScene: Scene = 'thread'
  let nextPhrase = ''
  let nextScene: Scene = 'thread'
  let phraseAt = -99
  let sceneAt = -99
  let errorUntil = 0
  let inFlight = 0

  const snap = (): Anim => ({ tick: tickN, active, leave: leaveLeft, phrase: curPhrase, scene: curScene })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'clawd',
      description: 'Turn the Clawd mascot on or off',
      argumentHint: 'on|off',
    })

    $.clock.every(200, () => {
      if (!active && leaveLeft <= 0) return
      tickN += 1
      if (active) {
        if (nextPhrase && nextPhrase !== curPhrase && tickN - phraseAt >= SWAP_TICKS) {
          curPhrase = nextPhrase
          phraseAt = tickN
        }
        if (nextScene !== curScene && tickN >= errorUntil && tickN - sceneAt >= SWAP_TICKS) {
          curScene = nextScene
          sceneAt = tickN
        }
      } else leaveLeft -= 1
      update($, anim, () => snap())
    })

    return next(e)
  })

  on('command.run', { command: 'clawd' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== 'on' && arg !== 'off') {
      const isOn = await read($, enabled)
      return { text: `Clawd: ${isOn ? 'on' : 'off'}. Usage: /clawd on|off` }
    }
    await update($, enabled, () => arg === 'on')
    return { text: `Clawd: ${arg}` }
  })

  on('turn.start', async ($, e, next) => {
    active = true
    leaveLeft = 0
    curPhrase = nextPhrase = 'Думаю…'
    curScene = nextScene = 'thread'
    phraseAt = sceneAt = tickN
    errorUntil = 0
    inFlight = 0
    await update($, anim, () => snap())
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    nextPhrase = phraseOf(e)
    nextScene = sceneOf(String(e.tool))
    inFlight += 1
    const result = await next(e)
    inFlight -= 1
    if ((result as { isError?: boolean }).isError) {
      curScene = nextScene = 'error'
      errorUntil = tickN + HOLD_ERROR_TICKS
      sceneAt = tickN
    }
    if (inFlight <= 0) {
      nextPhrase = 'Думаю…'
      nextScene = 'thread'
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    active = false
    leaveLeft = ROWS + 2
    curPhrase = 'Готово!'
    await update($, anim, () => snap())
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, anim)
    const isOn = await read($, enabled)
    const p = e.props
    const isTerminal = e.surface === 'terminal'
    if (!isTerminal && e.surface !== 'desktop') return next(e)

    // the terminal draws as wide as the band; the desktop draws a fixed-size picture
    const width = isTerminal ? p.bodyColumns : DESKTOP_COLUMNS
    const fits = isTerminal ? width >= MIN_COLUMNS && p.maxRows >= 4 : true
    const isShown = isOn && !p.hasSurvey && fits && (s.active ? p.isWorking : s.leave > 0)

    if (!isShown) return next(e)

    const rows = Math.min(ROWS, isTerminal ? p.maxRows : ROWS, s.active ? ROWS : s.leave)
    const c = newCanvas(width)
    drawScene(c, s.scene, s.tick)
    const centre = drawClawd(c, s.tick)
    if (s.phrase && (s.active || s.leave > ROWS - 2)) bubble(c, s.phrase, centre)

    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      return <Raster key="clawd" columns={width} rows={rows} cells={toCells(c, rows)} />
    }
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const source = toSvg(c, rows)
      if (source.length > 120000) return next(e)
      return <Svg source={source} alt="Clawd, the pixel mascot, walking while Claude works" />
    }
    return next(e)
  })
}
