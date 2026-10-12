import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

// Codex repeats initialize.instructions in every tool description. The shared
// workflow lives in the bundled mobile-monitor skill instead. Only remove that
// handshake field; catalogs and tool results remain exactly as upstream sends.
export class ControlTransport extends StdioServerTransport {
  #initializations = new Set();

  async start() {
    const onmessage = this.onmessage;
    this.onmessage = (message, extra) => {
      if (message.method === 'initialize' && message.id !== undefined) {
        this.#initializations.add(message.id);
      }
      onmessage?.(message, extra);
    };
    await super.start();
  }

  send(message) {
    if (
      this.#initializations.delete(message.id) &&
      typeof message.result?.instructions === 'string'
    ) {
      const result = { ...message.result };
      delete result.instructions;
      return super.send({ ...message, result });
    }
    return super.send(message);
  }
}
