import { createServer } from 'node:http';
import { ApiError } from './errors.js';

const MAX_BODY_BYTES = 16 * 1024;

async function readJson(request) {
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    request.resume();
    throw new ApiError(413, 'BODY_TOO_LARGE', 'JSON body must be at most 16 KiB.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    // Continue draining oversized chunked requests, without buffering their bytes.
  }
  if (size > MAX_BODY_BYTES) throw new ApiError(413, 'BODY_TOO_LARGE', 'JSON body must be at most 16 KiB.');
  if (size === 0) return {};
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json.');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
}

const reply = (body, status = 200, headers = {}) => ({ body, status, headers });

export function createHttpServer(service, { logger = console } = {}) {
  // The HTTP layer handles protocol details; service.js owns all business rules.
  const routes = [
    ['GET', /^\/health$/, () => reply({ status: 'ok' })],
    ['GET', /^\/products$/, () => reply({ products: service.listProducts() })],
    ['POST', /^\/carts$/, (_p, body) => {
      const cart = service.createCart(body);
      return reply(cart, 201, { Location: `/carts/${cart.id}` });
    }],
    ['GET', /^\/carts\/([^/]+)$/, ([id]) => reply(service.getCart(id))],
    ['POST', /^\/carts\/([^/]+)\/items$/, ([id], body) => reply(service.addItem(id, body), 201)],
    ['PATCH', /^\/carts\/([^/]+)\/items\/([^/]+)$/, ([id, productId], body) => reply(service.updateItem(id, productId, body))],
    ['DELETE', /^\/carts\/([^/]+)\/items\/([^/]+)$/, ([id, productId]) => reply(service.removeItem(id, productId))],
    ['POST', /^\/carts\/([^/]+)\/checkout$/, ([id], body, request) => {
      const result = service.checkout(id, request.headers['idempotency-key'], body);
      return reply(result.order, result.replayed ? 200 : 201,
        { Location: `/orders/${result.order.id}`, 'Idempotency-Replayed': String(result.replayed) });
    }],
    ['GET', /^\/orders\/([^/]+)$/, ([id]) => reply(service.getOrder(id))],
    ['PATCH', /^\/admin\/products\/([^/]+)$/, ([id], body) => reply(service.updateProduct(id, body))],
    ['POST', /^\/admin\/coupons$/, (_p, body) => reply(service.generateCoupon(body), 201)],
    ['GET', /^\/admin\/coupons$/, () => reply({ coupons: service.listCoupons() })],
    ['GET', /^\/admin\/orders$/, () => reply({ orders: service.listOrders() })],
    ['GET', /^\/admin\/report$/, () => reply(service.report())],
  ];

  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (request, response) => {
    try {
      const { pathname } = new URL(request.url, 'http://localhost');
      const matches = routes.filter(([, pattern]) => pattern.test(pathname));
      const route = matches.find(([method]) => method === request.method);
      if (!route) {
        if (matches.length) {
          response.setHeader('Allow', matches.map(([method]) => method).join(', '));
          throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This HTTP method is not supported for this resource.');
        }
        throw new ApiError(404, 'ROUTE_NOT_FOUND', 'Endpoint does not exist.');
      }
      let params;
      try {
        params = route[1].exec(pathname).slice(1).map(decodeURIComponent);
      } catch {
        throw new ApiError(400, 'INVALID_INPUT', 'Malformed URL encoding.');
      }
      const body = ['POST', 'PATCH'].includes(request.method) ? await readJson(request) : {};
      const result = route[2](params, body, request);
      response.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', ...result.headers });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      // SQLite can return an extended result code; the low byte is the primary code.
      const sqliteCode = Number.isInteger(error.errcode) ? error.errcode & 255 : null;
      if (sqliteCode === 5 || sqliteCode === 6) {
        error = new ApiError(503, 'DATABASE_BUSY', 'Database is busy. Retry the request; keep the same checkout key.');
        response.setHeader('Retry-After', '1');
      }
      if (!(error instanceof ApiError)) {
        logger.error(error);
        error = new ApiError(500, 'INTERNAL_ERROR', 'Request failed. A checkout retry must use the same key.');
      }
      if (response.destroyed) return;
      response.writeHead(error.status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', ...(error.status === 413 ? { Connection: 'close' } : {}) });
      response.end(JSON.stringify({ error: { code: error.code, message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }) } }));
    }
  });
}
