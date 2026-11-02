export class RecDomainError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'RecDomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
