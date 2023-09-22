const method = 'unbind'
const path = ['server', 'stop?']
const parameters = []

const func = ({ cache }) => (req, res) => {
  res.send('Shutting down...')
  cache.release()
  process.kill(process.pid, 'SIGTERM')
}

export { func, path, method, parameters }