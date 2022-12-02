/* global afterAll beforeAll describe expect jest test */
import * as path from 'path'
import request from 'supertest'

import { appInit } from '../app'
import { model } from '../model'
import { defaultTestOptions } from './lib/test-utils'
import { fooOutput } from './data/plugins/node_modules/foo'

const COMMAND_COUNT = 16

const mockLogOptions = () => {
  const logs = []
  const options = defaultTestOptions()

  options.reporter.log = jest.fn((msg) => { logs.push(msg) })
  options.logs = logs

  return options
}

const registrationRegExp = /^registering handler for path: [A-Z]+:/

describe('app', () => {
  describe('default setup provides useful info', () => {
    const testOptions = mockLogOptions()
    let cache

    beforeAll(() => {
      model.initialize(testOptions);
      ({ cache } = appInit(Object.assign(testOptions, { model })));
    })
    
    afterAll(() => { cache.release() })

    test('describes registered paths', () => {
      expect(testOptions.logs.filter((msg) =>
        // re: '[A-Z]:' matches the verb  v      v always start with a slash
        //                                          v regular path elements with optional ':', indicating it's a param
        //                                                            v or it's an RE as indicated by a closing '/'
        msg.match(registrationRegExp)).length)
        .toEqual(COMMAND_COUNT)
    })

    // TODO: use http.METHODS to verify that all registered paths used known verbs
  })

  describe('custom plugins', () => {
    let app, cache
    const testOptions = mockLogOptions()

    beforeAll(() => {
      model.initialize(testOptions)
      testOptions.pluginPath = path.join(__dirname, 'data', 'plugins')
      testOptions.skipCorePlugins = false;
      ({ app, cache } = appInit(testOptions));
    })
    
    afterAll(() => cache.release())

    test('are registered', () => {
      expect(testOptions.logs.filter((msg) =>
        msg.match(registrationRegExp)).length)
        .toEqual(COMMAND_COUNT + 1)
    })

    test('can be called', async() => {
      const { status, body } = await request(app).get('/foo')
      expect(status).toBe(200)
      expect(body).toEqual(fooOutput)
    })
  })
})
