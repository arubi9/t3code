interface ZoomShortcutInput {
  alt?: boolean;
  code?: string;
  control?: boolean;
  key?: string;
  meta?: boolean;
  shift?: boolean;
  type?: string;
}

export function isWindowsZoomInShortcut(
  input: ZoomShortcutInput,
  platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  if (input.type !== "keyDown") return false;
  if (!input.control || input.alt || input.meta) return false;

  return (
    input.key === "+" ||
    input.code === "NumpadAdd" ||
    (input.shift === true && (input.key === "=" || input.code === "Equal"))
  );
}
