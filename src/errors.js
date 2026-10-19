export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function check(condition, status, code, message, details) {
  if (!condition) throw new ApiError(status, code, message, details);
}

export function integer(value, name, minimum, maximum) {
  check(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    400, 'INVALID_INPUT', `${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

export function fields(body, allowed, required = []) {
  check(body !== null && typeof body === 'object' && !Array.isArray(body),
    400, 'INVALID_INPUT', 'The JSON body must be an object.');
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  check(unknown.length === 0, 400, 'INVALID_INPUT', 'Unknown request fields.', { fields: unknown });
  for (const key of required) {
    check(Object.hasOwn(body, key), 400, 'INVALID_INPUT', `${key} is required.`);
  }
}

export function identifier(value, name) {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value),
    400, 'INVALID_INPUT', `${name} must contain 1–80 letters, digits, underscores or hyphens.`);
  return value;
}
