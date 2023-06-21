/* global fetch */
import * as fs from 'node:fs/promises'

import { LIQ_SERVER_STATUS_STOPPED, LIQ_SERVER_STATUS_WORKING } from './constants'
import { LIQ_SERVER_PID_FILE } from '../../shared/locations'
import { status } from './status'

const stop = async() => {
  const currStatus = await status()

  if (currStatus === LIQ_SERVER_STATUS_STOPPED) {
    console.log('Server already stopped.')
    return LIQ_SERVER_STATUS_STOPPED
  }

  console.log('Stopping...')

  try {
    const result = await fetch('http:/127.0.0.1:32600/server/stop', { method : 'UNBIND' })
    // await new Promise(r => setTimeout(r, 1000)) // sleep
    const stopStatus = await status()

    if (result.ok && stopStatus !== LIQ_SERVER_STATUS_STOPPED) {
      console.error('Server responded it would stop, but it appears to still be running.')
      return LIQ_SERVER_STATUS_WORKING
    }
    else if (result.ok) {
      await fs.rm(LIQ_SERVER_PID_FILE())
      console.log('Server stopped.')
      return LIQ_SERVER_STATUS_STOPPED
    }
  }
  catch (e) {
    console.error('There was an error requesting the server to stop.', e)
  }

  // else try to kill the PID
  const pid = await fs.readFile(LIQ_SERVER_PID_FILE(), { encoding : 'utf8' })
  console.log('Attempting a hard kill...')
  process.kill(pid)
  await fs.rm(LIQ_SERVER_PID_FILE())
  return LIQ_SERVER_STATUS_STOPPED
}

export { stop }
