export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message, code = 'bad_request') => new HttpError(400, code, message);
export const conflict = (code, message) => new HttpError(409, code, message);
