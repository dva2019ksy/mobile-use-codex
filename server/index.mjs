import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectBroker } from './broker-client.mjs';

const require = createRequire(import.meta.url);
const { Mobilecli } = require('@mobilenext/mobile-mcp/lib/mobilecli.js');
const { version: VERSION } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const MIME = 'text/html;profile=mcp-app';

export async function createMobileCodex({
  cli = Mobilecli.getMobilecliPath(),
  runtimeDir = process.env.MOBILE_CODEX_RUNTIME_DIR,
} = {}) {
  const template = (
    await readFile(new URL('../ui/monitor.html', import.meta.url), 'utf8')
  ).replaceAll('__PLUGIN_VERSION__', VERSION);
  const revision = createHash('sha256').update(template).digest('hex').slice(0, 12);
  const UI_URI = `ui://mobile-use-codex/monitor-${VERSION}-${revision}.html`;
  const broker = await connectBroker({ cli, template, runtimeDir });
  const origin = broker.origin;
  const listDevices = () => broker.call('listDevices');
  const closeMonitor = (device) => broker.call('closeMonitor', { device });
  const openMonitor = async (args) => {
    const state = await broker.call('openMonitor', args);
    return {
      content: [
        {
          type: 'text',
          text: `Monitor ready for ${state.config.device.name}. End operation ${state.operation} when device work stops; renew it within ${state.leaseMs / 1000}s while working.`,
        },
      ],
      structuredContent: {
        device: state.config.device,
        state: state.state,
        targetFps: state.targetFps,
        operation: state.operation,
        leaseMs: state.leaseMs,
        activeOperations: state.activeOperations,
      },
      _meta: { mobileCodex: state.config, 'openai/outputTemplate': UI_URI },
    };
  };

  const server = new McpServer(
    { name: 'mobile-use-codex', version: VERSION },
    {
      instructions:
        "List devices before choosing a device ID. Open a monitor once before device work and reuse it. Model-facing monitor tools are read-only; use the mobile_* tools from this plugin's bundled mobile-control server for device interaction. No separately configured mobile-mcp server is needed. open_monitor begins an operation lease; renew within 90s while working, and always end_operation in cleanup when work finishes, fails or waits for user input. Viewers do not keep capture active. Tool success does not prove the widget rendered.",
    },
  );
  server.registerResource('mobile-monitor', UI_URI, { mimeType: MIME }, async () => ({
    contents: [
      {
        uri: UI_URI,
        mimeType: MIME,
        text: template,
        _meta: {
          ui: {
            prefersBorder: false,
            csp: {
              connectDomains: [origin],
              resourceDomains: [origin],
            },
          },
          'openai/widgetCSP': {
            connect_domains: [origin],
            resource_domains: [origin],
          },
          'openai/widgetPrefersBorder': false,
          'openai/ui': {
            availableDisplayModes: ['inline', 'fullscreen'],
            preferredDisplayMode: 'fullscreen',
          },
        },
      },
    ],
  }));
  const safe = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  };
  server.registerTool(
    'list_devices',
    {
      title: 'List mobile devices',
      description:
        'List actual connected devices, including their IDs, platforms, types and online state.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async () => {
      const devices = await listDevices();
      return {
        content: [{ type: 'text', text: JSON.stringify({ devices }) }],
        structuredContent: { devices },
      };
    }),
  );
  server.registerTool(
    'open_monitor',
    {
      title: 'Open mobile monitor',
      description:
        'Show a live mobile-device screen in a Codex MCP Apps widget. Choose an online device from list_devices. Reuses the shared capture for that device and begins or renews the operation lease of this connection. End the returned operation when work stops. Does not tap, type or launch apps.',
      inputSchema: z.object({
        device: z.string().min(1),
        fps: z.number().int().min(1).max(60).default(30),
        scale: z.number().min(0.1).max(1).default(0.5),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {
        ui: { resourceUri: UI_URI },
        'openai/outputTemplate': UI_URI,
        'openai/ui': { preferredModelDisplayMode: 'fullscreen' },
      },
    },
    safe(openMonitor),
  );
  server.registerTool(
    'close_monitor',
    {
      title: 'Close mobile monitor',
      description:
        "End this MCP connection's operations on a device. Capture stops when no other operations remain; other connections are preserved. Does not close device apps.",
      inputSchema: z.object({ device: z.string().min(1) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ device }) => {
      const state = await closeMonitor(device);
      return {
        content: [
          {
            type: 'text',
            text: state.activeOperations
              ? `Other operations still active: ${state.activeOperations}.`
              : 'Capture stopped.',
          },
        ],
        structuredContent: state,
      };
    }),
  );
  for (const [name, method, description] of [
    [
      'begin_operation',
      'beginOperation',
      'Begin an additional device operation after open_monitor. Each operation has its own lease; always end it when finished.',
    ],
    [
      'renew_operation',
      'renewOperation',
      'Renew an active operation within 90 seconds while device work continues. A widget viewer never renews operations.',
    ],
    [
      'end_operation',
      'endOperation',
      'End an operation after success, error, cancellation or waiting for the user. The final operation stops capture even if widgets remain open. Idempotent.',
    ],
  ]) {
    server.registerTool(
      name,
      {
        title: name.replaceAll('_', ' '),
        description,
        inputSchema:
          name === 'begin_operation'
            ? z.object({ device: z.string().min(1) })
            : z.object({ device: z.string().min(1), operation: z.string().uuid() }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      safe(async (args) => {
        const state = await broker.call(method, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(state) }],
          structuredContent: state,
        };
      }),
    );
  }
  server.registerTool(
    'monitor_status',
    {
      title: 'Mobile monitor status',
      description:
        'Read capture state and the number of active operations without starting capture.',
      inputSchema: z.object({ device: z.string().min(1) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
    },
    safe(async (args) => {
      const state = await broker.call('monitorStatus', args);
      return { content: [{ type: 'text', text: JSON.stringify(state) }], structuredContent: state };
    }),
  );

  const widgetOnly = { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true };
  server.registerTool(
    'tap_monitor_screen',
    {
      title: 'Tap monitored screen',
      description:
        'Widget-only tap within a live device frame. Maps a normalized image position to native screen coordinates; requires this connection’s active operation.',
      inputSchema: z.object({
        device: z.string().min(1),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        frameWidth: z.number().int().min(1).max(10000),
        frameHeight: z.number().int().min(1).max(10000),
        sequence: z.number().int().min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: widgetOnly,
    },
    safe(async (args) => {
      const point = await broker.call('tapMonitorScreen', args);
      return {
        content: [{ type: 'text', text: 'Tapped device screen.' }],
        structuredContent: point,
      };
    }),
  );
  server.registerTool(
    'press_monitor_button',
    {
      title: 'Press monitor device button',
      description:
        'Widget-only Home and volume controls for this connection’s active device operation. Does not begin or renew a capture lease.',
      inputSchema: z.object({
        device: z.string().min(1),
        button: z.enum(['HOME', 'VOLUME_UP', 'VOLUME_DOWN']),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: widgetOnly,
    },
    safe(async (args) => {
      const state = await broker.call('pressMonitorButton', args);
      return {
        content: [{ type: 'text', text: `Pressed ${state.button}.` }],
        structuredContent: state,
      };
    }),
  );
  server.registerTool(
    'read_frame',
    {
      title: 'Read latest monitor frame',
      description:
        'Widget-only frame transport through MCP. Keeps one expiring viewer lease and returns only the latest frame, without queuing old frames.',
      inputSchema: z.object({
        device: z.string().min(1),
        viewer: z.string().min(16).max(80),
        after: z.number().int().min(0).default(0),
        waitMs: z.number().int().min(0).max(1000).default(1000),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: widgetOnly,
    },
    safe(async ({ device, viewer, after, waitMs }) => {
      const { frame, status } = await broker.call('readFrame', { device, viewer, after, waitMs });
      return {
        content: [{ type: 'text', text: status.error || `Frame ${status.frames}` }],
        structuredContent: status,
        _meta: { mobileCodexFrame: frame ? { sequence: status.frames, jpeg: frame } : null },
      };
    }),
  );
  server.registerTool(
    'release_frame_viewer',
    {
      title: 'Release monitor viewer',
      description:
        'Widget-only cleanup when a viewer pauses or closes. Other viewers keep streaming.',
      inputSchema: z.object({ device: z.string().min(1), viewer: z.string().min(16).max(80) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: widgetOnly,
    },
    safe(async ({ device, viewer }) => {
      await broker.call('releaseViewer', { device, viewer });
      return { content: [{ type: 'text', text: 'Viewer released.' }] };
    }),
  );

  const close = () => broker.close();
  return { server, origin, broker, listDevices, openMonitor, closeMonitor, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createMobileCodex();
  serveStdio(() => app.server, { onerror: (error) => console.error(error) });
  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('end', shutdown);
}
