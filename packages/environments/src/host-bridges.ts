import { BlockList, isIPv4 } from "node:net";
import { context, fail } from "@contremaitre/execution/context";
import { EnvironmentLocks } from "@contremaitre/execution/locks";
import { tcpProxy } from "@contremaitre/routing/proxy";
import { type Environment, type ServiceState, serviceAddress } from "./model.js";

/** Host listeners accept only connections originating on their environment's container subnet. */
export class HostBridges {
  private readonly locks = new EnvironmentLocks();
  private entries = new Map<
    string,
    { controller: AbortController; done: Promise<void>; subnet: string }
  >();
  async reconcile(env: Environment) {
    for (const [key, entry] of this.entries) {
      const [id, name, port] = key.split("/");
      if (
        id !== env.Identity.ID ||
        (env.host_network &&
          env.Services[name]?.Ports?.[port] &&
          entry.subnet === env.host_network.subnet)
      )
        continue;
      entry.controller.abort();
      await entry.done;
      this.entries.delete(key);
    }
  }
  async ensure(env: Environment, service: ServiceState, current: () => ServiceState | undefined) {
    return this.locks.use([env.Identity.ID], AbortSignal.timeout(60000), () =>
      this.start(env, service, current),
    );
  }
  private async start(
    env: Environment,
    service: ServiceState,
    current: () => ServiceState | undefined,
  ) {
    if (!env.host_network) return;
    const { gateway, subnet } = env.host_network;
    const [network, bits] = subnet.split("/");
    const prefix = Number(bits);
    if (
      !isIPv4(gateway) ||
      !isIPv4(network) ||
      !bits ||
      !Number.isInteger(prefix) ||
      prefix < 1 ||
      prefix > 32
    )
      fail("Invalid container network gateway or subnet");
    const allowed = new BlockList();
    allowed.addSubnet(network, prefix, "ipv4");
    service.BridgePorts ??= {};
    for (const declared of Object.keys(service.Ports ?? {})) {
      const key = `${env.Identity.ID}/${service.Name}/${declared}`;
      if (this.entries.has(key)) continue;
      const controller = new AbortController();
      const listening = Promise.withResolvers<number>();
      const start = (port: number) =>
        tcpProxy(
          context(controller.signal),
          port,
          Number(declared),
          async () => {
            const target = current();
            return (
              (target && serviceAddress(target, Number(declared))) ||
              fail("Host service is offline")
            );
          },
          listening.resolve,
          {
            host: "0.0.0.0",
            allow: (address) => allowed.check(address.replace(/^::ffff:/, ""), "ipv4"),
          },
        );
      let done = start(service.BridgePorts[declared] ?? 0);
      // A previous reservation can be occupied after a hub crash. The manager restarts affected clients.
      done = done.catch((error) => {
        if (service.BridgePorts?.[declared] && !controller.signal.aborted) return start(0);
        throw error;
      });
      void done.catch(listening.reject);
      try {
        service.BridgePorts[declared] = await listening.promise;
        this.entries.set(key, { controller, done, subnet });
      } catch (error) {
        controller.abort();
        await done.catch(() => {});
        throw error;
      }
    }
  }
  async close(environment?: string) {
    for (const [key, entry] of this.entries) {
      if (environment && !key.startsWith(`${environment}/`)) continue;
      entry.controller.abort();
      await entry.done;
      this.entries.delete(key);
    }
  }
}
