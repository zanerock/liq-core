import { Readable } from 'stream'
import * as StreamPromises from 'stream/promises'
import { parse as parseCSV } from '@fast-csv/parse'

/**
* Transform CSV files into JSON objects. Bad data (missing headers)
*
* ### Parameters
*
* - `canBeAutoDeleted`: callback function used to test whether a current item record can be auto-deleted or not. Must
*     accept single positional argument (item object) and return true or false.
* - `files`: an object with the structure `{ [fileName]: { data: <byte data>} }` where
*     `files[fileName].data.toString()` yields the file contents.
* - `finalizeRecord`: called on the normalized records to do another round of checking and updates, but this time with
*     the assurance that all field names are normalized and required fields are present.
* - `headerNormalizations`: maps unambiguous variations to standard field names. E.g. 'Given name' and 'First name' may
*     be mapped to 'givenName'. Has the form of:
*     ```
*     [ [<regex matcher>, <normalized field name>], ... ]
*     ```
* - `headerValidations`: examines the headers as a whole to confirm required headers are present. Has the form of:
*     ```
*     [ (headers) => <validation check> ? null : <error message string>, ... ]
*     ```
*     where a `null` result indicates the validation is passed. E.g., to check for required fields, we would have a
*     validation like:
*     ```
*     (headers) => headers.indexOf('requiredField') !== -1 ? null : "missing required field 'requiredField'"
*     ```
* - `res`: the Express 'results' object. This is used to set 400 and 500 responses.
* - `resourceAPI`: API object used to retrieve current items and check against incoming items for DB refresh
* - `validateAndNormalizeRecords`: a function used to process the array of records to extract and normalize data. This
*     can be used to add new data as well as combine, vaidate, and transform existing data. E.g.: split field
*     'fullName' into 'givenName' and 'surname'; calculate 'daysSinceCertification' from 'lastCertification'; parse
*     'hireDate' as a date and validate it's in the past etc. Validation failures should throw an exception with a
*     useful, user facing error message. Note this function is used to normalize the 'form' of the data. Use
*     `finalizeRecord` incorporate cross references, etc.
*/
const importFromCSV = (options) => {
  const { res } = options
  if (!validateAPI(options)) return

  // array is built in-place
  const records = []
  options.records = records

  options = Object.assign(
    { pipelines : buildPipelines(options) },
    options
  )
  // An error respons may be generated by 'buildPipelines'; if so, we're done.
  if (res.headersSent) return
  processPipelines(options)
}

/**
* Simple API validation checks.
*
* ### Parameters
*
* - `res`: see `importFromCSV`
* - `resourceAPI`: see `importFromCSV`
*/
const validateAPI = ({ res, resourceAPI }) => {
  const requiredAPI = ['add', 'delete', 'get', 'itemName', 'keyField', 'list', 'resourceName', 'write']
  const missing = requiredAPI.reduce((acc, key) => {
    if (!resourceAPI[key]) { acc.push(key) }
    return acc
  }, [])
  if (missing.length > 0) {
    res.status(500).json({ message : `Resource API does not support '${missing.join("', '")}'` })
    return false
  }
  else return true
}

/**
* Sets up processing of the CSV data. Maps header variations to normalized name and processes CSV into an array of
* record data. Annotates each record with `_sourceFileName` for use when creating error messages.
*
* ### Parameters
*
* - `files`: see `importFromCSV`
* - `headerNormalizations`: see `importFromCSV`
* - `headerValidations`: see `importFromCSV`
* - `records`: array used to collect new records in place
* - `res`: Express result object; used to generate error response when necessay. Users should check `res.headersSent`
*     and stop processing if true.
*/
const buildPipelines = ({ files, headerNormalizations, headerValidations, records, res }) => {
  const pipelines = []

  const processRecord = (fileName) => (record) => {
    record._sourceFileName = fileName
    records.push(record)
  }

  for (const fileName of Object.keys(files)) {
    // TODO: can I reuse the same stream?
    const parserStream = parseCSV({
      // 'fileName' is used to generate useful error messages
      headers     : validateAndNormalizeHeaders({ fileName, headerNormalizations, headerValidations }),
      trim        : true,
      ignoreEmpty : true
    })
      .on('error', (error) => {
        // TODO: could build up errors from multiple files for better user experience
        // it's possible the other file died already
        if (res.headersSent) return
        res.status(400).json({ message : `Error while processing CSV upload: ${error.message}` })
        // note, the error is also impmlicitly thrown (I believe; haven't worked with Streams much, but that's
        // consistent with the observed behavior) TODO: improve this note
      })
      .on('data', processRecord(fileName))

    const fileDataStream = Readable.from(files[fileName].data.toString())

    pipelines.push(StreamPromises.pipeline(fileDataStream, parserStream))
  }

  return pipelines
}

/**
* Processes the results of completed pipelines and deals with pipeline processing errors.
*
* ### Parameters
*
* - `canBeAutoDeleted`: see `importFromCSV`
* - `finalizeRecord`: see `importFromCSV`
* - `pipelines`: the record processing pipelines
* - `records`: the list of incoming records (completed after pipelines processed)
* - `res`: see `importFromCSV`
* - `resourceAPI`: see `importFromCSV`
*/
const processPipelines = ({
  canBeAutoDeleted,
  finalizeRecord,
  model,
  org,
  pipelines,
  records,
  res,
  resourceAPI,
  validateAndNormalizeRecords
}) => {
  const names = { itemName : resourceAPI.itemName, resourceName : resourceAPI.resourceName }
  Promise.all(pipelines).then(() => {
    const normalizedRecords = tryValidateAndNormalizeRecords({ records, res, validateAndNormalizeRecords, ...names })
    if (!checkStatus({ res })) return

    const errors = []
    const actions = []
    const actionSummary = []
    // these build up 'actions', but don't do anything to the model until processed
    const { keepList } =
      processNewAndUpdated({ actions, actionSummary, errors, finalizeRecord, normalizedRecords, org, resourceAPI, ...names })
    processDeletions({ actions, actionSummary, canBeAutoDeleted, errors, keepList, resourceAPI })

    for (const action of actions) action()
    if (!checkStatus({ errors, source : 'processing updates', model, res })) return

    try {
      resourceAPI.write()
      res.json({ message : actionSummary.join('\n') })
    }
    catch (e) {
      console.error(e)
      res.status(500).json({ message : `There was a problem saving the updated staff: ${e.message}` })
      // reset the data
      model.initialize() // hopefully the data on file is intact...
    }
  }) // Promise(.all(pipelines).then(...
    .catch((error) => {
      console.error(error)
      if (res.headersSent) return
      // if there were problems with the parsing, the result would have already been sent with the '.on('error', ...)'
      // handler; so this is something else and we'll assume a 500
      res.status(500).json({ message : error.message })
    })
} // end processPipelines

const processNewAndUpdated = ({
  actions,
  actionSummary,
  errors,
  finalizeRecord,
  itemName,
  normalizedRecords,
  org,
  resourceAPI
}) => {
  const keepList = []
  // process the incoming and normalized records
  for (let newRecord of normalizedRecords) {
    newRecord = finalizeRecord({ actions, actionSummary, newRecord, org })
    const newId = newRecord[resourceAPI.keyField.toLowerCase()] // notice we normalize the ID to lower case
    keepList.push(newId)

    actions.push(() => {
      let action = 'update'
      try {
        if (resourceAPI.get(newId) === undefined) {
          action = 'add'
          resourceAPI.add(newRecord)
          actionSummary.push(`Created new ${itemName} '${newId}' as ${newRecord.roles.map((r) => r.name).join(', ')}`)
        }
        else {
          resourceAPI.update(newRecord)
          actionSummary.push(`Updated ${itemName} '${newId}' as ${newRecord.roles.map((r) => r.name).join(', ')}`)
        }
      }
      catch (e) {
        console.error(e)
        errors.push(`An error occurred while trying to ${action} ${itemName} '${newId}' from '${newRecord._sourceFileName}': ${e.message}`)
      }
    }) // end deferred action setup
  } // record processing loop

  return { actions, actionSummary, keepList }
}

const tryValidateAndNormalizeRecords = ({ itemName, records, res, validateAndNormalizeRecords }) => {
  try {
    return validateAndNormalizeRecords(records)
  }
  catch (e) { // the normalization functions will throw if they encounter un-processable data
    console.error(error)
    // TODO: it would be nicer to let the record exist in an "invalid" state and continue processing what we can
    res.status(400).json({ message : `Encounterd an error while normaliing ${itemName} records: ${e.message}` })
  }
}

const processDeletions = ({ actions, actionSummary, canBeAutoDeleted, errors, keepList, resourceAPI }) => {
  for (const currRecord of resourceAPI.list()) {
    const itemId = currRecord[resourceAPI.keyField].toLowerCase() // notice the normalization to lower case
    if (canBeAutoDeleted(currRecord) // it can be deleted and is NOT in the 'keepList'
        && !keepList.some((keepId) => keepId === itemId)) {
      actions.push(() => {
        try {
          resourceAPI.delete(itemId)
        }
        catch (e) {
          console.error(e)
          errors.push(`Error removing ${resourceAPI.itemName} '${itemId}': ${e.message}`)
        }
      })
      actionSummary.push(`Removed ${resourceAPI.itemName} '${itemId}'.`)
    }
  }
}

const checkStatus = ({ errors, model, res, source }) => {
  if (res?.headersSent) {
    model?.initialize()
    return false
  }

  if (errors && errors.length > 0) {
    const message = errors.length === 1
      ? `There was an error ${source}: ${errors[0]}`
      : `There were errors ${source}:\n* ${errors.join('\n* ')}`
    res.status(400).json({ message })

    model?.initialize()
    return false
  }

  return true
}

/**
* A function which generates a callback used in processing CSV headers. `validateAndNormalizeHeaders(options)` returns
* the actual callback. The callback maps original CSV headers to normalized camel-case JSON fields.
*      Validation failures should throw an exception with a useful, user facing error message.
*
* ### Parameters
*
* - `fileName`: used to generate user friendly error messages.
* - `headerNormalizations`: see `importFromCSV`
* - `headerValidations`: see `importFromCSV`
*/
const validateAndNormalizeHeaders =
    ({ fileName, headerValidations, headerNormalizations }) => (origHeaders) => {
      const newHeaders = []

      // First we map the incoming headers to known header names
      for (const origHeader of origHeaders) {
        const match = headerNormalizations.find(([re], i) => origHeader.match(re))
        // if we match, map the header to the known name; otherwise, leave the header unchanged
        newHeaders.push(match ? match[1] : origHeader)
      }

      const errorMessages = headerValidations.map((v) => v(newHeaders)).filter((r) => r !== null)

      if (errorMessages.length === 0) {
        return newHeaders
      }
      else {
        const errorMessage = errorMessages.length === 1
          ? errorMessages[0]
          : `\n* ${errorMessages.join('\n* ')}`

        throw new Error(`Error's processing '${fileName}': ${errorMessage}`)
      }
    }

export { importFromCSV }