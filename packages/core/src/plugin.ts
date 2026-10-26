import type { CompanionEvent } from "./types.js";

/**
 * Permissions a plugin can ask for. They are declared, not sandboxed by the registry:
 * only cross-plugin events (`emit`) are gated here. Anything that touches the filesystem
 * or the network runs in the host's own process and must be audited by whoever installs it.
 */
export type PluginPermission =
  | "message:send"
  | "memory:read"
  | "memory:write"
  | "network:request"
  | "filesystem:read";

export interface CompanionPluginManifest {
  id: string;
  name: string;
  version: string;
  permissions: PluginPermission[];
}

export interface CompanionPluginContext {
  readonly pluginId: string;
  readonly permissions: ReadonlySet<PluginPermission>;
  /** Re-broadcast an event to the other plugins. Requires the `message:send` permission. */
  emit(event: CompanionEvent): Promise<void>;
}

export interface CompanionPlugin {
  manifest: CompanionPluginManifest;
  onEvent?(event: CompanionEvent, context: CompanionPluginContext): Promise<void> | void;
}

export interface PluginRegistryOptions {
  logger?: { warn(message: string, error?: unknown): void };
  /** How many times a plugin may chain `emit` before the event is dropped. Default 3. */
  maxEmitDepth?: number;
}

/**
 * A tiny event bus for companion plugins.
 *
 * Two rules matter more than the API:
 * 1. A failing plugin never fails the turn — errors are logged and swallowed.
 * 2. A plugin reaches other plugins only through `emit`, and only with `message:send`,
 *    so an accidental event loop cannot take the runtime down.
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, CompanionPlugin>();
  private readonly logger: { warn(message: string, error?: unknown): void };
  private readonly maxEmitDepth: number;

  constructor(options: PluginRegistryOptions = {}) {
    this.logger = options.logger ?? { warn: (message, error) => console.warn(message, error) };
    this.maxEmitDepth = options.maxEmitDepth ?? 3;
  }

  register(plugin: CompanionPlugin): void {
    const { id, name, version } = plugin.manifest;
    if (!id || !name || !version) {
      throw new Error("Plugin manifest needs id, name and version");
    }
    if (this.plugins.has(id)) {
      throw new Error(`Plugin already registered: ${id}`);
    }
    this.plugins.set(id, plugin);
  }

  unregister(id: string): boolean {
    return this.plugins.delete(id);
  }

  list(): CompanionPluginManifest[] {
    return [...this.plugins.values()].map((plugin) => ({ ...plugin.manifest }));
  }

  async dispatch(event: CompanionEvent): Promise<void> {
    await this.dispatchAt(event, 0);
  }

  private async dispatchAt(event: CompanionEvent, depth: number): Promise<void> {
    if (depth > this.maxEmitDepth) {
      this.logger.warn(`plugin event ${event.type} dropped: emit depth exceeded`);
      return;
    }
    await Promise.all(
      [...this.plugins.values()].map(async (plugin) => {
        if (!plugin.onEvent) {
          return;
        }
        const permissions = new Set(plugin.manifest.permissions);
        const context: CompanionPluginContext = {
          pluginId: plugin.manifest.id,
          permissions,
          emit: async (next) => {
            if (!permissions.has("message:send")) {
              this.logger.warn(
                `plugin ${plugin.manifest.id} tried to emit without the message:send permission`,
              );
              return;
            }
            await this.dispatchAt(next, depth + 1);
          },
        };
        try {
          await plugin.onEvent(event, context);
        } catch (error: unknown) {
          this.logger.warn(`plugin ${plugin.manifest.id} failed on ${event.type}`, error);
        }
      }),
    );
  }
}
