import { isIP } from "node:net";
// Recreate the application services in the same OS process. Media nodes are external.
export function createPlatformRuntime({
  createServer,
  getOptions = () => ({}),
  host = "127.0.0.1",
  port = Number(process.env.PORT || 3000),
  onError = (error) => console.error("平台服务:", error.message),
}) {
  if (typeof host !== "string" || (!isIP(host) && host !== "localhost"))
    throw Error("HTTP_HOST须为本机监听IP或localhost");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("PORT须为有效端口");
  let server,
    pending,
    stopping = false,
    listenPort = port;
  const close = (app) =>
    new Promise((resolve, reject) =>
      app.close((error) => (error ? reject(error) : resolve())),
    );
  async function boot() {
    const app = createServer({ ...getOptions(), restartPlatform: restart });
    server = app;
    try {
      try {
        await app.startSip();
      } catch (error) {
        // Keep configuration and the restart action accessible if SIP cannot bind.
        onError(error);
      }
      await new Promise((resolve, reject) => {
        app.once("error", reject);
        app.listen(listenPort, host, () => {
          app.removeListener("error", reject);
          listenPort = app.address().port;
          resolve();
        });
      });
      return app;
    } catch (error) {
      await close(app).catch(onError);
      throw error;
    }
  }
  function restart() {
    if (stopping) return Promise.reject(Error("平台正在关闭"));
    if (pending) return pending;
    pending = (async () => {
      // Let the accepted response reach the requesting browser before disconnecting.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await close(server).catch(onError);
      if (!stopping) await boot();
    })().finally(() => {
      pending = null;
    });
    return pending;
  }
  return {
    start: boot,
    get server() {
      return server;
    },
    async stop() {
      stopping = true;
      if (pending) await pending.catch(onError);
      if (server?.listening) await close(server);
    },
  };
}
