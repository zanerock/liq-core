import fsPath from 'node:path'

import { CredDB } from './lib/credentials-db'
import { CREDS_PATH_STEM } from './lib/constants'

const method = 'put'
const path = ['credentials', ':credential', 'import']
const parameters = [
  {
    name        : 'replace',
    isBoolean   : true,
    description : 'By default, trying to import a credential of the same type results in an error, unless `replace` is true.'
  },
  {
    name          : 'path',
    required      : true,
    isSingleValue : true,
    descirption   : 'Local path to the credential file.'
  },
  {
    name        : 'copyToStorage',
    isBoolean   : true,
    descirption : 'When set, copies the credential file from [`path`](#param-path) to centralized storage under the `$LIQ_HOME/credentials` (`LIQ_HOME` is typically `$HOME/.liq`). Otherwise by default, we reference the credentials in-place.'
  }
]

const func = ({ app, cache, model, reporter }) => async(req, res) => {
  const credDB = new CredDB({ app, cache })
  const { copyToStorage, credential, path: srcPath, replace } = req.vars

  const destPath = copyToStorage === true ? fsPath.join(app.liqHome(), CREDS_PATH_STEM) : undefined

  await credDB.import({ destPath, key : credential, srcPath, replace })

  res.type('text/terminal').send(`Imported '${credential}' credentials.`)
}

export { func, parameters, path, method }
