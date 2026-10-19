type EntryDialogCancelControl = {
  disabled?: boolean;
  click?: () => void;
};

/** Close only when the pointer presses and releases on the backdrop itself. */
export function shouldDismissEntryDialog(
  pressedOnBackdrop: boolean,
  target: EventTarget | null,
  current: EventTarget | null
): boolean {
  return pressedOnBackdrop && target !== null && target === current;
}

/** The last plain button is the form's cancel. A disabled control keeps an in-flight submit open. */
export function activateEntryDialogCancel(
  root: { querySelectorAll(selector: string): ArrayLike<EntryDialogCancelControl> } | null
): boolean {
  if (!root) return false;
  const buttons = Array.from(root.querySelectorAll('button[type="button"]'));
  const cancel = buttons[buttons.length - 1];
  if (!cancel?.click || cancel.disabled) return false;
  cancel.click();
  return true;
}
