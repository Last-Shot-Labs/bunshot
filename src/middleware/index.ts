export type Handler = (req: Request) => Response | Promise<Response>;
export type Middleware = (req: Request, next: Handler) => Response | Promise<Response>;

export const applyMiddleware = (handler: Handler, ...middleware: Middleware[]): Handler =>
  middleware.reduceRight<Handler>(
    (next, mw) => (req) => mw(req, next),
    handler
  );
