export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (message = "not found") => new HttpError(404, message);
export const conflict = (message) => new HttpError(409, message);
