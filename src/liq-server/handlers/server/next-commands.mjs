import omit from 'lodash.omit'

import { nextOptions } from './lib/next-options'

const method = 'get'
const path = [ 'server', 'next-commands' ]
const parameters = [
  {
    name: 'command',
    description: "The (URL) path so far and optional '--' plus options."
  }
]

const CLI_STYLE = ' '
const URL_STYLE = '/'

const func = ({ app, model }) => (req, res) => {
  const { command = '/'} = req.vars
  
  const [ commandPath, optionString ] = command.split(/\s*--\s*/)
  
  let frontier = app.commandPaths
  const cmdsWalked = []
  const prevElements = {}
  let cmdSep
  let cmdsLeft
  if (commandPath.indexOf('/') === -1) { // then it's the CLI form
    cmdSep = CLI_STYLE
    cmdsLeft = commandPath.split(/\s+/)
    if (cmdsLeft.length !== 0 && cmdsLeft[0].startsWith('liq')) {
      cmdsLeft.shift() // drop any leading 'liq' that we might see in this form
    }
  }
  else { // command is in URL form
    cmdSep = URL_STYLE
    cmdsLeft = commandPath.split('/')
    cmdsLeft.shift() // drop '' from leading '/'
  }
  
  let optionsSpec
  while (cmdsLeft.length > 0) {
    const command = cmdsLeft.shift()
    if (command === '') break; // TODO: ???
    
    cmdsWalked.push(command)
    if (command in frontier) {
      frontier = frontier[command]
    }
    else { // the frontier says ':orgKey' and we have 'orgA' or whatever
      // TODO: document: you may only have one variable option element at any particular node in the tree
      let foundVariablePathElement = null
      for (const fKey of Object.keys(frontier)) {
        if (fKey.startsWith(':')) {
          if (foundVariablePathElement !== null) {
            throw new Error(`Illegal multiple variable path branch possibilities: ${cmdsWalked.join(cmdSep)}${cmdSep}(${foundVariablePathElement}|${fKey})`)
          }
          foundVariablePathElement = fKey
          const typeKey = fKey.slice(1)
          prevElements[typeKey] = command // save the value of the variable
          const elementConfig = app.commonPathResolvers[typeKey]
          const { bitReString } = elementConfig
          if (command.match(new RegExp(bitReString))) {
            frontier = frontier[fKey]
          }
        }
      }
      
      // if it's not in the frontier as a command nme, then it should be a variable match. Otherwise, it's unknown.
      if (foundVariablePathElement === null) {
        res.status(400).json({ message: `Unknown/unmatched final path component of: '${cmdsWalked.join("', '")}'.`})
        return
      }
    }
  }
  
  let inSomeOptions = false
  let nextCommands = Object.keys(frontier)
    .reduce((acc, k) => {
      if (k.startsWith(':')) {
        const elementConfig = app.commonPathResolvers[k.slice(1)] // this should already be validated
        const { optionsFetcher } = elementConfig
        acc.push(...optionsFetcher({ model, ...prevElements }))
      }
      // the blank happens because the root command is '', but it doesn't make sense to reflect it back
      // '_' vars are either hidden (if actually options) or internal vars
      else if (k !== '' && !k.startsWith('_')) {
        acc.push(k)
      }
      else if (k === '_parameters') {
        inSomeOptions = true
      }
      // else it's '' or a '_' var that isn't _parameters
      
      return acc
    }, [])
    // TODO: v is that necessary? Doesn't '_parameters' occur on it's own?
    .sort() // nice, and also puts '_parameters' first (remmember, we require unique paths, so there is only ever one)
  
  try {
  if (inSomeOptions === true) {
    nextCommands = nextOptions({ command, nextCommands, optionString, paramsSpec: frontier._parameters() })
  }
} catch (e) { console.error(e) }

  const format = req.accepts(['json', 'text'])
  
  switch (format) {
    case 'text':
      res.send(nextCommands.join('\n')); break
    default: // json
      res.json(nextCommands)
  }
}

export { func, method, parameters, path }
