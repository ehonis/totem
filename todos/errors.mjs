export class TodoDomainError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'TodoDomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
