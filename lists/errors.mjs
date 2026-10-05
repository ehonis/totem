export class ListDomainError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'ListDomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
