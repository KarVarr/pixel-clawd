import { test, expect } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 80 },
} as const

test('draws only after a turn starts, and /clawd off hides it', async ($, on) => {
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>base</Text> })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const quiet = await $.ui.mount({ plugin: 'clawd', surface: 'terminal', ...BAND })
  expect(await quiet.find({ key: 'clawd' })).toBeUndefined()
  await quiet.unmount()

  await $.turn.start({ text: 'hi', turnId: 't1' })
  const live = await $.ui.mount({ plugin: 'clawd', surface: 'terminal', ...BAND })
  expect(await live.find({ key: 'clawd' })).toBeDefined()
  await live.unmount()

  const off = await $.command.run({ command: 'clawd', args: 'off' })
  expect(off.text).toContain('off')
  const hidden = await $.ui.mount({ plugin: 'clawd', surface: 'terminal', ...BAND })
  expect(await hidden.find({ key: 'clawd' })).toBeUndefined()
  await hidden.unmount()
})

test('the desktop surface gets an SVG while a turn runs', async ($, on) => {
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>base</Text> })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'hi', turnId: 't2' })
  const ui = await $.ui.mount({ plugin: 'clawd', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()
})
