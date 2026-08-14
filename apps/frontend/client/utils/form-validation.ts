export function focusFirstInvalidField(
  root: ParentNode | null | undefined,
  fieldIds: readonly string[],
): boolean {
  if (!root) {
    return false;
  }

  for (const fieldId of fieldIds) {
    const field = root.querySelector<HTMLElement>(`#${fieldId}`);
    if (field && typeof field.focus === 'function') {
      field.focus();
      return true;
    }
  }

  return false;
}
