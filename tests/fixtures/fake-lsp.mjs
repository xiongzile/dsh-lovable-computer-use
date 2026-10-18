/** Minimal stdio LSP server used to test the generic probe without external tools. */
import process from 'node:process'

let buffer = Buffer.alloc(0)
function send(message) {
  const body = Buffer.from(JSON.stringify(message))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}
function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString('utf8')
    const match = /Content-Length: (\d+)/i.exec(header)
    if (match === null) { buffer = buffer.subarray(headerEnd + 4); continue }
    const length = Number.parseInt(match[1], 10)
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'))
    buffer = buffer.subarray(start + length)
    switch (message.method) {
      case 'initialize':
        respond(message.id, {
          capabilities: { semanticTokensProvider: { full: true }, completionProvider: {}, hoverProvider: true, documentSymbolProvider: true, definitionProvider: true },
          serverInfo: { name: 'fake-lsp', version: '1.0.0' },
        })
        break
      case 'textDocument/documentSymbol':
        respond(message.id, [{ name: 'main', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }])
        break
      case 'textDocument/completion':
        respond(message.id, { isIncomplete: false, items: [{ label: 'greet', kind: 3 }] })
        break
      case 'textDocument/hover':
        respond(message.id, { contents: { kind: 'plaintext', value: 'fake hover text' } })
        break
      case 'textDocument/definition':
        respond(message.id, [{ uri: 'file:///tmp/fake.py', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }])
        break
      case 'textDocument/semanticTokens/full':
        respond(message.id, { data: [0, 0, 4, 0, 0, 0, 0, 4, 0, 0] })
        break
      case 'shutdown':
        respond(message.id, null)
        break
      case 'exit':
        process.exit(0)
        break
      default:
        if (message.id !== undefined) respond(message.id, null)
    }
  }
})
