export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

export function ensure(condition, status, code, message) {
  if (!condition) throw new AppError(status, code, message);
}
