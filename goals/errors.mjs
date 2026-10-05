export class GoalDomainError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'GoalDomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
