// Modified from https://github.com/socketio/socket.io/blob/4.6.2/test/support/util.ts

import { Server as _Server, ServerOptions, Socket } from "socket.io";
import { io as ioc, ManagerOptions, Socket as ClientSocket, SocketOptions } from "socket.io-client";
import { Server as HttpServer } from "http";
import * as fs from "fs";
import type { AddressInfo } from "net";
import { debugModule } from "../../../src/common/utils";
import * as wpsExt from "../../../src";
import "../../../src"; // Otherwise: Error `this.useAzureSocketIO` is not a function

export const debug = debugModule("wps-sio-ext:ut:sio:util");
export const envFilePath = ".env.test";

const request = require("supertest");
const expect = require("expect.js");
const i = expect.stringify;

export const defaultWpsOptions = {
  hub: process.env.WebPubSubHub,
  connectionString: process.env.WebPubSubConnectionString,
} as wpsExt.AzureSocketIOOptions;

let internalCounter = process.env.InternalCounter ? parseInt(process.env.InternalCounter) : 0;

export const baseServerPort = 3000;

// e.g: /eventhandler/this-is-a-file.js
export const attachmentPath = (filename: string, path: string = "/socket.io/"): string =>
  (path.endsWith("/") ? path : path + "/") + filename;

// e.g. /eventhandler/socket.io.js
export const defaultAttachmentPath = attachmentPath("socket.io.js");

export const getIndexedHub = (idx: number): string => `${process.env.WebPubSubHub}_${idx}`;

// e.g. http://localhost:3000
export const getClientConnectDomain = (): string => getEndpointFullPath(process.env.WebPubSubConnectionString ?? "");

// e.g. /client/socket/hubs/eio_hub
export const getClientConnectPath = (idx: number = 0): string => `/clients/socketio/hubs/${getIndexedHub(idx)}`;

export const enableFastClose = (server: _Server): void => {
  server["httpServer"] = require("http-shutdown")(server["httpServer"]);
};

export class Server extends _Server {
  /**
   *
   * @param srv - port for new HTTP server or a existing HTTP server.
   * @param opts - option for Socket.IO server
   */
  constructor(srv?: number | HttpServer, opts?: Partial<ServerOptions>) {
    debug(`Server, srv = ${srv}, opts = ${JSON.stringify(opts)}`);
    super(srv, opts);

    // `Server.close()` will trigger `HttpServer.close()`, which costs a lot of time
    // This is a trick to shutdown http server in a short time
    enableFastClose(this);
    // this["httpServer"] = require("http-shutdown")(this["httpServer"]);
    debug(`Server, constructor, finish, srv=${srv}, opts=${JSON.stringify(opts)}`);
  }
}

export const updateAndGetInternalCounter = () => {
  // Too large counter => Too large port number
  internalCounter = (internalCounter + 1) % 5000;

  // Add or update `InternalCounter` in file `.env.test`
  if (!fs.existsSync(envFilePath)) {
    fs.writeFileSync(envFilePath, "");
  }
  const envContent = fs.readFileSync(envFilePath, "utf8");

  // If existing, replace it. If non-existing, append it.
  if (envContent.includes("InternalCounter")) {
    const updatedEnvContent = envContent.replace(/(InternalCounter=).*/, `$1${internalCounter}`);
    fs.writeFileSync(envFilePath, updatedEnvContent);
  } else {
    const dataToAppend = `\nInternalCounter=${internalCounter}\n`;
    fs.appendFileSync(envFilePath, dataToAppend);
  }
  return internalCounter;
};

export function getSioServerOptions(wpsOpts?: wpsExt.AzureSocketIOOptions) {
  return wpsOpts
    ? { ...wpsOpts, hub: getIndexedHub(internalCounter) }
    : { ...defaultWpsOptions, hub: getIndexedHub(internalCounter) };
}

export async function getServer(
  srv?: number | HttpServer,
  opts?: Partial<ServerOptions>,
  wpsOpts?: wpsExt.AzureSocketIOOptions
): Promise<Server> {
  debug(`getServer, srv = ${srv}, opts = ${JSON.stringify(opts)}, wpsOpts = ${JSON.stringify(wpsOpts)}`);
  let port = baseServerPort + updateAndGetInternalCounter();
  if (typeof srv === "number") {
    port = srv > 0 ? srv : internalCounter + baseServerPort;
    debug(`getServer, srv is port number, actual port = ${port}`);
  } else {
    port = getPort(srv as HttpServer);
    debug(`getServer, srv is HttpServer, actual port = ${port}`);
  }
  const io = new Server(srv, opts);

  const finalWpsOptions = getSioServerOptions(wpsOpts);
  debug(`http port=${port}, hub=${finalWpsOptions.hub}`);
  return io.useAzureSocketIO(finalWpsOptions);
}

// add support for Set/Map
const contain = expect.Assertion.prototype.contain;
expect.Assertion.prototype.contain = function (...args: any[]) {
  if (this.obj instanceof Set || this.obj instanceof Map) {
    args.forEach((obj) => {
      this.assert(
        this.obj.has(obj),
        function () {
          return "expected " + i(this.obj) + " to contain " + i(obj);
        },
        function () {
          return "expected " + i(this.obj) + " to not contain " + i(obj);
        }
      );
    });
    return this;
  }
  return contain.apply(this, args);
};

export function getEndpointFullPath(connectionString: string): string {
  const keyValuePairs = connectionString.split(";");
  var endpoint = "",
    port = -1;
  for (const pair of keyValuePairs) {
    const [key, value] = pair.split("=");
    if (key.trim().toLowerCase() === "port") {
      port = Number(value.trim());
    }
    if (key.trim().toLowerCase() === "endpoint") {
      endpoint = value.trim();
    }
  }
  if (port === -1) {
    port = endpoint.indexOf("https://") === 0 || endpoint.indexOf("wss://") === 0 ? 443 : 80;
  }
  return `${endpoint}:${port}`;
}

export function createClient(nsp: string = "/", opts?: Partial<ManagerOptions & SocketOptions>): ClientSocket {
  const endpointFullPath = getEndpointFullPath(process.env.WebPubSubConnectionString ?? "");
  opts = { path: getClientConnectPath(internalCounter), ...opts };
  let uri = `${endpointFullPath}${nsp}`;
  debug(`createClient, opts = ${JSON.stringify(opts)}, endpointFullPath = ${endpointFullPath}, uri = ${uri}`);
  return ioc(uri, opts);
}

export function shutdown(io: Server, cb?: (err?: Error) => void) {
  debug("shutdown");
  const commonShutdown = () => {
    debug("commonShutdown");
    io.close(() => {
      io.removeAllListeners();
      debug("SIO Server closed");
      cb && cb();
    });
  };
  if (!io["httpServer"]) return commonShutdown();
  // http server shutdown will trigger EIO engine close
  io["httpServer"].shutdown((err: Error) => {
    io["httpServer"] = null;
    debug(`Http Server shutdown ` + (err ? `failed: ${err.message}` : "successfully"));
    commonShutdown();
  });
}

export async function success(done: Function, io: Server, ...clients: (ClientSocket | Socket)[]) {
  clients.forEach((client) => client.disconnect());
  debug("start cleanup for success");
  shutdown(io, () => {
    done();
  });
}

export function successFn(done: Function, sio: Server, ...clientSockets: ClientSocket[]) {
  return () => success(done, sio, ...clientSockets);
}

export function getPort(srv: Server | HttpServer): number {
  const _getPort = (x: HttpServer) => (x.address() as AddressInfo).port;
  return (srv as any).httpServer ? _getPort(srv["httpServer"]) : _getPort(srv as HttpServer);
}

export function createPartialDone(count: number, done: (err?: Error) => void) {
  let i = 0;
  return () => {
    debug(`createPartialDone, i = ${i}`);
    if (++i === count) {
      done();
    } else if (i > count) {
      done(new Error(`partialDone() called too many times: ${i} > ${count}`));
    }
  };
}

export function waitFor<T = unknown>(emitter, event) {
  return new Promise<T>((resolve) => {
    emitter.once(event, resolve);
  });
}

// TODO: update superagent as latest release now supports promises
export function eioHandshake(): Promise<string> {
  return new Promise((resolve) => {
    request(getClientConnectDomain())
      .get(getClientConnectPath())
      .query({ transport: "polling", EIO: 4 })
      .end((err, res) => {
        debug(`eioHandshake, err = ${err} response = ${JSON.stringify(res)}`);
        const sid = JSON.parse(res.text.substring(1)).sid;
        resolve(sid);
      });
  });
}

export function eioPush(sid: string, body: string): Promise<void> {
  return new Promise((resolve) => {
    request(getClientConnectDomain())
      .post(getClientConnectPath())
      .type("text/plain")
      .send(body)
      .query({ transport: "polling", EIO: 4, sid })
      .expect(200)
      .end((err, res) => {
        debug(`eioPush, err = ${err}, res = ${JSON.stringify(res)}`);
        resolve();
      });
  });
}

export function eioPoll(sid: string): Promise<string> {
  return new Promise((resolve) => {
    request(getClientConnectDomain())
      .get(getClientConnectPath())
      .query({ transport: "polling", EIO: 4, sid })
      .expect(200)
      .end((err, res) => {
        debug(`eioPoll, err = ${err}, res = ${JSON.stringify(res)}`);
        resolve(res.text);
      });
  });
}

/**
 * Constantly execute `check` function every `intervalMilliseconds` until it finish without throwing exception or `maxMs` is reached.
 * When `maxMs` is reached and not returned yet, the last exception will be thrown.
 * @param check - a function that contains assert sentences which throw excpetion when fail
 * @param maxMilliseconds - the maximum milliseconds to wait for a sucessful `check` execution
 * @param intervalMilliseconds - the interval milliseconds between two `check` executions
 * @returns
 */

export async function spinCheck(
  check: () => void,
  maxMilliseconds: number = 2000,
  intervalMilliseconds: number = 100
): Promise<void> {
  debug("spinCheck, start");
  const start = Date.now();

  while (true) {
    try {
      check();
      debug(`spinCheck, success, total cost = ${Date.now() - start} ms`);
      return;
    } catch (e) {
      const cost = Date.now() - start;
      debug(`spinCheck, error message = ${e.message}, total cost = ${cost} ms`);
      if (cost > maxMilliseconds) {
        debug(`spinCheck, last error message = "${e.message}", total cost = ${cost} ms`);
        throw e;
      }
      // sleep await 200 ms
      await new Promise((resolve) => {
        setTimeout(resolve, intervalMilliseconds);
      });
    }
  }
}
