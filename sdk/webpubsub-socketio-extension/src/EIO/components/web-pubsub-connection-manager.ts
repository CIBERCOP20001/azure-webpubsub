// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  AzureSocketIOOptions,
  AzureSocketIOCredentialOptions,
  debugModule,
  getWebPubSubServiceCaller,
} from "../../common/utils";
import { ClientConnectionContext, ConnectionError } from "./client-connection-context";
import {
  CONNECTION_ERROR_EVENT_NAME,
  CONNECTION_ERROR_WEBPUBSUB_CODE,
  CONNECTION_ERROR_WEBPUBSUB_MESSAGE,
  EIO_CONNECTION_ERROR,
  TUNNEL_PATH,
  WEBPUBSUB_CLIENT_CONNECTION_FILED_NAME,
  WEBPUBSUB_TRANSPORT_NAME,
} from "./constants";
import type { BaseServer } from "engine.io";
import { ConnectRequest as WebPubSubConnectRequest, WebPubSubEventHandler } from "@azure/web-pubsub-express";
import { WebPubSubServiceCaller } from "../../serverProxies";
import { WebPubSubEioServer } from "..";

const debug = debugModule("wps-sio-ext:EIO:ConnectionManager");

/**
 * A `WebPubSubConnectionManager` instance is created for each Engine.IO server instance. It's designed to:
 * 1. Manages all Azure Web PubSub client connections and keep them consistent with corresponding EIO clients.
 * 2. Handle upstream invoke requests from AWPS and then translate them into Engine.IO behaviours.
 * 3. Translates Engine.IO behaviours to AWPS behaviours like REST API calls.
 * 4. Makes the EIO `sid` same as its corresponding Azure Web PubSub client connection id.
 */
export class WebPubSubConnectionManager {
  /**
   * Each `WebPubSubConnectionManager` instance is bound to a Engine.IO server instance and vice versa.
   */
  public eioServer: WebPubSubEioServer;

  /**
   * Client for connecting to a Web PubSub hub
   */
  public service: WebPubSubServiceCaller;

  /**
   * Map from the `connectionId` of each client to its corresponding logical `ClientConnectionContext`.
   */
  private _clientConnections: Map<string, ClientConnectionContext> = new Map();

  /**
   * Handle upstream invoke requests from AWPS.
   */
  private _webPubSubEventHandler: WebPubSubEventHandler;

  /**
   * Options for Azure Web PubSub service.
   */
  private _webPubSubOptions: AzureSocketIOOptions | AzureSocketIOCredentialOptions;

  /**
   * In native Engine.IO, the `sid` of each EIO connnection is generated by server randomly.
   * As for AWPS, it generates `ConnectionId` for each client.
   * For each EIO connection, the extension enforces its `sid` in server side is same as the ConnectionId assigned by service.
   * This array stores all `ConnectionId` which is generated by AWPS and is prepared to be assigned to EIO connection.
   */
  private _candidateSids: Array<string> = [];

  constructor(server: WebPubSubEioServer, options: AzureSocketIOOptions | AzureSocketIOCredentialOptions) {
    this.service = getWebPubSubServiceCaller(options, true);
    this.eioServer = server;
    this._webPubSubOptions = options;

    this._webPubSubEventHandler = new WebPubSubEventHandler(this._webPubSubOptions.hub, {
      path: TUNNEL_PATH,
      handleConnect: async (req, res) => {
        let timeout: NodeJS.Timeout;
        let cleanup: (error: string) => void;
        try {
          const connectionId = req.context.connectionId;
          debug(`onConnect, connectionId = ${connectionId}`);

          cleanup = (error: string): void => {
            if (this._clientConnections.has(connectionId)) {
              this._clientConnections.delete(connectionId);
            }
            if (this._candidateSids.lastIndexOf(connectionId) === this._candidateSids.length - 1) {
              this._candidateSids.shift();
            }
            const connectionError = {
              req: req,
              code: CONNECTION_ERROR_WEBPUBSUB_CODE,
              message: CONNECTION_ERROR_WEBPUBSUB_MESSAGE,
              context: error,
            } as ConnectionError;
            this.eioServer.emit(CONNECTION_ERROR_EVENT_NAME, connectionError);
          };

          const context = new ClientConnectionContext(this.service, connectionId, res, cleanup);

          /**
           * Two conditions lead to returning reponse for connect event:
           *   1. The connection is accepted or refused by EIO Server and the corresponding events are triggered.
           *   2. Exception is thrown in following code
           * As a defensive measure, a timeout is set to return response in 30000ms in case of both conditions don't happen.
           */
          timeout = setTimeout(() => {
            if (!context.connectResponded) {
              const error = `EIO server cannot handle connect request with error: Timeout 30000ms`;
              cleanup(error);
              res.fail(500, error);
            }
          }, 30000);

          const connectReq = this.getEioHandshakeRequest(req, context);

          this._candidateSids.push(connectionId);
          this._clientConnections.set(connectionId, context);

          await this.eioServer.onConnect(connectionId, connectReq, context);
        } catch (error) {
          debug(`onConnect, req = ${req}, err = ${error}`);
          const errorMessage = `EIO server cannot handle connect request with error: ${error}`;
          clearTimeout(timeout);
          cleanup(errorMessage);
          res.fail(500, errorMessage);
        }
      },

      handleUserEvent: async (req, res) => {
        try {
          const connectionId = req.context.connectionId;

          debug(`onUserEvent, connectionId = ${connectionId}, req.data = ${req.data}`);

          if (this._clientConnections.has(connectionId)) {
            await this.eioServer.onUserEvent(connectionId, req.data);
            return res.success();
          } else {
            // `UserEventResponseHandler.fail(code, ...)` cannot set `code` with 404. Only 400, 401 and 500 are available.
            return res.fail(400, `EIO server cannot find ConnectionId ${connectionId}`);
          }
        } catch (err) {
          debug(`onUserEvent, req = ${req}, err = ${err}`);
          return res.fail(500, `EIO server cannot handle user event with error: ${err}`);
        }
      },

      onDisconnected: async (req) => {
        const connectionId = req.context.connectionId;
        debug(`onDisconnected, connectionId = ${connectionId}`);
        if (this._clientConnections.delete(connectionId)) {
          try {
            await this.eioServer.onDisconnected(connectionId);
            debug(`onDisconnected, Failed to delete non-existing connectionId = ${connectionId}`);
          } catch (err) {
            debug(`onDisconnected, Failed to close client connection, connectionId = ${connectionId}, err = ${err}`);
          }
        }
      },
    });
  }

  /**
   * @returns AWPS event handler middleware for EIO Server.
   */
  public getEventHandlerEioMiddleware() {
    /**
     * AWPS package provides Express middleware for event handlers.
     * However Express middleware is not compatiable to be directly used by EIO Server.
     * expressMiddleware = (req: express.Request, res: express.Response, express.NextFunction) =\> void;
     * eioMiddleware = (req: IncomingMessage, res: ServerResponse) =\> void;
     * To resolve the difference, So a conversion from express middleware to EIO middleware.
     */
    const expressMiddleware: any = this._webPubSubEventHandler.getMiddleware();

    const eioMiddleware = (req, res, errorCallback): void => {
      /**
       * `baseUrl` is a property of Express Request object and its used in `expressMiddleware`.
       * Without actual usage as a part of Express, `req.baseUrl` is always ''.
       * Ref https://expressjs.com/en/api.html#req.baseUrl
       */
      req.baseUrl = "";
      req.path = req.url; // e.g. /eventhandler/
      expressMiddleware(req, res, errorCallback);
    };

    return eioMiddleware;
  }

  /**
   * @returns AWPS event handler middleware for Express Server.
   */
  public getEventHandlerExpressMiddleware() {
    return this._webPubSubEventHandler.getMiddleware();
  }

  public getNextSid = (): string | undefined => this._candidateSids.shift();

  public async close(): Promise<void> {
    this._clientConnections.forEach(async (context) => {
      await context.close();
    });
  }

  /**
   * Convert an AWPS `connect` request to an Engine.IO `handshake` request.
   * @param req - AWPS `connect` request.
   * @param context - Corrsponding `ClientConnectionContext` for the connecting client. It will be used in `createTransport` to bind each transport to the correct AWPS client connection.
   */
  private getEioHandshakeRequest(req: WebPubSubConnectRequest, context: ClientConnectionContext): unknown {
    /**
     * Properties inside `handshakeRequest` are used in Engine.IO `handshake` method in `Server` class.
     * src: https://github.com/socketio/engine.io/blob/6.0.x/lib/server.ts#L396
     */
    const handshakeRequest: { [key: string]: unknown } = {
      method: "GET",
      headers: req.headers,
      connection: {},
      url: TUNNEL_PATH,
      _query: {},
      claims: req.claims,
    };
    // Preserve all queires. Each value of `req.queries` is an one-element array which is wrapped by AWPS. Just pick out the first element.
    // Example: req.queries = { EIO:['4'], t: ['OXhVRj0'], transport: ['polling'] }.
    for (const key in req.queries) {
      handshakeRequest._query[key] = req.queries[key][0];
    }
    // AWPS helps server abstract the details of Long-Polling and WebSockets with the client. So server always use our own transport `WEBPUBSUB_TRANSPORT_NAME`.
    handshakeRequest._query["transport"] = WEBPUBSUB_TRANSPORT_NAME;
    // AWPS client connection context is passed to Engine.IO `createTransport` method to bind each transport to the correct AWPS client connection.
    handshakeRequest[WEBPUBSUB_CLIENT_CONNECTION_FILED_NAME] = context;
    return handshakeRequest;
  }
}
