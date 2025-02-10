export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isArray(value) {
  return Array.isArray(value);
}