export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(what: string, details?: Record<string, unknown>) {
    super(`${what} not found`, "NOT_FOUND", 404, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(reason = "unauthorized") {
    super(reason, "UNAUTHORIZED", 401);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION", 400, details);
  }
}
